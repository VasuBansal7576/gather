# Gather build ownership

## Authority

The working hierarchy is owner, Chief supervisor, Gather orchestrator, and execution workers.
Chief monitors the build, resolves escalations, and reports to the owner.
The Gather orchestrator owns the dependency graph, ready queue, worker dispatch, verified handoffs, independent review, integration, and tested milestone pushes.
Orca's current Run, Task, and Dispatch records are the authority for task state.
Public repository documentation must not contain private account addresses, terminal handles, or dispatch capabilities.

## Model and access constraints

| Role | Authorized model |
| --- | --- |
| Orchestration, reasoning, and review | Astra |
| OpenCode Go execution | `muse-spark-1.3-contributor` |
| Devin execution | SWE-2 |
| Codex CLI execution | `gpt-5.6-luna` |

Codex execution uses only the owner's explicitly authorized Orca-managed account.
Verify the active account through metadata before launch, without opening credential files or falling back to the system account.
Verify effective models through runtime metadata or the actual agent interface rather than launch arguments alone.
Use existing authorized allowances, with no purchases, overages, cloud handoffs, or blanket unsafe permission mode.
Gather-specific project trust and routine reversible project work are authorized.

## Work allocation

Dispatch as much useful independent work as runtime and subscription limits support.
Use separate write worktrees when independent writers could conflict.
Keep one main-branch integration owner and preserve all unrelated commits and uncommitted work.
Specify file ownership, invariants, observable acceptance, and dependency contracts before workers start.
Send verified contract artifacts to dependent workers promptly; an unverified worker summary is not a completed dependency.
Reuse settled workers when useful, with explicit ownership transfer.
Do not duplicate or interrupt an existing worker because its output has not arrived.

## Current dependency sequence

1. Develop durable booking approval and execution services alongside owner approval and recovery interactions.
2. Hand off their verified API and UI contracts to an integration worker that connects the actual local workspace.
3. Review the combined implementation independently and reproduce the owner journey and failure cases.
4. Integrate reviewed commits, run the relevant checks, update evidence, and push a coherent milestone.

Supported OpenClaw interface research proceeds independently of the local workflow implementation.
The runtime adapter depends on that research establishing a supported interface and isolation contract.
Live provider verification depends on authorized test-account access and individual reconciliation receipts.
Authentication gaps must not block unrelated ready work.

## Verification and handover

Test observable behavior at the highest practical boundary.
Exercise stale approvals, duplicate events, unavailable dates, uncertain timeouts, partial success, restart waiting states, reply-before-follow-up, revoked access, and prompt injection.
Inspect rendered UI at desktop and narrow widths, including loading, empty, error, recovery, and accessible interaction states.
Keep mocks, deterministic simulations, real local runtime execution, and live provider outcomes distinct.
Do not interpret the local application checklist as whole-product acceptance.

Each handover records the exact commit, file ownership, test commands and results, unresolved defects, and next dependency.
Before orchestrator cutover, the outgoing owner becomes quiescent and Chief explicitly transfers authority.
Preserve current workers and commits during the transfer.
Read the installed Orca references before taking over a Run or adopting a terminal.
Each child Dispatch needs an accepted outcome and an explicit reuse, retention, or release decision before the parent reports completion.

## Reporting

Keep [PROGRESS.md](PROGRESS.md) current with bounded commitments and acceptance evidence.
Send Chief the active nested run, worker ownership, dependency map, concrete blockers, and verified results through Orca.
Push coherent reviewed and tested milestones as they become ready.
A local simulation milestone is progress toward [PRD.md](PRD.md), and does not prove live product readiness.
