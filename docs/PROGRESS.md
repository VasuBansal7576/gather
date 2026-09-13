# Gather progress

## Current milestone

The local Gather application is runnable on Node 26 with the owner workspace, deterministic demo connectors, and a durable booking approval API integrated on `main`.
The reviewed service was integrated as `ef5e7c9` from `b0058ba`.
Reviewed Google Calendar and Gmail adapter boundaries were integrated as `72c82b7` from `363bef7`.
The isolated OpenClaw adapter was integrated as `e81fab9` from `8bca2f2`.
The owner workspace is still awaiting its verified API wiring and comparison with the owner-selected [Gather Linear UI](design/Gather-Linear-UI.png).

The demo connectors and fixture workspace remain explicitly simulated and are not live Gmail, Drive, Calendar, or OpenClaw integrations.

## Acceptance checklist

This checklist has a fixed total of 17 gates.

The local application and isolated adapter evidence satisfies 14/17 gates in this checklist.
This count describes the local application milestone only, not completion of the product requirements in [PRD.md](PRD.md).

- [x] Next.js application scaffold is present and builds.
- [x] Owner workspace renders Today, Bookings, and Connections views.
- [x] Demo fixtures are visibly labeled as demo data.
- [x] Shared Business, Booking, BusinessFact, ProposedAction, Approval, and ActionExecution contracts exist.
- [x] Server-only SQLite persistence stores bookings, proposals, approvals, and action outcomes.
- [x] Connector fixtures cover provenance, unavailable dates, idempotency, and timeout reconciliation.
- [x] Local launcher and doctor scripts are present and do not install packages or touch external runtimes.
- [x] `npm ci` completes without credentials or network provider setup.
- [x] Storage, connector, approval, recovery, offers, and runtime checks pass in one combined 158-test run on `1fbbb754`.
  The earlier doctor timeout under concurrent load remains documented below.
- [x] `npm run typecheck` passes.
- [x] `npm run build` passes.
- [x] Doctor passes with Node 26.8.2, installed dependencies, supported scripts, and a project-local writable `.runtime` directory.
- [x] Local dev server smoke check returns HTTP 200 and renders Gather, Demo data, Today, Bookings, and Connections.
- [x] Supported OpenClaw control-plane interface is verified and an isolated adapter is implemented; full model and provider execution remain unverified.
- [ ] Authorized test-account Gmail, Drive, and Calendar actions are executed and individually reconciled.
- [ ] The first inquiry-to-offer-to-approval-to-recheck-to-provisional-hold journey runs end to end with real receipts.
- [ ] Waiting states, restart recovery, reply handling, and duplicate prevention are wired through the owner experience.

## Evidence and blockers

Foundation commit `b9844b6` was integrated as `06798e9`, and packaging commit `bcd0a8d` was integrated as `aefd08a`.

The then-current 55-test suite, type checking, and production build passed on integrated `ef5e7c9` on 14 September 2026 in the owner's timezone.
Chief also independently reran the 55-test suite on that commit.

The incoming orchestrator independently verified that `main` and the remote `origin/main` both point to `f137a4401ae52fbc0ba36b104653d704caabd829` after the authorized handover.
That handover commit is historical evidence, not the current implementation head.

## Verified local approval service

Astra reviewed the exact service changes and independently reran 55 tests and type checking before integration, then reran tests, type checking, and the production build on `main`.
Independent review covered exact proposal identity, stale approval rejection, fresh calendar-scoped availability, individually persisted hold and email receipts, concurrent claims, repeated approvals, uncertain outcomes, and restart recovery.
Additional counterexamples exposed expired holds blocking in the same process and durable intents surviving known receipts.
Both original counterexamples pass after the fixes, alongside end-to-end simulated hold creation, clock advancement, rebooking, and restart tests.
The service review gate is accepted for this local simulated component only.
Independent actual HTTP acceptance on `b0058ba` passed against a temporary SQLite database: empty workspace, explicit demo initialization, exact approval, stable repeated receipts, stale approval rejection (409), cross-origin rejection (403), and restart preserving the same receipts without extra simulated writes.
No live provider receipt or booking confirmation is established by these tests.

## Next integrated milestone

The service is integrated; owner approval and recovery interactions remain under mounted browser review before API and UI integration.
Parallel workers are implementing and correcting the isolated runtime adapter, Google provider adapters, business-aware offers, and persistent proactive booking work.
Runtime worker evidence includes an actual isolated Gateway boot, protocol handshake, control-plane RPCs, and observed shutdown without model or Google calls.
The local adapter gate is accepted after independent isolation and lifecycle review, 42/42 tests on `8bca2f2`, and actual isolated Gateway boot, handshake, control-plane RPC, and observed shutdown.
On integrated `e81fab9`, the combined run passed 116/117 tests: the sentinel doctor spawned its child but did not receive hello-ok within 30 seconds, then shut down the child correctly.
After the concurrent build settled, the exact failed doctor check passed independently in 29.3 seconds with the same handshake threshold.
Type checking and the production build passed on the integrated commit.
This observed timeout under concurrent load remains a reliability limitation; the retest does not erase it.
Full model execution and Gateway-mediated Gather tool invocation remain unverified.
Google adapters passed independent review on `363bef7`, including scripted provider responses and a real loopback transport timeout.
The combined suite on `72c82b7` passes 84 tests and type checking.
These adapter component checks establish no live Google outcome; the adapters remain disconnected pending approved test-account assets.
The business-aware offers module was integrated as `8bc9674` from `997c2cf` after independent review and correction of invented currency and missed suitable rooms.
Astra reran all 41 offer-specific tests and type checking on the integrated module.
The module preserves approved floors and margin rules, does not claim profit when costs are unknown, checks scoped availability and local-time alternatives, and binds deterministic offer fingerprints.
It still requires host wiring to confirmed business facts, fresh availability, and exact owner approval before owner-facing acceptance.
Proactive-work, business-knowledge, and delivery-readiness modules remain under independent review and integration.
The next demonstrable owner journey is explicit demo initialization, exact proposal review and approval, individually persisted hold and email receipts, and restart recovery through the workspace.

The full product requirements and build ownership are recorded in [PRD.md](PRD.md) and [ORCHESTRATION.md](ORCHESTRATION.md).
The owner approved the full scope and clarified proactive monitoring, pricing and margin boundaries with honest treatment of unknown costs, and a seamless product experience that does not expose infrastructure configuration.
The PRD now contains an explicit section 13 for the operations handoff.

Two supervised Codex child launches were attempted with the active managed account metadata and effective model `gpt-5.6-luna`.

Both launches stopped at agent readiness on the Codex CLI update prompt, and exact attempts to select `Skip` were rejected by the terminal prompt guard.

OpenClaw interface research has completed; the isolated adapter implementation and its exact verification evidence now govern runtime acceptance.
Full model invocation remains unverified until a supported provider authentication route is supplied.

No credentials, personal OpenClaw configuration or data, provider actions, customer communications, cloud handoffs, or runtime state were added to Git.

## Workspace cleanup and dependency findings

Ten completed review, failed-launch, runtime, and inherited milestone worktrees were removed after checking clean tracked state and active worker ownership.
Original foundation, interface, connector-contract, and packaging commits remain preserved by local branch references; integrated review commits remain reachable on remote main.
Active execution worktrees and unrelated work were preserved.

Dependency remediation `64bb96e` was integrated as `1fbbb754` after compatibility review.
PostCSS is pinned to 8.5.23 and sharp resolves to 0.35.4 within the existing framework dependency range.
Astra independently ran a clean install, an audit with zero reported vulnerabilities, CSS and image-processing smoke checks, all 158 tests, type checking, and the production build successfully.
The combined run included both actual isolated runtime checks; this later success does not erase the earlier observed doctor timeout under concurrent load.
No major framework upgrade was applied.
See [dependency evidence](DEPENDENCIES.md) for the exact scope and limitations.
