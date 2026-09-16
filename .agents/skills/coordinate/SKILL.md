---
name: coordinate
description: Reconcile Gather design and supervise explicitly authorized implementation work.
---

# Coordinate

Read `AGENTS.md`. Feature implementation is currently paused. Do not dispatch paused ADRs, infer delegation from their presence, or resume implementation during repository cleanup.

## Before a feature ADR is accepted

Chief owns this entire preparation stage. Orca is reserved for execution of the reconciled plan, not PRD decomposition or product decision-making. Do not send Orca a request to distribute incomplete requirements among implementation workers.

- Reconcile it with the PRD, actual interfaces and related ADRs.
- Account for every public PRD requirement in an ADR coverage map, including honest empty scans, partial/failed import, judge-testable prepared mode and separately evidenced live effects. Reference guides are not substitute work orders.
- Identify the authoritative state/progression owner, failure behavior, scope, non-goals and observable acceptance evidence.
- Mark unresolved choices as unresolved; do not convert them into invented implementation instructions.
- Include all required file ownership and dependencies. Check overlaps and avoid concurrent writers.
- An ADR is ready only after its design and scope are accepted; ready does not itself authorize execution.

## Explicitly authorized coordination

Use workers only when the owner requests delegation. Give each the approved scope and relevant design context, not only an isolated task list. Respect dependency order and overlapping ownership. Delegation does not remove coordinator responsibility to inspect the diff and actual evidence.

When Orca execution is authorized, use Orca's version-matched orchestration workflow and the configured workers. Do not substitute another orchestration mechanism. Its coordinator may resolve routine implementation details within accepted contracts, but unresolved product decisions or missing dependency contracts return to Chief before the affected work is dispatched. No planning status authorizes a merge or deployment.

## Review and landing

Review source, scope, evidence, CI and remaining gaps. Require real provider receipts for external claims. Run the golden path if it exists; otherwise record its absence, not a fictitious pass. Maintenance does not need feature screenshots or a complete ADR implementation.

Merge only when explicitly authorized and required checks pass on the current head. Verify GitHub's merged state before marking work shipped. Do not automatically revert unrelated work, delete active worktrees or widen scope. Keep unresolved work and concrete blockers visible in the PR; no duplicate status ledger.
