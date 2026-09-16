# ADR-010: Inquiry-to-offer lifecycle, identity and waiting work

Status: specified — implementation paused
Depends on: ADR-002, ADR-003, ADR-005
Authorization: planning only; explicit owner instruction is required to start implementation.
PRD: 4, 4.1, 5, 8, 9; gates Booking journey, Exact authority, Recovery
Contracts: C02, C04, C05, C06, C07 in [shared contracts](CONTRACTS.md)

## Decision

Complete the existing business-operator/offer/identity/waiting-work composition. This ADR owns fresh inquiry-to-offer, reply ordering, hold lifecycle and takeover; it does not replace existing module algorithms.

## Existing code and scope

Read the source paths below and their module guides before editing. Existing implementations are reusable foundations, not evidence that this ADR is complete. Follow the [execution index](README.md) and shared contracts; references are not competing work orders.

## Owns

- `src/server/business-operator/**`
- `src/offers/**`
- `src/identity/**`
- `src/coordination/**`
- `src/server/operator-runtime/due-work.ts`
- `src/server/operator-runtime/automation.ts`
- `src/server/proactive/**`
- `src/server/booking-service.ts`
- `src/connectors/google/calendar.ts` (hold reuse/replacement and verified availability only)
- `src/connectors/google/hold-release.ts`
- `src/connectors/hold-release.ts`
- `src/domain/**` (additive lifecycle adapters only)
- `src/server/sqlite-store.ts` (required additive fields only)
- `tests/booking-lifecycle*.test.ts` (new)
- `tests/business-operator*.test.ts`
- `tests/golden-path.test.ts`
- `docs/BOOKING_API.md`
- `docs/PROACTIVE_WORK.md`
- `docs/OFFERS.md`

## Must not touch

- Personal `~/.openclaw`, unrelated installations, private SaaS files, credentials or live customer data.
- Paths outside Owns, including other in-flight ADR files. Shared paths require the index's exclusive write lock and predecessor integration; no simultaneous writers.
- Product requirements, acceptance criteria or shared contract semantics. Return a contradiction to Chief with source evidence; do not silently redesign.

## Inputs, outputs and integration

C02 inquiry plus C04 snapshot and scoped availability -> existing OperatorPrepareResult. Persist exact proposals/fingerprints and missing decisions, then C06 intents execute exact approved actions. Waiting ledger emits recommendations; only approved services dispatch effects.

## Implementation steps

1. Qualify missing fields, batch questions and use deterministic offers with explicitly confirmed price/capacity/policy. Resolve identity ambiguities through versioned owner decisions.
2. Implement price-only hold reuse, date/resource replacement with explicit release authority, expiry and cancellation semantics from C06/07.
3. Drain fresh replies before follow-ups; draft one after default deadline; stale sync/pause/reply/opt-out suppresses dispatch. Reconcile before resume.
4. Extend golden harness to three fresh inquiries with zero initial proposals, grounding, exact approval, hold/email, version invalidation and restart partial success. Export owner-facing lifecycle DTOs for ADR-006.

## Failure and recovery

Use the cited contracts' durable, scoped error paths. A capability/credential gate may block real verification without blocking scripted development; name the exact missing evidence. Do not substitute simulated success, relax authority, add a second progression owner or change vendors to make acceptance pass.

## Out of scope

Private hosted SaaS, billing, revenue-recovery strategy and autonomous code deployment. Adjacent subsystems belong to their named ADRs in the index. No merge, external deployment, purchases or submission is authorized here.

## Acceptance

- **010-A01:** 40 guests at the reference $50 rate produces $2,000 with cited policy; missing price/currency/tax assumptions block or ask rather than fabricate.
- **010-A02:** Weak identity hints require decision; replay of exact provider message does not create duplicate booking.
- **010-A03:** Price-only v2 yields no second hold; changed resources require exact replacement approval; confirmed/cancelled state not demoted.
- **010-A04:** Reply before due follow-up suppresses it across restart; pause/takeover/resume preserves external changes and does not refresh stale approvals.
- **010-A05:** Full prepared inquiry-to-offer-to-approved-hold/email golden path now passes, clearly scripted rather than live.
- **010-CHECKS:** `npm test`, `npm run typecheck`, `npm run build` pass; report optional skips honestly. Run the existing golden suite after ADR-002 introduces it; do not claim later release cases before their owning ADR lands. Attach source/command evidence, and rendered evidence for UI changes.

## Completion handoff

Return changed files, local/remote commit IDs, acceptance-ID evidence and remaining blockers to the Orca coordinator. Commit and push the task branch; verify matching remote SHA. Do not self-mark shipped or merge. The coordinator reviews actual artifacts and integrated behaviour, not only the worker summary.
