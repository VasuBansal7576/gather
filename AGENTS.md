# Gather: how agents work here

Every task is one ADR from `docs/adr/`. Read your ADR, then run the four steps in order using the skills in `.agents/skills/`:
`isolate` (fresh worktree from origin/main) -> `build` (service-layer code, only files your ADR owns) -> `prove` (before/after evidence at the user-visible level) -> `ship` (PR with the evidence, loop with review until clean).
`coordinate` is for the integrator only.

Non-obvious facts about this repo:

- Requirements live in `docs/HACKATHON_PRD.md`. Read only the sections your ADR cites. Do not invent scope beyond the ADR.
- `src/runtime/` is the only code that knows about OpenClaw. Never read or write the developer's personal `~/.openclaw`; the isolated runtime lives under `.runtime/`.
- The prepared business (demo mode) uses simulated connectors. Anything simulated must stay labeled as simulated in the UI and in test names.
- Authority, price floors, recipient limits and scope gates are enforced in server code, never in prompts. If your change would make a prompt the only enforcement, stop.
- A passing test, a tool call returning, or a model saying it sent something is not evidence of an external outcome. Evidence is a receipt, a screenshot, or a transcript.
- Golden path: `tests/golden-path.test.ts` (ADR-002) must stay green on every PR once it exists.
- Commands: `npm ci`, `npm test`, `npm run typecheck`, `npm run build`, `node scripts/gather-doctor.mjs`. Node 22+.
- Never commit secrets, runtime state, `.runtime/`, `*.sqlite`, customer data, or personal account identifiers. Operator-specific values come from env (`GATHER_*`).
- No status ledgers. Progress is the PR and its evidence, not a markdown file.
