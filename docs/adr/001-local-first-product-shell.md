# ADR-001: Local-first product shell

Status: ready
Depends on: ADR-000
PRD: 2, 2.1, 2.2, 7, 7.1, 10 (Local run gate, UX gate, Submission gate)

## Decision
Gather is distributed as a local-first app started with one command. `npx github:VasuBansal7576/gather` (and `npm start` from a clone) boots the prepared business with Node only: no keys, no OpenClaw install, no network provider. The first screen offers "Try the prepared business" and "Connect your own" (the latter gated by ADR-006). All judge-testable behavior in this build runs in the prepared business with visibly simulated connectors.

## Owns
- `package.json` (`bin`, `scripts.start`, `files`), `scripts/gather-start.mjs`, `scripts/gather-doctor.mjs`, new `scripts/gather-cli.mjs`
- `app/setup/**`, `app/page.tsx`, `app/layout.tsx`, `app/globals.css`
- `src/setup/**`
- `src/server/demo-fixtures.ts` (seed content only; keep exported IDs stable)
- `README.md`
- `tests/setup*.test.ts`, `tests/cli*.test.ts`

## Must not touch
- `src/runtime/**`, `src/server/connections/**`, `src/server/live-model/**`, `src/connectors/google/**`
- `~/.openclaw` or any path outside the repo and its `.runtime/`

## Do
- Add `"bin": { "gather": "scripts/gather-cli.mjs" }`. The CLI: verify Node >= 22, create `.runtime/`, run the doctor, `next build` if `.next/` is missing, start on `127.0.0.1` with a free port, print the URL, open the browser (`open`/`xdg-open`/`start`, ignore failure). Flags: `--port`, `--no-open`, `--reset` (deletes only `.runtime/prepared-business.sqlite`).
- Default database path when unset: `.runtime/prepared-business.sqlite`. Never default to a path outside the repo.
- Make the first-run screen two cards: "Try the prepared business" (one click, seeds fixtures, enters the workspace) and "Connect your own apps" (explains it needs a model login and Google consent; button disabled with that copy until ADR-006 ships). Remove the timezone/business-name form from the first run; the prepared business supplies its own.
- Every prepared-business screen shows a persistent, non-dismissable "Prepared business, simulated connectors" badge. Keep the existing `fictional: true` source labels.
- Extend the prepared business seed with: one venue policy document, one package/price list, one calendar with two existing holds, six inbox messages (three event inquiries, three non-events: an invoice, a newsletter, a vendor pitch). Non-events are needed by ADR-003.
- Add a "Reset prepared business" action in the workspace header that reseeds from scratch and confirms before doing so.
- Rewrite `README.md` top to: one-paragraph promise, "Watch (video link placeholder)", "Run: `npx github:VasuBansal7576/gather`", "What is simulated", "Connect your own (coming in ADR-006)". Keep the developer section below.
- Tests: CLI argument parsing, doctor runs, default DB path, seed idempotency, first-run render at 1440x900 and 390x844 with the badge present.

## Don't
- Don't install or spawn OpenClaw in this path. Demo mode is deterministic and stays that way.
- Don't publish to npm; `npx github:` is the distribution.
- Don't ask for a model key, Google client id, or any env var on first run.
- Don't touch the existing `/api/demo/init` contract; call it.
- Don't write a new status document. The README states what is simulated; nothing else.

## Out of scope
Live Google and model login (ADR-006). Classification of the seeded non-event emails (ADR-003). Durable intents behind the buttons (ADR-002).

## Acceptance
- Fresh clone, `npx github:VasuBansal7576/gather` on a machine with only Node: browser opens, prepared business visible within the doctor's reported time. Terminal transcript attached.
- Screenshot of first-run screen at 1440x900 and 390x844 showing both cards and the disabled "Connect your own" copy.
- Screenshot of the workspace with the simulated badge and the six seeded inbox messages.
- Reset action reseeds; screenshot before and after with different booking timestamps.
- `--reset` deletes only the prepared-business database (directory listing before/after).
- `npm test`, `npm run typecheck`, `npm run build` pass.
