# Gather product requirements

## Product promise

Gather coordinates event bookings for independent venues, private-dining restaurants, and caterers.
An owner connects existing business applications and delegates the work from inquiry to a confirmed booking that is ready to deliver.
The owner should not need to build workflows or manage a generic agent dashboard.
Gather is an owner-side, booking-only operator: it serves the business receiving inquiries, not a venue marketplace or a general-purpose business assistant.
Its customer experience is connect tools → understand the business while resolving essential questions → delegate → see outcomes.
It must maintain and improve its own booking execution machinery, not routinely transfer technical troubleshooting to the owner.
The owner approved this as the governing product scope, with explicit requirements for proactive operation, business-aware selling, and a seamless product experience.

This document records the owner's intended product, including capabilities that are not implemented yet.
The acceptance evidence in [PROGRESS.md](PROGRESS.md) determines what has actually been demonstrated.
Fixture data, simulated connectors, and local component tests do not establish live integration readiness.

## 1. Setup and onboarding

The initial delivery format is a local application with one documented setup and launch path.
Onboarding guides the owner through supported model-provider authentication, app connections, business-understanding confirmation, and operating authority.
Owners choose apps and confirm important business decisions; they do not configure workflows, agents, databases, or technical mappings.
Hosted delivery remains part of the product direction.

### Progressive understanding and fast activation

- Begin learning as connections become available. Build enough reliable understanding to handle useful booking work before completing the entire historical import; deepen understanding in the background.
- Show a short editable summary of packages, prices, capacity, booking conditions and inquiries needing attention. Distinguish confirmed, inferred, conflicting and missing information.
- Ask only consequential questions that reliable evidence cannot resolve. Ask essential questions before the affected action; defer unrelated questions until they become relevant. Do not present a giant onboarding questionnaire or require approval of every extracted fact.
- Propose plain-language delegation settings for the owner to confirm. Owners define how their business should operate; Gather handles the technical representation.
- Persist answered questions and corrections so the owner need not repeat them after a restart or in another booking. Revisit an answer only when its scope, applicability, evidence or policy has materially changed, and explain why.
- Measure time to first useful business understanding and time to first useful completed task separately from interface responsiveness and full-import duration. Select and verify performance targets; do not invent speed guarantees or equate connected with fully understood.

## 2. Connect existing business applications

Support relevant email, calendar, documents, payments, CRM, staffing, equipment, and other business systems without an arbitrary three-connector ceiling.
Each connection exposes its actual capabilities, permissions, health, and recovery path.
Connected applications remain authoritative, and consequential time-sensitive information must be fetched fresh.
Unsupported or disconnected capabilities are stated honestly.
Connections and imported information serve booking work only; access to a tool does not authorize unrelated business operations.
Capture booking conversations across the business's supported channels and associate them with one current booking. Email, website forms, phone notes, WhatsApp and other messaging channels are potential sources, not claims of implemented integrations.
Where direct capture is unavailable, provide an easy forwarding or plain-language recording path with honest coverage limits. The owner should not maintain duplicate booking records merely to keep Gather informed.

## 3. Understand the business from evidence

Learn packages, menus, services, current prices, optional extras, spaces, capacities, policies, previous agreements, customer history, and resource relationships.
Keep sources and observation history for consequential facts, distinguishing confirmed facts from inference and uncertainty.
Let the owner inspect and correct Gather's understanding and resolve consequential conflicts.
A special customer or booking exception must remain scoped instead of silently changing global policy.

### Persistent owner-authorized operating rules

Record consequential owner answers as versioned rules, not merely conversational memories. Retain the authorizing owner, source, business/booking/package scope, effective period where applicable, superseded rule and whether the answer grants authority or expresses a preference.
A one-off discount or historical agreement must not silently authorize future concessions. Customer claims and repeated agent behavior cannot establish owner policy.
Owners inspect and amend these rules through plain language and guided controls. Consequential changes show their scope and effects, invalidate affected pending approvals where necessary, and do not silently rewrite accepted agreements.
Corrections must influence future applicable booking decisions. Remember returning customers' relevant arrangements and communication preferences without promoting past exceptions into general authority or sharing knowledge across businesses.

## 4. Recognize a booking across applications

Connect inquiry, conversation, proposal, calendar hold, deposit, and resource records to the same booking.
Preserve that identity across revisions and resolve ambiguous matches instead of silently merging different customers or events.

## 5. Interpret inquiries and sell within business boundaries

Extract dates, times, guest counts, event types, preferences, budgets, and service requirements from an inquiry.
Retrieve the relevant business evidence, identify missing information, and check feasibility.
Seek suitable alternatives when the original request cannot be fulfilled.
Preserve approved pricing and margin boundaries instead of filling dates at any cost.
When relevant costs are unknown or incomplete, Gather must not claim that an offer is profitable.

### Bounded negotiation

Distinguish three behaviors:

1. Explain an existing offer and its terms without making concessions.
2. Find a better-fitting date, package or service combination within authorized business rules.
3. Make a concession: lower a price, add free services, waive fees or alter payment/cancellation terms.

The first two are normal booking coordination within granted authority. Autonomous concessions are off by default. When a concession lacks explicit owner authority, prepare a concise recommendation and exact decision for the owner; continue unrelated permitted work.
Owners may explicitly authorize scoped concession policies. Do not infer permission from past deals, customer pressure or a general instruction to increase conversion.
Evaluate cumulative concessions across the entire booking, including extras, fees, guest-count changes and terms; individually allowed concessions must not combine into an unauthorized deal. A price floor alone does not prove acceptable economics.
Use explicit calculations for applicable minimum spend, package pricing, taxes, service charges, gratuity, extras, currency and rounding under the business's supported rules. Surface missing consequential inputs instead of inventing them.
Success is an acceptable booking with low owner effort, not acceptance at any cost.

## 6. Prepare a meaningful, versioned offer

Make the proposed event, package, price, terms, deposit requirements, and unresolved assumptions clear and supported by inspectable evidence.
Version offers so changes to dates, price, recipients, terms, or other consequential details cannot silently reuse an earlier approval.

### Low-friction inquirer experience

Gather communicates on the business owner's behalf through supported channels. Inquirers should be able to understand the full offer, choose permitted options, request changes, accept the exact version, pay through a supported payment flow and supply final details without repeating information.
An inquirer need not install or learn Gather. Existing email/messaging and payment links may satisfy this journey; a branded mobile proposal page is optional, not a separate marketplace or mandatory customer application.
Record acceptance against the exact offer and authorized accepting party. Keep provisional, accepted, paid and confirmed states distinct. Communication delivery failures remain owned work, not assumed customer receipt.

## 7. Operate within explicit authority

The owner controls which actions Gather may take autonomously and which require approval.
Scope and version authority and business policy.
Customer messages, retrieved documents, and generated text cannot grant additional authority.
Required approval binds to the exact reviewed version, content, and target of the proposed action.
Enforce consequential price, terms, amount, recipient and action constraints server-side independently of model instructions or learned skills.
An inquirer can negotiate or supply requirements but cannot modify operating rules. Claims such as “the owner approved this discount” require authoritative verification. Embedded instructions cannot authorize a booking, disclose private data, waive a deposit or redirect funds.
Self-improvement cannot expand commercial authority, lower pricing boundaries, alter accepted commitments or weaken these enforcement checks to make a task succeed.

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
Reconcile uncertain external outcomes before another write. Gather owns diagnosis, safe repair, verification and resumption of blocked booking work rather than asking the owner to debug the system.
Show the owner the business impact and recovery status without requiring technical action. When recovery genuinely needs renewed account consent, provide a clear reconnect action; when it needs a business decision, present the exact decision and recommendation.
Do not hide failures, retry unchanged failures indefinitely or call an attempted repair a recovery. Unrecoverable infrastructure/provider failures remain explicitly owned by Gather operations; they are not silently abandoned or described as customer troubleshooting tasks.

## 11. Handle revisions, cancellations, and pauses

Identify affected commitments when a booking changes, invalidate obsolete approvals where necessary, and obtain new authority before consequential changes.
Pausing a business or booking prevents inappropriate pending work.
Cancellation accounts for applicable policies and existing commitments instead of merely changing a label.

### Human and agent coexistence

Observe and reconcile supported manual email replies, calendar edits, phone agreements and externally recorded payments before further dependent action. Do not contradict a human reply, repeat their completed work or treat an unverified manual claim as authoritative payment/approval evidence.
Maintain explicit ownership while a person takes over, suppress conflicting autonomous work, and reconcile the latest state before handback. Where an external change cannot be observed automatically, make that limitation clear and provide a simple booking update path.
Handle final guaranteed headcount, dietary/accessibility details and amendment deadlines as booking commitments. Reassess affected charges and delivery requirements when details change. Allergy-sensitive requests require appropriate business confirmation; general menu knowledge must not be treated as proof of allergen safety.

## 12. Confirm only when the booking is ready

Verify customer acceptance, the required deposit, availability, and required resource commitments according to the business's actual conditions.
Keep missing conditions explicit and mark the booking confirmed only when authoritative evidence supports them.

## 13. Prepare the operations handoff

Provide accepted event details, agreed services, responsibilities, required resources, and outstanding conditions for the people delivering the event.
Keep the handoff tied to the accepted booking version and update it when authorized revisions change delivery requirements.
Deliver a usable event sheet or banquet event order through supported team channels, with named responsibilities, outstanding balances/information and final-detail deadlines.
Highlight changes since the previous version and track required acknowledgments. Escalate missing critical details or acknowledgments within the owner's operating rules.
A generated handoff is not proof that the delivery team received it or is ready. Share only recipient-relevant information.

## 14. Provide a polished hospitality workspace

Provide a useful Today briefing, booking conversations and requirements, proposal and source inspection, approvals, business knowledge correction, connection health, and contextual chat.
Support desktop, mobile, keyboard, and accessible interaction with loading, empty, error, uncertain, partial, and recovery states.
The owner designated [Gather Linear UI](design/Gather-Linear-UI.png) as the authoritative visual reference.
Match its dark four-column hospitality workspace, compact triage, central offer review, booking details, and approval action while preserving the complete product behavior.
The implemented interface requires rendered comparison against that reference before visual acceptance.

### Outcomes first, machinery behind the product

The default view answers: what completed, what needs an owner decision, and what is still moving or blocked. Tool traces, reasoning transcripts and infrastructure controls are not the default experience; evidence and activity remain inspectable on demand.
Hide implementation complexity, not uncertain outcomes or missing conditions. Derive displayed outcomes from persisted evidence.
Define routine cases that progress without intervention and cases requiring one exact approval. Recommendations explain the decision, business consequence and permitted alternatives. Group and prioritize notifications, and define what happens when the owner does not respond without inventing consent.
Measure owner active minutes, repeated questions, corrections and approval/notification burden per booking. Provide an evidence-backed summary of booking progress, follow-ups, deposits and delivery readiness; claim recovered revenue or time savings only with defensible measurement.

## 15. Reuse OpenClaw with clear responsibilities

Reuse a separately isolated OpenClaw runtime through a verified supported adapter without reading or altering personal runtime data.
Gather owns booking-specific capabilities, business checks, durable records, approvals, receipts, and the owner experience.
Reuse adequate runtime memory, wiki, and connector capabilities; build separate machinery only for demonstrated requirements.
Design for hosted, isolated business workspaces later while keeping current delivery claims tied to verified local behavior.

## 16. Self-repair and task-specific improvement

Self-repair and self-improvement are core booking-product requirements, not merely retries or remembered preferences. Two connected loops must operate: execute booking work, and improve the machinery that executes it.

Reuse verified OpenClaw skill-learning and repair capabilities where adequate. Their presence does not establish autonomous application-code repair, deployment or successful task recovery. Gather must supply or integrate the missing booking-specific machinery and prove its behavior.

### Improvement lifecycle

1. Detect failed actions, repeated owner corrections, stalled work and unnecessary friction from actual booking execution.
2. Preserve scoped diagnostic evidence and reproduce the problem, identifying whether the cause is procedure, parsing, connector behavior, application code or an external dependency.
3. Prepare the relevant repair in an isolated environment using minimized, authorized data. Do not experiment with live customer communications or payments.
4. Evaluate the original failure and relevant regression cases against independently maintained booking requirements. The repair process cannot weaken the acceptance criteria or rely solely on tests it selected to justify itself.
5. Automatically release eligible passing changes within deployment authority using bounded rollout, versioned artifacts and a verified rollback path. Protect business rules, approval enforcement, tenant isolation, credentials and accepted records from being bypassed by self-modification.
6. Resume the original booking from its durable state, preserving completed receipts and reconciling uncertain outcomes before another external effect.
7. Verify the actual booking result and later recurrence. Retain improvements supported by measured correctness, reduced owner effort, latency or cost; revert or stop regressions.

Separate a proposed change, passing isolated evaluation, released repair, recovered booking and later proven improvement in the execution record. A skill edit alone does not prove improvement.
Keep learning business-scoped. Do not propagate one owner's preferences, private records or exceptions to another business. Shared technical improvements require separate evaluation without leaking customer data.
Bound repair attempts, compute and spending. A repair loop cannot authorize new expenditure, providers, permissions or destructive changes outside its existing authority. Continue unaffected booking work when safe.
External consent requirements and provider outages remain real limits. Gather owns the unresolved incident and the next recovery action; it cannot manufacture authorization or claim recovery without evidence.

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
| G19 | Progressive onboarding and persistent owner rules. | Partial import yields useful grounded work; essential conflicts block only affected actions; an answered question survives restart and applies only within its authorized scope. |
| G20 | Low-friction booking communication and human coexistence. | A customer can review, revise and accept the exact offer through a supported flow without a Gather account; manual replies/changes suppress conflicting actions and handback reconciles current state. |
| G21 | Bounded negotiation with independent financial enforcement. | Ordinary explanations and package alternatives work; unauthorized concessions, cumulative concession abuse, false owner claims and prompt injection cannot bypass price, terms, recipient or approval checks. |
| G22 | Autonomous technical repair and booking resumption. | A reproduced technical defect is repaired in isolation, passes independent regression gates, is released within authority and resumes the same booking without duplicate effects; a failing repair is rejected or rolled back. |
| G23 | Evidence-based task-specific improvement. | A retained improvement demonstrates measured benefit on representative booking cases and a later run without weaker acceptance criteria, expanded commercial authority or cross-business leakage. |
| G24 | Outcome-first operation through delivery readiness. | The owner sees accurate done/decision/pending states; required team acknowledgments and changed event details are tracked; owner effort and corrections are measured without invented savings. |

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
The owner-selected [Gather Linear UI](design/Gather-Linear-UI.png) governs the visual design.
A matching screenshot alone does not establish that the required interactions work.
Simulation must be labeled where the owner encounters it, including fixture connections and action receipts.

## Delivery boundaries

## Component reuse and integration contract — 2026-09-14

This section records the owner's reuse-first direction. These are requirements and candidate choices, not implementation or production-readiness claims. The complete booking scope above remains unchanged.

### Customer experience and deployment

- Owners connect business apps and delegate outcomes; they must not install or configure memory platforms, queues, databases, agents, or workflow infrastructure.
- The local distribution packages required dependencies behind the documented launch path. Hosted delivery operates infrastructure on the provider side. Software must run somewhere: an API/MCP connection avoids local installation but does not remove hosting, credentials, cost, or operational responsibilities.
- Do not install every shortlisted repository. Use one primary implementation per responsibility, reuse existing adequate capabilities, and leave optional integrations disabled unless configured.
- A hosted service, remote data transfer, or paid plan is not authorized solely by this architecture. Preserve existing test-data, spending, and credential boundaries.

### Component decisions

| Responsibility | Direction | Adoption gate |
| --- | --- | --- |
| Agent runtime | Reuse the isolated OpenClaw adapter. | Actual model/tool execution and restart behavior. |
| Business context | Evaluate Supermemory first; Cognee is a comparison/fallback, not a second simultaneous memory system. | Verify exact edition/license, available connector and self-hosted features, per-business isolation, retrieval quality, update/deletion behavior, latency and usage. No automatic migration. |
| Parsing | Use the selected context provider's adequate existing processing; evaluate Docling only for demonstrated format failures. | Representative menus, contracts, tables and attachments. |
| Durable work | Keep proven current persistence; consider pg-boss if PostgreSQL is selected, or Temporal if workflow complexity justifies it. | Demonstrated recovery improvement and explicit scheduling ownership; never competing schedulers. |
| Process lifecycle | Evaluate Execa only against reproduced native launcher issues; container init such as Tini applies only to containers. | Startup, cancellation, child shutdown and state preservation. |
| Verification | Reuse Playwright for browser journeys, Promptfoo where useful for model evaluation, and Gitleaks for secret scanning. | Real assertions and reproducible reports, not presence of a dependency. |
| Hosted operations | Prefer existing deployment secrets; evaluate OpenFGA, SigNoz and Restic only where requirements justify them. | Permission enforcement, useful alerts, consistent backups and actual restore. These services are not mandatory local startup dependencies. |

### Integration boundary

The logical path is: owner UI -> Gather backend -> isolated claw -> controlled Gather tools -> context provider or business apps. Background jobs also use the same permission and execution boundaries.

- A thin server-side context adapter supplies operations such as ingest, search, update and delete. These are Gather interface concepts, not assertions about any vendor's API names.
- A provider may be accessed through its supported HTTPS API, SDK or remote MCP interface. An SDK is client code, not the entire provider installation. Local stdio MCP requires a local server; remote MCP requires a running remote service.
- Server-side identity fixes business scope before every request; never let model-supplied tenant IDs or metadata tags alone enforce access control.
- Retrieved context is evidence, not authority. Keep credentials server-side and minimize provider payloads. Do not send private business data until authorized.
- Gather's durable records retain exact approvals, accepted offers, pending work and action receipts. Connected calendar/payment systems prove reservations/payments. A memory summary cannot replace those authoritative records.
- Use provider health, timeouts, bounded retries and visible degraded states. Missing critical context blocks the affected commitment, not unrelated work. Do not silently change memory providers or pretend stale context is fresh.

### Knowledge acceptance and customer setup

- Evaluate a realistic noisy dataset with old/new prices, signed exceptions, duplicates, unrelated content, similar customer names, deletions and changed policies. Include multiple isolated fictional businesses.
- Measure fact precision, important-evidence recall, linking accuracy, applicable-version selection and unsupported conclusions. Establish explicit acceptance thresholds before accepting the evaluation; do not invent calibrated confidence from model labels.
- Initial imports must expose progress and incomplete coverage. Ask owners focused consequential questions, not require approval of every extracted snippet. Unsupported apps and missing capabilities must be visible.
- Test replay, pagination, missed-update reconciliation, deletion and revocation. A connected account does not establish complete or current ingestion.

### Hackathon and hosted acceptance boundaries

For the hackathon: prove one isolated business's real three-or-more-app journey, attributable context, exact approvals, verified external actions, duplicate prevention and restart recovery. If required deposit/resource evidence is absent, label the outcome provisional rather than confirmed. Preserve the broader product requirements as outstanding, not removed.

Before hosted production: specify and verify employee roles and tenant isolation, retention/export/deletion including derived memory, usage limits and backpressure, operational latency/recovery targets, alert ownership, consistent backup restore, migrations and rollback. Infrastructure libraries supply mechanisms, not these product policies.

Record every component decision with its version/edition, license, tested interface, evidence, limitations, and rollback path. Keep implemented, locally tested and live-verified statuses separate in PROGRESS.md.

## Delivery constraints

Keep personal OpenClaw data and configuration untouched.
Do not publish credentials, private customer information, local runtime state, or raw authentication receipts.
Use authorized subscription access without enabling overages, purchasing services, or moving work to cloud execution.
Report explicit accepted gates and component limitations rather than an invented overall completion percentage.
