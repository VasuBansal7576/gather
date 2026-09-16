# ADR-006: Owner workspace and live composition

Status: specified — implementation paused
Depends on: ADR-004, ADR-005, ADR-011, ADR-012
Authorization: planning only; explicit owner instruction is required to start implementation.
PRD: 2.2, 3, 5, 7, 7.1, 8; gates Live mode, Booking journey, UX
Contracts: C01, C02, C03, C04, C05, C06, C07, C08, C10, C11, C12 in [shared contracts](CONTRACTS.md)

## Decision

Wire the completed subsystems into one owner journey and real own-account path. This is integration, not a second place to design runtime provisioning, OAuth or knowledge.

## Existing code and scope

Read the source paths below and their module guides before editing. Existing implementations are reusable foundations, not evidence that this ADR is complete. Follow the [execution index](README.md) and shared contracts; references are not competing work orders.

## Owns

- `app/setup/**`
- `app/api/workspace/route.ts`
- `app/api/bookings/**`
- `app/api/actions/**`
- `app/api/executions/**`
- `app/api/live-model/**`
- `src/host/**`
- `src/components/gather/GatherWorkspace.tsx`
- `src/components/gather/GatherWorkspace.css`
- `src/components/gather/types.ts`
- `src/components/gather/state.ts`
- `src/components/gather/index.ts`
- `src/server/runtime.ts` (composition)
- `src/server/dto.ts`
- `src/server/live-model/**` (compose existing ports)
- `src/integrations/contracts.ts` (new)
- `src/integrations/registry.ts` (new)
- `tests/host-integration.test.ts`
- `tests/live-integration*.test.ts` (new)
- `tests/workspace*.test.ts` (new)
- `docs/UI.md`
- `docs/LIVE_MODEL_RUN.md`

## Must not touch

- Personal `~/.openclaw`, unrelated installations, private SaaS files, credentials or live customer data.
- Paths outside Owns, including other in-flight ADR files. Shared paths require the index's exclusive write lock and predecessor integration; no simultaneous writers.
- Product requirements, acceptance criteria or shared contract semantics. Return a contradiction to Chief with source evidence; do not silently redesign.

## Inputs, outputs and integration

Workspace DTO composes persisted intents, inquiries, knowledge, proposals, receipts, incidents and coverage. Preserve existing DTO adapters or version them with callers. IntegrationProfile port declares provider capabilities, selected mode, credential requirements, intake adapter and proof label; event ADRs return modules consumed by ADR-016 registry wiring.

## Implementation steps

1. Wire Today/Booking/Connections/Business understanding/Recoveries/trend, composer, identity decisions, takeover, exact approval and acceptance/handoff states. No fabricated optimistic completions.
2. Enable Connect your own only after runtime/knowledge/Google capability gates pass for the selected profile. Keep prepared completely independent.
3. Switch long-running action routes and host callers to durable intent progress together; preserve existing service authority and error mapping.
4. Run own-account flow on explicitly authorized test recipients: real inquiry, cited Drive facts, model proposal, owner approval, hold and email with independent provider re-read. Exercise the empty-account path without fixture injection.

## Failure and recovery

Use the cited contracts' durable, scoped error paths. A capability/credential gate may block real verification without blocking scripted development; name the exact missing evidence. Do not substitute simulated success, relax authority, add a second progression owner or change vendors to make acceptance pass.

## Out of scope

Private hosted SaaS, billing, revenue-recovery strategy and autonomous code deployment. Adjacent subsystems belong to their named ADRs in the index. No merge, external deployment, purchases or submission is authorized here.

## Acceptance

- **006-A01:** Every PRD 7.1 prepared step interactive and rendered; keyboard/mobile, loading/empty/partial/error/reconnect checked.
- **006-A02:** Real model invocation and separately re-read Calendar/Gmail effects recorded; fake transport never marked live.
- **006-A03:** Mode switching cannot leak source data/tools; no business data or credentials in client payload beyond required display.
- **006-A04:** Live acceptance email can be sent from a remote customer mailbox; absent authorized accounts leaves live evidence explicitly blocked, not passed.
- **006-CHECKS:** `npm test`, `npm run typecheck`, `npm run build` pass; report optional skips honestly. Run the existing golden suite after ADR-002 introduces it; do not claim later release cases before their owning ADR lands. Attach source/command evidence, and rendered evidence for UI changes.

## Completion handoff

Return changed files, local/remote commit IDs, acceptance-ID evidence and remaining blockers to the Orca coordinator. Commit and push the task branch; verify matching remote SHA. Do not self-mark shipped or merge. The coordinator reviews actual artifacts and integrated behaviour, not only the worker summary.
