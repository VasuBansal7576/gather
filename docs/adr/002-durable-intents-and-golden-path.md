# ADR-002: Durable intents and the golden path

Status: ready
Depends on: ADR-000
PRD: 5, 6.1, 9, 10 (Booking journey, Exact authority, Recovery gates)

## Decision
Every consequential user action is persisted as an intent before any work starts, progresses through an explicit state machine, and the UI renders progress from that record. One end-to-end test (`tests/golden-path.test.ts`) exercises the prepared business from inquiry to offer to approval to hold and email receipts, through a price change that invalidates approval, and through a process restart that resumes without duplicating any receipt. Every later PR must keep it green.

## Owns
- New `src/intents/**` (contracts, store, service, state machine)
- `src/server/sqlite-store.ts` (new `intents` table and migration only)
- `app/api/intents/**` (new), and the existing action routes under `app/api/bookings/**`, `app/api/actions/**`, `app/api/executions/**` to wrap their work in intents
- `src/host/**` (progress rendering from intents)
- `tests/golden-path.test.ts` (new), `tests/intents*.test.ts` (new)

## Must not touch
- `src/runtime/**`, `src/connectors/google/**`, `src/server/connections/**`
- Offer pricing logic in `src/offers/**`; approval binding logic in `src/server/booking-service.ts` beyond calling it from an intent

## Do
- Intent record: `id, businessId, kind (prepare_offer | approve | execute | reset | inject_fault | reconnect), input (json), state, steps (json array of {name, state, receiptId?, error?}), createdAt, updatedAt, resumeToken`. States: `queued -> running -> (completed | failed | blocked)`, with `failed` resumable and `blocked` terminal until an operator acts.
- Write the intent row in the same transaction that the HTTP handler commits before returning `202 {intentId}`. Handlers never do the work inline.
- A single in-process runner picks `queued`/resumable intents, executes step by step, persists each step's receipt id before starting the next, and is idempotent on restart: a step with a persisted receipt is skipped, never re-executed.
- `GET /api/intents/:id` returns the state machine; the workspace polls it and renders per-step progress and the final receipts. Replace any fire-and-forget button behavior with this.
- Golden path test, running against a temp SQLite file and the simulated connectors, in this order and with these assertions:
  1. seed prepared business; three inquiries exist, zero bookings-with-proposals.
  2. `prepare_offer` intent for inquiry A completes; proposal has price, date, evidence references.
  3. `approve` intent binds to proposal version 1; `execute` intent yields two distinct receipts (hold, email), each with its own external id.
  4. change the proposal price; assert approval for version 1 is now `invalidated` and `execute` on version 1 is rejected with 409.
  5. approve version 2; execute; assert two new receipts and the original hold receipt unchanged and not duplicated.
  6. simulate crash after hold and before email on a third booking; restart the runner on the same database; assert the email step completes and exactly one hold receipt exists.
  7. attempt approval of proposal from booking X against booking Y; assert rejected.
- Add `npm run golden` that runs only this test.

## Don't
- Don't put the runner on a timer that overlaps with itself; one runner, claim with a lease.
- Don't store receipts inside the intent; reference existing `ActionExecution` records.
- Don't make the UI infer progress from HTTP response timing or optimistic state.
- Don't weaken any existing test to accommodate the new flow; adapt the flow.
- Don't add a queue library. The existing SQLite store and a lease column are sufficient for a single local process.

## Out of scope
Incident creation from failed intents (ADR-004). Owner-visible repair thread (ADR-004). Real provider calls (ADR-006).

## Acceptance
- `npm run golden` passes; full output attached.
- HTTP transcript: `POST .../prepare` returns 202 with `intentId`; `GET /api/intents/:id` shows `queued`, then `running` with step states, then `completed` with receipt ids.
- Screenshot of the workspace showing per-step progress for an in-flight intent, and the two separate receipts afterwards.
- Kill the server mid-execution (transcript with timestamps), restart, `GET /api/intents/:id` shows completion; SQL count of hold receipts for that booking is 1.
- Price change screenshot: version 1 approval labeled invalidated, version 2 awaiting approval.
- `npm test`, `npm run typecheck`, `npm run build` pass.
