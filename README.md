# Gather

### Your event-booking operator. Your tools. Your authority.

Gather helps independent venues, private-dining restaurants, and caterers move from scattered inquiries to organized bookings.
Connect business apps, give the operator a goal, and review the decisions that need you.

**Gmail brings the conversation. Drive supplies packages and policies. Calendar provides availability. Gather connects the work.**

## Demo video

The previous narrated overview has been withdrawn: it did not demonstrate the application executing a complete workflow. A replacement screen recording will be linked only after the actual workflow and its results are verified.

## What the product does

- Brings inquiries, business information, offers, approvals, and action results into one owner workspace.
- Uses an isolated OpenClaw runtime to let a model call controlled Gather tools.
- Prepares offers using customer requirements, venue policies, and availability.
- Binds approval to the exact proposal, rather than granting unlimited permission.
- Records calendar and email actions separately, so partial completion is visible.
- Persists booking progress and supports recovery instead of blindly repeating writes.

The intended journey is **inquiry → evidence → feasible offer → owner approval → reservation and communication → verified booking conditions → team handoff**.
A provisional hold is not a paid or confirmed booking.

## Run locally

Use **Node.js 26+** for the documented, tested setup and npm.

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
Choose a different port if 3000 is already occupied.

**Demo mode requires no Google credentials or model subscription.**
Its application logic and persistence are real; its venue records and external effects are explicitly simulated.

For development, use `npm run dev` after installing dependencies.
See [local setup](docs/LOCAL_SETUP.md) for launcher and troubleshooting details.

## Connect real apps and a model

**Live mode requires your own Google account authorization and a supported model login. Demo mode requires neither.**

### Customer experience versus self-hosted developer setup

The intended customer experience is **Connect Google → select your account → approve access**. Customers should not create Cloud projects, enable APIs, or manage OAuth client secrets. A Gather-operated OAuth application and connection service should handle that developer configuration and any required Google verification centrally.

**That shared onboarding service is not included in this local prototype yet.** The instructions below are for developers self-hosting their own instance, not a finished customer signup flow. Cloning this repository does not provide access to the project's test OAuth client or anyone else's connected accounts. Never distribute a shared web-client secret in the repository or browser bundle.

### Current self-hosted configuration

1. Register a Google OAuth application, enable Gmail, Drive, and Calendar APIs, and designate the test user when using Testing mode.
2. Configure `GATHER_GOOGLE_CLIENT_ID`, `GATHER_GOOGLE_CLIENT_SECRET`, and `GATHER_GOOGLE_REDIRECT_URI` securely in the server environment.
3. Register the exact callback, normally `http://localhost:3000/api/connections/google/callback`, and use the matching browser hostname for the connection flow.
4. Use Gather's **Connect Google** flow and approve the requested permissions.
5. Configure a separate OpenClaw runtime with a supported, authorized model login and designate the business sources used by its tools.

Never put OAuth secrets, tokens, runtime state, or customer data in Git.
The macOS connection adapter uses Keychain; other deployment environments require an appropriate secret-store integration.

Detailed guides: [Google connections](docs/CONNECTIONS.md) · [Google adapters](docs/GOOGLE_CONNECTORS.md) · [OpenClaw integration](docs/OPENCLAW.md) · [Model configuration](docs/MODEL_CONFIG.md) · [Model-driven execution](docs/LIVE_MODEL_RUN.md).

## Architecture

```text
Owner workspace
      │
Gather backend: booking state, authority, approvals, receipts
      │
Isolated OpenClaw runtime ↔ controlled Gather tools
                                  │
                      Gmail · Drive · Calendar
```

**Gather** owns the business rules and customer experience.
**OpenClaw** supplies the agent runtime; this repository does not rebuild it.
**Orca** coordinates development and is not required by customers.
Connected applications remain authoritative for their external records.

## Reliability and honest boundaries

The repository includes tests for stale approvals, duplicate actions, partial failures, uncertain outcomes, restart recovery, connection scoping, and model-tool boundaries.

```sh
npm test
npm run typecheck
npm run build
```

Automated tests include simulated providers and are not, on their own, proof of live external outcomes.
Owner-authorized development runs have separately verified Google account connection and Luna model/tool execution.
A complete live inquiry-to-confirmed-booking outcome is not claimed here until its external receipts and UI journey are verified.
The current local prototype is not a production multi-tenant hosted service.

See [progress and acceptance gates](docs/PROGRESS.md) for detailed evidence and outstanding work.

## Product documentation

- [Product requirements](docs/PRD.md)
- [Business knowledge](docs/BUSINESS_KNOWLEDGE.md)
- [Booking API](docs/BOOKING_API.md)
- [Proactive work](docs/PROACTIVE_WORK.md)
- [Data recovery](docs/DATA_RECOVERY.md)

**The goal: less coordination for the owner, with clear authority and verifiable outcomes.**
