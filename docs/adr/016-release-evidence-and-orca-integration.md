# ADR-016: Integrated release proof and submission profiles

Status: specified — implementation paused
Depends on: ADR-006, ADR-013, ADR-014, ADR-015
Authorization: planning only; explicit owner instruction is required to start implementation.
PRD: 1–11; every section-10 gate and section-11 event profile
Contracts: C01, C02, C03, C04, C05, C06, C07, C08, C09, C10, C11, C12 in [shared contracts](CONTRACTS.md)

## Decision

Integrate the three independently developed event adapters and prove the complete release. This ADR owns final evidence, not permission to paper over failed subsystems or publish a submission.

## Existing code and scope

Read the source paths below and their module guides before editing. Existing implementations are reusable foundations, not evidence that this ADR is complete. Follow the [execution index](README.md) and shared contracts; references are not competing work orders.

## Owns

- `src/integrations/registry.ts`
- `src/host/GatherHostWorkspace.tsx` (profile mounts only)
- `app/setup/**` (profile selection only)
- `tests/golden-path.test.ts`
- `tests/release*.test.ts` (new)
- `scripts/gather-doctor.mjs` (release capability report)
- `.github/workflows/**`
- `package.json`
- `package-lock.json`
- `README.md`
- `docs/LOCAL_SETUP.md`
- `docs/RELEASE_EVIDENCE.md` (new, proof index not progress ledger)
- `docs/HACKATHON_PRD.md` (event factual verification only)

## Must not touch

- Personal `~/.openclaw`, unrelated installations, private SaaS files, credentials or live customer data.
- Paths outside Owns, including other in-flight ADR files. Shared paths require the index's exclusive write lock and predecessor integration; no simultaneous writers.
- Product requirements, acceptance criteria or shared contract semantics. Return a contradiction to Chief with source evidence; do not silently redesign.

## Inputs, outputs and integration

Completed ADR outputs + selected profile -> packaged artifact, full journey evidence and gate-by-gate report at one commit SHA. New dependency requests from adapters are reviewed/integrated here; adapters should prefer existing fetch/SDK interfaces.

## Implementation steps

1. Register profile exports explicitly and ensure only selected enabled adapter receives data. Test base and each event independently.
2. Run full prepared sequence including empty/partial/error and fault paths, acceptance, confirmation/handoff, policy corrections and same-case-set eval.
3. Run opt-in native and authorized live proofs separately; record missing external access as a release blocker, not a skipped pass.
4. Recheck official event rules/baseline/reuse/license, capture real demo only after success, and keep video under applicable limit. No automatic publish, registration, deployment or submission.
5. Update README only with demonstrated commands/capabilities; retain limitation labels. Update CI for deterministic checks only, without live secrets.

## Failure and recovery

Use the cited contracts' durable, scoped error paths. A capability/credential gate may block real verification without blocking scripted development; name the exact missing evidence. Do not substitute simulated success, relax authority, add a second progression owner or change vendors to make acceptance pass.

## Out of scope

Private hosted SaaS, billing, revenue-recovery strategy and autonomous code deployment. Adjacent subsystems belong to their named ADRs in the index. No merge, external deployment, purchases or submission is authorized here.

## Acceptance

- **016-A01:** Every coverage-map row has an artifact at the final commit or a named blocker; no unowned/implicitly waived gate.
- **016-A02:** Fresh packed distribution works on Linux/macOS, Node baseline, with clean prepared state and no personal runtime access.
- **016-A03:** Each event adapter is actually exercised on its qualifying task, with exact profile and separate evidence; disabled adapters make no calls.
- **016-A04:** End-to-end live and prepared results, recovery, acceptance and handoff match persisted/provider state. No fabricated demo URL or implementation claim.
- **016-CHECKS:** `npm test`, `npm run typecheck`, `npm run build` pass; report optional skips honestly. Run the existing golden suite after ADR-002 introduces it; do not claim later release cases before their owning ADR lands. Attach source/command evidence, and rendered evidence for UI changes.

## Completion handoff

Return changed files, local/remote commit IDs, acceptance-ID evidence and remaining blockers to the Orca coordinator. Commit and push the task branch; verify matching remote SHA. Do not self-mark shipped or merge. The coordinator reviews actual artifacts and integrated behaviour, not only the worker summary.
