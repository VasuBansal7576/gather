---
name: prove
description: Capture before/after evidence at the user-visible level for an ADR: screenshots, HTTP transcripts, test output, receipts. Use after build, before ship.
---

# Prove

A worker saying "it works" is not evidence. Tests alone are not evidence of user-visible behavior. Produce artifacts a reviewer can inspect without running anything.

## Required artifacts (put them in `.evidence/adr-<NNN>/`, attach to the PR, never commit them)

1. **Before**: what the app did on `origin/main` for the scenario your ADR changes. A screenshot, an HTTP transcript (`curl -i`), or a failing test run. If the feature did not exist, a screenshot showing its absence.
2. **After**: the same scenario on your branch. Same viewport, same route, same inputs.
3. **The ADR's Acceptance list, item by item**, each with the artifact that proves it. Missing items are listed as missing, not omitted.
4. **Suite**: `npm test`, `npm run typecheck`, `npm run build` output from your worktree, plus `tests/golden-path.test.ts` passing if it exists.

## How to capture

- Start the app on a fresh database: `GATHER_DATABASE_PATH=.runtime/adr-<NNN>.sqlite npm run build && npm run start -- --hostname 127.0.0.1 --port <free port>`.
- Screenshots at 1440x900 and 390x844 for any UI change. Show the full route, including labels such as "simulated".
- HTTP transcripts must show request and response including status codes; redact nothing except tokens.
- For anything involving the model or a provider, state plainly whether the artifact came from a simulated connector, a scripted transport, or a real external call. Never blur that line.
- Restart the server once and re-check anything that claims persistence.

## Not allowed

- Editing acceptance criteria to match what you built.
- Claiming an external outcome (email sent, hold created) from a tool return value. Only a re-read receipt counts.
- Screenshots of code or terminals as proof of UI behavior.
