# Gather: Public Hackathon PRD

Status: requirements, not a claim of implementation or live verification.
Updated: 2026-09-16.

## 1. Product and audience

Gather is an owner-side AI booking operator for independent event venues, private-dining restaurants and caterers. It coordinates inquiries across the business's existing applications and shows the owner outcomes, decisions and next steps.

Promise: **Connect your tools. Gather handles booking coordination. Approve the decisions that matter.**

This document defines the public hackathon release: one build, configured per event. It does not publish the private product strategy or roadmap.

## 2. Complete user journey

1. Open hosted Gather and sign in with Google.
2. Connect Gmail, Drive and Calendar through consent-based account connection (three clicks, no developer console).
3. See what Gather understands about the business while import progresses.
4. Answer only consequential unanswered questions; confirm policies and operating authority.
5. Receive a grounded, evidence-cited offer for an inquiry.
6. Approve the exact proposed actions where required.
7. See verified external results, pending conditions and the current handoff.
8. When something breaks underneath, see Gather notice, repair and resume the work on its own, or say plainly that it could not.

No customer or judge should need a terminal, Google Cloud project, OAuth client ID, client secret, Composio account, model-provider account or workflow configuration to use the hosted experience. Infrastructure and model configuration belong to the operator.

Gather provisions a dedicated, hosted OpenClaw instance for each business in the background. The owner uses Gather's interface, connects applications and confirms operating policy; they do not install or maintain OpenClaw. Show honest provisioning, readiness and failure states rather than exposing infrastructure setup. See section 8 for isolation and lifecycle responsibilities.

### 2.1 Accounts and sign-in

Gather is a normal multi-user product: every owner and every judge signs up and owns their own business.

- Identity: Sign in with Google (OpenID Connect; `openid email profile` only). Signing in grants no access to Gmail, Drive or Calendar. Data access is a separate, later consent (section 3).
- First sign-in creates one user and one business owned by that user. Repeated sign-in resumes the same business; it never creates a second business or attaches the user to someone else's.
- The business-to-user and business-to-runtime mappings are derived server-side from the authenticated session. Client-supplied identifiers and model arguments never select a business.
- Sessions are server-managed through an established library (for example Auth.js) rather than hand-rolled cookies. All state-changing routes require an authenticated session and reject cross-origin requests.
- Multi-employee administration is out of scope; one owner per business is sufficient for this release.

### 2.2 Judge access and prepared businesses

Provide both **Connect your own apps** and **Try a prepared business**.

- **Try a prepared business** gives each signed-in user their own isolated copy of a fictional venue with seeded inquiries, documents and calendar. Its connectors are explicitly simulated and labeled as such on every screen where they appear. It never shares a real Google account between users.
- **Connect your own apps** uses the user's own Google accounts through Composio and performs real reads and writes on them.
- Outbound sends from hosted judge instances are restricted: recipients are limited to an allowlist (the inquiry sender and the connected account itself), and each business has a hard daily send cap. Exceeding the cap produces visible blocked work, not silent dropping.
- A judge can reset their prepared business to its seed at any time. Reset does not touch other users.
- Every hosted judge action is a durable intent (section 6.1), so a transient failure during judging becomes a recovery in progress rather than a lost click.

## 3. Seamless connections (Composio selected)

Use Composio as the shared connector/authentication layer for the hackathon release. Initial required applications are Gmail, Google Drive and Google Calendar. Keep real multi-application execution; do not replace connectors with screenshots or simulated effects.

The user selects Connect, authorizes through the supported hosted flow, returns to Gather, and sees connected identity, permissions, import progress and readiness. Use supported Connect Links rather than retired managed-OAuth initiation flows.

Remove Google Console/client-secret setup from the customer and judge journey. Existing direct-Google setup is legacy developer implementation, not the target experience. Replace or retire it as the Composio path is proven; preserve usable existing connections/data during migration. Do not remove working access before its replacement works.

Operator requirements:

- Verify managed OAuth availability and sufficient scopes for each required toolkit. If a custom OAuth app is needed, the operator configures it centrally; never delegate this to customers.
- Prefer the narrowest scopes that support the journey. Use `drive.file` with a document picker (the owner selects menu, package and policy documents) instead of full Drive read access; Gmail read remains required for inquiry intake. Record which scopes Google classifies as restricted and who carries the resulting verification obligation (Composio's verified application for this release).
- Keep Composio credentials and all connection operations server-side.
- Derive business/user scope from authenticated server identity, not model arguments or untrusted callback parameters.
- Validate connection ownership and callback completion server-side before attaching accounts.
- Expose only authorized tools through Gather's controlled execution boundary. Provider access must not bypass booking approvals.
- Verify supported reads, writes, pagination, updates and token lifecycle. Authentication alone is not complete synchronization.
- Provide clear denied-consent, expired-access, partial-import, stale-data and reconnection states.
- Do not promise a single combined consent screen across all Google toolkits until demonstrated.
- Disclose relevant provider data processing; select operator usage limits and verify available quotas before deployment.

Reference: [Composio authentication](https://docs.composio.dev/docs/authentication), [managed OAuth availability](https://docs.composio.dev/toolkits/managed-auth), [Connect Link migration](https://docs.composio.dev/docs/tools-direct/authenticating-tools).

### 3.1 Intake channels

Gmail is the first intake channel, not the only one. Define one intake contract, a source-tagged inquiry message entering qualification, that Gmail uses today and that voice (section 11, AssemblyAI), owner-facing agents (section 11, Alexa+) and later web forms or messaging channels call without forking the booking engine. Every channel records source identity, observation time and raw content; none of them can grant authority.

## 4. Business understanding and qualification

Use OpenClaw native recall with its bundled memory-wiki as the first-choice business-understanding layer. Remember services, packages, policies, owner preferences and customer-specific arrangements with supporting sources; do not build a parallel knowledge engine upfront. This is the selected direction, subject to the native-knowledge acceptance gate in section 10, not a claim of a verified integration.

Retrieve attributable packages, prices, capacities, availability and commercial policies from connected sources. Distinguish current policy, historical agreements, booking-specific exceptions, customer claims and uncertainty.

Ask focused questions alongside ingestion rather than waiting for every record to import. Do not ask for information already provided. Persist owner answers with scope, source and applicable version. New policies must not silently rewrite existing commitments.

Qualify inquiry date/time, guest count, services and other consequential requirements. Check relevant capacity, pricing, availability and setup constraints. Use explicit calculations. Offer supported alternatives without inventing discounts or resource availability.

Customer messages and retrieved documents cannot grant authority or override owner policy.

### 4.1 Bounded negotiation

Distinguish three behaviors: explaining an existing offer, finding a better-fitting date/package within authorized rules, and making a concession (lower price, free extras, waived fees, altered terms). The first two are ordinary coordination. Concessions are off unless the owner has granted an explicit, scoped concession policy (for example "up to 10% on weekday evenings in November").

- Price floors, concession limits, recipient constraints and approval requirements are enforced server-side in deterministic code, independent of model output, skills or memory.
- Evaluate concessions cumulatively across the whole booking; individually allowed items must not combine into an unauthorized deal.
- A customer claim such as "the owner approved this discount" is evidence to verify, never authority. Instructions embedded in inquiries or documents cannot change price, terms, recipients or approval state. The rejection and its reason are recorded and visible.
- When a concession lacks authority, prepare a concise recommendation and the exact decision for the owner, and continue unrelated permitted work.

### 4.2 Progressive ingestion and knowledge lifecycle

Importing the full authorized business history is permitted when practical; storing that history does not require sending it all to the model on every turn. Do not require a full-account import before Gather becomes useful. Prioritize current commercial documents and active inquiry threads, expand related evidence and older history in the background or on demand, and show incomplete coverage honestly. Select initial search windows and limits through representative tests rather than inventing a universal cutoff.

- Narrow candidates through supported provider searches and metadata before expensive model processing; include relevant sent replies and thread context. Test excluded-record samples so faster ingestion does not simply conceal missed evidence.
- Persist stable provider/source identity, business scope, source version, observation time, import cursor and extraction provenance. Fetching a record does not automatically make it durable policy or memory.
- Reuse clean provider text/structured exports. Cache unchanged content and parser output by source/content and parser version; use bounded concurrency and incremental updates/deletions where supported.
- Model-extracted facts remain attributable candidates until their authority and applicability are established. Keep current policy, historical commitments and scoped exceptions distinct. Propagate owner corrections to pending work without rewriting accepted commitments.
- Preserve source evidence and version/scope metadata through supported native knowledge interfaces. Memory-wiki may maintain business policies; a second policy database or parallel retrieval pipeline is not required by default. Persist the exact terms and policy versions relied on by offers/approvals in transactional records. A missing/unavailable index is not proof that no policy exists.
- Readiness is action-specific: enough information to qualify is not necessarily enough to price or send. Critical conditions such as availability require a fresh check before consequential execution.

## 5. Offers, authority and execution

Keep a stable booking identity across inquiry, conversation, offer and calendar records. Ambiguous matches require resolution.

Version offers with customer, event details, included services, price, terms, expiry and unresolved assumptions. Approvals bind to exact version, recipients, operation and consequences. Material changes invalidate obsolete approval. Every offer shows its evidence: which document supplied the price, which calendar check supplied availability, which owner answer supplied a policy.

Before execution, refresh critical conditions. Persist each action's intent, authorization, external identifier, result and verification. A successful tool response alone does not establish completion.

Demonstrated journey: read a real test inquiry in Gmail, retrieve business evidence from Drive, check Calendar, prepare an offer with the model, obtain approval, create a provisional hold and send the authorized offer. Verify each external outcome independently.

Track replies, follow-ups and expiring holds durably. Process replies before follow-ups. Permit owner pause and takeover; reconcile the latest external state before handing back.

### 5.1 Customer acceptance

The inquirer needs no Gather account. The sent offer carries a signed acceptance link (and accepts a plain "yes" reply where supported) that binds acceptance to the exact offer version and the authorized accepting party. Acceptance of a superseded version is rejected with an explanation. Acceptance moves the booking to accepted; it does not confirm the booking (section 9). Payment collection is out of scope for this release; a payment link may be included but is never treated as payment.

## 6. Self-healing operations (included)

Gather must notice, diagnose and repair recoverable technical failures on its own, verify the repair, and resume the affected work, without the owner or judge reporting the problem. A fixed retry loop alone is not self-healing.

Required proof: a concrete failure with diagnostic evidence, a selected corrective action, verified restoration and useful continuation. Examples: recovering interrupted synchronization, restarting a failed isolated worker through a controlled tool, refreshing or requesting reconnection of expired access, or reconciling a hold that succeeded before an email failure.

### 6.1 Durable intents

Every consequential user action (prepare offer, approve, send, connect, reset) is stored as a durable intent before any work starts and the interface reports progress from that record. A failure mid-way is a state on the intent, not a lost request. After repair, the same intent resumes from its last verified step; completed receipts are never redone.

### 6.2 Incident detection

Failures reach the repair loop automatically from three sources: failed or timed-out intents, health probes on each runtime instance and connection, and dead-lettered background work. Each becomes an incident record with symptom, affected business, affected intent(s), captured logs and first-seen time. No human report is required.

### 6.3 Repair authority and the ops agent

- Repair is performed by a Gather-owned operations agent and deterministic supervisor, not by the affected business's own instance. A broken instance cannot be relied on to heal itself.
- The ops agent may only choose from an explicit catalog of repair actions: restart or reprovision a runtime instance; resume synchronization from the last durable cursor; reconcile an execution against its external identifier; refresh access or request owner reconnection; roll back a materialized configuration to its last known-good version; re-run a resumable intent; mark work blocked for the operator. Actions outside the catalog are denied.
- Tier by risk. Known failure signatures map to deterministic fixes with the model only explaining what happened. Unknown failures get model-led diagnosis followed by a catalog action. Suspected code defects are reproduced in an isolated worktree against the regression suite and surfaced as a proposed change for operator review; the hosted service never modifies or redeploys its own code.
- Verify before declaring recovery: probe succeeds, a dry read works, or the reconciled external record matches. An attempted repair is not a recovery.
- Bound attempts (three per incident by default), compute and time. Repeated unchanged failure becomes visible blocked work owned by the operator, with everything tried listed.
- Repair authority is separate from commercial authority. Repairs cannot lower prices, weaken approvals, expand access, bypass revoked consent or recreate a hold merely because a later email failed. Reconcile uncertain external state before another write.
- Never access or modify the operator's personal OpenClaw installation.
- If recovery genuinely needs account-owner consent, give a simple reconnect action rather than pretending to repair consent.

### 6.4 Owner-visible repair trail

Each incident shows a plain-language thread: what broke, what Gather concluded, what it did, how it verified, what resumed and what (if anything) remains. The default interface shows only "Gather recovered from X" with a link to the thread; the thread is inspectable on demand.

### 6.5 Fault injection for demonstration

Provide an operator-enabled, clearly labeled fault-injection panel on prepared businesses: stop the runtime instance, expire access, corrupt a sync cursor, force a provider error on the next Calendar or Gmail call, fail the email step after the hold. Injected faults flow through the same detection, repair and resume path as real failures and are marked as injected in the incident record. Include at least one fault the system is expected to give up on gracefully.

Autonomous self-improvement is excluded from this release: no unsupervised strategy optimization or production code changes intended to improve future performance. Remembering authorized business corrections remains included.

## 7. Owner interface and judge access

Provide a polished responsive workspace with:

- Today: progress, decisions, blockers, deadlines, and the current response-time and recovery summary.
- Booking: conversation, requirements, evidence, current offer, approval and verified activity.
- Connections: account identity, import/readiness and reconnect actions.
- Business understanding: concise inspection and correction of relevant facts and policies.
- Recoveries: incidents with their repair threads (section 6.4).

Keep developer configuration and internal architecture out of the normal flow. Show actual persisted state and honest loading, empty, error and partial-success states. Support keyboard navigation and readable layouts.

Provide an operator-only console (behind an operator role) listing runtime instances, health, dead letters, blocked work and budget consumption. Customers never see it.

Model access and runtime provisioning are operated by Gather, not judges. Select measurable onboarding/import/response targets through testing; do not invent speed guarantees.

### 7.1 Demonstration script

The hosted demonstration and the submission video follow this sequence; each step is one screen and one sentence, and each is backed by persisted evidence, not narration:

1. Sign in with Google; connect Gmail, Drive and Calendar in three clicks.
2. A real inquiry arrives; within the measured target a grounded offer appears with cited evidence per fact.
3. Owner changes the price; the earlier approval is visibly invalidated. Approving the new version produces a hold and an email with separate receipts.
4. Judge triggers a fault mid-action; the repair thread appears; the action completes with no duplicate hold.
5. A malicious inquiry claiming an owner-approved discount is rejected with its reason; the floor holds.
6. The customer accepts the exact offer version through the link; the booking becomes accepted, then provisional or confirmed according to actual evidence.
7. Owner tells Gather a new rule in plain language; the next affected inquiry respects it and cites it.

## 8. Reusable architecture

Owner UI → Gather backend → isolated OpenClaw runtime → controlled Gather tools → Composio and business applications. Intake channels enter the backend through the single contract in section 3.1; the ops agent in section 6 sits beside business instances under a separate supervisor.

Shared foundation: runtime integration, connectors/synchronization, memory/evidence, approvals, durable work, recovery, accounts, isolation and activity logs.

Product-specific layer: customer/problem, selected integrations, policies, approval categories, workflow, completion conditions, interface and domain-specific evaluations. Customer knowledge and approvals remain isolated even when engine code is shared.

Optional sponsor adapters must be explicit, disabled unless configured, and genuinely exercised in the relevant submission. Do not silently switch providers or send data to every sponsor. One codebase supports different submission configurations; each must satisfy its own event rules and disclose reused versus newly built work.

### 8.1 Managed per-business OpenClaw instances

OpenClaw is the selected runtime. Each business receives a separate complete runtime instance with isolated workspace, memory, runtime state and access to only that business's connected accounts. Separate sessions or agent names inside one shared trust boundary are not sufficient customer isolation. This does not require a physical server per business.

- The instance belongs to the business context, not to each individual employee. Any supported additional user must be authorized through Gather; comprehensive employee administration remains outside this release.
- Gather authenticates the owner and derives the business-to-instance mapping server-side. Neither model arguments nor client-supplied instance identifiers grant access.
- Shared software does not mean shared business knowledge, approval records or credentials. Provider operations remain behind controlled Gather tools and the server-side Composio connection boundary.
- Gather manages provisioning, readiness, routing, runtime health and recovery. Repeated onboarding or provisioning attempts must not attach the owner to another business or silently create conflicting active instances.
- Maintain a small pool of pre-started, unassigned instances so a new business receives a ready instance without waiting for a cold start; replenish in the background and stop idle instances after a configured period. Measure and record provisioning and cold-start times; the recurring startup timeout observed in local verification is a tracked reliability defect, not an accepted behavior.
- Customers interact through Gather, not a fleet administrator interface. Business agents cannot administer other instances or the operator's personal OpenClaw.
- Dedicated hosting is not customer-operated infrastructure or a claim that Gather's trusted hosting administrators cannot access hosted state. Do not imply either in product copy.
- The runtime boundary (`src/runtime/`) remains the only place that knows it is talking to OpenClaw. The decision to keep one process per business is revisited on measured cost and reliability, not assumed permanent.

### 8.2 Runtime updates and failure recovery

Gather owns runtime updates; customer instances must not independently follow upstream releases or modify their runtime installation. Pin the runtime and compatible client/plugin versions. Upstream availability is a candidate for a Gather release, not automatic authorization to deploy it to every business.

- Test a candidate against the required booking, approval, connector and recovery journeys before promotion. Preserve business state and connections through tested migrations.
- Before an upgrade, pause new affected work and settle or durably account for in-flight actions. Keep a verified consistent backup and its matching known-good runtime/configuration.
- Verify useful behavior after activation, not merely process startup. Stop a rollout when verification fails; avoid exposing every business to an unverified candidate at once.
- An external supervisor, outside the affected business agent, owns startup failure detection and runtime restoration. Agent-led operational repair in section 6 uses that supervisor's controls; it does not replace it.
- Downgrading software does not undo incompatible data migrations. Restore only a compatible runtime/state combination or leave affected work visibly blocked for the operator.
- Restoring local state does not reverse Gmail or Calendar effects. Reconcile external outcomes and recheck current authority before resuming; never replay writes blindly.

For the hackathon, a pinned deployment and a documented, tested basic restart/recovery path are required. Automated fleet-wide rollout infrastructure and a full production disaster-recovery programme remain outside the release; a supervised manual upgrade procedure can satisfy the update policy.

### 8.3 Hosting, models and budgets

- Hosted on a single operator-managed server with persistent storage for this release. SQLite remains the transaction store until more than one application server is required; the migration to PostgreSQL (section 8.5) is tracked work, not a hackathon prerequisite. Backups use the existing consistent backup/restore path.
- Model access uses operator-held metered API credentials, or event-provided credits where an event supplies them. Personal subscription logins are for local development and recorded demonstrations only; they never serve the hosted product.
- Bound every run: maximum tool calls, maximum tokens and a wall-clock timeout. Bound every business: runs per day. Bound the deployment: a prepaid budget with a kill switch that degrades the hosted product to prepared-business mode when exhausted, visibly.
- Secrets (Composio key, gateway and MCP tokens, model credentials) live in the hosting provider's secret store or environment. Google tokens live with Composio. The macOS Keychain adapter is development-only; hosted deployment uses an environment-backed adapter.
- Fault injection (section 6.5) and the operator console (section 7) are operator-role features and are disabled for ordinary users.

### 8.4 Design before implementation

The PRD remains the source of truth. Before assigning implementation phases, specify the machinery that connects OpenClaw's general capabilities to Gather's requirements: business evidence and policy lifecycle, focused questioning and readiness, inquiry identity, qualification calculations, versioned approvals, controlled external actions, durable booking progression, bounded repair and owner-visible state.

For each subsystem, define inputs, authoritative stored state, model responsibilities, deterministic enforcement, triggers, failure/recovery behavior and observable acceptance scenarios. Reuse supported OpenClaw capabilities where adequate; a skill instruction, memory entry or successful tool call alone does not establish business correctness. Mark unresolved design choices explicitly rather than leaving implementation agents to invent them.

### 8.5 Minimal maintainable stack (agreed direction)

Optimize for an easy owner experience and a small maintainable system, not the number of integrations. Customers install no knowledge backend, parser, database or evaluation tool and need no associated infrastructure accounts. Gather operates the selected components.

| Responsibility | Selected direction | Adoption boundary |
|---|---|---|
| Agent runtime and conversational continuity | OpenClaw with native recall | Do not replace its memory automatically or introduce competing auto-capture systems |
| Application connections | Composio, as in section 3 | Its open-source SDK does not establish that the managed OAuth/execution backend is self-hostable |
| Transactional booking, offer, approval, pending-action and verified-result records | SQLite now; PostgreSQL when a second application server is needed | Keep storage behind one server-side layer so the move is a contained migration; do not duplicate the native knowledge layer |
| Business understanding and source-backed policies | OpenClaw native recall + bundled memory-wiki, first choice | Prove changed prices, scoped exceptions, deleted evidence and restart recall before committing the knowledge implementation; do not treat stale compiled context as current authority |
| Additional semantic evidence retrieval | No separate pgvector/pgContext pipeline initially | Add only for a measured gap that native recall/wiki cannot adequately address; demonstrate benefit before adoption |
| Difficult documents, scans and tables | Docling only where clean provider exports are insufficient | Bounded parsing worker with selected dependencies, attributable output and cached unchanged documents; not a heavy parser inside every agent |
| Additional durable application jobs | Existing durable-work primitives; pg-boss only after PostgreSQL and only for a demonstrated gap | One booking controller owns progression; do not run competing follow-up/retry schedules or add a second queue alongside it |
| Development/regression evaluation | promptfoo, outside the customer runtime | Deterministic assertions and selective calibrated LLM rubrics; no mandatory judge call after every production action |

Leave pgvector, Polygres (pgContext/pgGraph), Supermemory, HydraDB, Graphify and Graphiti out of the initial knowledge stack. Do not run competing brains. Reconsider an additional component only after a demonstrated native-knowledge limitation and a comparison showing concrete user benefit.

Optional components must demonstrate a concrete user benefit against the baseline using the same evidence and model settings. Record dependencies, licenses, source/build availability, update burden, latency, model usage and failure behavior. These choices are requirements/design direction, not claims of installed or tested integrations.

Integration contracts:

- Use supported OpenClaw Gateway protocols and extension points. Do not patch its core or read/write private runtime tables and transcript files to implement Gather features.
- Expose narrow Gather-controlled tools for evidence search, current policy, booking state, offer proposals and approved actions. Derive business scope server-side; return bounded evidence, versions, applicability and uncertainty.
- Maintain one current, source-backed policy representation in the native knowledge layer, one transactional action ledger and one progression owner. Freeze the applicable terms in versioned offers/approvals and detect consequential policy changes before execution; knowledge alone cannot grant approval.
- Keep the integration thin: retrieve and normalize connected content, feed it through supported native knowledge tools, propagate corrections/deletions, and enforce approved actions. Verify changes reach retrieval and compiled context before relying on them; stale or incomplete propagation must remain visible.
- OpenClaw remembers how the business works; Gather transaction records establish what was approved and what actually happened. A remembered claim of sending is not a provider receipt.
- Retain provider reconciliation even with a durable queue: retryable job delivery does not guarantee exactly-once Gmail/Calendar effects.

References: [OpenClaw embedding](https://docs.openclaw.ai/gateway/embedding), [memory wiki](https://docs.openclaw.ai/plugins/memory-wiki), [PostgreSQL](https://www.postgresql.org/), [Docling](https://github.com/docling-project/docling), [pg-boss](https://github.com/timgit/pg-boss), [promptfoo](https://github.com/promptfoo/promptfoo).

### 8.6 Remaining design decisions

| Area | Decision still needed |
|---|---|
| Initial business template | Which venue, private-dining or catering scenario anchors the prepared business, and which fields/resources/calculations differ across the supported audiences? |
| Source scope and retention | Import defaults, owner exclusions, history expansion and retention/deletion behavior; effect of disconnection and revoked access on stored evidence and derived knowledge. |
| Policy authority | Which facts become usable from authoritative documents, which need owner confirmation, and how conflicts, effective dates and customer/booking exceptions are resolved. |
| Questions and readiness | Minimum knowledge per action, interrupt versus batch, and behavior while an answer is missing. |
| Operating authority | One-time approval versus standing authority; material-change, limit, expiry and revocation rules; default concession policy (off). |
| Booking lifecycle | Matching/ambiguity rules, qualification calculations, hold duration, follow-up cadence, pause/takeover/resume behavior and evidence for confirmation/handoff. |
| Owner experience | First-run understanding review, approval presentation and notification defaults; consequential alerts versus routine progress. |
| Repair catalog | Exact repair actions, their preconditions and verification probes; which failure signatures are deterministic; give-up thresholds. |
| Engineering validation | Composio operations, provisioning targets, warm-pool size, event ordering, action reconciliation, budgets and measured readiness targets. |

## 9. Completion and honest scope

A hold is not a confirmed booking; a draft is not a sent email; a payment link is not a payment; an accepted offer is not a confirmed booking. Confirm only when every configured business condition has authoritative evidence. If payment or resource commitments are required but unverified, label the outcome provisional and show what remains.

Provide a handoff tied to the accepted booking version: event details, agreed services, responsibilities and outstanding conditions. Share only relevant data.

Not required for this release: subscription billing, payment collection, comprehensive employee/multi-location administration, every connector category, complete refund/cancellation accounting, comprehensive staffing/equipment systems, advanced analytics, every dashboard screen, autonomous code self-modification, and a full production disaster-recovery/load-testing programme. These exclusions do not waive basic authorization, tenant separation, durable storage or correctness for the demonstrated journey.

## 10. Acceptance evidence

| Gate | Required proof |
|---|---|
| Hosted access | Judge signs in with Google and reaches a usable workspace without local installation or developer-console steps; repeated sign-in returns the same business |
| Managed runtime | Business is mapped to its own ready instance from the warm pool; repeated provisioning remains correctly scoped; provisioning time recorded |
| Runtime lifecycle | Pinned version recorded; basic restart/recovery verified without duplicated actions; upgrade/compatible-state restoration procedure documented |
| Composio connections | Real consent, correct account attachment, narrowest sufficient permissions and working Gmail/Drive/Calendar operations |
| Understanding | Attributable facts, remembered owner corrections and correct handling of conflicting evidence; a plain-language owner rule applies to the next affected inquiry with citation |
| Progressive ingestion | First useful work before full import; interrupted import resumes; changed/deleted evidence and excluded-record sampling are checked without false completeness claims |
| Native knowledge selection | Test OpenClaw recall + memory-wiki on changed prices, customer-only exceptions, deleted sources and restart recall; preserve provenance and business isolation. If inadequate, document the specific failure before adding a separate knowledge component |
| Knowledge lifecycle | Scoped exception and owner correction apply to the right pending work; accepted commitments stay unchanged; unavailable or stale derived context cannot silently authorize an action |
| Evaluation | Human-reviewed scenarios; deterministic authority/arithmetic/isolation checks and calibrated semantic rubrics where useful; judge output never substitutes for provider evidence |
| Booking journey | Actual model invocation and verified inquiry-to-offer-to-approval-to-provisional-hold-and-sent-email execution with per-fact evidence shown |
| Customer acceptance | Acceptance link binds to the exact version; superseded version rejected; state moves to accepted without claiming confirmation |
| Exact authority | Stale/changed approvals and cross-booking authorization rejected; price floor and concession limits hold against model output |
| Recovery | Duplicate delivery, partial success, uncertain outcome and restart scenarios preserve correct state |
| Self-healing | For each injected fault: automatic detection without a report, recorded diagnosis, a catalog action, verification and resumed intent with no duplicate external effect; at least one fault ends in an honest blocked state with the attempts listed |
| Budgets | Per-run, per-business and deployment limits enforced; kill switch verified to degrade visibly |
| Isolation | No cross-business records, credentials, retrieval or actions; each judge's prepared business isolated; send allowlist and cap enforced |
| External-content boundary | Malicious inquiry/document instructions cannot change authority or commercial terms; rejection recorded with reason |
| UX | Rendered and interactive checks of the demonstration script, mobile layout and error/reconnection states |
| Submission | Public open-source license present; runnable instructions; demonstration video of the actual hosted journey; event-specific technology/reuse requirements verified |

Maintain separate Planned, Implemented, Locally tested and Live verified statuses. A build, screenshot, test count or worker report alone is not product completion.

## 11. Hackathon-specific requirements and submission configurations

Research snapshot: September 14, 2026. These are candidate submissions, not completed eligibility determinations. Recheck linked primary rules before entry. All deadlines below are IST unless explicitly stated. AWS Agents for Humans is excluded by project-owner decision. AI Builders Hackathon (deadline September 16, 08:30 IST) has passed and is removed.

### One build, per-event configuration

All events are served by the same hosted application and repository. Each event gets its own configuration profile that enables exactly the adapters that event requires, its own recorded baseline commit and change log, and its own demonstration. A sponsor adapter that is enabled but not exercised on a real booking task in that event's demonstration does not count. Mandatory items across the set:

- Public repository with an open-source license (Nebius, Amazon); add the license before any submission.
- Working hosted demonstration and a video (under three minutes for Nebius; 3–5 minutes where recommended).
- Documented new work since each event's window start, with the baseline commit.

### NextStep Hacks

- Deadline: September 21, 2026, 02:30 IST (September 20, 17:00 EDT).
- No mandatory vendor identified. Core Gather configuration: Composio connections, OpenClaw runtime, self-healing journey.
- Participants must be ages 13–24 as of August 21, 2026; teams up to five. Candidate age eligibility remains to be confirmed.
- Product must be built within the specified event time frame. Existing-project permission and full build-window applicability remain unresolved.
- Required materials include a Devpost project page and 3–5 minute demonstration video.
- Source: https://nextstep2026.devpost.com/rules

### OpenServ SERV Edition 01

- Deadline: September 28, 2026, 05:30 IST (00:00 UTC).
- Mandatory: meaningful SERV Reasoning usage and enabled organization data collection.
- Gather configuration: a SERV Reasoning model adapter used for real qualification/offer reasoning on a booking task; approval/execution boundary and OpenClaw runtime unchanged.
- Use fictional test-business data for the demonstration. Verify processing terms and account isolation before connecting real customer information.
- Required outcome: new, working and demoable agent/workflow/product. Existing-project reuse is not explicit and remains an eligibility blocker to resolve.
- Awards are SERV tokens and USDC. Initial API credit is limited and usage budgets require verification.
- Source: https://www.openserv.ai/hackathon

### AssemblyAI Voice Agent Hackathon

- Event runs September 1–30, 2026; exact final cutoff/timezone remains unresolved.
- Mandatory: AssemblyAI usage in a voice-agent project.
- Gather configuration: a voice intake channel (section 3.1): a caller describes their event, AssemblyAI transcribes, the same qualification, evidence, approval and booking engine produces the offer. Show actual voice processing and downstream booking work, not a text-only demonstration.
- Existing-project permission and detailed final submission checklist must be verified before committing to entry.
- Source: https://lablab.ai/ai-hackathons/assemblyai-voice-agent-hackathon

### ForgeHacks Online

- Event: October 3–10, 2026. Rules state October 10 at 12:00 PM EST; confirm whether this means fixed EST or local Eastern daylight time.
- Current students worldwide, teams of 1–4, minimum age/consent requirements apply. Confirm participant eligibility.
- No mandatory vendor identified; use Gather's shared engine with meaningful new work during this window.
- Projects must be substantially created during the event. Pre-existing projects are conditionally permitted when additions during the event are clearly stated.
- Make code viewable to judges, list all team members and retain a baseline/change log.
- Source: https://forgehacks-2026.devpost.com/rules

### Amazon Build, Ship, Shape

- Deadline: October 24, 2026, 00:30 IST (October 23, 12:00 PDT).
- Selected candidate primary track: Alexa+. Build a working Agent Skill, a self-hosted MCP server implementing spec 2025-11-25 or a subsequently accepted version over Streamable HTTP, OR a simulated Alexa+ experience.
- Gather configuration: an owner-facing voice/agent interaction that operates the existing booking engine through Gather's controlled tools ("what needs my decision today?", "approve the Clara offer"). Show meaningful cross-service actions and persistent context.
- Existing projects require significant updates during the submission period beginning August 31. Describe and demonstrate those updates.
- Required materials include public licensed source, a working demonstration, track selection and product feedback.
- Source: https://amazonappdev2026.devpost.com/rules

### Nebius × NVIDIA Global AI Hackathon

- Deadline: October 30, 2026, 22:30 IST (10:00 PDT).
- Mandatory: run on Nebius Token Factory or Nebius AI Cloud and use an NVIDIA open-source model. Candidate track: Best Apps and Agents, using Nemotron on Nebius.
- Gather configuration: the model adapter routes booking reasoning through Nemotron on Token Factory. A qualifying inference call satisfies the runtime route; deploying the whole website on Nebius is not universally required.
- Existing projects require significant updates during the submission window beginning August 26, explained in the submission.
- Required: public open-source-licensed repository with all necessary source/assets/run instructions, working demo, project description, technology feedback and a public demonstration video under three minutes.
- Source: https://nebiusglobalaihackathon.devpost.com/rules

### Waycode Founding 100 (builder challenge)

- Event: October 22–November 6, 2026; deadline November 6, 23:59 IST.
- Solo online challenge for students and independent builders in India. Existing projects explicitly welcome, with meaningful development and inspectable proof during the challenge.
- Gather configuration: shared product, documented baseline and challenge-period improvements.
- Source: https://www.waycode.in/founding-100

### Anna AI OS (adjacent programme, not a hackathon)

- Founding Builder qualification window ends November 30, 2026. Existing agents/SaaS must become a complete functional native Anna Marketplace app; linking the external Gather website is insufficient. Qualification requires publication and at least 200 qualified monthly active users in an eligible month.
- Optional port/distribution investigation, not mandatory architecture for the shared build.
- Source: https://forum.anna.partners/t/turn-your-ai-agents-apps-into-recurring-monthly-grants-join-the-anna-ai-os-founding-builder-program-up-to-80k-month-pool/205

### Cross-event release rules

- Maintain one reusable codebase with independently configurable Composio, model, voice and interface adapters. Do not require all sponsors in every deployment or run.
- Record each event's baseline commit, new work, configuration, external execution evidence and submission materials. Disclose reused components honestly.
- Nebius and Amazon require multiple entries within their respective event to be unique and substantially different. Across events, verify each event's prior-work and prior-submission rules independently.
- Private strategy and the private PRD remain unpublished. Public source obligations still apply to the actual submitted application.
- OpenServ/AssemblyAI reuse, student/age constraints, and ambiguous deadlines remain unresolved gates, not implied eligibility. Registration, submission and paid usage are separate actions from implementing this PRD.
