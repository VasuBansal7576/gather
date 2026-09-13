# Proactive waiting-work ledger

Owner: coordination worker. Files owned: `src/coordination/**`,
`tests/coordination*.test.ts`, this document. Shared domain, server,
SQLite store, API, UI, and packaging files are untouched.

## What it is

`CoordinationLedger` (`src/coordination/ledger.ts`, contracts in
`src/coordination/contracts.ts`, re-exported from `src/coordination/index.ts`)
is booking-specific durable event intake plus a persistent waiting-work
ledger. It binds to an **injected existing SQLite connection** — e.g.
`new CoordinationLedger(gatherStore.db, { sharedTables: "auto" })` — and
creates only its own `coord_events` / `coord_waiting` / `coord_control`
tables in the **same** database. There is no second database, scheduler,
daemon, or swarm: OpenClaw owns scheduling/watches, and the host runtime
owns the drain loop.

The ledger never sends externally and never forges approvals. It produces
ready work/decisions (`WaitingItem` with `recommendedAction`,
`requiresApproval: true`, `requiresFreshCheck: true`) for guarded Gather
services to act on. A ledger token alone prevents no external duplication:
services must use stable operation keys and reconcile uncertain outcomes
before retry; the token only fences which worker may resolve ledger rows.

## Authority model (read this before wiring)

`ingestEvent` treats **everything as evidence** and can never honor control
or retire deposit reminders, no matter what `sourceKind` or payload it
carries. A provider body claiming `sourceKind: "manual"`, an `authorizedBy`
value, or `verifiedReceipt: true` with a locator is recorded and answered
with an owner decision — never honored. Authority flows only through two
separate host-owned methods whose caller (the host, not the event) is the
attestation:

```ts
ledger.applyOwnerControl({   // pause | resume | cancel, host-attested
  dedupeKey: "ctrl:<stable-id>",   // stable across retries
  kind: "pause",
  bookingId: "<booking id>",
  attestedBy: "<owner identity>",
  note?: "...",
  observedAt?: "<ISO-8601>",
});

ledger.recordVerifiedReceipt({  // trusted verifier only
  dedupeKey: "receipt:<stable-id>",
  bookingId: "<booking id>",
  receiptLocator: "<authoritative locator>",
  verifiedBy: "<trusted verifier identity>",
  note?: "...",
  observedAt?: "<ISO-8601>",
});
```

The host must load `attestedBy`/`verifiedBy` from persisted
owner-confirmed state (approval records, verified operator identity) —
never from model output, customer text, or provider payloads. Unknown
inputs cannot mint authority: there is no parameter combination on
`ingestEvent` that honors control.

## Interface contract

```ts
import { CoordinationLedger } from "./src/coordination/index.ts";
const ledger = new CoordinationLedger(gatherStore.db); // same DB, own coord_* tables

ledger.ingestEvent({       // idempotent intake; safe to retry
  dedupeKey: "email:<message-id>" | "cal:<event-id>:<rev>" | ...,
  kind: "inquiry" | "reply" | "change" | "payment_signal" | "resource_signal" | "pause" | "resume" | "cancel",
  bookingId: "<booking id>",
  sourceId: "<provider-stable id>",
  sourceKind: "email" | "calendar" | "payment" | "manual" | ...,
  observedAt: "<ISO-8601 source timestamp>",
  revision: 3,             // optional per-booking ordering
  payload: { ...evidence }, // never authority
});

ledger.listDueWork({ nowIso, limit?, bookingId? }); // pending + due, drain-guarded
ledger.claimDueWork({ ids, claimedBy, nowIso, leaseMs? }); // atomic rechecks + fencing token
ledger.releaseStaleClaims({ nowIso }); // recover expired claims to pending
ledger.resolveWaiting({ id, resolution: "done" | "suppressed" | "invalidated", note?, claimToken? });
ledger.listWaitingForBooking(bookingId);
ledger.controlStateForBooking(bookingId); // active | paused | cancelled
ledger.getEventByDedupeKey(bookingId, dedupeKey);
```

All public inputs are validated at the unknown boundary (`assertValid*`);
there is no `any` in the module. All timestamps are normalized to canonical
UTC for storage and compared as epoch millis, so caller clock shapes
(`Z` vs `+02:00`) never change drain, lease, or suppression semantics.

## Semantics

- **Idempotency with conflict detection:** `(booking_id, dedupe_key)` is
  unique per booking/source scope. Exact redelivery returns
  `{ duplicate: true }` with no side effects, so restarts and redeliveries
  collapse safely. Reusing a key with *different* content (different source,
  timestamps, or payload) throws a conflict instead of silently colliding.
  The same provider key may serve two bookings as separate rows. Pre-scoped
  databases (global-unique keys) are migrated automatically with data
  preserved. Attested calls (`applyOwnerControl`, `recordVerifiedReceipt`)
  compare stable identity excluding `observedAt` (which defaults to intake
  time), so retries never conflict with themselves.
- **Stale revisions:** intake tracks the max non-stale revision per booking.
  An event with a lower revision is stored with `stale: true` and causes no
  side effects. A `change` with an equal or higher revision supersedes prior
  pending or claimed `change_review` items (equal revisions must not fork
  duplicate owner decisions) and raises a fresh one. Late replies older than
  the latest processed reply are likewise stale.
- **Reply-before-followup, received-order aware:** a received non-stale
  reply suppresses pending and claimed followups regardless of source-clock
  skew in `observedAt` — receipt order decides, and `received_at` is always
  consulted. Stale historic replies are respected (stored stale, no side
  effects). The host must still recheck for newer replies immediately before
  any send (`requiresFreshCheck`).
- **Claim-time rechecks:** `claimDueWork` revalidates every id inside the
  claim transaction — still pending, still due, booking not paused or
  cancelled (ledger control state plus shared state), no newer revision, no
  reply received since the item was created. A stale snapshot alone can never
  hand out obsolete work; replies found at claim time suppress, superseded
  reviews invalidate.
- **Claim leases and fencing:** each claim issues an opaque `claimToken`
  with a lease expiry (default 5 minutes, configurable per claim).
  Resolving claimed work requires the matching token; resolving pending
  work with any token throws, so a stale token can never silently close a
  released claim. `releaseStaleClaims` returns expired, unresolved claims to
  `pending` for recovery.
- **Persisted control state:** `applyOwnerControl` records pause/cancel in
  `coord_control`, durable across restarts. `pause` moves pending items to
  `paused` (drain-hidden) and invalidates claimed items so their tokens die
  with the obsolete work; new inquiries raised while paused enter as
  `paused` and stay hidden until `resume`. Trusted `cancel` is terminal
  (resume is refused) and invalidates pending, paused, and claimed items.
  Intake-time `pause`/`resume`/`cancel` events are never honored and always
  raise a `change_review` owner decision instead.
- **Shared-state guards with declared mode:** the drain and claim paths
  additionally hide work when the shared `bookings` row is `cancelled` or
  its `businesses` row is `paused`. Constructor option `sharedTables`
  declares the integration: `"auto"` (default) reads shared tables when
  present and treats absent tables as the supported standalone contract;
  `"required"` throws when they are absent or unreadable (integration
  guard); `"off"` never reads them. Unexpected query failures are
  rethrown (fail-closed) instead of leaking guarded work — except the
  explicit absent-tables standalone case.
- **Evidence, not authority:** `payment_signal` message text claiming
  payment always creates a pending `deposit_check` with
  `detail.verifiedPayment: false` and
  `recommendedAction: verify_deposit_against_authoritative_receipt`. Only
  `recordVerifiedReceipt` with a trusted verifier and receipt locator
  retires the followup — and even then the deposit is recorded as
  unverified evidence for the confirmation worker (G12), never counted as
  paid.

## Verified (module scope only)

`tests/coordination.ledger.test.ts` — 28 tests against real temporary
SQLite files: restart survival across close/reopen (including persisted
control state), duplicate collapse, scoped per-booking dedupe keys, legacy
schema migration with data preserved, dedupe-content conflicts,
reply-before-due suppression, skewed-clock suppression, late/stale
revisions, equal-revision supersede, attested pause/resume/cancel (plus
resume-after-cancel refusal and redelivery idempotency), forged
control-as-nothing, forged receipt booleans retiring nothing, trusted
receipt recording and redelivery, new-inquiries-while-paused hidden,
claimed-work fencing on pause, stale-token-after-release rejection,
offset-clock drain/release semantics, shared-table modes (off/required/
fail-closed/standalone), paused-business and cancelled-booking drain
exclusion, payment-as-evidence-only, single-winner claims, claim-time
reply/revision rechecks, claim expiry/release with token fencing, and
boundary validation. These are module tests; they do **not** establish
integration acceptance, and the ledger token alone guarantees nothing
about external duplication.

## Wiring that remains (not claimed)

1. OpenClaw watch loop calling `ingestEvent` for new/changed provider
   state, with stable `dedupeKey` and `sourceId` derivation per connector,
   namespaced per booking. `sourceKind` and payloads are untrusted labels.
2. Owner-experience control callbacks into `applyOwnerControl` with the
   persisted owner identity, and verifier callbacks into
   `recordVerifiedReceipt` — never provider text.
3. Host drain loop calling `listDueWork` / `claimDueWork`, then routing
   claimed items to guarded Gather services (availability recheck, offer
   drafting, approval-gated sends, deposit-receipt verification) using
   stable operation keys with reconciliation of uncertain outcomes.
4. Guarded-service callbacks into `resolveWaiting` after acting; services
   must recheck pause/cancel/revision/reply immediately before any external
   effect, since in-flight ledger rows never block a send by themselves.
5. Owner-experience surfacing of pending/due/paused/suppressed work, and
   monitoring-failure visibility. No UI was changed here.
