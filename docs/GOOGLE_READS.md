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

- `GET …/users/{userId}/history?startHistoryId&historyTypes&labelId&maxResults&pageToken`:
  chronological records, monotonic but non-contiguous `historyId`
  (maxResults ≤ 500), `messagesAdded`/`messagesDeleted` buckets whose
  messages typically carry only `id`/`threadId`, per-response `historyId`
  (the commit point), `nextPageToken` paging. `labelId` is the documented
  server-side scope; the documented parameter list has no `q`, so the
  poller never sends one. The accepted query boundary is therefore
  exact — absent (unfiltered: the whole mailbox, spam and trash included)
  or a single system-label filter (`in:inbox`, `in:sent`, `in:trash`,
  `in:spam`, `in:draft(s)`, `label:<system>`,
  `is:unread|starred|important`), enforced via `labelId`; any other query
  is rejected as `invalid_request` before any HTTP call, never silently
  broadened and never filtered by a local semantic heuristic. An invalid
  or expired
  `startHistoryId` (valid ≥ a week, sometimes only hours) returns **HTTP
  404 — the documented expiry signal, verified by test, not an assumed
  410** — and the client must full-sync.
- `GET …/messages?labelIds&includeSpamTrash&maxResults&pageToken` (ids
  only, ≤100/page requested): the bootstrap snapshot scopes with the
  exact provider label parameters, never a `q` search alias. `labelIds`
  keeps only messages carrying every listed id, and SPAM/TRASH messages
  are excluded unless `includeSpamTrash=true` — while history has no such
  exclusion. Snapshots therefore always set `includeSpamTrash=true`, so
  the snapshot observes exactly the population the delta observes
  (otherwise existing spam/trash messages would be lost and unfiltered
  snapshot/delta membership would disagree).
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

## Cursor contract (durable, consumer-owned, at-least-once)

- Cursors are opaque (`ghi.` + base64url JSON, version 2) binding the stable
  account identity, the query filter, the base watermark, and — for an
  uncompleted page — its continuation token plus already-emitted ids. A
  cursor presented for another account or query, or a legacy v1 cursor, fails
  `invalid_request` before any HTTP call. The bound identity is the
  poller's required `accountId` — the actual configured account, never the
  `userId` `"me"` alias, which is identical across accounts: two pollers
  sharing `"me"` with different `accountId` values reject each other's
  cursors (tested). Factory callers serving several accounts must pass
  distinct `accountId` values. Only exact scopes are accepted (unfiltered
  or a single system-label filter); anything else fails `invalid_request`
  before any HTTP call, so a scoped cursor can never silently return
  unscoped mail.
- `nextCursor` never advances the base watermark past unvisited pages or
  un-emitted messages: a capped result resumes the exact page (replayed
  server-side, de-duplicated by message id, so repeats are possible but
  silent loss is not — including truncation within a page, where the resume
  replays the page skipping already-emitted ids). Only a fully consumed
  result set advances the base to the provider's latest `historyId`.
- Cursor-less bootstrap reads the profile watermark first, snapshots ids,
  then runs a bounded catch-up delta from that watermark within the same
  page budget, so arrivals during listing are returned instead of skipped by
  a post-list cursor. If the budget fills first, the watermark itself is
  named as the next base (replays dedupe). History earlier than the cursor's
  validity window still requires reset, not data drop.
- **Commit only after durable ingestion acknowledgement**: the adapter keeps
  no second store; if the consumer crashes before persisting `nextCursor`,
  the next poll simply replays. Consumers must de-duplicate replays by
  message id.
- `resetRequired: true` (on history 404, including an expired catch-up
  watermark) carries no changes and no cursor: run a cursor-less full sync
  and adopt its fresh cursor.
- `truncated: true` (page/message bounds hit, or cursor unavailable) means
  "poll again with the returned cursor, do not treat this as a complete
  view." Bounds default to 5 pages / 50 messages and are caller-tunable;
  truncation is surfaced, never a silent claim of full context.

## Thread intake and identity rules

- Full bodies come from the existing thread reader (MIME audit below);
  intake identity keys on `threadId` only. **Never merge threads into one
  booking on sender address alone**: distinct threads from the same sender
  stay distinct records (tested).
- Provider content (bodies, Drive text) is evidence, not authority:
  receipts label it `LIVE … (provider evidence, not verified authority)`,
  and downstream business facts must enter at reduced confidence.

## MIME audit of the existing thread reader (bounded variant added)

Reviewed `gmail.ts` parsing for intake use: recursive multipart walk
preferring `text/plain`, strict base64url validation, header guards, snippet
fallback. Two corrections apply since the first audit: undecodable base64 no
longer decodes to empty/mojibake text (the old lenient decoder stripped
invalid characters, so a part claiming `text/plain` with undecodable data
did NOT fall back to the snippet — it presented transformed content as the
body); such parts are now skipped with an explicit flag. A bounded reader,
`readThreadBounded`, shares the single fetch+parse path with
`readInquiryThread` (identical bodies) and adds a per-message completeness
record with stable codes (`malformed-base64-part`, `unsupported-charset`,
`attachment-skipped`, `snippet-fallback`, `no-text-content`); non-UTF-8
charsets are never decoded as UTF-8. Sibling scanning continues after the
first usable text is selected, so skipped attachments later in the part
list are still flagged. Base64 payloads decode with fatal UTF-8: truly
invalid byte sequences are flagged `malformed-base64-part`, while a valid
literal U+FFFD stays text. Intake must treat `complete: false` as
"decide, do not assume a full body." Source bodies remain evidence, never
authority, and nothing here registers a host.

## Memory bounds (honest accounting)

The 2 MiB Drive cap is a correctness bound enforced after buffering by
default; a server that ignores `Range` still buffers fully before the length
check. All cap comparisons use encoded bytes (`Buffer.byteLength`), never
UTF-16 units, and over-cap bodies fail closed rather than being sliced
(so no truncation can split a Unicode code point). `createFetchTransport({ maxBytes })` adds a true streaming cap that
counts bytes as chunks arrive and aborts past the cap
(`TransportBodyTooLargeError`, mapped by the retriever to fail-closed
over-cap); it is opt-in and backward compatible, and timeout/uncertain-write
behavior is untouched. Without it, no bounded-memory claim is made.

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
