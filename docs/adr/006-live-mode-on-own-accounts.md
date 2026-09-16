# ADR-006: Live mode on the user's own accounts

Status: paused proposal — requires design reconciliation and explicit authorization before implementation
Depends on: ADR-001, ADR-002, ADR-003, ADR-004
PRD: 3, 5, 8.1, 8.3, 10 (Connections, Booking journey, Managed runtime, Budgets gates)

> The task list below is retained for design review, not execution. See [repository design conflicts](../README.md#design-conflicts-to-resolve-before-implementation). No feature work is authorized during cleanup.

## Proposed decision
"Connect your own apps" becomes real, locally: OpenClaw is installed lazily under `.runtime/openclaw/`, the user signs into a model through OpenClaw's own subscription login or pastes a key, connects Gmail, Drive and Calendar through Gather's OAuth client using the loopback flow, and runs the same inquiry -> offer -> approval -> hold -> email journey on their real accounts with independent receipts. Everything runs on the user's machine; Gather the operator pays nothing and holds no user data. Composio is the fallback if the direct Google path proves unusable for unverified apps.

## Owns
- `src/runtime/**` (lazy install, model login flow, budget bounds)
- `src/server/connections/**`, `src/connectors/google/**` (loopback OAuth, `drive.file` + picker, token storage under `.runtime/secrets/` with 0600; replace the macOS-only Keychain adapter with a file-backed adapter behind the existing interface)
- `app/setup/**` "Connect your own" path, `app/api/connections/**`, `app/api/live-model/**`
- New `src/server/budget.ts`
- `docs/CONNECTIONS.md`, `docs/GOOGLE_CONNECTORS.md`, `docs/OPENCLAW.md`, `docs/MODEL_CONFIG.md`, `docs/LIVE_MODEL_RUN.md` (update to match)
- `tests/live-*.test.ts`, `tests/connections*.test.ts`, `tests/budget.test.ts`

## Must not touch
- `~/.openclaw`, `~/.config`, or any path outside the repo and `.runtime/`
- Intent, incident, knowledge and gate modules beyond calling them

## Do
- Lazy install: on first "Connect your own", `npm install --prefix .runtime/openclaw openclaw@<pinned>` with progress shown; verify `--version`; never a global install. Reuse `src/runtime/process.ts` isolation env exactly as documented in `docs/OPENCLAW.md`.
- Model: present OpenClaw's supported subscription login (OAuth) as the default with the exact profile id stored in `.runtime/openclaw/`; "paste an API key" as the alternative. Persist `GATHER_MODEL_PROFILE_ID` equivalent in the runtime config, never in git. Copy states plainly that a subscription login is for personal use on this machine.
- Google: register one OAuth client (desktop/loopback type) operated by Gather; the client id ships in the app, no client secret is required for the loopback flow. Scopes: `gmail.readonly`, `gmail.send`, `calendar.events`, `drive.file`. Use the Google Picker for the owner to select the policy and price documents. Show the "unverified app" step honestly in the UI with a screenshot of what Google will display and the "Advanced -> continue" instruction.
- Verify on a fresh Google account whether restricted scopes complete on the unverified client. If they do not, implement the Composio Connect Link path behind `GATHER_CONNECTOR=composio` with a tiny broker endpoint (the operator's Composio key never ships in the app) and state in the UI that mail transits Composio during sync.
- Budget: per-run max tool calls (15) and wall-clock (5 min) via the existing `agent.wait` timeout; per-day runs per business (default 50); all configurable. Exceeding shows a plain message; nothing silent.
- Route real provider failures into ADR-004's detector unchanged; `request_reconnect` must surface as a button in Connections.
- Recipient for real sends is the inquiry sender only (ADR-003 tool contract). Keep `GATHER_TEST_RECIPIENT` as an optional additional allowlist entry for the developer.
- Live journey on the developer's own test account, recorded: real inquiry email -> offer citing the Drive document -> approval -> Calendar hold receipt re-read from Calendar -> Gmail send receipt re-read from Gmail -> owner-visible receipts.

## Don't
- Don't hardcode any account, profile id, or address.
- Don't default to full `drive.readonly`; `drive.file` plus picker.
- Don't store tokens in the SQLite database or in git-tracked paths.
- Don't let a subscription login serve anyone but the local user; no hosted use.
- Don't fake a receipt from a tool return; re-read the provider.
- Don't remove the prepared business path or make it depend on any of this.

## Out of scope
Hosted multi-tenant deployment. Sponsor model adapters (one ADR per event, next). Voice intake (event ADR).

## Acceptance
- Screen recording: fresh clone -> `npx github:...` -> Connect your own -> OpenClaw installs under `.runtime/` (directory listing, `~/.openclaw` untouched by mtime) -> model login -> Google consent -> workspace shows three connected accounts.
- Live journey recording with the four receipts, each re-read from the provider (Calendar event id fetched back, Gmail message id fetched back).
- Decision record on the unverified-client test: works, or Composio fallback implemented with its own consent screenshot.
- Budget test: 16th tool call in a run is refused with the message; screenshot.
- Expired-token scenario: reconnect button appears via the incident path; screenshot.
- `npm test`, `npm run typecheck`, `npm run build` pass; golden path green.
