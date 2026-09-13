# Gather progress

## Current milestone

The local Gather application is runnable on Node 26 with the owner workspace, deterministic demo connectors, and server-only SQLite booking persistence integrated on `main`.

The demo connectors and fixture workspace remain explicitly simulated and are not live Gmail, Drive, Calendar, or OpenClaw integrations.

## Acceptance checklist

This checklist has a fixed total of 17 gates.

The inherited local application evidence satisfies 13/17 gates in this checklist.
This count describes the local application milestone only, not completion of the product requirements in [PRD.md](PRD.md).

- [x] Next.js application scaffold is present and builds.
- [x] Owner workspace renders Today, Bookings, and Connections views.
- [x] Demo fixtures are visibly labeled as demo data.
- [x] Shared Business, Booking, BusinessFact, ProposedAction, Approval, and ActionExecution contracts exist.
- [x] Server-only SQLite persistence stores bookings, proposals, approvals, and action outcomes.
- [x] Connector fixtures cover provenance, unavailable dates, idempotency, and timeout reconciliation.
- [x] Local launcher and doctor scripts are present and do not install packages or touch external runtimes.
- [x] `npm ci` completes without credentials or network provider setup.
- [x] `npm test` passes: 9 tests across storage and connector suites.
- [x] `npm run typecheck` passes.
- [x] `npm run build` passes.
- [x] Doctor passes with Node 26.8.2, installed dependencies, supported scripts, and a project-local writable `.runtime` directory.
- [x] Local dev server smoke check returns HTTP 200 and renders Gather, Demo data, Today, Bookings, and Connections.
- [ ] Supported OpenClaw interface is verified and an isolated adapter is implemented.
- [ ] Authorized test-account Gmail, Drive, and Calendar actions are executed and individually reconciled.
- [ ] The first inquiry-to-offer-to-approval-to-recheck-to-provisional-hold journey runs end to end with real receipts.
- [ ] Waiting states, restart recovery, reply handling, and duplicate prevention are wired through the owner experience.

## Evidence and blockers

Foundation commit `b9844b6` was integrated as `06798e9`, and packaging commit `bcd0a8d` was integrated as `aefd08a`.

The executable checks above ran on the integrated working tree on 13 September 2026.

The incoming orchestrator independently verified that `main` and the remote `origin/main` both point to `f137a4401ae52fbc0ba36b104653d704caabd829` after the authorized handover.
The test results above are the outgoing orchestrator's evidence and have not yet been rerun for the next milestone.

## Next integrated milestone

Parallel implementation is in progress for durable exact-version approval and booking execution, and for owner approval and recovery interactions.
API and UI integration depends on their verified contracts, followed by independent review and direct application checks.
The review identified missing UI version/fingerprint binding, attempt-scoped execution keys, incomplete uncertain/partial outcome presentation, and a retry control that only navigated.
These findings remain open until the corresponding fixes are verified.

The full product requirements and build ownership are recorded in [PRD.md](PRD.md) and [ORCHESTRATION.md](ORCHESTRATION.md).
The owner approved the full scope and clarified proactive monitoring, pricing and margin boundaries with honest treatment of unknown costs, and a seamless product experience that does not expose infrastructure configuration.
The PRD now contains an explicit section 13 for the operations handoff.

Two supervised Codex child launches were attempted with the active managed account metadata and effective model `gpt-5.6-luna`.

Both launches stopped at agent readiness on the Codex CLI update prompt, and exact attempts to select `Skip` were rejected by the terminal prompt guard.

The active Devin OpenClaw interface research remains the source of truth for adapter capability verification.

No credentials, personal OpenClaw configuration or data, provider actions, customer communications, cloud handoffs, or runtime state were added to Git.
