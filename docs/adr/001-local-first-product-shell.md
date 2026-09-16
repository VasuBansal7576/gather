# ADR-001: Local-first shell and prepared business

Status: specified — implementation paused
Depends on: none
Authorization: planning only; explicit owner instruction is required to start implementation.
PRD: 1, 2, 2.1, 2.2, 7, 7.1; gates Local run, First run, Prepared business, Isolation
Contracts: C01, C10 in [shared contracts](CONTRACTS.md)

## Decision

Reuse setup and fixture initialization, but separate the existing two-proposal regression seed from a new inquiry-first product fixture. Deliver the packaged local entry and safe mode/reset boundaries without implementing booking intelligence.

## Existing code and scope

Read the source paths below and their module guides before editing. Existing implementations are reusable foundations, not evidence that this ADR is complete. Follow the [execution index](README.md) and shared contracts; references are not competing work orders.

## Owns

- `package.json`
- `package-lock.json`
- `scripts/gather-cli.mjs` (new)
- `scripts/gather-start.mjs`
- `scripts/gather-doctor.mjs`
- `app/setup/**`
- `app/page.tsx`
- `app/layout.tsx`
- `app/globals.css`
- `src/setup/**`
- `src/server/demo-fixtures.ts`
- `src/server/runtime.ts` (mode/path selection only)
- `app/api/demo/init/route.ts`
- `app/api/setup/**`
- `tests/cli*.test.ts` (new)
- `tests/setup*.test.ts`
- `tests/fixtures/prepared/**` (new)
- `README.md`

## Must not touch

- Personal `~/.openclaw`, unrelated installations, private SaaS files, credentials or live customer data.
- Paths outside Owns, including other in-flight ADR files. Shared paths require the index's exclusive write lock and predecessor integration; no simultaneous writers.
- Product requirements, acceptance criteria or shared contract semantics. Return a contradiction to Chief with source evidence; do not silently redesign.

## Inputs, outputs and integration

Installation root + selected mode -> validated state paths, single-business store and fixture scenario. Preserve legacy seed exports/callers; expose a separate product-scenario selector rather than silently changing regression data. /api/demo/init remains compatible for existing clients.

## Implementation steps

1. Implement C01 package staging, process lock, free loopback port, --port/--no-open and browser launch with printable URL fallback. npm start remains a developer entry and must not recursively invoke itself.
2. Implement two first-run choices; live remains disabled until ADR-006 passes. Preserve no-credential prepared entry and persistent simulation badge.
3. Implement inquiry-first and honest-absence fixtures, idempotent seed and safe reset. Protect explicit custom databases and live state. Existing data migration is an explicit backed-up copy with refusal for ambiguous multi-business stores.
4. Keep runnable README claims behind actual artifact verification. No video or installation-success claim from a source-tree build alone.

## Failure and recovery

Use the cited contracts' durable, scoped error paths. A capability/credential gate may block real verification without blocking scripted development; name the exact missing evidence. Do not substitute simulated success, relax authority, add a second progression owner or change vendors to make acceptance pass.

## Out of scope

Private hosted SaaS, billing, revenue-recovery strategy and autonomous code deployment. Adjacent subsystems belong to their named ADRs in the index. No merge, external deployment, purchases or submission is authorized here.

## Acceptance

- **001-A01:** Packed artifact invoked from a fresh writable directory on Linux/macOS reaches prepared setup without credentials/OpenClaw; show state location and package contents.
- **001-A02:** Six product inbox messages, two busy blocks, zero product offers before preparation; legacy regression fixture still passes. Empty/non-event/partial/error scenarios selectable.
- **001-A03:** Reset refuses live/custom/symlink escape and active foreign process; original legacy DB remains intact; repeated seed/reset produces documented state.
- **001-A04:** Two mode roots cannot access each other; second business creation denied; mobile/desktop first-run and keyboard flow evidenced.
- **001-CHECKS:** `npm test`, `npm run typecheck`, `npm run build` pass; report optional skips honestly. Run the existing golden suite after ADR-002 introduces it; do not claim later release cases before their owning ADR lands. Attach source/command evidence, and rendered evidence for UI changes.

## Completion handoff

Return changed files, local/remote commit IDs, acceptance-ID evidence and remaining blockers to the Orca coordinator. Commit and push the task branch; verify matching remote SHA. Do not self-mark shipped or merge. The coordinator reviews actual artifacts and integrated behaviour, not only the worker summary.
