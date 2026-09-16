---
name: coordinate
description: Reconcile Gather design and supervise explicitly authorized implementation work.
---

# Coordinate

Read `AGENTS.md`. Feature implementation is currently paused. Do not dispatch paused ADRs, infer delegation from their presence, or resume implementation during repository cleanup.

## Before a feature ADR is accepted

- Reconcile it with the PRD, actual interfaces and related ADRs.
- Identify the authoritative state/progression owner, failure behavior, scope, non-goals and observable acceptance evidence.
- Mark unresolved choices as unresolved; do not convert them into invented implementation instructions.
- Include all required file ownership and dependencies. Check overlaps and avoid concurrent writers.
- An ADR is ready only after its design and scope are accepted; ready does not itself authorize execution.

## Explicitly authorized coordination

Use workers only when the owner requests delegation. Give each the approved scope and relevant design context, not only an isolated task list. Respect dependency order and overlapping ownership. Delegation does not remove coordinator responsibility to inspect the diff and actual evidence.

## Review and landing

Review source, scope, evidence, CI and remaining gaps. Require real provider receipts for external claims. Run the golden path if it exists; otherwise record its absence, not a fictitious pass. Maintenance does not need feature screenshots or a complete ADR implementation.

Merge only when explicitly authorized and required checks pass on the current head. Verify GitHub's merged state before marking work shipped. Do not automatically revert unrelated work, delete active worktrees or widen scope. Keep unresolved work and concrete blockers visible in the PR; no duplicate status ledger.
