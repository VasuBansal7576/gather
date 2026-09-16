# ADR-005: Business understanding, corrections and regression UX

Status: specified — implementation paused
Depends on: ADR-003, ADR-008
Authorization: planning only; explicit owner instruction is required to start implementation.
PRD: 4, 4.1, 4.2, 4.3, 7; gates Understanding, Knowledge lifecycle, Evaluation
Contracts: C04, C05, C10 in [shared contracts](CONTRACTS.md)

## Decision

Compose the verified KnowledgePort into owner review/correction flows and per-business regression evaluation. Do not invent another memory engine or claim causal business improvement from a score.

## Existing code and scope

Read the source paths below and their module guides before editing. Existing implementations are reusable foundations, not evidence that this ADR is complete. Follow the [execution index](README.md) and shared contracts; references are not competing work orders.

## Owns

- `src/knowledge/**` (application service/port consumers, preserve ADR-008 adapter contract)
- `src/evals/**` (new)
- `app/api/knowledge/**`
- `app/api/evals/**` (new)
- `src/components/gather/knowledge/**` (new)
- `src/components/gather/evals/**` (new)
- `evaluation/knowledge/**`
- `tests/knowledge-rules*.test.ts` (new)
- `tests/evals*.test.ts` (new)

## Must not touch

- Personal `~/.openclaw`, unrelated installations, private SaaS files, credentials or live customer data.
- Paths outside Owns, including other in-flight ADR files. Shared paths require the index's exclusive write lock and predecessor integration; no simultaneous writers.
- Product requirements, acceptance criteria or shared contract semantics. Return a contradiction to Chief with source evidence; do not silently redesign.

## Inputs, outputs and integration

Owner-confirmed typed candidates/corrections -> versioned scoped facts and affected-pending-work events. Queries/snapshots come from ADR-008 KnowledgePort. UI components are exported for ADR-006 composition; no common host file edits.

## Implementation steps

1. Show sources, uncertainty, candidate/current/historical distinction and missing information. Batch-confirm inspected document claims; plain language owner rules show parsed scope before confirmation.
2. On correction, publish changed-policy event to affected pending offers; retain accepted snapshots. No automatic exception promotion.
3. Use confirmed expectations for regression cases. Compare the same versioned case set, record denominators and show unchanged/worse results honestly.
4. Show no-facts separately from unavailable/stale index. Concession policy UI uses C05 explicit scope/limit and never grants standing send authority.

## Failure and recovery

Use the cited contracts' durable, scoped error paths. A capability/credential gate may block real verification without blocking scripted development; name the exact missing evidence. Do not substitute simulated success, relax authority, add a second progression owner or change vendors to make acceptance pass.

## Out of scope

Private hosted SaaS, billing, revenue-recovery strategy and autonomous code deployment. Adjacent subsystems belong to their named ADRs in the index. No merge, external deployment, purchases or submission is authorized here.

## Acceptance

- **005-A01:** Changed price affects pending offers only; customer exception cannot affect another customer; source deletion blocks dependent work.
- **005-A02:** Unconfirmed/model-injected rule cannot become policy; owner parsing ambiguity asks clarification; duplicate correction idempotent.
- **005-A03:** Same-case-set before/after run is reproducible; added cases cannot masquerade as score improvement.
- **005-A04:** Rendered rule confirmation, evidence review, empty/error and scoped concession form work with keyboard/mobile.
- **005-CHECKS:** `npm test`, `npm run typecheck`, `npm run build` pass; report optional skips honestly. Run the existing golden suite after ADR-002 introduces it; do not claim later release cases before their owning ADR lands. Attach source/command evidence, and rendered evidence for UI changes.

## Completion handoff

Return changed files, local/remote commit IDs, acceptance-ID evidence and remaining blockers to the Orca coordinator. Commit and push the task branch; verify matching remote SHA. Do not self-mark shipped or merge. The coordinator reviews actual artifacts and integrated behaviour, not only the worker summary.
