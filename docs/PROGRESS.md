# Gather progress

## Current milestone

The local Gather application is runnable on Node 26 with the owner workspace, deterministic demo connectors, and a durable booking approval API integrated on `main`.
The reviewed service was integrated as `ef5e7c9` from `b0058ba`.
Reviewed Google Calendar and Gmail adapter boundaries were integrated as `72c82b7` from `363bef7`.
The isolated OpenClaw adapter was integrated as `e81fab9` from `8bca2f2`.
The reviewed owner workspace and local API wiring were integrated as `dc07d55`, following comparison with the owner-selected [Gather Linear UI](design/Gather-Linear-UI.png).

The demo connectors and fixture workspace remain explicitly simulated and are not live Gmail, Drive, Calendar, or OpenClaw integrations.

## Acceptance checklist

This checklist has a fixed total of 17 gates.

Fourteen gates are accepted after the latest combined 343-test run and production build.
The recurring isolated Gateway startup timeout remains an open reliability issue despite the passing rerun.
This count describes the local application milestone only, not completion of the product requirements in [PRD.md](PRD.md).

- [x] Next.js application scaffold is present and builds.
- [x] Owner workspace renders Today, Bookings, and Connections views.
- [x] Demo fixtures are visibly labeled as demo data.
- [x] Shared Business, Booking, BusinessFact, ProposedAction, Approval, and ActionExecution contracts exist.
- [x] Server-only SQLite persistence stores bookings, proposals, approvals, and action outcomes.
- [x] Connector fixtures cover provenance, unavailable dates, idempotency, and timeout reconciliation.
- [x] Local launcher and doctor scripts are present and do not install packages or touch external runtimes.
- [x] `npm ci` completes without credentials or network provider setup.
- [x] Storage, connector, approval, recovery, offers, runtime, Google scope, and owner-state checks pass together in the 343-test run on `cb913a9`.
  The preceding `dc07d55` run passed 330/331 with the isolated Gateway handshake timeout described below; this failure remains recorded.
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

The service and reviewed owner approval interactions are integrated; setup, connection, runtime-intake, business-operator, and confirmation-service handoffs remain under review.
The runtime adapter and business-aware offers module have passed component review and are integrated.
Parallel workers are reviewing Google reads and confirmed knowledge, correcting durable identity and proactive work, and verifying delivery readiness and the owner workspace.
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
Durable booking identity was integrated as `a430f52` from `f60f8f8` after independent review, 111 tests, ten adverse reproductions, and Astra rerunning all 27 identity checks.
Bindings are scoped to trusted accounts, corrections carry exact monotonic revisions, old provider proof is cleared on reassignment, and link/audit writes plus legacy schema upgrades are atomic.
Google incremental inbox and bounded document reads were integrated as `5eff0d9` from `16ca877` after independent review and Astra rerunning 54 adapter tests.
Cursors bind a stable account identity and query, preserve capped page progress, and catch arrivals during initial sync; malformed or skipped content remains explicitly incomplete.
Persistent booking waiting work was integrated as `dae72d8` from `7f21c7e` after Astra reran 37 coordination tests, type checking, and both exact migration counterexamples.
Review verified scoped deduplication, reply suppression, persisted pause controls, claim fencing, and legacy migrations that preserve queued work and live leases.
All 247 tests, type checking, and the production build pass on the combined integration.
Source-linked business knowledge was integrated as `1091509` from `640f57b` after independent review, 28 focused tests, type checking, and Astra reproducing the exact two-connection command race.
Competing commands now produce one fact and one decision; altered command reuse is rejected inside the write transaction.
Rejected decisions replay as typed errors, corrected facts retain consistent revision identity, and unconfirmed source changes remain withheld from offer inputs.
All 275 tests, type checking, and the production build passed with knowledge integrated.
The delivery-readiness evaluator and operational handoff module were integrated as `927051e` from reviewed `e626000`.
Independent review and 39 focused tests verify deterministic receipt freshness, refund deduplication, exact booking/proposal windows, current resource commitments, scoped owner waivers, and separate fixture/live evidence.
All 314 combined tests and the production build pass with the evaluator integrated; the guarded confirmation service and owner-facing handoff remain in progress.
This does not establish live acceptance for G12 or G13.
These are component acceptances; knowledge-to-offer host integration, delivery readiness, owner interaction polish, setup and connection recovery, and actual runtime intake wiring remain under review or implementation.
The isolated-runtime intake integration now has verified dependency artifacts; live provider and model execution remain separate blocked gates.
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

Fifteen completed review, failed-launch, runtime, dependency-maintenance, knowledge, delivery-evaluator, owner-workspace, and inherited milestone worktrees were removed after checking clean tracked state and active worker ownership.
Original foundation, interface, connector-contract, and packaging commits remain preserved by local branch references; integrated review commits remain reachable on remote main.
The completed knowledge commit is additionally preserved at `archive/gather-business-knowledge-640f57b`; its successor worker uses a separate business-operator worktree.
The completed delivery evaluator is preserved at `archive/gather-delivery-readiness-e626000`; its successor uses a separate booking-delivery worktree.
The completed owner workspace is preserved at `archive/gather-owner-host-fbafe11`; its worker now independently reviews the confirmation service.
Active execution worktrees and unrelated work were preserved.

Dependency remediation `64bb96e` was integrated as `1fbbb754` after compatibility review.
PostCSS is pinned to 8.5.23 and sharp resolves to 0.35.4 within the existing framework dependency range.
Astra independently ran a clean install, an audit with zero reported vulnerabilities, CSS and image-processing smoke checks, all 158 tests, type checking, and the production build successfully.
The combined run included both actual isolated runtime checks; this later success does not erase the earlier observed doctor timeout under concurrent load.
No major framework upgrade was applied.
See [dependency evidence](DEPENDENCIES.md) for the exact scope and limitations.

## Filtering acceptance correction

Chief identified, and Astra verified against the [Gmail history API](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list), that incremental history requests do not support the `q` search parameter.
The previous Google adapter review did not catch this unsupported parameter in delta and initial catch-up paths.
The corrected intake boundary was integrated as `619ad4b` from `ef062eb` after Astra reran 66 focused Google tests and type checking.
Only an unfiltered mailbox or a single supported system-label scope is accepted; arbitrary search queries are rejected before any HTTP request.
Snapshot requests use exact `labelIds` and explicit spam/trash inclusion, while history and catch-up use `labelId`.
This acceptance covers message-added intake, not a complete label-membership or deletion mirror, semantic relevance filtering, or live Google behavior.
Review also found and corrected inherited object-property names escaping the scope allowlist.
Knowledge vocabulary validation, attributable candidate storage, explicit owner confirmation, and source-change withholding are implemented.
These controls do not establish semantic relevance classification, calibrated confidence, or measured precision and recall on noisy business data.
No live Google or model extraction evaluation has been run.

## Owner workspace integration and reopened startup reliability

Astra reran 17 focused owner-state and host-contract tests and type checking on `fbafe11` before integration.
The combined `dc07d55` run passed 330/331 tests; the production build passed separately.
The sole failure was the actual isolated doctor not receiving Gateway `hello-ok` within 30 seconds, followed by verified child shutdown.
The same timeout was observed on an earlier integration under concurrent load; its cause remains under investigation and a passing isolated retry would not erase the reliability gap.
The unchanged single doctor check subsequently passed in 17 seconds, followed by all 343 combined tests and a production build passing on `cb913a9`.
Fixed-port contention is a hypothesis from source inspection, not a demonstrated cause; a separate worker is addressing per-run port isolation and clearer startup evidence.
Astra exercised the exact integrated production build against a disposable database: empty workspace, explicit demo initialization, Today-to-booking navigation, approval, and separately persisted simulated hold and email receipts.
Desktop 1586×992 and mobile 390×844 checks showed no horizontal overflow, with the mobile action control inside the viewport.
Removing only the task-owned simulated email execution reproduced a crash between steps: the UI remained incomplete and reapproval recovered the missing step while preserving the original hold execution.
The browser tab and task-owned server were closed after verification.
These checks establish local simulated approval behavior, not live booking confirmation or complete proactive operation.
