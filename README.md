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

The local application milestone is runnable with the owner workspace, deterministic demo connectors, server-only SQLite persistence, and local doctor/launcher scripts.
Demo connectors are fixtures only, and no live provider integration, isolated OpenClaw adapter, or hosted deployment is claimed yet.
See [docs/PROGRESS.md](docs/PROGRESS.md) for the evidence-backed acceptance checklist and pending gates.
