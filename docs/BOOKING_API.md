# Booking approval API (DEMO ONLY)

Local, durable booking-approval service backed by SQLite and deterministic
demo connectors. Every response is explicitly marked
`{ "demo": true, "mode": { "kind": "demo", "label": "DEMO ONLY", ... } }`.
Nothing here calls a live provider; receipts are simulated.

Typed contract: `src/server/dto.ts` (UI should import these types).
Service functions (injectable clock/connectors): `src/server/booking-service.ts`.
Request validation + same-origin guard: `src/server/validation.ts`.

## Approval identity

`approvedBy` is **server-derived** from `GATHER_OWNER_ID` (default
`"local-owner"`) and exposed in `GET /api/workspace` as `approvalIdentity`.
Clients must not send `approvedBy`; any such field is ignored, so untrusted
inquiry text can never authorize execution.

## Fingerprint coverage

`proposalFingerprint` covers exactly `{ bookingId, kind, payload,
sourceReferences }`. The pipeline executes **only** payload-explicit fields
(`startAt`, `endAt`, `expiresAt`, `calendarId`, `emailTo`, `emailSubject`,
`emailBody`) and rejects proposals that omit any of them — so the displayed
fingerprint covers every consequential hold/email field, including the calendar
target. Changing the calendar target changes the fingerprint and invalidates
prior approval. `expiresAt` is a provisional-hold expiry: it must lie in the
future relative to the server clock, and it is legitimately before the event
(an offer held until next week for an October event). `GET /api/workspace`
exposes per-proposal `consequences` previews (resolved with the same function
the pipeline uses); `consequences: null` plus `consequencesError` means the
proposal is incomplete and approval will return `INVALID_REQUEST`.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/workspace` | Bookings with proposals + consequences previews, approvals, per-step executions, connections, `approvalIdentity`. |
| `POST` | `/api/bookings/:bookingId/approve` | Exact-version approve then fresh-availability → hold → email pipeline. Body: `{ bookingId, proposedActionId, proposalVersion, proposalFingerprint }`. |
| `POST` | `/api/actions/:actionId/retry` | Retry failed steps only. Succeeded steps are reused, never resent. Uncertain steps return `RECONCILE_REQUIRED`. |
| `POST` | `/api/executions/:executionId/reconcile` | Reconcile one `uncertain`/`partial` execution via its stable idempotency key. |
| `POST` | `/api/demo/init` | Seed fictional fixtures. Body must be exactly `{ "demo": true }`. |

A provisional hold is **never** a confirmed booking: successful responses carry
`"confirmedBooking": false`, and booking status becomes `provisional_hold`
(not `confirmed`) after a hold. `confirmed` is reserved for a future
payment/confirmation step.

## Durability model

- Step executions are **reserved atomically in SQLite before** any provider
  side effect (`reserveStepExecution`), keyed by a stable idempotency key
  (`stableOperationKey` over `{ proposedActionId, proposalVersion }`) that is
  identical across retries, reconciliation, and restarts. The reservation
  grants a time-boxed **claim** (`{ execution, created, reclaimed }`); only
  the claim holder may execute or complete the step. A pending row with a live
  claim belongs to another in-flight attempt (possibly on a separate store
  connection) and is refused with retryable `409 CONFLICT` instead of being
  replayed. Completion writes (`completeActionExecution`,
  `markExecutionUncertain`) are conditional on the claim token, so an expired
  in-flight call and a new owner can never both commit.
- A reclaimed (crashed/leaked) pending attempt is **reconciled by stable key
  before any further write**: a found provider write heals to `succeeded`
  without a new side effect; an absent one stays `uncertain` until provider
  evidence appears — lease expiry never authorizes a blind replay.
- Availability is re-checked fresh before every new hold write (approve and
  retry), and the requested range must be **fully covered** by available
  slots; partial overlap is rejected as `SLOT_UNAVAILABLE`. Retry also
  re-verifies a live exact-version approval, so stale receipts are never
  served after the proposal moves on.
- Uncertainty (throw/timeout) is **persisted as `uncertain` before** any retry
  is allowed; retry of an uncertain step is refused until reconciliation.
- Provider receipts are persisted twice: per-step results in
  `action_executions.result_json`, and every completed demo provider write
  (including writes whose response was lost) in `provider_receipts`. The
  durable demo wrappers reconcile from SQLite, so restart-while-uncertain
  recovery survives adapter rebuilds. The demo adapter's in-memory world is
  volatile and is never the source of truth; simulation restart recovery
  proves SQLite durability, not a real external provider restart.
- Hold windows are claimed atomically in SQLite (`provider_hold_intents` +
  `provider_receipts` overlap check inside one IMMEDIATE transaction) before
  the volatile adapter is touched, so a restarted process or a second booking
  action cannot double-book the same calendar window; definitive failures
  release the claim. Pending intents are never purged by lease or clock: an
  intent records a provider effect of unknown outcome and stays fail-closed
  until evidence (a durable receipt, an explicit release after definitive
  failure, or reconciliation) — except that an intent whose key already has a
  durable receipt defers to that receipt, so a crash between receipt write
  and intent release cannot block forever. Receipts whose hold has expired no
  longer deny their window — expiry is observed against the injected service
  clock — but receipt rows are preserved as history. The availability read
  consults the same durable conflict set (excluding the caller's own
  operation key), so availability and create agree in-process and across
  restarts. The demo adapter mirrors these rules in-memory: its hold conflict
  check ignores expired holds, create-time slot reads are scoped to the
  requested calendar exactly like availability, and all three layers (demo
  world, durable wrappers, service clock) share one injected clock source in
  the server runtime.
- Failed steps reopen under the **same** idempotency key, so a real provider
  dedupes them.

## Ordering and state rules

- The executable payload is validated **before** any approval row is stored:
  invalid, past-window, malformed-recipient, or unsupported-kind proposals
  gain no approval and no executions. Past event windows (`endAt` at or
  before the server clock) are rejected outright, as are windows whose
  `startAt` is at or before now (an event that already started cannot be
  newly approved; `startAt == now` counts as begun). Every `emailTo` element
  must be a non-empty address: malformed elements are rejected, never
  silently filtered, so the approved recipient set is exactly the executed
  one.
- Only `kind: "create_provisional_hold"` is executable. Any other kind —
  including `custom` with a hold-shaped payload — is rejected with
  `INVALID_REQUEST` at the approve/retry boundary.
- Availability is scoped to the proposal's `calendarId` (required end to
  end: payload, availability request/key, and slot attribution) and must
  fully cover the requested range. A repeat approval whose own hold already
  succeeded skips the availability read and reuses receipts.
- Booking status aggregates step uncertainty: any outstanding
  `uncertain`/`partial` step keeps the booking `uncertain` (including an
  uncertain email after a succeeded hold); reconciliation refreshes the
  aggregate back to `provisional_hold` once nothing is uncertain.

## Current proposal authority (durable pointer, not ordering)

Each booking has exactly one **current proposal**, resolved through the
durable `booking_current_proposals` pointer — never by comparing per-action
`proposalVersion`, wall-clock `createdAt`, or UUID order. The pointer and a
persisted per-booking `proposal_seq` are assigned atomically at insert;
pre-pointer databases backfill sequences in legacy creation order and point
at the last-created action, preserving the old confirmation behavior.

- `GET /api/workspace` exposes the pointer per booking as
  `currentProposedActionId`. **UI contract (including delivery UI): display,
  approve, and confirm exactly the proposal named by
  `currentProposedActionId` — never `proposals.at(-1)`, never
  max-`proposalVersion`.** When the pointer is absent (pre-pointer
  payloads), the adapter falls back to version-then-`createdAt` ordering.
- `proposalVersion` keeps its existing meaning: the in-place revision count
  *within one action row*. A genuinely new proposal is a *new row* (new id,
  version reset to 1, next `proposal_seq`) that atomically supersedes the
  old row (`status: "superseded"`), invalidates live approvals on it, and
  moves the pointer — all inside one `IMMEDIATE` transaction, so concurrent
  publishes serialize with no duplicates and no half-moved state. Old
  receipts, executions, and audit rows are preserved untouched, scoped to
  their exact action + version.
- Fingerprint-bound idempotency: republishing an identical proposal reuses
  the existing row (`reused: true`) without moving the pointer. A replay
  whose fingerprint matches a *superseded* row never revives that row.
- Approve, retry, and reconcile all gate on the pointer **before and after
  every await**: a superseded action (even with a matching version and
  fingerprint) is refused with `STALE_PROPOSAL`. A proposal published
  mid-approval halts the pipeline after the await — observed provider
  evidence is preserved as versioned history on the old action, the email
  step never runs, and the booking parks as `uncertain`. Confirmation binds
  the same pointer and revalidates it transactionally at commit.

## Receipt provenance (preserved connector proof)

Every completed step result embeds the serving connector's proof
(`{ mode, simulated, provenance }`) taken from its response metadata — it is
read back, never re-derived. A receipt reads as live only on positive proof:
live mode, explicitly not simulated, non-empty provenance, zero fictional
refs. Missing/malformed proof (legacy rows, unknown connectors), simulated
results, and fixture refs all fail closed to demo, and completion notes name
the actual proof per step instead of blanket-claiming simulated. Fixture
receipts are never upgraded to live, at the service or at display.

## Errors

Typed `{ code, message, retryable, demo: true }`. Codes: `INVALID_REQUEST`
(400), `NOT_FOUND` (404), `STALE_PROPOSAL`/`CROSS_BOOKING`/`SLOT_UNAVAILABLE`/
`CONFLICT`/`RECONCILE_REQUIRED` (409), `CROSS_ORIGIN_DENIED` (403),
`ACCESS_REVOKED`/`EXECUTION_FAILED` (502), `UNCERTAIN`/`RECONCILE_PENDING`
(503, retryable).

`RECONCILE_PENDING` means reconciliation found no provider evidence yet: the
execution stays `uncertain` and the caller may retry reconciliation later.
It is explicitly not a failure verdict, and it never authorizes a new write.

A demonstrated durable-window conflict (another booking durably holds the
same calendar window) surfaces as actionable `SLOT_UNAVAILABLE` naming the
conflicting record — both at the availability pre-check and, for create-time
races, at the hold step. Other conflict kinds (e.g. an operation key rebound
to a different payload) keep the `EXECUTION_FAILED` path and are never
masked as availability.
It is explicitly not a failure verdict, and it never authorizes a new write.

## Manual resolution limits

Protected indefinite uncertainty is a legitimate durable state, not a
failure to be reclassified to make a flow complete. When the provider can
never prove absence (e.g. a timeout-after-success whose record is
unreachable), the execution remains `uncertain`, retry stays refused, and no
API exists to force-resolve it: the operator must verify the provider state
out of band (provider dashboard / calendar / mailbox) and then reconcile —
reconciliation succeeds only if the provider actually holds the record. If
the provider confirms absence out of band, the current API still offers no
absence-attested re-execution; that path is intentionally unbuilt rather
than faked. Simulation restart recovery proves SQLite durability of these
states, not real external provider restart behavior.

Mutations require `Content-Type: application/json` and reject cross-origin
browser requests: when `Origin` (or `Referer` fallback) is present it must
match the request `Host`, else `403 CROSS_ORIGIN_DENIED`.

## Examples

```sh
curl -s localhost:3000/api/workspace | head -c 400
curl -s -X POST localhost:3000/api/demo/init \
  -H 'Content-Type: application/json' -d '{"demo":true}'
curl -s -X POST localhost:3000/api/bookings/demo-booking-clara-01/approve \
  -H 'Content-Type: application/json' \
  -d '{"bookingId":"demo-booking-clara-01","proposedActionId":"demo-proposal-clara-v1","proposalVersion":1,"proposalFingerprint":"<from workspace>"}'
curl -s -X POST localhost:3000/api/actions/demo-proposal-clara-v1/retry
curl -s -X POST localhost:3000/api/executions/<executionId>/reconcile
```

## UI mapping notes (left to the UI owner)

- Render `mode.label` ("DEMO ONLY") wherever bookings or receipts appear.
- Show each proposal's `consequences` (hold window, recipients, subject) next
  to the approve control, plus `approvalIdentity` ("approval recorded as …").
- Approval controls send the exact `proposalVersion` + `proposalFingerprint`
  from the displayed proposal; `409 STALE_PROPOSAL` means refresh the workspace.
- Blocked states: `SLOT_UNAVAILABLE` (unavailable date), `ACCESS_REVOKED`
  (reconnect), `RECONCILE_REQUIRED` (reconcile action), `UNCERTAIN` (retry later).
