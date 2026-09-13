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
ledger.claimDueWork({ ids, claimedBy, nowIso });    // BEGIN IMMEDIATE; losers get skippedIds
ledger.resolveWaiting({ id, resolution: "done" | "suppressed" | "invalidated", note? });
ledger.listWaitingForBooking(bookingId);
```

All public inputs are validated at the unknown boundary (`assertValid*`);
there is no `any` in the module.

## Semantics

- **Idempotency:** `dedupeKey` is unique. Re-ingest returns
  `{ duplicate: true }` with no side effects, so restarts and redeliveries
  collapse safely.
- **Stale revisions:** intake tracks the max non-stale revision per booking.
  An event with a lower revision is stored with `stale: true` and causes no
  side effects. A `change` with a higher revision invalidates prior pending
  `change_review` items and raises a fresh one.
- **Reply-before-followup:** a `reply` suppresses pending `followup` items
  created before the reply's `observedAt`, so an answered inquiry never gets
  an inappropriate reminder. The host must still recheck for newer replies
  immediately before any send (`requiresFreshCheck`).
- **Pause / cancel:** `pause` moves pending items to `paused` (drain-hidden);
  `resume` restores them; `cancel` invalidates pending and paused items. The
  drain additionally hides work when the shared `bookings` row is
  `cancelled` or its `businesses` row is `paused` (read-only; tolerant of a
  bare connection without those tables).
- **Evidence, not authority:** `payment_signal` (e.g. a customer writing
  "we already paid") creates a `deposit_check` with
  `detail.verifiedPayment: false` and
  `recommendedAction: verify_deposit_against_authoritative_receipt`. Message
  text alone never verifies payment, availability, or approval.
- **Concurrency:** `claimDueWork` flips only rows still `pending` inside
  `BEGIN IMMEDIATE`; a racing duplicate worker receives those ids in
  `skippedIds`.

## Verified (module scope only)

`tests/coordination.ledger.test.ts` — 9 tests against real temporary
SQLite files: restart survival across close/reopen, duplicate collapse,
reply-before-due suppression, late/stale revisions plus superseding
changes, pause/resume/cancel, paused-business and cancelled-booking drain
exclusion, payment-as-evidence-only, single-winner claims, and boundary
validation. These are module tests; they do **not** establish integration
acceptance.

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
