# ADR-015: Nebius and NVIDIA booking-model profile

Status: specified — implementation paused
Depends on: ADR-006
Authorization: planning only; explicit owner instruction is required to start implementation.
PRD: 8.3, 11 Nebius; gates Budgets, Booking journey, Submission
Contracts: C04, C05, C08, C12 in [shared contracts](CONTRACTS.md)

## Decision

Route real booking reasoning through a qualifying Nebius/NVIDIA model configuration while preserving the same tools, knowledge and authority boundary.

## Existing code and scope

Read the source paths below and their module guides before editing. Existing implementations are reusable foundations, not evidence that this ADR is complete. Follow the [execution index](README.md) and shared contracts; references are not competing work orders.

## Owns

- `src/integrations/nebius/**` (new)
- `tests/nebius-model*.test.ts` (new)
- `docs/NEBIUS.md` (new)

## Must not touch

- Personal `~/.openclaw`, unrelated installations, private SaaS files, credentials or live customer data.
- Paths outside Owns, including other in-flight ADR files. Shared paths require the index's exclusive write lock and predecessor integration; no simultaneous writers.
- Product requirements, acceptance criteria or shared contract semantics. Return a contradiction to Chief with source evidence; do not silently redesign.

## Inputs, outputs and integration

IntegrationProfile supplies explicit provider endpoint/model configuration through ADR-009 RuntimeControl; no standalone second agent runtime. Map token usage/reservations/errors to C08. ADR-016 wires registry and selected profile.

## Implementation steps

1. Verify current official provider model identity, NVIDIA provenance and qualifying endpoint before live call; record exact model and profile. No made-up model slug or silent fallback.
2. Use authorized key/credits, enforce run/token/tool/deadline budgets, and preserve existing commercial tool allowlist.
3. Capture actual reasoning on a booking task and provider receipt/usage without secrets; disabled profile sends nothing.

## Failure and recovery

Use the cited contracts' durable, scoped error paths. A capability/credential gate may block real verification without blocking scripted development; name the exact missing evidence. Do not substitute simulated success, relax authority, add a second progression owner or change vendors to make acceptance pass.

## Out of scope

Private hosted SaaS, billing, revenue-recovery strategy and autonomous code deployment. Adjacent subsystems belong to their named ADRs in the index. No merge, external deployment, purchases or submission is authorized here.

## Acceptance

- **015-A01:** Qualifying Nebius runtime call with required NVIDIA model produces a grounded booking proposal through existing boundaries.
- **015-A02:** Provider failure does not fall back silently; unsupported bounded usage disables live capped execution.
- **015-A03:** Injection, tool-limit and token-budget scenarios enforce same rules; evidence distinguishes real provider from scripted tests.
- **015-CHECKS:** `npm test`, `npm run typecheck`, `npm run build` pass; report optional skips honestly. Run the existing golden suite after ADR-002 introduces it; do not claim later release cases before their owning ADR lands. Attach source/command evidence, and rendered evidence for UI changes.

## Completion handoff

Return changed files, local/remote commit IDs, acceptance-ID evidence and remaining blockers to the Orca coordinator. Commit and push the task branch; verify matching remote SHA. Do not self-mark shipped or merge. The coordinator reviews actual artifacts and integrated behaviour, not only the worker summary.
