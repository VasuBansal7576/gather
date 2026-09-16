# Google Calendar + Gmail adapters (LIVE, unverified)

Contract-level live adapters under `src/connectors/google/`. Every exchange
is currently exercised only against scripted transports in
`tests/google-calendar.test.ts` and `tests/google-gmail.test.ts` (labeled
SIMULATED). These tests do not verify a live account. A live run needs separately authorized, configured account assets and independent outcome evidence. These
adapters are never registered as connected by default — `createGoogleConnectors`
only composes them; no runtime wiring references them.

## Verified API surface

Calendar v3 (verified against developers.google.com/calendar/api):

- `POST /calendar/v3/calendars/{calendarId}/events` (`events.insert`;
  ref `/calendar/api/v3/reference/events/insert`, guide
  `/workspace/calendar/api/guides/create-events`): client-settable `id`
  (base32hex `a-v0-9`, 5–1024 chars, unique per calendar; collisions not
  guaranteed detectable), `sendUpdates=none` for silent provisional holds,
  returns the Events resource. Duplicate id → HTTP 409.
- `GET .../events/{eventId}` (`events.get`): reconciliation read.
- `POST /calendar/v3/freeBusy` (`freebusy.query`; ref
  `/workspace/calendar/api/v3/reference/freebusy/query`): availability comes
  from server-computed busy instants (`timeMin`/`timeMax`, single-item
  `items:[{id}]`), so all-day dates resolve in the calendar's own timezone
  (DST included) with zero client timezone math. Per-calendar `errors[]`
  reasons (`notFound`, `internalError`, …) are surfaced, never swallowed;
  malformed busy windows fail the whole check closed.
- Errors (`/workspace/calendar/api/guides/errors`): 401, 403
  (`rateLimitExceeded`/`userRateLimitExceeded`, also 429), 404, 409
  (identifier exists), 5xx.

Gmail v1 (verified against developers.google.com/gmail/api):

- `POST /gmail/v1/users/{userId}/messages/send` with `{raw: base64url
  RFC 2822, threadId?}` (ref `.../reference/rest/v1/users.messages/send`,
  guide `/workspace/gmail/api/guides/sending`): returns `{id, threadId,
  labelIds}`. Threading requires matching Subject plus RFC 2822
  References/In-Reply-To. **No idempotency key exists: exactly-once send is
  not claimed.**
- `GET messages/{id}?format=full`, `GET messages?q=&pageToken=`
  (search, e.g. `rfc822msgid:`), `GET threads/{id}?format=full`.
- Errors (`/workspace/gmail/api/guides/handle-errors`): 401 authError
  (expired/invalid credentials → refresh/re-OAuth), 403 rate limits vs
  privilege, 404, 429, 5xx.

## Least-privilege scopes

- Availability reads: `calendar.freebusy` (freeBusy only; event bodies are
  never listed for availability).
- Event reads for reconcile/409 verification: `calendar.readonly`.
- Provisional holds: `calendar.events` (never full `calendar`, which also
  grants sharing/ACL control).
- Inquiry reads + send reconciliation: `gmail.readonly`.
- Sends: `gmail.send`.
- Never requested: `mail.google.com`, `gmail.modify`, `gmail.compose`.

## Deterministic ids and reconciliation

- Calendar: `googleEventIdFor(operationKey)` = `g` + 31 sha256 hex chars
  (hex ⊆ base32hex, always valid). 409 replays fetch the event and verify
  the exact calendar, stored operation key, booking, and approved window
  before reuse. Every reuse path (409 replay, reconcile) verifies **all**
  of: response id equals the deterministic id, stored operation-key linkage
  is present and equal (absent metadata is never a pass), event not
  cancelled, and — when the durable resolver supplies the approved payload —
  exact booking, window, and expiry. Anything else is `conflict`; receipts
  never carry blank booking/dates/expiry or locally-coerced timestamps.
  Timeout/5xx/408/425/network ambiguity on insert → `uncertain`, as is a
  200/201 with unusable event fields (reconcile by deterministic id, never
  blind-retry). A bound adapter rejects any request naming another calendar
  without any HTTP call.
- Gmail: `gmailMessageIdFor(operationKey)` Message-ID is generated per send
  and recomputed for reconciliation, which searches `rfc822msgid:` in sent
  mail (≤5 pages) and confirms via full `messages.get`. The record must
  carry the SENT label and match the durable approved payload (recipients,
  subject, thread, body when recorded) — Message-ID discoverability alone
  is not identity, and a silent expectation resolver reports cannot-verify
  (`conflict`). Cc is preserved from provider headers. Gmail search
  indexing lags acceptance, so an empty result is `not_found` **retryable**,
  never proof of non-delivery; a 5xx/timeout (or a 200 with a malformed
  body) on send is `uncertain`.
- Reconcile scope: `reconcileProvisionalHold` receives only the operation
  key, so the adapter resolves the calendar from an explicit `calendarId`
  binding or an injected durable `resolveHoldScope` (caller-owned storage),
  never a volatile map. Without either it fails `invalid_request`.

## Availability semantics

Fresh `freeBusy.query` per check for exactly the request calendar: the
server returns busy instants, so all-day dates resolve in the calendar's
own timezone (DST included) with no client timezone math. Overlaps become
unavailable slots; gaps become available slots; per-calendar errors and
malformed busy windows fail the check closed instead of reporting free.
Slot ids are content hashes prefixed `live-slot-`. Event reads
(`events.get`) remain `dateTime`-exact with all-day `date` boundaries used
only for window verification, never for availability math.

## Built-in fetch transport

`createFetchTransport({ fetchImpl?, timeoutMs? })` wraps an injected fetch
(default: global fetch) with a bounded per-request timeout via
AbortController. Timeouts and pre-response network failures surface as
`TransportTimeoutError`/`TransportNetworkError`, which mutating adapters
translate into `uncertain`. The transport performs no auth lookup, adds no
headers, and registers nothing — callers supply every header, including
Authorization.

## Error mapping

401 authError/invalid_grant → `access_revoked`; 403 permission/scope →
`authorization_denied`; 403/429 rate-limit reasons → `rate_limited`
(retryable); 5xx/408/425 on reads → `transport_error` (retryable); the same
on writes → `uncertain`; 404 → `not_found`; 409 → `conflict`; 400 →
`invalid_request`; unknown JSON shapes → `transport_error` (never coerced
into success). Missing/failed token supply → `access_revoked` (live gate
BLOCKED); no HTTP call is attempted.

## Boundary validation and secrets

All provider JSON crosses `unknown` guards (no `any`); recipients must be
plain ASCII addresses; Subject/addresses reject CR/LF (header-injection
safe) while the body after the blank separator preserves newlines as
content; non-ASCII subjects are RFC 2047 encoded; Gmail search terms are
quote-escaped; calendar ids/event ids are `encodeURIComponent`-escaped.
Tokens travel only in the Authorization header, are never logged, stored,
or embedded in bodies/receipts (tests assert absence).

## Receipt distinction

Live receipts carry the correlated metadata union: `{mode:LIVE,
fictional:false, simulated:false}` is the only constructible live shape —
a live result claiming `simulated:true` (or a demo result claiming live
provenance) is a compile-time error, enforced by the
`ConnectorMetadata` discriminated union rather than a boolean with a
comment. Receipts carry provider-issued ids (Calendar event id, Gmail
immutable message id) and `LIVE` locators (`google-calendar://…`,
`gmail://…`). A Gmail receipt proves **sent, not delivery**. Demo receipts
remain `DEMO ONLY`/`simulated:true`/fictional and are structurally
unmistakable.

## Escalated interface notes (resolved this task)

- Former `simulated: true` literal could not model live results; with
  coordinator authorization `contracts.ts` now types `simulated: boolean`
  correlated with the discriminated mode. Demo types and callers are
  unchanged (they pass `true`).
- Bare-key calendar reconcile cannot resolve scope alone; the binding /
  durable-resolver design above is the explicit answer (no volatile map).

## Manual limits

Provisional holds are plain opaque events with linkage in
`extendedProperties.private` (`gatherOperationKey`, `gatherBookingId`,
`gatherExpiresAt`); expiry is bookkeeping for Gather, not provider
enforcement — a sweep/cancel path is unbuilt. Gmail correlation assumes the
provider preserves our Message-ID; if it ever rewrites it, reconciliation
degrades to subject/recipient/time-window heuristics (documented, not
implemented). Sync-token incremental sync (410 handling) is out of scope.
