---
name: build
description: Implement one ADR with readable service-layer code, tests that assert observable behavior, and no scope beyond the ADR. Use after isolate.
---

# Build

Read the ADR fully. Read only the PRD sections it cites. Then:

## Structure

- Route handlers (`app/api/**`) parse, validate with zod at the boundary, call one service, and map the result to a DTO. No business logic in routes.
- Services (`src/server/**`, `src/<domain>/**`) own the why and when. They are pure TypeScript with explicit types at their public surface and are testable without HTTP.
- Stores own SQL. A service never writes SQL inline.
- Anything that must hold regardless of what the model says (price floor, recipient allowlist, scope gate, approval binding) is a plain function with unit tests, called from the service before any provider or runtime call.
- `unknown` plus narrowing at boundaries; no `any`; no helpers that exist only to hide a cast.
- Comments explain contracts and non-obvious constraints, not what the code obviously does. Do not delete existing comments.

## Behavior

- Extend `tests/golden-path.test.ts` if your ADR adds a step to the journey. Never weaken an existing assertion to make a change pass.
- Simulated connectors and fixtures stay labeled `simulated` in names, DTOs and UI copy.
- New operator-specific values are read from `GATHER_*` env with an undeliverable or disabled default, never a real account or address.
- Keep the change to the files the ADR **Owns**. Note anything you wanted to change elsewhere in the PR under "Follow-ups".

## Before moving to prove

`npm run typecheck && npm test && npm run build` all pass in your worktree.
