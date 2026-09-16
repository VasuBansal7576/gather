# ADR-004: Bounded incident diagnosis and verified repair

Status: specified — implementation paused
Depends on: ADR-002, ADR-007, ADR-009, ADR-010
Authorization: planning only; explicit owner instruction is required to start implementation.
PRD: 6, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 8.2; gates Recovery, Self-healing
Contracts: C06, C08, C09, C10 in [shared contracts](CONTRACTS.md)

## Decision

Use a supervisor outside the booking agent, an explicit repair catalog and separately verified continuation. Consume implemented runtime/sync/progression ports; do not depend on the later live-composition ADR.

## Existing code and scope

Read the source paths below and their module guides before editing. Existing implementations are reusable foundations, not evidence that this ADR is complete. Follow the [execution index](README.md) and shared contracts; references are not competing work orders.

## Owns

- `src/incidents/**` (new)
- `src/server/sqlite-store.ts` (additive incidents schema)
- `src/server/operator-runtime/health.ts`
- `src/server/operator-runtime/due-work.ts` (incident emission only)
- `app/api/incidents/**` (new)
- `app/api/faults/**` (new)
- `src/components/gather/recoveries/**` (new)
- `tests/incidents*.test.ts` (new)
- `tests/faults*.test.ts` (new)

## Must not touch

- Personal `~/.openclaw`, unrelated installations, private SaaS files, credentials or live customer data.
- Paths outside Owns, including other in-flight ADR files. Shared paths require the index's exclusive write lock and predecessor integration; no simultaneous writers.
- Product requirements, acceptance criteria or shared contract semantics. Return a contradiction to Chief with source evidence; do not silently redesign.

## Inputs, outputs and integration

Intent failure / health / deadletter -> scoped incident + attempts. Catalog methods use C09 preconditions and verification. RuntimeControl from ADR-009 and source port from ADR-007 are dependencies; prepared adapters are scripted, not real restart proof.

## Implementation steps

1. Deduplicate incidents by affected operation/resource and signature. Persist symptom, diagnosis, selected action, verification, resumed intent and remaining impact.
2. Known signatures use deterministic repair; unknown diagnosis is budgeted, read-only, validates catalog choice, and blocks on unavailable/invalid model output.
3. Implement all C09 catalog entries without arbitrary shell/provider/authority access. Maximum three attempts; unchanged permanent denial may stop earlier.
4. Provide prepared fault API and recovery components; real process tests explicitly opt in. Code-defect branch produces isolated reproduction, proposed patch and failing regression artifact without applying it.

## Failure and recovery

Use the cited contracts' durable, scoped error paths. A capability/credential gate may block real verification without blocking scripted development; name the exact missing evidence. Do not substitute simulated success, relax authority, add a second progression owner or change vendors to make acceptance pass.

## Out of scope

Private hosted SaaS, billing, revenue-recovery strategy and autonomous code deployment. Adjacent subsystems belong to their named ADRs in the index. No merge, external deployment, purchases or submission is authorized here.

## Acceptance

- **004-A01:** Each catalog action has precondition/verification tests, including denied wrong-resource operations and unknown action IDs.
- **004-A02:** Hold-success/email-failure recovers with one hold; repeated transient failure exhausts three attempts; permanent rejection and revoked consent remain honestly blocked.
- **004-A03:** Real isolated process stop/restart verifies useful read and resumed work separately from scripted fixture evidence.
- **004-A04:** Unknown diagnosis cannot invoke arbitrary tools, spend beyond budget or claim recovery from command success. Code patch proposal never changes running source.
- **004-CHECKS:** `npm test`, `npm run typecheck`, `npm run build` pass; report optional skips honestly. Run the existing golden suite after ADR-002 introduces it; do not claim later release cases before their owning ADR lands. Attach source/command evidence, and rendered evidence for UI changes.

## Completion handoff

Return changed files, local/remote commit IDs, acceptance-ID evidence and remaining blockers to the Orca coordinator. Commit and push the task branch; verify matching remote SHA. Do not self-mark shipped or merge. The coordinator reviews actual artifacts and integrated behaviour, not only the worker summary.
