# Gather product requirements

## Product promise

Gather coordinates event bookings for independent venues, private-dining restaurants, and caterers.
An owner connects existing business applications and delegates the work from inquiry to a confirmed booking that is ready to deliver.
The owner should not need to build workflows or manage a generic agent dashboard.

This document records the owner's intended product, including capabilities that are not implemented yet.
The acceptance evidence in [PROGRESS.md](PROGRESS.md) determines what has actually been demonstrated.
Fixture data, simulated connectors, and local component tests do not establish live integration readiness.

## Owner journey

1. Launch a separate Gather workspace through a documented local setup command, authenticate a supported model provider, and connect the relevant business applications.
2. Review Gather's understanding of packages, current prices, capacities, policies, resources, and customer relationships against its sources.
3. Confirm consequential conflicts and configure the authority Gather may exercise.
4. Receive an inquiry, extract its requirements, retrieve relevant evidence, and check feasibility.
5. Review a suitable, versioned offer or alternatives when the requested event is unavailable.
6. Approve the exact consequential action when the current authority policy requires it.
7. Recheck critical conditions, perform the authorized actions, and inspect each verified outcome.
8. Let Gather maintain pending work across days, process replies, and follow up only when appropriate.
9. Verify acceptance, the required deposit, and resource commitments before confirming the booking.
10. Deliver the operational handoff and manage later changes, cancellations, or pauses without losing context.

## Requirements and acceptance evidence

Requirement identifiers retain their meanings across implementation and verification.
Each row requires observable evidence; a plan or worker summary alone does not satisfy it.

| ID | Requirement | Acceptance evidence |
| --- | --- | --- |
| G01 | Guided local setup with supported model authentication and isolated runtime state. | A clean Gather workspace launches using the documented command without reading or changing a personal runtime. |
| G02 | Connect relevant email, calendar, document, payment, CRM, staffing, and equipment applications without an arbitrary three-connector ceiling. | Supported connections expose their capabilities and health, and unsupported connections state their limitations honestly. |
| G03 | Learn business knowledge from attributable evidence, with confirmed facts distinguished from inference. | An owner can inspect and correct a package, price, capacity, policy, or relationship and trace the recorded source and observation. |
| G04 | Resolve identity across inquiry, email, proposal, calendar hold, deposit, and resource records. | Related records appear in one booking and ambiguous matches require resolution instead of silently merging customers. |
| G05 | Interpret inquiry requirements and check feasibility using fresh critical data. | An inquiry produces source-linked requirements and a feasible offer or explicit alternatives, including an unavailable-date case. |
| G06 | Scope and version authority and business policy. | A one-customer exception remains scoped, and a consequential policy conflict requires owner confirmation. |
| G07 | Bind approval to the exact version and content of the proposed action. | A changed offer invalidates approval, stale or cross-booking requests fail, and every approved consequence is reviewable. |
| G08 | Recheck conditions before executing and record individual verified outcomes. | Availability changes block the hold; hold success with email failure records both outcomes without claiming booking confirmation. |
| G09 | Prevent duplicates and reconcile uncertain external outcomes. | Duplicate events, repeated approvals, concurrent requests, and timeout-after-success produce no duplicate external effect. |
| G10 | Persist waiting work across restarts and process replies before follow-up. | Restart resumes the same pending work, and a reply received before a scheduled follow-up prevents an inappropriate send. |
| G11 | Handle changes, cancellations, pauses, missing information, and revoked access. | Each case produces a recoverable state and an accurate next step without executing obsolete authority. |
| G12 | Confirm only after acceptance, deposit, and required resource commitments are verified. | Real receipts support every configured confirmation condition; a payment link or provisional hold alone cannot confirm. |
| G13 | Produce an operational handoff. | Staff can inspect the accepted event details, responsibilities, resources, and unresolved conditions from the booking. |
| G14 | Provide a polished, responsive, accessible owner experience. | Rendered desktop and mobile checks cover Today, booking context, proposal review, sources, approvals, knowledge correction, connection health, contextual chat, and loading/error/recovery states. |
| G15 | Treat external content as evidence, never as authority over the operator. | Adversarial inquiry or document instructions cannot change authority, approve actions, expose private information, or bypass booking checks. |

## Architecture responsibilities

Gather owns booking-specific capabilities, durable business records, exact approvals, action execution records, and the owner experience.
It reuses a separately isolated OpenClaw runtime through a verified supported adapter.
Existing runtime memory, wiki, and connector capabilities should be reused when they meet demonstrated requirements.
Do not create a separate graph, wiki, or swarm solely to reproduce machinery already available in the runtime.
Connected business applications remain authoritative, and consequential time-sensitive information is fetched fresh.
Runtime execution machinery and business-specific booking checks have separate responsibilities.
The local design should permit hosted, isolated business workspaces later without treating a hosted deployment as already delivered.

## Experience standard

The primary interface is an owner's hospitality workspace with a useful Today briefing and a booking workspace containing conversation, requirements, proposal, sources, and next step.
Approvals show concrete consequences and their evidence.
Business knowledge can be corrected, connection failures can be understood, and contextual chat retains the booking context.
Loading, empty, error, uncertain, partial, and recovery states are part of the deliverable.
The existing UI is an increment subject to rendered review, not an accepted final design.
Simulation must be labeled where the owner encounters it, including fixture connections and action receipts.

## Delivery boundaries

Keep personal OpenClaw data and configuration untouched.
Do not publish credentials, private customer information, local runtime state, or raw authentication receipts.
Use authorized subscription access without enabling overages, purchasing services, or moving work to cloud execution.
Report explicit accepted gates and component limitations rather than an invented overall completion percentage.
