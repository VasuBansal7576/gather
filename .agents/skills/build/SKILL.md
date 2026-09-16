---
name: build
description: Make the authorized Gather change without expanding product scope.
---

# Build

Read `AGENTS.md` first. Feature work is paused unless explicitly resumed by the owner. A documentation, CI or test-harness cleanup is not permission to implement the ADR backlog.

## Maintenance

- Correct claims against source. Separate intended behavior, existing code, tests and live evidence.
- Repair reproduced defects in existing application behavior as well as build/test reproducibility. Add focused regression evidence; preserve intended contracts and never weaken assertions. Do not implement missing product capabilities under the label of repair.
- Preserve existing contracts, data and unrelated settings. Do not delete modules because their names overlap.
- Use fictional versioned fixtures, not local account data or shared `/tmp` inputs.
- Repository-owned skill files can be corrected as ordinary source when requested; do not change installed/global skills.

## Authorized feature work (only after the pause is lifted)

- Read the accepted ADR and the PRD sections it cites. Stay inside the reviewed scope.
- Routes parse and validate inputs, call services and map responses. Services own business behavior; stores own SQL.
- Use `unknown` and narrowing at boundaries. Do not weaken deterministic authority, price, scope or recipient checks.
- Preserve comments explaining contracts, simulation labels, and operator-specific `GATHER_*` configuration.
- Extend the golden path if it exists and the behavior changes; never invent a passing golden-path claim.

## Before proving

Run `npm run typecheck`, `npm test` and `npm run build`. Report failures and skips accurately. New product behavior needs user-visible evidence; docs/config changes need source and command evidence, not screenshots of unchanged UI.
