# ADR-008: Supported native knowledge adapter and selection gate

Status: specified — implementation paused
Depends on: ADR-007, ADR-009
Authorization: planning only; explicit owner instruction is required to start implementation.
PRD: 4, 4.2, 4.3, 8.5; gates Native knowledge selection, Knowledge lifecycle
Contracts: C03, C04, C08 in [shared contracts](CONTRACTS.md)

## Decision

Implement the thin KnowledgePort using documented OpenClaw recall/wiki extension points, with an explicit scripted prepared implementation. Prove native semantics before live authority cutover.

## Existing code and scope

Read the source paths below and their module guides before editing. Existing implementations are reusable foundations, not evidence that this ADR is complete. Follow the [execution index](README.md) and shared contracts; references are not competing work orders.

## Owns

- `src/runtime/knowledge.ts` (new)
- `src/knowledge/port.ts` (new)
- `src/knowledge/native.ts` (new)
- `src/knowledge/prepared.ts` (new)
- `src/knowledge/migration.ts` (new)
- `src/runtime/config.ts` (knowledge capability allowlist only)
- `tests/native-knowledge*.test.ts` (new)
- `docs/BUSINESS_KNOWLEDGE.md`
- `docs/KNOWLEDGE_EXTRACTION.md`

## Must not touch

- Personal `~/.openclaw`, unrelated installations, private SaaS files, credentials or live customer data.
- Paths outside Owns, including other in-flight ADR files. Shared paths require the index's exclusive write lock and predecessor integration; no simultaneous writers.
- Product requirements, acceptance criteria or shared contract semantics. Return a contradiction to Chief with source evidence; do not silently redesign.

## Inputs, outputs and integration

C04 KnowledgePort is stable for ADR-005/010. Translate supported upstream capability schemas in src/runtime/knowledge.ts only. Source version and trusted owner-confirmation metadata gate all commercial snapshots; internal wiki mutations do not mint authority.

## Implementation steps

1. Discover/document supported capability mapping on the exact ADR-009 pinned manifest. Do not invent an ingest/delete RPC or inspect private runtime databases.
2. Implement source import/version/invalidation through supported extension points and verify compiled/searchable state catches up. Block while stale.
3. Run C04 native gate with fictional isolated data and real runtime; prepared implementation has separate labelled contract tests.
4. Export existing confirmed facts through the existing service; compare migration output and atomically activate live port only after gate passes. Preserve rollback backup, no dual-writer policy store.

## Failure and recovery

Use the cited contracts' durable, scoped error paths. A capability/credential gate may block real verification without blocking scripted development; name the exact missing evidence. Do not substitute simulated success, relax authority, add a second progression owner or change vendors to make acceptance pass.

## Out of scope

Private hosted SaaS, billing, revenue-recovery strategy and autonomous code deployment. Adjacent subsystems belong to their named ADRs in the index. No merge, external deployment, purchases or submission is authorized here.

## Acceptance

- **008-A01:** All C04 native cases pass across restart with provenance and no cross-business retrieval.
- **008-A02:** Deleted source cannot authorize through stale compiled memory; unavailable runtime is unavailable, not empty.
- **008-A03:** Model/source text cannot confirm commercial facts; correct exception precedence and conflicting-current-policy block demonstrated.
- **008-A04:** Capability absence produces precise blocked evidence and leaves live disabled; no silent second knowledge vendor or destructive migration.
- **008-CHECKS:** `npm test`, `npm run typecheck`, `npm run build` pass; report optional skips honestly. Run the existing golden suite after ADR-002 introduces it; do not claim later release cases before their owning ADR lands. Attach source/command evidence, and rendered evidence for UI changes.

## Completion handoff

Return changed files, local/remote commit IDs, acceptance-ID evidence and remaining blockers to the Orca coordinator. Commit and push the task branch; verify matching remote SHA. Do not self-mark shipped or merge. The coordinator reviews actual artifacts and integrated behaviour, not only the worker summary.
