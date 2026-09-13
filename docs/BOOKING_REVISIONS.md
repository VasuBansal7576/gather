# G11 owner booking revision / cancellation / pause (DEMO ONLY)

Owner command workflow for revising terms, cancelling bookings, and
pausing/resuming write activity. Every command executes under an exact
host-owner authority binding — business + booking + the booking's durable
**current** action triple (id + version + fingerprint) + an idempotent
command id — and currency always resolves through the store's durable
current-proposal pointer. No second pointer exists in this module.

Implementation: `src/server/booking-revisions/` (service, module-owned
lifecycle/command/release tables, validation). Routes:
`POST /api/bookings/[bookingId]/{revision,cancellation,pause}`.
Contract: `src/connectors/hold-release.ts` (N-owned, vendored verbatim —
never a divergent mirror, never an independent key derivation).

## Command envelope

- Same command id + same canonical request hash replays the stored
  response (restart-safe, `duplicate: true`). Same id + different content
  is a conflict, never a silent overwrite. Thrown errors (stale, conflict)
  propagate unrecorded so the owner can retry the same id; every executed
  step is itself idempotent (deterministic release keys, ledger dedupe
  keys).
- Request-supplied owner identities are ignored; the host owner id is
  authoritative. Cross-business or cross-booking bindings are refused;
  version/fingerprint drift or a superseded action is `STALE_PROPOSAL`.
- Blocked responses are replayed canonically; making progress after a
  block requires a **new** command id.

## Revision

`requestRevision` carries a complete revised inquiry (+ calendar, email,
expiry) through the existing operator prepare path
(`buildBookingOffer` → `persistPreparedProposal`): a genuinely new
proposal becomes current, the old action is superseded, its approval is
invalidated, and a new owner approval is required. Nothing is sent and no
hold is created by the command itself.

Guards, evaluated before persisting:

- Paused or cancellation-requested bookings refuse (`BOOKING_PAUSED` /
  `CANCELLATION_REQUESTED`).
- An obsolete **unreleased** hold on the current proposal that overlaps
  the revised window blocks (`obsolete_hold_unreleased`) — the old terms
  must be released first, otherwise the new hold could never execute.
  Released holds and non-overlapping windows pass; holds without readable
  provider evidence fail closed (`obsolete_hold_unverified`).
- Non-feasible revised offers persist nothing (`offer_not_feasible` with
  the underlying missing items). Audit and receipts are never rewritten.

## Cancellation: local request vs external verification

`requestCancellation` records a **local** request only:

1. Lifecycle → `requested` (module table; the booking `status` is NOT
   touched).
2. Every live approval on the booking is invalidated
   (`invalidateApprovalsForBooking`).
3. Ledger `applyOwnerControl(cancel)` stops due work (waiting rows
   invalidated; claimed work fenced).

`verifyCancellation` flips the booking to `cancelled` only when **all**
conditions verify against the **current** action:

- No pending/uncertain/partial executions (`actions_not_settled`).
- Every succeeded hold has a durably recorded release
  (`release_unverified`, or `release_uncertain` when the delete may have
  applied — reconcile before retrying, never blind-retry). Releases run
  through the injected hold-release port with deterministic keys; **no
  wired port means explicitly blocked, never cancelled, never faked**.
- Deposit/refund: with no payment provider, a deposit implicated by a
  sent offer (configured `depositCents` + any executed step) clears only
  via a booking-scoped, owner-approved allow-exception naming the
  permitting domain policy (`refund_unverified` otherwise). Unknown
  obligations are never waived automatically.
- The binding is re-read after every await: a proposal published
  mid-verify aborts with `STALE_PROPOSAL` before anything cancels.

Responses distinguish `cancellationScope: "local_request"` (still
requested, prior status kept) from `"external_verified"` (cancelled).

## Pause / resume (actual ledger controls)

`pauseBooking` / `resumeBooking` call the real
`CoordinationLedger.applyOwnerControl` (same handle, command id as dedupe
key: ledger first, then the local paused flag, so crashes replay safely)
and set the module lifecycle flag. While paused, approve, retry, prepare,
persist, and confirm refuse with retryable `BOOKING_PAUSED`; already
executed receipts and statuses are never rewritten. Resume on a cancelled
(or cancellation-requested) booking is refused — cancellation is
terminal.

## Narrow shared hooks (Astra note)

To make pause/cancel actually prevent new writes, four pre-existing write
paths gained a 1–3 line `requireBookingWritable` guard plus two error
codes (`BOOKING_PAUSED` retryable 409, `CANCELLATION_REQUESTED` 409):
`approveAndExecute`, `retryFailedSteps`, operator
`persistPreparedProposal`, and delivery `confirmBooking`. Reconcile and
all reads are intentionally ungated. The store gained one method,
`invalidateApprovalsForBooking`. Lifecycle, command-log, and release
tables are module-owned (created by the module, no shared schema edits).

## Runtime integration hook

Routes build `RevisionsDeps` per request: store + booking deps + owner
from the existing runtime, a same-handle `CoordinationLedger`, and **no**
hold-release port until the host bootstrap wires one — every release-gated
verification then fails closed with `release_unverified`. Wiring the port
is the only integration step (constructor injection); no route changes
needed. Route handlers are thin (strict body parse → service → json) and
are covered through the validation parsers plus service tests, because
`next/server` does not execute under the plain-node test harness.
