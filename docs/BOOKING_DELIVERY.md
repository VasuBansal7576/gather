# Booking Delivery: Guarded Confirmation and Operational Handoff

Status: implemented module, fixture-verified. The wired runtime uses the
demo calendar adapter, so real-venue confirmation is **unavailable** — a
simulated provider can never mint live provenance, and `liveReady`
requires every cited source reference to be non-fictional.

## What this adds

A delivery layer on top of the reviewed `src/delivery` evaluator
(e626000) and the existing booking/approval pipeline:

- `src/server/booking-delivery/store.ts` — `DeliveryStore`: delivery
  tables on the same `GatherStore` SQLite handle (same file, same
  durability), no shared-store edits.
- `src/server/booking-delivery/verifiers.ts` — `StoreDeliveryVerifiers`
  (host-injected trusted resolver boundary over persisted evidence + the
  injected calendar provider reader) and `CollectingVerifiers` (records
  every fetch so the commit can revalidate).
- `src/server/booking-delivery/service.ts` — `readinessForBooking`
  (read-only), `confirmBooking` (guarded, idempotent, atomic),
  `handoffForBooking` (revised operational handoff).
- Routes:
  - `GET  /api/bookings/[bookingId]/readiness` — read-only evaluation
  - `POST /api/bookings/[bookingId]/confirm` — guarded transition
  - `GET  /api/bookings/[bookingId]/handoff` — read-only handoff view;
    reports the latest persisted revision, never creates one
  - `POST /api/bookings/[bookingId]/handoff` — explicit build command;
    persists a new numbered revision

## Persisted, attributable evidence

All trusted-resolver evidence is persisted host-side with business
scope and source references — never accepted from request payloads:

| Table | Contents | Binding |
| --- | --- | --- |
| `delivery_policies` | Confirmation conditions per business | `business_id` |
| `delivery_acceptance` | Customer acceptance / revocation | business + booking + version + fingerprint |
| `delivery_deposit_receipts` | Payment ledger snapshots (incl. refunds) | business + booking + receipt |
| `delivery_resource_commitments` | committed/revoked/expired resource records | business + booking + version + fingerprint + resource |
| `delivery_waivers` | Owner waivers for optional conditions | business + booking + version + fingerprint + owner |
| `delivery_decisions` | Every evaluated confirm decision | booking + action + version + fingerprint |
| `delivery_confirm_commands` | Idempotent command log | `confirm_key` + request hash |
| `delivery_handoffs` | Numbered handoff revisions | action + revision |

## The confirm guard

`POST .../confirm` takes `{ proposedActionId, proposalVersion,
proposalFingerprint, confirmKey }` only. In order:

1. **Exact binding** — the action must belong to the booking and carry
   exactly the asserted version + fingerprint, else `STALE_PROPOSAL`.
2. **Authority** — a live exact-version owner approval must exist
   (invalidated/superseded approvals refuse).
3. **Command reservation** — `confirm_key` dedupes the operation: same
   key + same request hash replays the persisted response canonically;
   same key + different hash conflicts (non-retryable); a live
   in-progress command reports retryable concurrency; an expired
   in-progress claim is reclaimable (crash recovery).
4. **Fresh proofs** — `evaluateBookingReadiness` runs through
   `CollectingVerifiers`: policy, acceptance, deposit receipts,
   availability (via the injected provider reader), resource
   commitments, and waivers are host-fetched and business/booking
   scoped.
5. **Atomic commit** — inside one `BEGIN IMMEDIATE` transaction (never
   spanning awaited provider calls):
   - re-reads the binding (booking status, action version/fingerprint/
     status, live approval) — any drift throws `STALE_PROPOSAL` and
     rolls back;
   - re-runs every store-backed fetch synchronously — any evidence
     drift throws retryable `CONFLICT` and rolls back;
   - re-checks the durable hold-conflict set for the payload window —
     a window claimed mid-flight refuses with `SLOT_UNAVAILABLE`;
   - when the decision can confirm, requires a `succeeded` execution
     under the canonical operation key for every declared step of the
     exact approved version — for `create_provisional_hold`, the hold
     AND the email (`holdOperationKey`/`emailOperationKey`). Missing,
     versionless, superseded-version, `pending`, `partial`,
     `uncertain`, or `failed` steps refuse with `CONFLICT` (retryable
     while a step is still in flight) and roll the command back;
   - persists the evaluated decision bound to the action/version/
     fingerprint and finishes the command row, atomically with the
     booking transition.
6. **Transition** — `bookings.status = 'confirmed'` only when the
   decision is `ready` AND `liveReady` (all cited evidence
   non-fictional) AND every required step execution succeeded.
   Otherwise the command is persisted `blocked` with
   the full decision — a hold alone, a payment link, missing evidence,
   or demo provenance never confirms.

Every response derives `demo` from the evaluated decision's provenance:
`true` unless all cited evidence is live. A live-ready confirmation is
never mislabeled demo, and a blocked demo-evidence command never claims
live readiness.

## Handoff

`GET .../handoff` is read-only: it evaluates fresh through the verifier
boundary (a persisted decision is never reused — its availability
evidence could be stale) and reports a revision number only when the
freshly evaluated view is byte-identical to the latest persisted
revision; otherwise `revision` is `null` and the view is an explicit
unpersisted preview, never paired with an old revision number.
`POST .../handoff` is the explicit build command that persists a new
numbered revision.

Both paths re-read the exact binding (action identity, version,
fingerprint, live approval, booking snapshot) after every awaited
evaluation and — for POST — transactionally before persist. Anything that
moved mid-flight (approval invalidated, new proposal or action, booking
paused or cancelled, evidence changed) turns the call explicitly
`blocked` with nothing built or persisted: an older view is never
inserted under a newer action, and `ready` never claims an obsolete
approval or status.

Both paths report `state`:

- `ready` — a live approval exists for the exact current version, the
  fresh decision is `ready` + `liveReady`, and the booking is
  `confirmed`.
- `preliminary` — the approval is live but the booking is not yet
  confirmed, readiness is blocked, or provenance is not live; `reason`
  says which.
- `blocked` — no live approval for the current version, or evaluation
  could not run (e.g. no persisted policy); `handoff` is `null` and
  `reason` is explicit. A blocked build persists nothing.

Services, responsibilities, timings, and outstanding items come only
from the accepted payload + decision evidence — nothing is invented.

## Provenance separation

Fixture proof vs real receipt verification is carried by
`SourceReference.fictional` end to end: the availability verifier
inherits the provider adapter's declared `simulated` flag, and
`liveReady` requires zero fictional refs among cited evidence.
The default runtime wires the demo calendar adapter, so its
attestations are fictional and `confirm` will report `blocked` — the
guarded path is exercised in tests with injected live-marked fakes.

An expired in-progress confirm command is reclaimable only once: the
reclaim is a conditional update on `updated_at`, and a caller whose
update matched zero rows (a competing reclaimer committed first) is
re-classified against the winner's row — `conflict`, `in_progress`, or
`replay` — never `owned`.

## Verified

- `tests/booking-delivery.test.ts` — 22 tests: live confirm +
  persisted decision, canonical replay, key conflict and in-progress
  concurrency, stale version + invalidated approval, fixture
  provenance block, missing/revoked/refunded evidence, hold-alone
  block, fail-closed drift revalidation, handoff state + read-only
  GET + numbered POST revisions, unapproved handoff block,
  mid-await handoff drift fence (approval invalidation, proposal
  replacement, brand-new action, booking cancel, evidence change),
  revision/content pairing on GET, restart
  persistence, read-only readiness + cancelled booking, required
  hold/email execution gate (missing/incomplete/superseded-version
  steps), and single-claim lease reclaim.
- `npm run typecheck` clean; `npm run build` compiles all routes.

## Left for live integration

- Real provider adapters behind `CalendarAvailabilityReader` (and any
  deposit-ledger / resource-registry ingestion) must feed the delivery
  tables and availability boundary before live confirmations exist.
- `readiness`/`handoff` GETs and `confirm` POST are local-owner,
  same-origin only; no external customer communication is sent.
