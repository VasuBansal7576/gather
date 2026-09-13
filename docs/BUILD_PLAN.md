# Gather build plan

## Outcome

An event-booking operator that connects existing business apps, prepares feasible offers, obtains required approvals, executes booking actions, and verifies results. The owner delegates booking coordination rather than configuring workflows.

## Delivery milestones

1. Isolated OpenClaw runtime, supported backend adapter, durable state, and proven test-account integrations.
2. Source-linked inquiry interpretation and feasible offer generation using Gmail, Drive, and Calendar.
3. Versioned owner approval, fresh availability check, provisional hold and approved email, with individual action receipts.
4. Persistent waiting states, follow-ups, reply handling, restart recovery, and duplicate prevention.
5. Payment verification, richer revisions, resource checks, confirmation conditions, and operational handoff.
6. Guided local launch, polished owner experience, reproducible demonstration, and deployment documentation.

## Shared contracts

Define Business, ConnectedAccount, Booking, BusinessFact, ProposedAction, Approval, and ActionExecution before implementation streams diverge. Every consequential fact needs provenance. Approval refers to the exact proposal version. Persist individual action outcomes. Reconcile uncertain external outcomes before retries. A provisional hold is not a confirmed booking; a payment link is not a payment.

## Parallel ownership

- Runtime worker: isolated runtime, adapter, packaging, restart behavior.
- Connections worker: app access, context retrieval, booking actions, external verification.
- Product worker: onboarding, booking workspace, approvals, evidence and activity presentation.
- Independent reviewer: inspect changes and reproduce failure cases.
- Coordinator: contracts, dispatch, integration, actual-run verification, and follow-through.

Use separate worktrees for independent writers. Keep shared contract changes coordinated. Independent fixtures and UI work need not wait for external authentication, but fixtures must be visibly labeled and never presented as verified integrations.

## Required failure checks

Unavailable date; conflicting policies; duplicate events; repeated approvals; hold success with email failure; uncertain timeout; restart while waiting; reply before follow-up; revoked connection; untrusted customer instructions attempting to override authority.

## Git delivery

Push coherent milestones throughout development. Review worker changes before integrating them. Run checks relevant to the change and verify remote commit state after pushing. Planning documentation does not constitute a working feature. Never publish credentials, runtime state, private customer information, or raw authentication receipts.

## Boundaries

Keep personal OpenClaw untouched. Use separate runtime state, credentials and ports. Codex workers must use Luna and only the account explicitly authorized by the owner; verify identity before launch. Other harnesses use authorized existing subscription access. Do not enable paid overages or cloud handoffs without authorization.

## Current implementation status

The local application milestone is integrated and verified with the owner workspace, deterministic demo connectors, server-only SQLite persistence, and local doctor/launcher scripts.
The isolated OpenClaw control-plane adapter, booking approval service, Google write adapter boundaries, and business-aware offer module have passed component review.
Confirmed knowledge, durable identity, incremental Google reads, and persistent waiting-work components have also passed review and combined regression checks.
Owner workspace integration, knowledge-to-offer preparation, actual runtime intake, guided app setup, and delivery readiness remain in progress.
Actual model execution and live provider verification remain separate acceptance gates.
No live provider actions or external booking integration have been verified.
