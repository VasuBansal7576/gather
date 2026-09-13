# Google Calendar + Gmail adapters (LIVE, unverified)

Contract-level live adapters under `src/connectors/google/`. Every exchange
is currently exercised only against scripted transports in
`tests/google-calendar.test.ts` and `tests/google-gmail.test.ts` (labeled
SIMULATED). **No live account verification has been performed; the live gate
is BLOCKED** until onboarding provides approved account assets. These
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
- `GET .../events?timeMin&timeMax&singleEvents=true&orderBy=startTime`
  (`events.list`): `timeMin` bounds event end, `timeMax` bounds event start;
  `maxResults` ≤ 2500 with `nextPageToken` pagination; `showDeleted`
  semantics for cancellations.
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

- Availability reads: `calendar.readonly`.
- Provisional holds: `calendar.events` (never full `calendar`, which also
  grants sharing/ACL control).
- Inquiry reads + send reconciliation: `gmail.readonly`.
- Sends: `gmail.send`.
- Never requested: `mail.google.com`, `gmail.modify`, `gmail.compose`.

## Deterministic ids and reconciliation

- Calendar: `googleEventIdFor(operationKey)` = `g` + 31 sha256 hex chars
  (hex ⊆ base32hex, always valid). 409 replays fetch the event and verify
  the exact calendar, stored operation key, booking, and approved window
  before reuse; mismatches are `conflict`. Timeout/5xx/408/425/network
  ambiguity on insert → `uncertain` (reconcile by id, never blind-retry).
- Gmail: `gmailMessageIdFor(operationKey)` Message-ID is generated per send
  and recomputed for reconciliation, which searches `rfc822msgid:` in sent
  mail (≤5 pages) and confirms via `messages.get`. Gmail search indexing
  lags acceptance, so an empty result is `not_found` **retryable**, never
  proof of non-delivery; a 5xx/timeout on send is `uncertain`.
- Reconcile scope: `reconcileProvisionalHold` receives only the operation
  key, so the adapter resolves the calendar from an explicit `calendarId`
  binding or an injected durable `resolveHoldScope` (caller-owned storage),
  never a volatile map. Without either it fails `invalid_request`.

## Availability semantics

Fresh `events.list` per check, scoped to the request calendar, paged fully:
`cancelled` and `transparent` events never block; other overlaps become
unavailable slots (reason names the live event); gaps become available
slots. Times normalize to epoch millis (`dateTime` exact; all-day `date`
as UTC day boundaries, RFC5545-exclusive ends preserved via the API's own
values). Slot ids are content hashes prefixed `live-slot-`.

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
safe); non-ASCII subjects are RFC 2047 encoded; Gmail search terms are
quote-escaped; calendar ids/event ids are `encodeURIComponent`-escaped.
Tokens travel only in the Authorization header, are never logged, stored,
or embedded in bodies/receipts (tests assert absence).

## Receipt distinction

Live receipts carry `mode: {mode:"live",label:"LIVE",fictional:false}` with
`simulated:false` under the discriminated `ConnectorMetadata` contract
(`simulated: boolean`, correlated with the mode), provider-issued ids
(Calendar event id, Gmail immutable message id), and `LIVE` locators
(`google-calendar://…`, `gmail://…`). A Gmail receipt proves **sent, not
delivery**. Demo receipts remain `DEMO ONLY`/`simulated:true`/fictional and
are structurally unmistakable.

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
