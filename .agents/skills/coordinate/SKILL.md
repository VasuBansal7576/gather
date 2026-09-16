---
name: coordinate
description: Integrator role. Write ADRs from the PRD, dispatch one worker per ADR in Orca, review evidence against the ADR's acceptance list, merge in dependency order, keep the golden path green. Use only as the integrator.
---

# Coordinate

One integrator owns `main` and the end-to-end journey. Workers own ADRs.

## Writing an ADR

Copy `docs/adr/000-template.md`. An ADR is ready when a worker can finish it without asking a question: Decision, PRD sections, Owns, Must not touch, Do, Don't, Out of scope, Acceptance (each item provable by an artifact). Set `Status: ready`. Number contiguously.

## Dispatching

- One worker per ADR, in Orca, each in its own worktree (the worker runs `isolate`).
- Prompt the worker with: the ADR path, "follow AGENTS.md and the skills", nothing else. Do not paste the PRD.
- Respect `Depends on`. Do not dispatch an ADR whose dependency is not merged.
- Never two workers on ADRs with overlapping **Owns**.

## Reviewing a PR

Reject without reading code if the evidence table is missing or has missing rows. Otherwise check, in order:

1. Every Acceptance item has an artifact that actually shows it.
2. Simulated vs real is stated and matches the artifacts.
3. Files changed are within **Owns**. Anything else is either justified in the PR or rejected.
4. `tests/golden-path.test.ts` passes on the branch merged with current `main` (run it yourself).
5. No new prompt-only enforcement; no personal identifiers; nothing under `.runtime/` committed.

## Merging

Squash-merge in dependency order. After each merge: run the golden path on `main`, set the ADR `Status: shipped` with the merge commit, delete the branch. If the golden path breaks, revert immediately, then investigate.

## Boundaries

Do not fix a worker's PR yourself; return it with the failing item. Do not widen an ADR mid-flight; write a new one. Do not keep a status ledger; the ADR statuses and merged PRs are the record.
