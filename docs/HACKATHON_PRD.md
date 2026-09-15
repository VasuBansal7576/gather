# Gather — Public Hackathon PRD

Status: requirements, not a claim of implementation or live verification.
Updated: 2026-09-15.

## 1. Product and audience

Gather is an owner-side AI booking operator for independent event venues, private-dining restaurants and caterers. It coordinates inquiries across the business's existing applications and shows the owner outcomes, decisions and next steps.

Promise: **Connect your tools. Gather handles booking coordination. Approve the decisions that matter.**

This document defines the public hackathon release. It does not publish the private product strategy or roadmap.

## 2. Complete user journey

1. Open hosted Gather and sign in.
2. Connect business applications through consent-based account connection.
3. See what Gather understands about the business while import progresses.
4. Answer only consequential unanswered questions; confirm policies and operating authority.
5. Receive a grounded offer for an inquiry.
6. Approve the exact proposed actions where required.
7. See verified external results, pending conditions and the current handoff.

No customer or judge should need a terminal, Google Cloud project, OAuth client ID, client secret, Composio account, model-provider account or workflow configuration to use the hosted experience. Infrastructure and model configuration belong to the operator.

Gather provisions a dedicated, hosted OpenClaw instance for each business in the background. The owner uses Gather's interface, connects applications and confirms operating policy; they do not install or maintain OpenClaw. Show honest provisioning, readiness and failure states rather than exposing infrastructure setup. See section 8 for isolation and lifecycle responsibilities.

## 3. Seamless connections — Composio selected

Use Composio as the shared connector/authentication layer for the hackathon release. Initial required applications are Gmail, Google Drive and Google Calendar. Keep real multi-application execution; do not replace connectors with screenshots or simulated effects.

The user selects Connect, authorizes through the supported hosted flow, returns to Gather, and sees connected identity, permissions, import progress and readiness. Use supported Connect Links rather than retired managed-OAuth initiation flows.

Remove Google Console/client-secret setup from the customer and judge journey. Existing direct-Google setup is legacy developer implementation, not the target experience. Replace or retire it as the Composio path is proven; preserve usable existing connections/data during migration. Do not remove working access before its replacement works.

Operator requirements:

- Verify managed OAuth availability and sufficient scopes for each required toolkit. If a custom OAuth app is needed, the operator configures it centrally; never delegate this to customers.
- Keep Composio credentials and all connection operations server-side.
- Derive business/user scope from authenticated server identity, not model arguments or untrusted callback parameters.
- Validate connection ownership and callback completion server-side before attaching accounts.
- Expose only authorized tools through Gather's controlled execution boundary. Provider access must not bypass booking approvals.
- Verify supported reads, writes, pagination, updates and token lifecycle. Authentication alone is not complete synchronization.
- Provide clear denied-consent, expired-access, partial-import, stale-data and reconnection states.
- Do not promise a single combined consent screen across all Google toolkits until demonstrated.
- Disclose relevant provider data processing; select operator usage limits and verify available quotas before deployment.

Reference: [Composio authentication](https://docs.composio.dev/docs/authentication), [managed OAuth availability](https://docs.composio.dev/toolkits/managed-auth), [Connect Link migration](https://docs.composio.dev/docs/tools-direct/authenticating-tools).

## 4. Business understanding and qualification

Retrieve attributable packages, prices, capacities, availability and commercial policies from connected sources. Distinguish current policy, historical agreements, booking-specific exceptions, customer claims and uncertainty.

Ask focused questions alongside ingestion rather than waiting for every record to import. Do not ask for information already provided. Persist owner answers with scope, source and applicable version. New policies must not silently rewrite existing commitments.

Qualify inquiry date/time, guest count, services and other consequential requirements. Check relevant capacity, pricing, availability and setup constraints. Use explicit calculations. Offer supported alternatives without inventing discounts or resource availability.

Customer messages and retrieved documents cannot grant authority or override owner policy. No unrestricted negotiation: commercial flexibility must be explicitly owner-authorized and enforced outside the model.

### 4.1 Progressive ingestion and knowledge lifecycle

Do not require a full-account import before Gather becomes useful. Prioritize current commercial documents and active inquiry threads, expand related evidence and older history in the background or on demand, and show incomplete coverage honestly. Select initial search windows and limits through representative tests rather than inventing a universal cutoff.

- Narrow candidates through supported provider searches and metadata before expensive model processing; include relevant sent replies and thread context. Test excluded-record samples so faster ingestion does not simply conceal missed evidence.
- Persist stable provider/source identity, business scope, source version, observation time, import cursor and extraction provenance. Fetching a record does not automatically make it durable policy or memory.
- Reuse clean provider text/structured exports. Cache unchanged content and parser output by source/content and parser version; use bounded concurrency and incremental updates/deletions where supported.
- Model-extracted facts remain attributable candidates until their authority and applicability are established. Keep current policy, historical commitments and scoped exceptions distinct. Propagate owner corrections to pending work without rewriting accepted commitments.
- Preserve canonical evidence and authoritative structured business records independently of derived summaries, graphs or vector indexes. A missing/unavailable index is not proof that no policy exists.
- Readiness is action-specific: enough information to qualify is not necessarily enough to price or send. Critical conditions such as availability require a fresh check before consequential execution.

## 5. Offers, authority and execution

Keep a stable booking identity across inquiry, conversation, offer and calendar records. Ambiguous matches require resolution.

Version offers with customer, event details, included services, price, terms, expiry and unresolved assumptions. Approvals bind to exact version, recipients, operation and consequences. Material changes invalidate obsolete approval.

Before execution, refresh critical conditions. Persist each action's intent, authorization, external identifier, result and verification. A successful tool response alone does not establish completion.

Demonstrated journey: read a real test inquiry in Gmail, retrieve business evidence from Drive, check Calendar, prepare an offer with the model, obtain approval, create a provisional hold and send the authorized offer. Verify each external outcome independently.

Track replies, follow-ups and expiring holds durably. Process replies before follow-ups. Permit owner pause and takeover. Recheck current authority after restart.

## 6. Self-fixing OpenClaw — included

Detailed repair design is deferred until the core knowledge, authority and booking behavior is specified. This sequencing decision does not remove the requirements or acceptance gate below.

Gather must use its isolated OpenClaw runtime to detect, diagnose and repair recoverable technical blockers within explicit authority, verify recovery, and resume affected booking work. A fixed retry loop alone is not the complete self-fixing demonstration.

Required proof includes a concrete failure with diagnostic evidence, a selected corrective action, verified restoration and useful continuation. Examples include recovering interrupted synchronization, restarting a failed isolated worker through a controlled tool, or reconciling a hold that succeeded before an email failure.

- Preserve successful action receipts; never recreate a hold merely because a later email failed.
- Reconcile uncertain external state before another write.
- Bound retries and repair attempts. Repeated unchanged failure becomes visible blocked work owned by the operator.
- Keep repair authority separate from commercial authority. Repairs cannot lower prices, weaken approvals, expand access or bypass revoked consent.
- Never access or modify the operator's personal OpenClaw installation.
- If reconnection needs account-owner consent, give a simple reconnect action rather than pretending to repair consent.
- Record diagnosis, action, verification and remaining impact in the activity trail.

Autonomous self-improvement is excluded: no unsupervised strategy optimization or production code changes intended to improve future performance. Remembering authorized business corrections remains included. The required self-fixing demonstration uses bounded operational repairs, not unrestricted self-modification.

## 7. Owner interface and judge access

Provide a polished responsive workspace with:

- Today: progress, decisions, blockers and deadlines.
- Booking: conversation, requirements, evidence, current offer, approval and verified activity.
- Connections: account identity, import/readiness and reconnect actions.
- Business understanding: concise inspection and correction of relevant facts and policies.

Keep developer configuration and internal architecture out of the normal flow. Show actual persisted state and honest loading, empty, error and partial-success states. Support keyboard navigation and readable layouts.

Provide both Connect your own apps and Try a prepared business. The latter uses an isolated fictional business with authorized test accounts and real integrations; it must not expose personal inboxes or allow unrestricted messaging. Disclose seeded data. Keep simulated fallback demonstrations visibly separate from live execution.

Model access and runtime provisioning are operated by Gather, not judges. Select measurable onboarding/import/response targets through testing; do not invent speed guarantees.

## 8. Reusable architecture

Owner UI → Gather backend → isolated OpenClaw runtime → controlled Gather tools → Composio and business applications.

Shared foundation: runtime integration, connectors/synchronization, memory/evidence, approvals, durable work, recovery, accounts, isolation and activity logs.

Product-specific layer: customer/problem, selected integrations, policies, approval categories, workflow, completion conditions, interface and domain-specific evaluations. Customer knowledge and approvals remain isolated even when engine code is shared.

Optional sponsor adapters must be explicit, disabled unless configured, and genuinely exercised in the relevant submission. Do not silently switch providers or send data to every sponsor. One codebase can support different submission configurations; each must satisfy its own event rules and disclose reused versus newly built work.

### 8.1 Managed per-business OpenClaw instances

OpenClaw is the selected runtime. Each business receives a separate complete runtime instance with isolated workspace, memory, runtime state and access to only that business's connected accounts. Separate sessions or agent names inside one shared trust boundary are not sufficient customer isolation. This does not require a physical server per business.

- The instance belongs to the business context, not to each individual employee. Any supported additional user must be authorized through Gather; comprehensive employee administration remains outside this release.
- Gather authenticates the owner and derives the business-to-instance mapping server-side. Neither model arguments nor client-supplied instance identifiers grant access.
- Shared software does not mean shared business knowledge, approval records or credentials. Provider operations remain behind controlled Gather tools and the server-side Composio connection boundary.
- Gather manages provisioning, readiness, routing, runtime health and recovery. Repeated onboarding or provisioning attempts must not attach the owner to another business or silently create conflicting active instances.
- Customers interact through Gather, not a fleet administrator interface. Business agents cannot administer other instances or the operator's personal OpenClaw.
- Dedicated hosting is not customer-operated infrastructure or a claim that Gather's trusted hosting administrators cannot access hosted state. Do not imply either in product copy.

### 8.2 Runtime updates and failure recovery

Gather owns runtime updates; customer instances must not independently follow upstream releases or modify their runtime installation. Pin the runtime and compatible client/plugin versions. Upstream availability is a candidate for a Gather release, not automatic authorization to deploy it to every business.

- Test a candidate against the required booking, approval, connector and recovery journeys before promotion. Preserve business state and connections through tested migrations.
- Before an upgrade, pause new affected work and settle or durably account for in-flight actions. Keep a verified consistent backup and its matching known-good runtime/configuration.
- Verify useful behavior after activation, not merely process startup. Stop a rollout when verification fails; avoid exposing every business to an unverified candidate at once.
- An external supervisor, outside the affected business agent, owns startup failure detection and runtime restoration. Agent-led operational repair in section 6 remains separate from platform recovery.
- Downgrading software does not undo incompatible data migrations. Restore only a compatible runtime/state combination or leave affected work visibly blocked for the operator.
- Restoring local state does not reverse Gmail or Calendar effects. Reconcile external outcomes and recheck current authority before resuming; never replay writes blindly.

For the hackathon, a pinned deployment and a documented, tested basic restart/recovery path are required. Automated fleet-wide rollout infrastructure and a full production disaster-recovery programme remain outside the release; a supervised manual upgrade procedure can satisfy the update policy.

### 8.3 Design before implementation

The PRD remains the source of truth. Before assigning implementation phases, specify the machinery that connects OpenClaw's general capabilities to Gather's requirements: business evidence and policy lifecycle, focused questioning and readiness, inquiry identity, qualification calculations, versioned approvals, controlled external actions, durable booking progression, bounded repair and owner-visible state.

For each subsystem, define inputs, authoritative stored state, model responsibilities, deterministic enforcement, triggers, failure/recovery behavior and observable acceptance scenarios. Reuse supported OpenClaw capabilities where adequate; a skill instruction, memory entry or successful tool call alone does not establish business correctness. Mark unresolved design choices explicitly rather than leaving implementation agents to invent them. The earlier delivery outline is not an approved implementation specification.

### 8.4 Minimal maintainable stack — agreed direction

Optimize for an easy owner experience and a small maintainable system, not the number of integrations. Customers install no knowledge backend, parser, database or evaluation tool and need no associated infrastructure accounts. Gather operates the selected components.

| Responsibility | Selected direction | Adoption boundary |
|---|---|---|
| Agent runtime and conversational continuity | OpenClaw with native recall | Do not replace its memory automatically or introduce competing auto-capture systems |
| Application connections | Composio, as in section 3 | Its open-source SDK does not establish that the managed OAuth/execution backend is self-hostable |
| Authoritative business, evidence, booking, approval and action records | PostgreSQL is the preferred hosted target | Validate deployment topology, isolation, backups and migration before implementation; do not migrate working storage merely to add an extension |
| Curated derived knowledge | Evaluate bundled OpenClaw memory-wiki first, only if useful | Not a bulk mailbox/PDF ingestion engine or automatic semantic policy-conflict resolver; current authority must not depend solely on delayed compilation |
| Additional semantic evidence retrieval | pgvector only for a demonstrated retrieval gap | Reuse PostgreSQL if selected; do not duplicate native conversational recall without a distinct need |
| Difficult documents, scans and tables | Docling only where clean provider exports are insufficient | Bounded parsing worker with selected dependencies, attributable output and cached unchanged documents; not a heavy parser inside every agent |
| Additional durable application jobs | pg-boss only if PostgreSQL is selected and existing runtime primitives leave a gap | One booking controller owns progression; do not run competing follow-up/retry schedules or add a second queue alongside it |
| Development/regression evaluation | promptfoo, outside the customer runtime | Deterministic assertions and selective calibrated LLM rubrics; no mandatory judge call after every production action |

Do not include Supermemory, HydraDB or Graphify as default customer knowledge infrastructure. Supermemory remains a conditional evaluation candidate after verifying the actual engine source/build, deployment and behavior; its OpenClaw plugin changes memory/prompt behavior and is not merely a search tool. HydraDB is deferred until a concrete graph-storage need justifies its operational cost. Graphify-Labs/graphify is omitted from the customer knowledge stack. Graphiti is a conditional temporal/relationship retrieval challenger, not an additional default service. Do not combine overlapping brains merely because they are open source.

Optional components must demonstrate a concrete user benefit against the baseline using the same evidence and model settings. Record dependencies, licenses, source/build availability, update burden, latency, model usage and failure behavior; an SDK license, a published binary or repository activity alone does not prove complete platform source availability or runtime suitability. These choices are requirements/design direction, not claims of installed or tested integrations.

Integration contracts:

- Use supported OpenClaw Gateway protocols and extension points. Do not patch its core or read/write private runtime tables and transcript files to implement Gather features.
- Expose narrow Gather-controlled tools for evidence search, current policy, booking state, offer proposals and approved actions. Derive business scope server-side; return bounded evidence, versions, applicability and uncertainty.
- Keep one authoritative policy record, one action ledger and one progression owner. Derived knowledge must not mint approval, override current policy or independently schedule commercial work.
- Retain provider reconciliation even with a durable queue: retryable job delivery does not guarantee exactly-once Gmail/Calendar effects.

References: [OpenClaw embedding](https://docs.openclaw.ai/gateway/embedding), [memory wiki](https://docs.openclaw.ai/plugins/memory-wiki), [PostgreSQL](https://www.postgresql.org/), [pgvector](https://github.com/pgvector/pgvector), [Docling](https://github.com/docling-project/docling), [pg-boss](https://github.com/timgit/pg-boss), [promptfoo](https://github.com/promptfoo/promptfoo).

### 8.5 Remaining design decisions

The questions below remain open; they are not reasons to reopen the settled runtime choice or install all candidate libraries. Resolve them through worked booking scenarios before deriving implementation phases.

| Area | Decision still needed |
|---|---|
| Initial business template | Which venue, private-dining or catering scenario anchors the first complete journey, and which fields/resources/calculations differ across the supported audiences? This does not silently exclude the other audiences. |
| Source scope and retention | What import defaults, owner exclusions, history expansion and retention/deletion behavior apply? How do disconnection and revoked access affect stored evidence and derived knowledge? |
| Policy authority | Which facts can become usable from authoritative documents, which need owner confirmation, and how are conflicts, effective dates and customer/booking exceptions resolved? |
| Questions and readiness | What is the minimum knowledge for each action, when should Gather interrupt versus batch questions, and how does it proceed while an answer is missing? |
| Operating authority | Which actions require one-time approval versus explicit standing authority; what material changes, limits, expiry and revocation rules apply? |
| Booking lifecycle | Exact matching/ambiguity rules, qualification calculations, hold duration, follow-up cadence, negotiation limits, pause/takeover/resume behavior and evidence required for confirmation/handoff. |
| Owner experience | Exact first-run understanding review, approval presentation and notification defaults; distinguish consequential alerts from routine background progress. |
| Engineering validation | Verify selected Composio operations, data topology/migration, runtime/tool contracts, event ordering, action reconciliation, optional-library need, budgets and measured readiness targets. These are engineering responsibilities, not customer setup choices. |
| Later repair design | Supported repair contracts and supervisor controls remain to be specified after the above core behavior, within section 6. |

Separate product decisions from business-specific policies collected from each owner and from technical choices resolved through evidence. The product owner should not have to pick chunk sizes, database indexes or retry algorithms to make progress.

## 9. Completion and honest scope

A hold is not a confirmed booking; a draft is not a sent email; a payment link is not a payment. Confirm only when every configured business condition has authoritative evidence. If payment or resource commitments are required but unverified, label the outcome provisional and show what remains.

Provide a handoff tied to the accepted booking version: event details, agreed services, responsibilities and outstanding conditions. Share only relevant data.

Not required for this release: subscription billing, comprehensive employee/multi-location administration, every connector category, complete refund/cancellation accounting, comprehensive staffing/equipment systems, advanced analytics, every dashboard screen, and a full production disaster-recovery/load-testing programme. These exclusions do not waive basic authorization, tenant separation, durable storage or correctness for the demonstrated journey.

## 10. Acceptance evidence

| Gate | Required proof |
|---|---|
| Hosted access | Judge reaches a usable workspace without local installation or developer-console steps |
| Managed runtime | Business is mapped to its own ready instance; repeated provisioning remains correctly scoped; customers need no runtime administration |
| Runtime lifecycle | Pinned version recorded; basic restart/recovery verified without duplicated actions; upgrade/compatible-state restoration procedure documented |
| Composio connections | Real consent, correct account attachment, sufficient permissions and working Gmail/Drive/Calendar operations |
| Understanding | Attributable facts, remembered owner corrections and correct handling of conflicting evidence |
| Progressive ingestion | First useful work before full import; interrupted import resumes; changed/deleted evidence and excluded-record sampling are checked without false completeness claims |
| Knowledge lifecycle | Scoped exception and owner correction apply to the right pending work; accepted commitments stay unchanged; unavailable or stale derived context cannot silently authorize an action |
| Evaluation | Human-reviewed scenarios; deterministic authority/arithmetic/isolation checks and calibrated semantic rubrics where useful; judge output never substitutes for provider evidence |
| Booking journey | Actual model invocation and verified inquiry-to-offer-to-provisional-hold execution |
| Exact authority | Stale/changed approvals and cross-booking authorization rejected |
| Recovery | Duplicate delivery, partial success, uncertain outcome and restart scenarios preserve correct state |
| Self-fixing | Actual diagnosis, bounded corrective action, verification and resumed work after an injected technical failure |
| Isolation | No cross-business records, credentials, retrieval or actions; prepared judge data isolated |
| External-content boundary | Malicious inquiry/document instructions cannot change authority or commercial terms |
| UX | Rendered and interactive checks of main journey, mobile layout and error/reconnection states |
| Submission | Runnable instructions, demo and event-specific technology/reuse requirements verified |

Maintain separate Planned, Implemented, Locally tested and Live verified statuses. A build, screenshot, test count or worker report alone is not product completion. This PRD introduces requirements; Composio migration and hosted onboarding must not be reported complete until those gates pass.

## 11. Hackathon-specific requirements and submission configurations

Research snapshot: September 14, 2026. These are candidate submissions, not completed eligibility determinations. Recheck linked primary rules before entry. All deadlines below are IST unless explicitly stated. AWS Agents for Humans is excluded by project-owner decision.

### AI Builders Hackathon

- Deadline: September 16, 2026, 08:30 IST (September 15, 23:00 EDT).
- Mandatory theme: AI, agentic AI or intelligent systems. No mandatory vendor identified in published rules.
- Gather configuration: shared booking engine, OpenClaw, Composio connections and self-fixing journey; no extra sponsor adapter needed.
- Required materials: public source repository, project description, demo video (3–5 minutes recommended), documentation and team details.
- Eligibility gate: submitted work must have been created during the event window beginning August 21. Audit actual development history; a recent push does not establish eligibility. Existing-project reuse is not explicitly authorized.
- Source: https://ai-builders-hackathon-2026.devpost.com/rules

### NextStep Hacks

- Deadline: September 21, 2026, 02:30 IST (September 20, 17:00 EDT).
- No mandatory vendor identified. Use the same core Gather configuration.
- Participants must be ages 13–24 as of August 21, 2026; teams up to five. Candidate age eligibility remains to be confirmed.
- Product must be built within the specified event time frame. Existing-project permission and full build-window applicability remain unresolved.
- Required materials include a Devpost project page and 3–5 minute demonstration video.
- Source: https://nextstep2026.devpost.com/rules

### OpenServ SERV Edition 01

- Deadline: September 28, 2026, 05:30 IST (00:00 UTC).
- Mandatory: meaningful SERV Reasoning usage and enabled organization data collection.
- Gather configuration: a separately selected SERV Reasoning adapter used for a real booking task; preserve Gather's approval/execution boundary and OpenClaw runtime. Do not add an unused sponsor call.
- Use fictional test-business data for the demonstration. Verify processing terms and account isolation before connecting real customer information.
- Required outcome: new, working and demoable agent/workflow/product. Existing-project reuse is not explicit and remains an eligibility blocker to resolve.
- Awards are SERV tokens and USDC, not an equivalent advertised cash total. No application fee stated; initial API credit is limited and usage budgets require verification.
- Source: https://www.openserv.ai/hackathon

### AssemblyAI Voice Agent Hackathon

- Event runs September 1–30, 2026; exact final cutoff/timezone remains unresolved.
- Mandatory: AssemblyAI usage in a voice-agent project.
- Gather configuration: voice inquiry intake connected to the same qualification, evidence, approval and booking engine. Show actual voice processing and downstream booking work, not a text-only demonstration.
- Existing-project permission and detailed final submission checklist must be verified before committing to entry. Worldwide online participation is advertised.
- Source: https://lablab.ai/ai-hackathons/assemblyai-voice-agent-hackathon

### ForgeHacks Online

- Event: October 3–10, 2026. Rules state October 10 at 12:00 PM EST; confirm whether this means fixed EST or local Eastern daylight time before converting the deadline.
- Current students worldwide, teams of 1–4, minimum age/consent requirements apply. Confirm participant eligibility.
- No mandatory vendor identified; use Gather's shared engine with meaningful new work during this window.
- Projects must be substantially created during the event. The rules conditionally permit pre-existing projects when additions during the event are clearly stated; this is not permission for an unchanged resubmission.
- Make code viewable to judges, list all team members and retain a baseline/change log. Verify the final submission form's required materials.
- Source: https://forgehacks-2026.devpost.com/rules

### Amazon Build, Ship, Shape

- Deadline: October 24, 2026, 00:30 IST (October 23, 12:00 PDT).
- Selected candidate primary track: Alexa+. Build a working Agent Skill, a self-hosted MCP server implementing spec 2025-11-25 or a subsequently accepted version over Streamable HTTP, OR a simulated Alexa+ experience using the entrant's own AI/agentic tools. The simulation alternative does not require a specific framework, SDK or MCP interface.
- Gather configuration: owner-facing agent interaction that operates the existing booking engine. Show meaningful cross-service actions and persistent context; generic AWS usage alone is not a primary-track submission.
- Existing projects require significant updates during the submission period beginning August 31. Describe and demonstrate those updates.
- Required materials include public licensed source, a working demonstration, track selection and product feedback describing actual technology usage. Recheck exact demo limits and repository conditions before submission.
- AWS Builder and Open Source mini challenges are optional additions, not substitutes for a primary track; do not add unrelated infrastructure solely for an optional award.
- Source: https://amazonappdev2026.devpost.com/rules

### Nebius × NVIDIA Global AI Hackathon

- Deadline: October 30, 2026, 22:30 IST (10:00 PDT).
- Mandatory: run on Nebius Token Factory or Nebius AI Cloud and use an NVIDIA open-source model. Candidate track: Best Apps and Agents, using Nemotron on Nebius as specified by the track.
- Gather configuration: genuine booking reasoning through the Nebius model adapter. A qualifying Token Factory inference call can satisfy the runtime route; deploying the whole website on Nebius is not universally required.
- Existing projects require significant updates during the submission window beginning August 26, explained in the submission.
- Required: public open-source-licensed repository containing all necessary source/assets/run instructions, working demo or test build, project description, technology feedback and a public demonstration video under three minutes. A private essential dependency must not prevent the submitted project from meeting these requirements.
- City-specific awards require attendance; do not assume remote participation qualifies for those awards. Overall eligibility has separate terms.
- Source: https://nebiusglobalaihackathon.devpost.com/rules

### Waycode Founding 100 — builder challenge

- Event: October 22–November 6, 2026; deadline November 6, 23:59 IST.
- Solo online challenge for students and independent builders in India.
- Existing projects explicitly welcome, with meaningful development and inspectable proof during the challenge.
- No universal sponsor technology requirement identified. A sponsor-specific award such as Best Use of Render requires the relevant technology for that award only.
- Gather configuration: shared product, with a documented baseline and challenge-period improvements. Provide inspectable demo/repository/build-log evidence as required by final instructions.
- Published rewards include credits/subscriptions/certificates, not an established cash-prize pool.
- Source: https://www.waycode.in/founding-100

### Anna AI OS — adjacent programme, not a hackathon

- Founding Builder qualification window ends November 30, 2026; exact final cutoff must be checked.
- Existing agents/SaaS can be adapted, but must become a complete functional native Anna Marketplace app with UI/backend. Linking the external Gather website is insufficient.
- Qualification requires approval/publication and at least 200 qualified monthly active users in an eligible month, alongside maintenance and programme rules. Grants are conditional, not guaranteed winnings.
- This is an optional port/distribution investigation, not mandatory architecture for the shared hackathon build. Verify platform/runtime compatibility, terms and payment eligibility before adoption.
- Source: https://forum.anna.partners/t/turn-your-ai-agents-apps-into-recurring-monthly-grants-join-the-anna-ai-os-founding-builder-program-up-to-80k-month-pool/205

### Cross-event release rules

- Maintain one reusable codebase with independently configurable Composio, model, voice and interface adapters. Do not require all sponsors in every deployment or run.
- Record each event's baseline commit, new work, configuration, external execution evidence and submission materials. Disclose reused components honestly.
- Nebius and Amazon require multiple entries within their respective event to be unique and substantially different. Renaming or reskinning is not sufficient. Across events, verify each event's prior-work and prior-submission rules independently.
- Private strategy and the private PRD remain unpublished. Public source obligations still apply to the actual submitted application.
- OpenServ/AssemblyAI reuse, student/age constraints, and ambiguous deadlines remain unresolved gates, not implied eligibility. Registration, submission and paid usage are separate actions from implementing this PRD.
