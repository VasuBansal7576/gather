# ADR-002: Durable intent envelope and progression ownership

Status: specified — implementation paused
Depends on: ADR-001
Authorization: planning only; explicit owner instruction is required to start implementation.
PRD: 5, 6.1, 8, 9; gates Recovery, Exact authority
Contracts: C02, C06 in [shared contracts](CONTRACTS.md)

## Decision

Compose the existing operator drain, CoordinationLedger and execution claims under one progression owner. Add durable user-visible intents; do not introduce another scheduler or replace verified action receipts.

## Existing code and scope

Read the source paths below and their module guides before editing. Existing implementations are reusable foundations, not evidence that this ADR is complete. Follow the [execution index](README.md) and shared contracts; references are not competing work orders.

## Owns

- `src/intents/**` (new)
- `src/server/sqlite-store.ts` (additive intent schema)
- `src/server/runtime.ts` (runner lifecycle)
- `src/server/operator-runtime/host.ts`
- `src/server/operator-runtime/automation.ts`
- `src/server/proactive/bootstrap.ts`
- `app/api/intents/**` (new)
- `tests/intents*.test.ts` (new)
- `tests/golden-path.test.ts` (new harness)
- `package.json` (golden script only)
- `docs/BOOKING_API.md`
- `docs/PROACTIVE_WORK.md`

## Must not touch

- Personal `~/.openclaw`, unrelated installations, private SaaS files, credentials or live customer data.
- Paths outside Owns, including other in-flight ADR files. Shared paths require the index's exclusive write lock and predecessor integration; no simultaneous writers.
- Product requirements, acceptance criteria or shared contract semantics. Return a contradiction to Chief with source evidence; do not silently redesign.

## Inputs, outputs and integration

C06 enqueue/claim/advance/reconcile/cancel/get ports over existing GatherStore and CoordinationLedger. Additive schema references action rows; no copied receipt authority. Keep synchronous internal service APIs; new intent endpoints return 202 and durable status. ADR-006 wires existing UI routes to these ports.

## Implementation steps

1. Implement stable command dedupe, leases/fencing, execution deadline and restart reconciliation. Own process startup/shutdown in the existing host, not a competing timer.
2. Add intent states including uncertain and cancelled; cancellation/replay preserves accepted/confirmed state and blocks unsent steps after awaits.
3. Bind provider operation identity before dispatch; adopt provider-correlated receipts after crash or leave uncertain. Missing provider search result never licenses a blind retry.
4. Create golden-path harness initially exercising existing approved-action services with explicitly prebuilt regression proposals. Label this scaffold; ADR-010 adds fresh inquiry-to-offer and ADR-016 closes release coverage.

## Failure and recovery

Use the cited contracts' durable, scoped error paths. A capability/credential gate may block real verification without blocking scripted development; name the exact missing evidence. Do not substitute simulated success, relax authority, add a second progression owner or change vendors to make acceptance pass.

## Out of scope

Private hosted SaaS, billing, revenue-recovery strategy and autonomous code deployment. Adjacent subsystems belong to their named ADRs in the index. No merge, external deployment, purchases or submission is authorized here.

## Acceptance

- **002-A01:** Duplicate command returns same intent; mismatched payload with same key conflicts; concurrent claims have one authoritative fenced owner.
- **002-A02:** Kill/restart after hold and before email preserves the hold and resumes only eligible email; crash after remote success before receipt remains uncertain until reconciled.
- **002-A03:** Cancelled/confirmed records retain state on retries; cancellation between awaits blocks next effect.
- **002-A04:** Scaffold golden test runs with simulated providers; explicitly reports that full product journey awaits ADR-010/016.
- **002-CHECKS:** `npm test`, `npm run typecheck`, `npm run build` pass; report optional skips honestly. Run the existing golden suite after ADR-002 introduces it; do not claim later release cases before their owning ADR lands. Attach source/command evidence, and rendered evidence for UI changes.

## Completion handoff

Return changed files, local/remote commit IDs, acceptance-ID evidence and remaining blockers to the Orca coordinator. Commit and push the task branch; verify matching remote SHA. Do not self-mark shipped or merge. The coordinator reviews actual artifacts and integrated behaviour, not only the worker summary.
