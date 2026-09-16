# ADR-009: Isolated runtime lifecycle and enforceable budgets

Status: specified — implementation paused
Depends on: ADR-001
Authorization: planning only; explicit owner instruction is required to start implementation.
PRD: 8.1, 8.2, 8.3; gates Local runtime, Runtime lifecycle, Budgets, Isolation
Contracts: C01, C08 in [shared contracts](CONTRACTS.md)

## Decision

Extend the existing isolated OpenClaw boundary into provision/readiness/run-budget/restart support. Publish RuntimeControl before knowledge and recovery consume it.

## Existing code and scope

Read the source paths below and their module guides before editing. Existing implementations are reusable foundations, not evidence that this ADR is complete. Follow the [execution index](README.md) and shared contracts; references are not competing work orders.

## Owns

- `src/runtime/**` (except later ADR-008 knowledge.ts)
- `src/server/budget.ts` (new)
- `scripts/gather-runtime-manifest.json` (new)
- `tests/runtime*.test.ts`
- `tests/budget*.test.ts` (new)
- `docs/OPENCLAW.md`
- `docs/MODEL_CONFIG.md`

## Must not touch

- Personal `~/.openclaw`, unrelated installations, private SaaS files, credentials or live customer data.
- Paths outside Owns, including other in-flight ADR files. Shared paths require the index's exclusive write lock and predecessor integration; no simultaneous writers.
- Product requirements, acceptance criteria or shared contract semantics. Return a contradiction to Chief with source evidence; do not silently redesign.

## Inputs, outputs and integration

C08 RuntimeControl wraps existing process/client/tasks/MCP. Model selection is explicit and capability-validated; manifest pins runtime/client/plugin versions. Provision is live-only. Tool and token budgets are checked at trusted dispatch boundaries and passed to downstream adapters.

## Implementation steps

1. Record exact compatible release pins and package integrity before provisioning, validate Node/platform and useful protocol readiness, never latest/global/personal installation.
2. Implement supported local-user login/key flow with isolated secrets; do not claim unsupported subscription models.
3. Enforce persistent per-call/run/day reservations, tool count and real execution deadline. Separate wait timeout from stop and confirm actual exit/cancellation.
4. Backup only consistent compatible state; restore with fenced runs and external-reconciliation requirement. Export safe repair controls, not shell access.

## Failure and recovery

Use the cited contracts' durable, scoped error paths. A capability/credential gate may block real verification without blocking scripted development; name the exact missing evidence. Do not substitute simulated success, relax authority, add a second progression owner or change vendors to make acceptance pass.

## Out of scope

Private hosted SaaS, billing, revenue-recovery strategy and autonomous code deployment. Adjacent subsystems belong to their named ADRs in the index. No merge, external deployment, purchases or submission is authorized here.

## Acceptance

- **009-A01:** Fresh isolated provision/restart and useful read on Linux/macOS; no personal path reads/writes, channels or inherited credentials.
- **009-A02:** 16th tool call denied; next call exceeding token reservation denied; five-minute deadline fences tools despite wait timeout; restart preserves budget usage.
- **009-A03:** Unknown/cancelled run cannot relaunch as duplicate; unobserved process exit stays blocked and resources owned.
- **009-A04:** Known-good backup/restore checks schema/version and does not replay external effects; secrets never enter tracked files or diagnostics.
- **009-CHECKS:** `npm test`, `npm run typecheck`, `npm run build` pass; report optional skips honestly. Run the existing golden suite after ADR-002 introduces it; do not claim later release cases before their owning ADR lands. Attach source/command evidence, and rendered evidence for UI changes.

## Completion handoff

Return changed files, local/remote commit IDs, acceptance-ID evidence and remaining blockers to the Orca coordinator. Commit and push the task branch; verify matching remote SHA. Do not self-mark shipped or merge. The coordinator reviews actual artifacts and integrated behaviour, not only the worker summary.
