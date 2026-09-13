# Gather

An outcome-driven event-booking operator for independent venues, private-dining restaurants, and caterers.

## Product direction

Connect existing business apps. Gather connects inquiries, packages, policies, availability, and payments to help move inquiries toward feasible, confirmed, ready-to-deliver bookings.

Owners review consequential uncertainties and define operating authority rather than configure workflows.

## Architecture direction

- **Gather:** owner interface, onboarding, booking tools, approvals, business context, and durable action records.
- **OpenClaw:** a separately deployed agent runtime, subject to verification of supported interfaces. Not copied or forked into this repository by default.
- **Orca:** development orchestration; not part of the customer-facing runtime.
- **Connected apps:** authoritative external records, initially Gmail, Google Drive, and Google Calendar.

## First executable journey

Read a test inquiry → retrieve venue information → check availability → prepare a source-linked offer → obtain approval → recheck availability → create a provisional hold and send the offer → verify individual results.

A provisional hold is not a confirmed or paid booking. Track partial failures and uncertain results explicitly.

## Development principles

- Keep the developer's personal OpenClaw installation and data untouched.
- Use separate runtime configuration, storage, ports, and test accounts.
- Reuse existing components before building replacements.
- Persist approvals and individual action results; reconcile uncertain outcomes before retrying.
- Keep credentials, customer data, and runtime state out of Git.

## Status

The usable local subset includes guided demo setup, the owner workspace, exact proposal approval, separate simulated hold and email receipts, and SQLite persistence across restarts.
Google adapter code and an isolated OpenClaw control-plane adapter exist, but real connected-app actions and model execution have not been verified.
The isolated Gateway doctor has an unresolved intermittent startup timeout; it is separate from the demo launch below.
There is no verified real-model, three-app booking journey or hosted deployment.
See [docs/PROGRESS.md](docs/PROGRESS.md) for the evidence-backed acceptance checklist and pending gates.

## Run the local demo

Use Node.js 26 or newer and run these commands from the repository root.
Run `npm ci` once if dependencies are missing.

```sh
mkdir -p .runtime
node scripts/gather-doctor.mjs
npm run build
GATHER_DATABASE_PATH=.runtime/owner-demo.sqlite npm run start -- --hostname 127.0.0.1 --port 3000
```

Open [Gather setup locally](http://127.0.0.1:3000/setup) and keep the terminal running.
This uses a separate local demo database and preserves it on restart.
If port 3000 is occupied, choose another port in the command and browser address.
The demo needs no Google credentials, model provider, or OpenClaw process.
For development and launcher options, see [local setup](docs/LOCAL_SETUP.md).

## Two-minute demonstration

1. Choose **Try demo** and enter the workspace with the explicitly fictional venue.
2. Open **Today**, then the Clara booking, and inspect its proposed offer and approval request.
3. Approve the proposal and show the separate simulated calendar hold and offer email results.
4. Explain that the booking remains provisional: a sent offer and a hold do not establish payment, customer acceptance, or delivery readiness.

The local UI, approval records, and persistence run for real; the demo's business data and external effects are simulated.
Connected-app onboarding, proactive model operation, verified payments/resources, and the complete owner journey remain work in progress.
