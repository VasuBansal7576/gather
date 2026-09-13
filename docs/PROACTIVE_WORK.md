# Proactive waiting-work ledger

Owner: coordination worker. Files owned: `src/coordination/**`,
`tests/coordination*.test.ts`, this document. Shared domain, server,
SQLite store, API, UI, and packaging files are untouched.

## What it is

`CoordinationLedger` (`src/coordination/ledger.ts`, contracts in
`src/coordination/contracts.ts`, re-exported from `src/coordination/index.ts`)
is booking-specific durable event intake plus a persistent waiting-work
ledger. It binds to an **injected existing SQLite connection** — e.g.
`new CoordinationLedger(gatherStore.db)` — and creates only its own
`coord_events` / `coord_waiting` tables in the **same** database. There is
no second database, scheduler, daemon, or swarm: OpenClaw owns
scheduling/watches, and the host runtime owns the drain loop.

The ledger never sends externally and never forges approvals. It produces
ready work/decisions (`WaitingItem` with `recommendedAction`,
`requiresApproval: true`, `requiresFreshCheck: true`) for guarded Gather
services to act on.

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
```

All public inputs are validated at the unknown boundary (`assertValid*`);
there is no `any` in the module.

## Semantics

- **Idempotency with conflict detection:** `dedupeKey` is unique per
  booking/source scope. Exact redelivery returns `{ duplicate: true }` with
  no side effects, so restarts and redeliveries collapse safely. Reusing a
  key with *different* content (different booking, source, timestamps, or
  payload) throws a conflict instead of silently colliding.
- **Stale revisions:** intake tracks the max non-stale revision per booking.
  An event with a lower revision is stored with `stale: true` and causes no
  side effects. A `change` with a higher revision invalidates prior pending
  `change_review` items and raises a fresh one. Late replies older than the
  latest processed reply are likewise stale. Ordering follows received
  (monotonic insert) order plus revisions — observed timestamps are
  preserved as evidence but never decide ordering alone.
- **Reply-before-followup:** a `reply` suppresses pending `followup` items
  created before the reply's `observedAt`, so an answered inquiry never gets
  an inappropriate reminder. The host must still recheck for newer replies
  immediately before any send (`requiresFreshCheck`).
- **Claim-time rechecks:** `claimDueWork` revalidates every id inside the
  claim transaction — still pending, still due, booking not paused or
  cancelled, no newer revision, no reply arrived since the drain snapshot.
  A stale snapshot alone can never hand out obsolete work; replies found at
  claim time suppress, superseded reviews invalidate.
- **Claim leases and fencing:** each claim issues an opaque `claimToken`
  with a lease expiry (default 5 minutes, configurable per claim).
  `resolveWaiting` on claimed work requires the matching token, so a stale
  worker cannot complete another worker's claim and duplicate an external
  effect after uncertainty. `releaseStaleClaims` returns expired,
  unresolved claims to `pending` for recovery.
- **Control authority:** `pause`/`resume`/`cancel` are honored only from
  trusted owner controls (`sourceKind` manual/owner plus an explicit
  `payload.authorizedBy` owner identity) and reported via `controlHonored`.
  Customer or provider messages requesting control are recorded but honored
  as nothing: they raise a `change_review` owner decision instead.
  `pause` moves pending items to `paused` (drain-hidden); `resume` restores
  them; trusted `cancel` invalidates pending and paused items. The drain
  additionally hides work when the shared `bookings` row is `cancelled` or
  its `businesses` row is `paused` (read-only; tolerant of a bare
  connection without those tables).
- **Evidence, not authority:** `payment_signal` message text claiming
  payment creates a pending `deposit_check` with
  `detail.verifiedPayment: false` and
  `recommendedAction: verify_deposit_against_authoritative_receipt`. Only
  receipt evidence with `verifiedReceipt: true` plus a receipt locator from
  a payment-provider or trusted owner/manual source retires the followup —
  and even then the deposit is recorded as unverified evidence for the
  confirmation worker (G12), never counted as paid.

## Verified (module scope only)

`tests/coordination.ledger.test.ts` — 17 tests against real temporary
SQLite files: restart survival across close/reopen, duplicate collapse,
dedupe-content conflicts, reply-before-due suppression, late/stale
revisions plus superseding changes, trusted pause/resume/cancel,
untrusted control-as-decision, paused-business and cancelled-booking drain
exclusion, payment-as-evidence-only, verified-receipt followup retirement,
single-winner claims, claim-time reply/revision rechecks, claim
expiry/release with token fencing, and boundary validation. These are
module tests; they do **not** establish integration acceptance.

## Wiring that remains (not claimed)

1. OpenClaw watch loop calling `ingestEvent` for new/changed provider
   state, with stable `dedupeKey` and `sourceId` derivation per connector.
2. Host drain loop calling `listDueWork` / `claimDueWork`, then routing
   claimed items to guarded Gather services (availability recheck, offer
   drafting, approval-gated sends, deposit-receipt verification).
3. Guarded-service callbacks into `resolveWaiting` after acting, plus
   reconciliation of uncertain external outcomes before retry.
4. Owner-experience surfacing of pending/due/paused/suppressed work, and
   monitoring-failure visibility. No UI was changed here.
