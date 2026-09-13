# Google read surfaces: inbox polling + Drive retrieval (LIVE, unverified)

Contract-level read adapters in `src/connectors/google/incremental.ts`
(Gmail history polling) and `src/connectors/google/documents.ts`
(Drive/Docs retrieval). Thread bodies reuse the reviewed
`GoogleGmailConnector.readInquiryThread` by composition — there is no
parallel inquiry reader. Everything here is exercised only against
scripted transports (`tests/google-read-inbox.test.ts`,
`tests/google-read-documents.test.ts`, labeled SIMULATED). **No live
account verification has been performed; the live gate is BLOCKED.**

## Verified API surface

Gmail (`users.history.list` reference; `messages.list`/`get`, `profile`):

- `GET …/users/{userId}/history?startHistoryId&historyTypes=maxResults&pageToken`:
  chronological records, monotonic but non-contiguous `historyId`
  (maxResults ≤ 500), `messagesAdded`/`messagesDeleted` buckets whose
  messages typically carry only `id`/`threadId`, per-response `historyId`
  (the commit point), `nextPageToken` paging. An invalid or expired
  `startHistoryId` (valid ≥ a week, sometimes only hours) returns **HTTP
  404 — the documented expiry signal, verified by test, not an assumed
  410** — and the client must full-sync.
- `GET …/messages?q&maxResults&pageToken` (ids only, ≤100/page requested),
  `GET …/messages/{id}`, `GET …/profile` (`historyId` bootstrap).
- Quota (Gmail quota doc): `history.list` 2 units, `messages.list` 5,
  `messages.get` 20.

Drive (`files.get` / `files.export` references, "Download and export files"
guide):

- `GET /drive/v3/files/{fileId}?fields=id,name,mimeType,capabilities/canDownload&supportsAllDrives=true`
  for metadata; `capabilities/canDownload` is honored before any content
  fetch.
- Google Workspace types via `files.export?mimeType=` (Docs→`text/plain`,
  Sheets→`text/csv`, Slides→`text/plain`; provider-side export cap 10 MB).
- Blobs via `files.get?alt=media` with a `Range` cap; binary MIMEs are
  refused, never decoded as text.
- There is no `files.list` call anywhere in the retriever: retrieval is
  addressed solely by caller-approved explicit IDs. No recursive account
  scan exists or is planned in this lane.

## Least-privilege scopes (additions)

- Inbox polling + thread reads: `gmail.readonly` (existing).
- Drive retrieval: `drive.readonly` (content for explicit IDs; metadata
  scopes alone cannot download).

## Cursor contract (durable, consumer-owned)

- Cursors are opaque (`ghi.` + base64url JSON); invalid cursors fail
  `invalid_request` before any HTTP call.
- `nextCursor` always comes from the provider's latest `historyId`
  (history response, else profile bootstrap), so cursors advance
  monotonically across repeated pages and duplicates, which are deduped by
  message id with first-seen order preserved.
- **Commit only after durable ingestion acknowledgement**: the adapter keeps
  no second store; if the consumer crashes before persisting `nextCursor`,
  the next poll simply replays.
- `resetRequired: true` (on history 404) carries no changes and no cursor:
  run a cursor-less full sync and adopt its fresh cursor.
- `truncated: true` (page/message bounds hit, or cursor unavailable) means
  "poll again, do not treat this as a complete view." Bounds default to 5
  pages / 50 messages and are caller-tunable; truncation is surfaced,
  never a silent claim of full context.

## Thread intake and identity rules

- Full bodies come from the existing thread reader (MIME audit below);
  intake identity keys on `threadId` only. **Never merge threads into one
  booking on sender address alone**: distinct threads from the same sender
  stay distinct records (tested).
- Provider content (bodies, Drive text) is evidence, not authority:
  receipts label it `LIVE … (provider evidence, not verified authority)`,
  and downstream business facts must enter at reduced confidence.

## MIME audit of the existing thread reader (no code change)

Reviewed `gmail.ts` parsing for intake use: recursive multipart walk
preferring `text/plain`, base64url validation, header guards, snippet
fallback. Known limitation (documented, unfixed in this lane): a part
claiming `text/plain` with undecodable data is skipped toward the snippet
fallback without an incompleteness flag on the contract shape. Changing
that would alter reviewed read output; a bounded reader with explicit
truncation flags is future work, not a silent second abstraction.

## Error mapping (reads never write, so retry is safe)

401 → `access_revoked`; 403 rate-limit reasons / 429 → `rate_limited`
(retryable); 403 privilege → `authorization_denied`; 404 history →
`resetRequired` (not an error); 404 elsewhere → `not_found`; 400 →
`invalid_request`; 5xx/transport/timeout → `transport_error` (retryable);
unknown JSON → `transport_error` fail-closed. Drive: undownloadable →
`authorization_denied`; unexportable/binary → `unsupported`; over-cap →
fail-closed instead of silent truncation.

## Manual limits

History earlier than the cursor's validity window is unrecoverable except
by full sync; `messages.list` ordering is provider-defined, so intake must
tolerate any order. Drive revisions, comments/suggestions views, and
export-format negotiation beyond plain text/CSV are unbuilt. Simulation
proves contract handling, not live mailbox/drive behavior.
