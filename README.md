# Gather

An owner-side AI booking operator for event venues, private-dining restaurants, and caterers.

The goal is to coordinate inquiries across a business's existing email, documents, and calendar: understand the business, prepare evidence-backed offers, ask for consequential decisions, and track what actually happened. OpenClaw supplies the agent runtime; Gather owns booking rules, exact approvals, and action receipts.

**Gather is an unfinished prototype undergoing cleanup.** It is not a finished booking product or a submission-ready demo. Feature implementation is paused while the existing repository and design are reconciled. There is no product demonstration video yet.

## What exists today

- A local Next.js owner workspace and setup flow.
- SQLite-backed bookings, versioned proposals, exact-version approvals, and separate calendar/email execution records.
- Explicitly fictional fixtures for exercising approval, simulated actions, and recovery.
- Google adapters, connection plumbing, deterministic offer/knowledge modules, and an isolated OpenClaw adapter with regression tests. Their presence is not proof of a complete live owner journey.

The fixture path starts with two pre-created bookings and proposals. It does **not** demonstrate an agent reading a fresh inquiry, learning a venue, or preparing a priced offer end to end.

## What is not ready

The one-command installer, prepared-inbox composer and reset flow, event-only intake gate, durable user-intent runner, automatic incident/repair experience, native-memory integration, and finished live onboarding are proposed work—not shipped capabilities. The end-to-end golden-path test is also not present.

The [product requirements](docs/HACKATHON_PRD.md) describe the intended product. The [repository guide](docs/README.md) maps the existing code and unresolved design conflicts. ADRs are proposals unless explicitly accepted; they are not permission to start implementation.

## Inspect the prototype locally

Use **Node.js 26+** and npm. The development/CI baseline is pinned in [.node-version](.node-version). No Google credentials, model login, or OpenClaw installation is needed for the simulated fixture path.

```sh
git clone https://github.com/VasuBansal7576/gather.git
cd gather
npm ci
mkdir -p .runtime
node scripts/gather-doctor.mjs
npm run build
GATHER_DATABASE_PATH=.runtime/owner-demo.sqlite npm start -- --hostname 127.0.0.1 --port 3000
```

Open **http://127.0.0.1:3000/setup**, choose **Try demo**, then **Enter workspace**. Records and external effects on this path are fictional/simulated. A provisional hold is not a confirmed booking.

The explicit database path above preserves this inspection's records in `.runtime/`. Without it, the existing application defaults to `data/gather.sqlite`; this cleanup does not migrate or delete existing state. `npx github:VasuBansal7576/gather` is not a working install command yet.

See [local setup](docs/LOCAL_SETUP.md) for development commands and troubleshooting. Keep the server bound to loopback; the current local-owner identity is not hosted authentication.

## Checks

```sh
npm test
npm run typecheck
npm run build
```

[CI](.github/workflows/ci.yml) runs these checks plus the local doctor on Linux and macOS, without model/provider credentials. Tests use temporary databases and scripted providers. Four optional real-OpenClaw process checks are reported as skipped unless explicitly enabled; see [local setup](docs/LOCAL_SETUP.md#optional-openclaw-process-checks). `npm run lint` is currently a compatibility alias for typechecking, not a separate lint pass.

A green build or test suite does not establish live Google outcomes, model quality, or product completion.

## Data and live integrations

Local-first is the intended distribution model, not a claim that live data never leaves the machine. Connected Google services and a configured remote model necessarily receive the data needed for their operations.

Live integration remains developer-configured. The current Google secret adapter uses macOS Keychain; there is no shipped cross-platform file-backed Google credential store. The current model configuration accepts one explicit OAuth model selection, not arbitrary subscriptions or API keys. See [connections](docs/CONNECTIONS.md), [model configuration](docs/MODEL_CONFIG.md), and [live execution](docs/LIVE_MODEL_RUN.md) for the actual boundaries.

Never commit credentials, runtime state, databases, or customer data. No deployment, account connection, live send, or paid model call is part of repository checks.

## Development

Read [AGENTS.md](AGENTS.md) before making changes. Preserve working contracts and tests; distinguish repository maintenance from feature work, and do not treat unfinished ADRs as an implementation queue.

Licensed under [MIT](LICENSE).
