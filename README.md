# Gather

### Your event-booking operator. Your tools. Your machine.

Gather helps independent venues, private-dining restaurants, and caterers move from scattered inquiries to organized bookings.
Connect business apps, give the operator a goal, and review the decisions that need you.

**Gmail brings the conversation. Drive supplies packages and policies. Calendar provides availability. Gather connects the work.**

Gather is local-first: everything runs on your machine and your business data stays with you.
A hosted service is a later offering.

## Demo video

A narrated recording of the actual workflow will be linked here once the current build is verified.
The previous overview was withdrawn because it did not show a complete run.

## What the product does

- Brings inquiries, business information, offers, approvals, and action results into one owner workspace.
- Acts only on event bookings; everything else is visibly declined with a reason.
- Uses an isolated OpenClaw runtime to let a model call controlled Gather tools.
- Prepares offers using customer requirements, venue policies, and availability.
- Binds approval to the exact proposal, rather than granting unlimited permission.
- Records calendar and email actions separately, so partial completion is visible.
- Persists booking progress and supports recovery instead of blindly repeating writes.
- Detects operational failures and repairs recoverable ones from a fixed catalog, with a visible repair thread.

The intended journey is **inquiry → evidence → feasible offer → owner approval → reservation and communication → verified booking conditions → team handoff**.
A provisional hold is not a paid or confirmed booking.

## Run it

Use **Node.js 22+** and npm.
The verified route today is a clone:

```sh
git clone https://github.com/VasuBansal7576/gather.git
cd gather
npm ci
mkdir -p .runtime
node scripts/gather-doctor.mjs
npm run build
GATHER_DATABASE_PATH=.runtime/owner-demo.sqlite npm run start -- --hostname 127.0.0.1 --port 3000
```

Open **http://127.0.0.1:3000/setup**, select **Try demo**, and enter the owner workspace.
Keep the server running; the database remains in `.runtime` across restarts.
All state lives under `.runtime/`; nothing outside the working directory is created.

A one-command install (`npx github:VasuBansal7576/gather`) and a "prepared business" first-run screen are the current build target (see `docs/adr/001-local-first-product-shell.md`); the steps above are what works today.

**The prepared business needs no Google credentials and no model subscription.**
Its application logic and persistence are real; its venue records and external effects are explicitly simulated and labeled as such.

## Connect your own apps and a model

**Live mode requires your own Google account authorization and a supported model login. The prepared business requires neither.**

Live mode is the current development focus; the prepared business is the supported evaluation path today.
When live mode ships, it will:

- Install the pinned OpenClaw runtime under `.runtime/` on first use (never touching `~/.openclaw`).
- Sign into a model through OpenClaw's own subscription login or a key you provide.
- Connect Gmail, Drive, and Calendar through a Gather OAuth client using the loopback flow, with `drive.file` plus a document picker instead of full Drive access.
- Send only to the inquiry sender (plus an optional configured test recipient).

Today, developers can exercise the live boundary with `GATHER_MODEL_PROFILE_ID`, `GATHER_MODEL_EMAIL`, `GATHER_TEST_RECIPIENT`, and `GATHER_OPENCLAW_BIN` environment variables; see the guides below.

Never put OAuth secrets, tokens, runtime state, or customer data in Git.
The macOS connection adapter uses Keychain; other environments use the file-backed adapter under `.runtime/secrets/`.

Detailed guides: [Google connections](docs/CONNECTIONS.md) · [Google adapters](docs/GOOGLE_CONNECTORS.md) · [OpenClaw integration](docs/OPENCLAW.md) · [Model configuration](docs/MODEL_CONFIG.md) · [Model-driven execution](docs/LIVE_MODEL_RUN.md).

## Architecture

```text
Owner workspace
      |
Gather backend: booking state, authority, approvals, receipts
      |
Isolated OpenClaw runtime <-> controlled Gather tools
                                  |
                      Gmail · Drive · Calendar
```

**Gather** owns the business rules and customer experience.
**OpenClaw** supplies the agent runtime; this repository does not rebuild it.
Connected applications remain authoritative for their external records.

## Reliability and honest boundaries

The repository includes tests for stale approvals, duplicate actions, partial failures, uncertain outcomes, restart recovery, connection scoping, and model-tool boundaries.

```sh
npm test
npm run typecheck
npm run build
```

Automated tests include simulated providers and are not, on their own, proof of live external outcomes.
Owner-authorized development runs have separately verified Google account connection and model/tool execution.
A complete live inquiry-to-confirmed-booking outcome is not claimed until its external receipts and UI journey are verified.
This is a local-first single-business application, not a multi-tenant hosted service.

## Product documentation

- [Public hackathon requirements](docs/HACKATHON_PRD.md) — target scope for the Amazon, AssemblyAI, and Nebius/NVIDIA events.
- [Architecture decision records](docs/adr/) — the units of work for this build.
- [Agent workflow](AGENTS.md) — how every change is isolated, built, proven, and shipped.
- [Business knowledge](docs/BUSINESS_KNOWLEDGE.md)
- [Booking API](docs/BOOKING_API.md)
- [Proactive work](docs/PROACTIVE_WORK.md)
- [Data recovery](docs/DATA_RECOVERY.md)

**The goal: less coordination for the owner, with clear authority and verifiable outcomes.**
