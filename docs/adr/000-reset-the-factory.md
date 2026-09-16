# ADR-000: Reset the factory

Status: shipped (see the commit that adds this file)
Depends on: none
PRD: 8.4 (design before implementation), 10 (Submission gate)

## Decision
Remove hand-maintained status ledgers and personal identifiers from the repository, license it MIT, and install the agent workflow (AGENTS.md, five skills, ADR template) so that all further work happens as one ADR per worker per worktree per PR with evidence.

## What was done
- Deleted `docs/PROGRESS.md`, `docs/BUILD_PLAN.md`, `docs/ORCHESTRATION.md`, `docs/DEPENDENCIES.md`; stripped status and "remaining work" prose from `docs/LIVE_MODEL_RUN.md`, `docs/PROACTIVE_WORK.md`, `docs/DELIVERY_READINESS.md`.
- Replaced hardcoded personal OAuth profile ids, emails and the test recipient with `GATHER_MODEL_PROFILE_ID`, `GATHER_MODEL_EMAIL`, `GATHER_TEST_RECIPIENT`, `GATHER_OPENCLAW_BIN` (undeliverable or absent defaults).
- Added `LICENSE` (MIT), set `license` in `package.json`, removed `private`.
- Deleted stale remote branches; rewrote history so the former private PRD is not present in any commit.
- Added `AGENTS.md`, `.agents/skills/{isolate,build,prove,ship,coordinate}/SKILL.md`, `docs/adr/000-template.md`, `.evidence/` to `.gitignore`.

## Rules that now hold
- No status documents. Progress is merged PRs and ADR statuses.
- No personal identifiers in tracked files.
- Every change after this commit arrives through an ADR and a PR with an evidence table.
