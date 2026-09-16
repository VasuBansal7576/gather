# ADR-013: AssemblyAI voice intake profile

Status: specified — implementation paused
Depends on: ADR-006
Authorization: planning only; explicit owner instruction is required to start implementation.
PRD: 3.1, 8, 11 AssemblyAI; gates Submission, External-content boundary
Contracts: C02, C05, C08, C12 in [shared contracts](CONTRACTS.md)

## Decision

Add AssemblyAI transcription as a source adapter feeding the same inquiry engine. Do not build a second voice-specific booking agent.

## Existing code and scope

Read the source paths below and their module guides before editing. Existing implementations are reusable foundations, not evidence that this ADR is complete. Follow the [execution index](README.md) and shared contracts; references are not competing work orders.

## Owns

- `src/integrations/assemblyai/**` (new)
- `app/api/voice/**` (new)
- `src/components/gather/voice/**` (new)
- `tests/assemblyai*.test.ts` (new)
- `tests/fixtures/assemblyai/**` (new)
- `docs/ASSEMBLYAI.md` (new)

## Must not touch

- Personal `~/.openclaw`, unrelated installations, private SaaS files, credentials or live customer data.
- Paths outside Owns, including other in-flight ADR files. Shared paths require the index's exclusive write lock and predecessor integration; no simultaneous writers.
- Product requirements, acceptance criteria or shared contract semantics. Return a contradiction to Chief with source evidence; do not silently redesign.

## Inputs, outputs and integration

Authorized bounded audio upload/recording + source identity -> transcription provenance/confidence -> C02 intake. Export an IntegrationProfile from the ADR-006 contract; ADR-016 owns central registry/UI mount.

## Implementation steps

1. Use maintained provider HTTP API via existing fetch patterns; bounded audio size/duration, timeout, cancellation and no automatic unrelated uploads.
2. Show transcription and uncertainty for clarification; audio/transcript instructions cannot grant commercial authority. Dedupe retries with source identity.
3. Require explicit profile/credentials; disabled profile makes zero requests. Produce actual transcription receipt plus downstream booking outcome for event proof.

## Failure and recovery

Use the cited contracts' durable, scoped error paths. A capability/credential gate may block real verification without blocking scripted development; name the exact missing evidence. Do not substitute simulated success, relax authority, add a second progression owner or change vendors to make acceptance pass.

## Out of scope

Private hosted SaaS, billing, revenue-recovery strategy and autonomous code deployment. Adjacent subsystems belong to their named ADRs in the index. No merge, external deployment, purchases or submission is authorized here.

## Acceptance

- **013-A01:** Actual supplied recording transcribed using AssemblyAI and feeds the same qualified booking; not a prerecorded text substitution.
- **013-A02:** Uncertain date/guest transcription asks instead of silently booking; injection cannot bypass approvals.
- **013-A03:** Upload limits, provider failure/retry/dedupe and disabled-profile no-network tests pass; source/privacy label visible.
- **013-CHECKS:** `npm test`, `npm run typecheck`, `npm run build` pass; report optional skips honestly. Run the existing golden suite after ADR-002 introduces it; do not claim later release cases before their owning ADR lands. Attach source/command evidence, and rendered evidence for UI changes.

## Completion handoff

Return changed files, local/remote commit IDs, acceptance-ID evidence and remaining blockers to the Orca coordinator. Commit and push the task branch; verify matching remote SHA. Do not self-mark shipped or merge. The coordinator reviews actual artifacts and integrated behaviour, not only the worker summary.
