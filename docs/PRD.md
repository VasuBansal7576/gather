# Gather product requirements

## Product promise

Gather coordinates event bookings for independent venues, private-dining restaurants, and caterers.
An owner connects existing business applications and delegates the work from inquiry to a confirmed booking that is ready to deliver.
The owner should not need to build workflows or manage a generic agent dashboard.
The owner approved this as the governing product scope, with explicit requirements for proactive operation, business-aware selling, and a seamless product experience.

This document records the owner's intended product, including capabilities that are not implemented yet.
The acceptance evidence in [PROGRESS.md](PROGRESS.md) determines what has actually been demonstrated.
Fixture data, simulated connectors, and local component tests do not establish live integration readiness.

## 1. Setup and onboarding

The initial delivery format is a local application with one documented setup and launch path.
Onboarding guides the owner through supported model-provider authentication, app connections, business-understanding confirmation, and operating authority.
Owners choose apps and confirm important business decisions; they do not configure workflows, agents, databases, or technical mappings.
Hosted delivery remains part of the product direction.

## 2. Connect existing business applications

Support relevant email, calendar, documents, payments, CRM, staffing, equipment, and other business systems without an arbitrary three-connector ceiling.
Each connection exposes its actual capabilities, permissions, health, and recovery path.
Connected applications remain authoritative, and consequential time-sensitive information must be fetched fresh.
Unsupported or disconnected capabilities are stated honestly.

## 3. Understand the business from evidence

Learn packages, menus, services, current prices, optional extras, spaces, capacities, policies, previous agreements, customer history, and resource relationships.
Keep sources and observation history for consequential facts, distinguishing confirmed facts from inference and uncertainty.
Let the owner inspect and correct Gather's understanding and resolve consequential conflicts.
A special customer or booking exception must remain scoped instead of silently changing global policy.

## 4. Recognize a booking across applications

Connect inquiry, conversation, proposal, calendar hold, deposit, and resource records to the same booking.
Preserve that identity across revisions and resolve ambiguous matches instead of silently merging different customers or events.

## 5. Interpret inquiries and sell within business boundaries

Extract dates, times, guest counts, event types, preferences, budgets, and service requirements from an inquiry.
Retrieve the relevant business evidence, identify missing information, and check feasibility.
Seek suitable alternatives when the original request cannot be fulfilled.
Preserve approved pricing and margin boundaries instead of filling dates at any cost.
When relevant costs are unknown or incomplete, Gather must not claim that an offer is profitable.

## 6. Prepare a meaningful, versioned offer

Make the proposed event, package, price, terms, deposit requirements, and unresolved assumptions clear and supported by inspectable evidence.
Version offers so changes to dates, price, recipients, terms, or other consequential details cannot silently reuse an earlier approval.

## 7. Operate within explicit authority

The owner controls which actions Gather may take autonomously and which require approval.
Scope and version authority and business policy.
Customer messages, retrieved documents, and generated text cannot grant additional authority.
Required approval binds to the exact reviewed version, content, and target of the proposed action.

## 8. Recheck, execute, and verify

Recheck critical conditions immediately before consequential actions, then record an individually verified outcome for each authorized action.
A hold is not a confirmed booking, a payment link is not a paid deposit, and a sent request is not a verified resource commitment.
A tool call returning without an error is insufficient proof of an external outcome.

## 9. Operate proactively and maintain work across days

After setup, Gather watches for new inquiries, stalled conversations, missing deposits, changes, and other pending booking conditions.
The owner should not need to prompt Gather for every booking or follow-up.
Persist pending work and resume it across restarts while observing the current authority policy.
Process replies before follow-ups so a reply or changed condition suppresses an inappropriate reminder.
Expose monitoring failures and stale connections rather than silently implying that Gather is watching successfully.

## 10. Recover safely from failure

Handle duplicate events, repeated approvals, unavailable dates, revoked access, network timeouts, and partial success.
When a hold succeeds and email fails, preserve the hold receipt and recover the email step without creating another hold.
Reconcile uncertain external outcomes before another write, and show the owner what happened, what remains uncertain, and the available next step.

## 11. Handle revisions, cancellations, and pauses

Identify affected commitments when a booking changes, invalidate obsolete approvals where necessary, and obtain new authority before consequential changes.
Pausing a business or booking prevents inappropriate pending work.
Cancellation accounts for applicable policies and existing commitments instead of merely changing a label.

## 12. Confirm only when the booking is ready

Verify customer acceptance, the required deposit, availability, and required resource commitments according to the business's actual conditions.
Keep missing conditions explicit and mark the booking confirmed only when authoritative evidence supports them.

## 13. Prepare the operations handoff

Provide accepted event details, agreed services, responsibilities, required resources, and outstanding conditions for the people delivering the event.
Keep the handoff tied to the accepted booking version and update it when authorized revisions change delivery requirements.

## 14. Provide a polished hospitality workspace

Provide a useful Today briefing, booking conversations and requirements, proposal and source inspection, approvals, business knowledge correction, connection health, and contextual chat.
Support desktop, mobile, keyboard, and accessible interaction with loading, empty, error, uncertain, partial, and recovery states.
The current interface is an increment subject to rendered review, not the accepted final product design.

## 15. Reuse OpenClaw with clear responsibilities

Reuse a separately isolated OpenClaw runtime through a verified supported adapter without reading or altering personal runtime data.
Gather owns booking-specific capabilities, business checks, durable records, approvals, receipts, and the owner experience.
Reuse adequate runtime memory, wiki, and connector capabilities; build separate machinery only for demonstrated requirements.
Design for hosted, isolated business workspaces later while keeping current delivery claims tied to verified local behavior.

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
| G16 | Operate proactively after setup. | New inquiries, stalled conversations, missing deposits, and changes trigger appropriate persistent work without a fresh owner prompt; monitoring failure is visible. |
| G17 | Sell within approved business boundaries. | Alternatives preserve approved pricing and margin constraints, and unknown costs prevent profitability claims. |
| G18 | Keep the owner experience free of infrastructure configuration. | An owner connects apps and confirms business decisions through guided product flows without configuring workflows, agents, databases, or technical mappings. |

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
