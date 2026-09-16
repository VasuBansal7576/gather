# Gather: Public Hackathon PRD

Status: reconciled product direction; future requirements, not a claim of implementation or live verification. Feature implementation is paused by the owner; this document and the ADRs are not execution authorization. See [repository design conflicts](README.md#design-conflicts-to-resolve-before-implementation).
Updated: 2026-09-16.

## 1. Product and audience

Gather is an owner-side AI booking operator for independent event venues, private-dining restaurants and caterers.
It coordinates inquiries across the business's existing applications and shows the owner outcomes, decisions and next steps.

Promise: **Connect your tools. Gather handles booking coordination. Approve the decisions that matter.**

Gather is a managed service: the owner uses the web workspace and does not install OpenClaw or maintain a server. Gather manages a dedicated isolated OpenClaw instance per business, tested/pinned updates and external-supervisor recovery. A dedicated instance does not necessarily mean a dedicated VM.
The current repository runs locally for developer inspection; it does not yet provide hosted authentication or provisioning. Public demonstration scope does not override the customer delivery model. Vendor, commercial and private operating plans are outside this document.

This document defines the public hackathon release: one build, configured per event.
It does not publish the private product strategy or roadmap.

## 2. Complete user journey

1. Open the Gather workspace; the target customer path is managed sign-in and business onboarding.
2. Connect authorized business tools, or inspect a clearly labeled fictional prepared business without real credentials.
3. See what Gather understands while import progresses.
4. Answer consequential unanswered questions; confirm policies and operating authority.
5. Receive a grounded, evidence-cited offer for an inquiry.
6. Approve the exact proposed actions where required.
7. See verified external results, pending conditions and the current handoff.
8. See recovery and useful continuation, or an honest blocked state, when something fails.

### 2.1 Developer inspection versus customer delivery

- The existing local inspection commands are in the root README; they require Node.js 26+, dependencies and a production build. There is no packaged `npx github:` installer.
- Preserve the existing default `data/gather.sqlite`; inspection may explicitly set `GATHER_DATABASE_PATH` under `.runtime/`. No implicit path migration or reset of existing databases.
- Local development must never read or alter the developer's personal OpenClaw state.
- Hosted sign-in, provisioning and tenant isolation require their own implementation evidence before deployment. `local-owner` is not customer authentication.

### 2.2 Prepared business and live operation

- The prepared business is explicitly fictional, with simulated connectors labeled wherever effects or receipts appear. It currently has two bookings with pre-created proposals; a richer intake/offer journey is future work.
- Fixture inspection requires no model credentials or OpenClaw process. It cannot prove actual runtime restart, model diagnosis or provider recovery.
- Live operation uses the host-managed isolated runtime and authorized Google accounts. Model access is configured by the operator under supported provider terms; no pooled personal subscription credentials.
- Sending is limited to the exact approved booking recipient and content. A developer test-recipient restriction narrows this boundary; it never grants permission to add recipients.
- Any future fixture reset must be explicitly confirmed and limited to fictional state; it must not erase real businesses or source records.

## 3. Connections

Initial required applications are Gmail, Google Drive and Google Calendar.
Keep real multi-application execution in live mode; do not replace connectors with screenshots or simulated effects.

Target path: a Gather-operated web OAuth flow with server-side callback/state/PKCE handling, business ownership checks and protected credentials. The current localhost callback and macOS Keychain setup are developer plumbing, not completed hosted onboarding.

- Validate the minimum scopes against actual read/write operations and selected-document access; a Picker and `drive.file` flow must work end to end before narrowing existing configured scopes. Do not silently break current integrations.
- Determine Google verification and assessment applicability for the actual scopes/data flow before onboarding businesses. An unverified-app bypass or connector broker is not a production consent strategy.
- Keep tokens server-side behind the secret-store interface. No token in model arguments, browser responses, analytics or Git. Hosted secret storage and lifecycle require explicit design and verification.
- Derive business scope from authenticated server context, not model arguments or untrusted callback parameters. Local inspection remains loopback-only until hosted authentication exists.
- Validate connection ownership and callback completion before attaching accounts.
- Expose only authorized tools through Gather's controlled execution boundary.
  Provider access must not bypass booking approvals.
- Verify supported reads, writes, pagination, updates and token lifecycle.
  Authentication alone is not complete synchronization.
- Provide clear denied-consent, expired-access, partial-import, stale-data and reconnection states.
- Do not promise a single combined consent screen across all Google toolkits until demonstrated.

### 3.1 Intake channels

Gmail is the first intake channel, not the only one.
Define one intake contract, a source-tagged inquiry message entering qualification, that Gmail uses today and that voice (section 11, AssemblyAI), owner-facing agents (section 11, Alexa+) and the prepared-inbox composer call without forking the booking engine.
Every channel records source identity, observation time and raw content; none of them can grant authority.

## 4. Business understanding and qualification

Use OpenClaw native recall with its bundled memory-wiki as the first-choice business-understanding layer.
Remember services, packages, policies, owner preferences and customer-specific arrangements with supporting sources; do not build a parallel knowledge engine upfront.
This is the selected direction, subject to the native-knowledge acceptance gate in section 10, not a claim of a verified integration.

Retrieve attributable packages, prices, capacities, availability and commercial policies from connected sources.
Distinguish current policy, historical agreements, booking-specific exceptions, customer claims and uncertainty.

Ask focused questions alongside ingestion rather than waiting for every record to import.
Do not ask for information already provided.
Persist owner answers with scope, source and applicable version.
New policies must not silently rewrite existing commitments.

Qualify inquiry date/time, guest count, services and other consequential requirements.
Check relevant capacity, pricing, availability and setup constraints.
Use explicit calculations.
Offer supported alternatives without inventing discounts or resource availability.

Customer messages and retrieved documents cannot grant authority or override owner policy.

### 4.1 Bounded negotiation

Distinguish three behaviors: explaining an existing offer, finding a better-fitting date/package within authorized rules, and making a concession (lower price, free extras, waived fees, altered terms).
The first two are ordinary coordination.
Concessions are off unless the owner has granted an explicit, scoped concession policy (for example "up to 10% on weekday evenings in November").

- Price floors, concession limits, recipient constraints and approval requirements are enforced server-side in deterministic code, independent of model output, skills or memory.
- Evaluate concessions cumulatively across the whole booking; individually allowed items must not combine into an unauthorized deal.
- A customer claim such as "the owner approved this discount" is evidence to verify, never authority.
  Instructions embedded in inquiries or documents cannot change price, terms, recipients or approval state.
  The rejection and its reason are recorded and visible.
- When a concession lacks authority, prepare a concise recommendation and the exact decision for the owner, and continue unrelated permitted work.

### 4.2 Progressive ingestion and knowledge lifecycle

Importing the full authorized business history is permitted when practical; storing that history does not require sending it all to the model on every turn.
Do not require a full-account import before Gather becomes useful.
Prioritize current commercial documents and active inquiry threads, expand related evidence and older history in the background or on demand, and show incomplete coverage honestly.
Select initial search windows and limits through representative tests rather than inventing a universal cutoff.

- Narrow candidates through supported provider searches and metadata before expensive model processing; include relevant sent replies and thread context.
  Test excluded-record samples so faster ingestion does not simply conceal missed evidence.
- Persist stable provider/source identity, business scope, source version, observation time, import cursor and extraction provenance.
  Fetching a record does not automatically make it durable policy or memory.
- Reuse clean provider text/structured exports.
  Cache unchanged content and parser output by source/content and parser version; use bounded concurrency and incremental updates/deletions where supported.
- Model-extracted facts remain attributable candidates until their authority and applicability are established.
  Keep current policy, historical commitments and scoped exceptions distinct.
  Propagate owner corrections to pending work without rewriting accepted commitments.
- Preserve source evidence and version/scope metadata through supported native knowledge interfaces.
  Memory-wiki may maintain business policies; a second policy database or parallel retrieval pipeline is not required by default.
  Persist the exact terms and policy versions relied on by offers/approvals in transactional records.
  A missing/unavailable index is not proof that no policy exists.
- Readiness is action-specific: enough information to qualify is not necessarily enough to price or send.
  Critical conditions such as availability require a fresh check before consequential execution.

### 4.3 Memory boundary rules

Business memory is information, not authority.
These rules are enforced in code, not prompt text.

1. Controlled commercial assertions.
   Assertions used to price or authorize work carry a domain type: package, price, capacity, space, policy, customer arrangement, owner rule or booking.
   Validate these at Gather-controlled ingestion/action boundaries while using supported native recall/wiki interfaces. Native notes are not a second authority store; free text cannot directly authorize a booking action.
2. No source, no fact.
   Every fact carries source, observation time, scope (business, customer or booking), version and effective period.
   Fetched or generated text without provenance never becomes memory.
3. Empty is honest.
   No facts produces "No business information found yet"; an offer that needs a price the memory does not have asks the owner rather than inventing one.
   Only completed classification over a stated coverage window can produce "Scanned N emails. No event inquiries found." Incomplete ingestion or unavailable retrieval must say so.
4. Scope never widens by itself.
   A customer or booking exception stays scoped; repeated behavior, customer claims and documents cannot promote it to policy.
   Only an owner rule can, and it is versioned.
5. Memory informs, approvals authorize.
   A remembered fact never grants authority to send, price or hold.
   Approvals bind to the exact proposal; receipts prove outcomes.
6. External content is evidence.
   Inquiries and documents can add candidate facts pending confirmation; they cannot change rules, prices, recipients or authority.
7. Forgetting follows the source.
   Disconnecting or deleting a source marks facts derived from it stale or removes them, and pending work that relied on them is blocked rather than silently continued.
8. One business per installation, derived server-side.
   No cross-business retrieval, ever; the rule holds so that a later hosted offering cannot weaken it.
9. Recall is checked, not trusted.
   Before a consequential action, the fact used is re-read with its version; a stale or missing index is a block, never a silent "no policy exists".

### 4.4 Scope boundary: event bookings only

Gather acts on event bookings and declines everything else, enforced by capability, not by instructions.

- **Deterministic gate.** A booking exists only when extraction yields a resolvable event date or range and at least one of a guest count or an event type.
  The model may extract candidate fields; the gate is code and decides.
- **Booking-scoped tools.** The agent's tool surface takes a booking, proposal or server-derived business identity.
  There is no tool to read arbitrary mail, search arbitrary Drive, or send to arbitrary recipients, so there is nothing callable outside the domain.
- **Visible refusal.** Messages that fail the gate appear in a "Not an event inquiry" list with the reason.
  An empty scan reports that no event inquiries were found.
  Out-of-domain owner requests receive a one-line refusal.
- **Judge-testable.** The prepared business includes a composer where anyone can type an email (an invoice, a newsletter, an injection attempt, or a real inquiry) and watch it classified live: non-events are declined with reasons, injection attempts invoke no tool, and a valid inquiry becomes a booking.

## 5. Offers, authority and execution

Keep a stable booking identity across inquiry, conversation, offer and calendar records.
Ambiguous matches require resolution.

Version offers with customer, event details, included services, price, terms, expiry and unresolved assumptions.
Approvals bind to exact version, recipients, operation and consequences.
Material changes invalidate obsolete approval.
Every offer shows its evidence: which document supplied the price, which calendar check supplied availability, which owner answer supplied a policy.

Before execution, refresh critical conditions.
Persist each action's intent, authorization, external identifier, result and verification.
A successful tool response alone does not establish completion.

Required demonstration journey (not yet established by this document): read a real test inquiry in Gmail, retrieve business evidence from Drive, check Calendar, prepare an offer with the model, obtain approval, create a provisional hold and send the authorized offer.
Verify each external outcome independently.

Track replies, follow-ups and expiring holds durably.
Process replies before follow-ups.
Permit owner pause and takeover; reconcile the latest external state before handing back.

### 5.1 Customer acceptance

The inquirer needs no Gather account.
The sent offer carries a signed acceptance link (and accepts a plain "yes" reply where supported) that binds acceptance to the exact offer version and the authorized accepting party.
Acceptance of a superseded version is rejected with an explanation.
Acceptance moves the booking to accepted; it does not confirm the booking (section 9).
Payment collection is out of scope for this release; a payment link may be included but is never treated as payment.

## 6. Self-healing operations (included)

Gather must notice, diagnose and repair recoverable technical failures on its own, verify the repair, and resume the affected work, without the owner or judge reporting the problem.
A fixed retry loop alone is not self-healing.

Required proof: a concrete failure with diagnostic evidence, a selected corrective action, verified restoration and useful continuation.
Examples: recovering interrupted synchronization, restarting a failed isolated worker through a controlled tool, refreshing or requesting reconnection of expired access, or reconciling a hold that succeeded before an email failure.

### 6.1 Durable intents

Consequential asynchronous work must be durably recorded before dispatch and report progress from persisted records. Reuse existing approval/execution claims, waiting-work records and connection sessions; do not introduce a competing runner. ADR-002 defines ownership and crash-reconciliation boundaries for any future orchestration layer.
A failure mid-way is retained work, not a lost request. An external success without a persisted receipt remains uncertain; receipt absence never authorizes blind replay.
After repair, the same intent resumes from its last verified step; completed receipts are never redone.

### 6.2 Incident detection

Failures reach the repair loop automatically from three sources: failed or timed-out intents, health probes on the runtime instance and connections, and dead-lettered background work.
Each becomes an incident record with symptom, affected intent(s), captured evidence and first-seen time.
No human report is required.

### 6.3 Repair authority and the ops agent

- Repair is performed by a Gather-owned operations agent and deterministic supervisor, not by the business booking agent.
  A broken instance cannot be relied on to heal itself, and the repair agent's tool surface is narrower than the booking agent's.
- The ops agent may only choose from an explicit catalog of repair actions: restart the runtime instance; resume synchronization from the last durable cursor; reconcile an execution against its external identifier; refresh access or request owner reconnection; roll back a materialized configuration to its last known-good version; re-run a resumable intent; mark work blocked for the operator.
  Actions outside the catalog are denied.
- **Tier 1 (deterministic):** known failure signatures map to fixed catalog actions, with the model only explaining what happened.
- **Tier 2 (model diagnosis):** unknown failures get model-led diagnosis that must select one catalog action; any other output falls back to marking the work blocked.
  The diagnosis model never receives write tools.
- **Tier 3 (code defects):** a suspected code defect produces a proposed patch plus a failing regression test under `.runtime/repairs/` for operator review.
  The running installation never modifies or redeploys its own code.
- Verify before declaring recovery: probe succeeds, a dry read works, or the reconciled external record matches.
  An attempted repair is not a recovery.
- Bound attempts (three per incident by default), compute and time.
  Repeated unchanged failure becomes visible blocked work owned by the operator, with everything tried listed.

### 6.4 Owner-visible repair trail

Each incident shows a plain-language thread: what broke, what Gather concluded, what it did, how it verified, what resumed and what (if anything) remains.
The default interface shows only "Gather recovered from X" with a link to the thread; the thread is inspectable on demand.

### 6.5 Fault injection for demonstration

For a future recovery demonstration, use a clearly labeled isolated fault-injection harness: stop the runtime instance, expire access, corrupt a sync cursor, force a provider error on the next Calendar or Gmail call, fail the email step after the hold, and one unrepairable fault that must end in an honest blocked state.
Injected faults flow through the same detection, repair and resume path as real failures and are marked as injected in the incident record. Fixture faults prove simulated behavior only. Actual runtime-stop/diagnosis proof requires a separate opt-in runtime harness; the credential-free fixture path cannot claim it.

Autonomous self-improvement is excluded from this release: no unsupervised strategy optimization or production code changes intended to improve future performance.
Remembering authorized business corrections remains included, and corrections feed the measured self-improvement trend in section 7.

### 6.6 Non-negotiable repair rules

1. Repairs come from the catalog only; anything else is denied.
2. A repair never touches prices, approvals, accepted records, credential scope, Gather's own running source, or another business's runtime/state. The configured isolated runtime root, not a hardcoded local directory, defines the repair boundary.
3. A completed receipt is never redone; reconcile before any rewrite.
4. A repair counts only when its verification passes; attempts are recorded as attempts.
5. Three attempts, then blocked and visible with everything tried listed.
6. The repair agent holds repair tools only; the booking agent holds booking tools only.
7. Expired or revoked consent produces a reconnect action, never a pretend fix.
8. Repairs cannot call paid providers beyond the run budget, install packages or change versions.
9. Suspected code defects produce a patch and a failing test as a proposal, never applied automatically.
10. Every incident records symptom, diagnosis, action, verification, resumed work, remaining impact and whether it was injected.

## 7. Owner interface

Provide a polished responsive workspace with:

- Today: progress, decisions, blockers, deadlines, and the current response-time and recovery summary.
- Booking: conversation, requirements, evidence, current offer, approval and verified activity.
- Connections: account identity, import/readiness and reconnect actions.
- Business understanding: concise inspection and correction of relevant facts and policies, including typing an owner rule in plain language with visible scope and citation.
- Recoveries: incidents with their repair threads (section 6.4).
- Trend: the business's own evaluation score over its past inquiries, recomputed when the owner corrects Gather, so self-improvement is measured rather than claimed.

Keep developer configuration and internal architecture out of the normal flow.
Show actual persisted state and honest loading, empty, error and partial-success states.
Support keyboard navigation and readable layouts.

### 7.1 Demonstration script

The submission video and a judge running the prepared business follow this sequence; each step is one screen and one sentence, and each is backed by persisted evidence, not narration:

1. Open the prepared workspace using the documented inspection path; no live credentials are needed. This is not proof of hosted onboarding.
2. Distinguish clearly unrelated messages from legitimate incomplete inquiries. A booking inquiry lacking a date stays eligible for qualification. Embedded malicious instructions are ignored and cannot grant authority; legitimate booking content remains usable.
3. A seeded inquiry produces a grounded offer with cited evidence per fact.
4. Owner changes the price; the earlier approval is visibly invalidated. Approving the new version produces a hold and an email with separate receipts.
5. The judge triggers a fault mid-action from the fault panel; the repair thread appears; the action completes with no duplicate hold. A second fault ends in an honest blocked state.
6. A customer claim of an owner-approved discount is rejected as authority, not automatically as an inquiry; the floor holds while legitimate qualification can continue.
7. Owner tells Gather a new rule in plain language; the next affected inquiry respects it and cites it; the trend chart moves after the correction.

The live-mode recording (developer's own test account) adds: Google consent, a real Gmail inquiry, and hold and email receipts re-read from Calendar and Gmail.

## 8. Reusable architecture

Owner UI -> Gather backend -> isolated OpenClaw runtime -> controlled Gather tools -> connected business applications.
Intake channels enter the backend through the single contract in section 3.1; the ops agent in section 6 sits beside the business agent under a separate supervisor.

Shared foundation: runtime integration, connectors/synchronization, memory/evidence, approvals, durable work, recovery, intake, isolation and activity logs.

Product-specific layer: customer/problem, selected integrations, policies, approval categories, workflow, completion conditions, interface and domain-specific evaluations.

Optional sponsor adapters (model provider, voice, owner-facing agent interface) must be explicit, disabled unless configured, and genuinely exercised in the relevant submission.
Do not silently switch providers or send data to every sponsor.
One codebase supports different submission configurations; each must satisfy its own event rules and disclose reused versus newly built work.

### 8.1 Managed OpenClaw instances

OpenClaw is selected. Gather operates one isolated business runtime per business, with separately scoped workspace, state, credentials, sessions and tools. The model cannot select another tenant. Host infrastructure can be shared only with a verified isolation boundary; separate directories alone do not establish hosted tenant security.

- The host provisions a pinned runtime, readiness checks and resource limits; customers do not install it.
- Development/test instances use isolated roots, ports and tokens, never personal `~/.openclaw` state.
- External supervisor controls own startup, stop and recovery outside the business agent.
- `src/runtime/` owns the Gateway/process boundary. Existing adapters are not proof that hosted lifecycle/authentication is finished.

### 8.2 Runtime updates and failure recovery

Gather owns the runtime version; the installed instance must not independently follow upstream releases or modify its own installation.
Pin the runtime and compatible client/plugin versions.

- Test a candidate against the required booking, approval, connector and recovery journeys before promotion.
- Before an upgrade, settle or durably account for in-flight actions and keep a verified consistent backup with its matching known-good runtime/configuration.
- Verify useful behavior after activation, not merely process startup; restore only a compatible runtime/state combination or leave affected work visibly blocked.
- An external supervisor, outside the business agent, owns startup failure detection and runtime restoration.
  Agent-led repair in section 6 uses that supervisor's controls.
- Restoring local state does not reverse Gmail or Calendar effects.
  Reconcile external outcomes and recheck current authority before resuming; never replay writes blindly.

For this release a pinned deployment and a documented, tested restart/recovery path are required; automated rollout infrastructure remains outside scope.

### 8.3 Models, secrets and budgets

- Use explicitly configured, commercially supported model access; sponsor access is isolated to its relevant event configuration. Do not assume personal subscription OAuth can serve hosted customers.
- Attribute usage per business and bound tools, tokens, wall-clock time, concurrency and retries. A timeout must cancel work or leave its outcome uncertain, not merely stop waiting while writes continue.
- Secrets stay server-side behind protected storage with revocation/rotation. The existing macOS Keychain adapter is development plumbing, not hosted credential management.
- Hosting, inference and connector operations have costs. No zero-operator-cost or unlimited-usage promise. Purchases and paid execution require separate authority.
- Fault controls are restricted to isolated test/fixture environments, never a customer production reset surface.

### 8.4 Design before implementation

The PRD remains the source of truth.
ADRs in `docs/adr/` record consistent design contracts and future acceptance evidence, not a complete release plan or execution queue. Existing defect repairs are authorized during cleanup, including application code and regression tests. New feature implementation remains paused; before it resumes, the relevant design must map to actual interfaces and an explicitly bounded implementation scope.
Any future authorized implementation must read its accepted ADR alongside the relevant PRD sections and existing interfaces. An ADR cannot override the product requirements or resolve an open design choice by assumption.

For each subsystem, define inputs, authoritative stored state, model responsibilities, deterministic enforcement, triggers, failure/recovery behavior and observable acceptance scenarios.
Reuse supported OpenClaw capabilities where adequate; a skill instruction, memory entry or successful tool call alone does not establish business correctness.
Mark unresolved design choices explicitly rather than leaving implementation agents to invent them.

### 8.5 Minimal maintainable stack (agreed direction)

Optimize for an easy owner experience and a small maintainable system, not the number of integrations.
The owner installs nothing but the one command and needs no infrastructure accounts.

| Responsibility | Selected direction | Adoption boundary |
|---|---|---|
| Agent runtime and conversational continuity | OpenClaw with native recall, under `.runtime/` | Do not replace its memory automatically or introduce competing auto-capture systems |
| Application connections | Proposed Gather Google OAuth client via loopback; Composio fallback subject to verification | Existing direct-Google adapters are developer-configured; product onboarding and any hosted fallback need feasibility, data-flow and cost decisions before implementation |
| Transactional booking, offer, approval, pending-action and verified-result records | SQLite under `.runtime/` | Keep storage behind one server-side layer so a later move to PostgreSQL is contained |
| Business understanding and source-backed policies | OpenClaw native recall + bundled memory-wiki, first choice | Prove changed prices, scoped exceptions, deleted evidence and restart recall before committing; do not treat stale compiled context as current authority |
| Additional semantic evidence retrieval | No separate pgvector/pgContext pipeline initially | Add only for a measured gap that native recall/wiki cannot adequately address |
| Difficult documents, scans and tables | Docling only where clean provider exports are insufficient | Bounded parsing worker with selected dependencies, attributable output and cached unchanged documents |
| Development/regression evaluation | promptfoo and the per-business regression cases, outside the runtime | Deterministic assertions and selective calibrated LLM rubrics; no mandatory judge call after every production action |

Leave pgvector, Polygres (pgContext/pgGraph), Supermemory, HydraDB, Graphify and Graphiti out of the initial knowledge stack.
Do not run competing brains.
Reconsider an additional component only after a demonstrated native-knowledge limitation and a comparison showing concrete user benefit.

Optional components must demonstrate a concrete user benefit against the baseline using the same evidence and model settings.
Record dependencies, licenses, source/build availability, update burden, latency, model usage and failure behavior.
These choices are requirements/design direction, not claims of installed or tested integrations.

Integration contracts:

- Use supported OpenClaw Gateway protocols and extension points.
  Do not patch its core or read/write private runtime tables and transcript files to implement Gather features.
- Expose narrow Gather-controlled tools for evidence search, current policy, booking state, offer proposals and approved actions.
  Derive business scope server-side; return bounded evidence, versions, applicability and uncertainty.
- Maintain one current, source-backed policy representation in the native knowledge layer, one transactional action ledger and one progression owner.
  Freeze the applicable terms in versioned offers/approvals and detect consequential policy changes before execution; knowledge alone cannot grant approval.
- Keep the integration thin: retrieve and normalize connected content, feed it through supported native knowledge tools, propagate corrections/deletions, and enforce approved actions.
- OpenClaw remembers how the business works; Gather transaction records establish what was approved and what actually happened.
  A remembered claim of sending is not a provider receipt.
- Retain provider reconciliation: retryable job delivery does not guarantee exactly-once Gmail/Calendar effects.

References: [OpenClaw embedding](https://docs.openclaw.ai/gateway/embedding), [memory wiki](https://docs.openclaw.ai/plugins/memory-wiki), [Docling](https://github.com/docling-project/docling), [promptfoo](https://github.com/promptfoo/promptfoo).

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
| Engineering validation | Hosted OAuth/data-flow requirements, provisioning/isolation targets, event ordering, action reconciliation and measured readiness targets. |

## 9. Completion and honest scope

A hold is not a confirmed booking; a draft is not a sent email; a payment link is not a payment; an accepted offer is not a confirmed booking.
Confirm only when every configured business condition has authoritative evidence.
If payment or resource commitments are required but unverified, label the outcome provisional and show what remains.

Provide a handoff tied to the accepted booking version: event details, agreed services, responsibilities and outstanding conditions.
Share only relevant data.

Not required for this release: subscription billing, payment collection, hosted multi-tenant accounts, comprehensive employee/multi-location administration, every connector category, complete refund/cancellation accounting, comprehensive staffing/equipment systems, advanced analytics, every dashboard screen, autonomous code self-modification, and a full production disaster-recovery/load-testing programme.
These exclusions do not waive authorization, durable storage or correctness for the demonstrated journey.

## 10. Acceptance evidence

| Gate | Required proof |
|---|---|
| Developer inspection | Documented clone/install/build/start commands reach the fictional workspace without live credentials; this does not certify hosted onboarding |
| First run | Customer onboarding needs no runtime installation; unavailable connections and incomplete provisioning stay explicit. Current local setup is labeled developer inspection |
| Prepared business | Simulated connectors labeled on every screen; seed and reset verified; six seeded inbox messages including non-events |
| Scope boundary | Unrelated messages are separated; incomplete booking inquiries remain eligible; injected instructions cannot grant authority or widen tools/recipients even when legitimate inquiry content is processed |
| Live mode | Approved Google OAuth/data flow, real inquiry to offer to hold and email, each receipt independently re-read; scripted transports and authentication alone do not satisfy this |
| Managed runtime | Host-provisioned isolated business runtime, pinned version, readiness and external-supervisor control; no customer installation and no personal runtime access |
| Runtime lifecycle | Pinned version recorded; basic restart/recovery verified without duplicated actions |
| Understanding | Attributable facts, remembered owner corrections and correct handling of conflicting evidence; a plain-language owner rule applies to the next affected inquiry with citation |
| Progressive ingestion | First useful work before full import; interrupted import resumes; changed/deleted evidence and excluded-record sampling are checked without false completeness claims |
| Native knowledge selection | Test OpenClaw recall + memory-wiki on changed prices, customer-only exceptions, deleted sources and restart recall; preserve provenance. If inadequate, document the specific failure before adding a separate knowledge component |
| Knowledge lifecycle | Scoped exception and owner correction apply to the right pending work; accepted commitments stay unchanged; unavailable or stale derived context cannot silently authorize an action |
| Evaluation | Human-reviewed scenarios; deterministic authority/arithmetic/isolation checks and calibrated semantic rubrics where useful; judge output never substitutes for provider evidence |
| Booking journey | Actual model invocation and verified inquiry-to-offer-to-approval-to-provisional-hold-and-sent-email execution with per-fact evidence shown |
| Customer acceptance | Acceptance link binds to the exact version; superseded version rejected; state moves to accepted without claiming confirmation |
| Exact authority | Stale/changed approvals and cross-booking authorization rejected; price floor and concession limits hold against model output |
| Recovery | Duplicate delivery, partial success, uncertain outcome and restart scenarios preserve correct state |
| Self-healing | For each injected fault: automatic detection without a report, recorded diagnosis, a catalog action, verification and resumed intent with no duplicate external effect; at least one fault ends in an honest blocked state with the attempts listed |
| Budgets | Per-run tool-call, token and wall-clock limits enforced with a visible refusal |
| Isolation | Per-business runtime, authenticated server scope and provider bindings; no tool, retrieval, file or callback path reaches another business |
| External-content boundary | Malicious inquiry/document instructions cannot change authority or commercial terms; rejection recorded with reason |
| UX | Rendered and interactive checks of the demonstration script, mobile layout and error/reconnection states |
| Submission | Public open-source license present; runnable instructions; demonstration video of the actual journey; event-specific technology/reuse requirements verified |

Distinguish planned requirements, implemented code, local test evidence and live verification in each PR. Do not create a second progress ledger or infer completion from ADR status.
A build, screenshot, test count or worker report alone is not product completion.

## 11. Hackathon-specific requirements and submission configurations

Research snapshot: September 16, 2026.
Three target events, rechecked against primary rules pages on that date.
Recheck linked primary rules before entry.
NextStep (environmental theme, students only), OpenServ (existing-project eligibility unresolved, owner deprioritized), ForgeHacks (current students only), Waycode and Anna are excluded by owner decision.

### One build, per-event configuration

All events use the same application and repository; developer inspection and submission configuration do not change the managed customer-delivery decision.
Each event gets its own configuration profile that enables exactly the adapters that event requires, its own recorded baseline commit and change log, and its own demonstration.
A sponsor adapter that is enabled but not exercised on a real booking task in that event's demonstration does not count.
Mandatory items across the set:

- Public repository with an open-source license (present: MIT).
- Runnable instructions plus a demonstration video (under three minutes for Amazon and Nebius).
- Documented new work since each event's window start, with the baseline commit.

### AssemblyAI Voice Agent Hackathon

- Event runs September 1 to 30, 2026; fully online, join anytime.
- Mandatory: AssemblyAI usage in a voice-agent project.
- Gather configuration: a voice intake channel (section 3.1): a caller describes their event, AssemblyAI transcribes, the same gate, qualification, evidence, approval and booking engine produces the offer.
  Show actual voice processing and downstream booking work, not a text-only demonstration.
- Prizes: $10,000 pool ($5,000 cash plus credits).
- Source: https://lablab.ai/ai-hackathons/assemblyai-voice-agent-hackathon

### Amazon Build, Ship, Shape

- Deadline: October 23, 2026, 12:00 PDT.
- Selected track: Alexa+. Build a working Agent Skill, a self-hosted MCP server implementing MCP spec version 2025-11-25 or later over Streamable HTTP, or a simulated Alexa+ experience.
- Gather configuration: an owner-facing agent interaction that operates the existing booking engine through Gather's controlled tools ("what needs my decision today?", "approve the Clara offer"), exposed as a self-hosted MCP server.
  Show meaningful cross-service actions and persistent context.
- Existing projects require significant updates during the submission period beginning August 31; describe and demonstrate those updates.
- Required: public licensed source (license detectable at the repository top level), working demonstration, video under three minutes, track selection and product feedback.
- Prizes: $25,000 and $15,000 in the Alexa+ track; $150 AWS promotional credits available on request by October 21.
- Source: https://amazonappdev2026.devpost.com/rules

### Nebius x NVIDIA Global AI Hackathon

- Deadline: October 30, 2026, 10:00 PDT.
- Mandatory: make a runtime call to Nebius Token Factory or run on Nebius AI Cloud, and use at least one NVIDIA open-source model.
- Selected track: Personal AI ("always-on, private assistant, keeping your data under your control, persistent memory, reusable skills"), as a candidate fit for the isolated business operator; verify the managed deployment against current track rules before submission rather than assuming local-first eligibility.
- Gather configuration: the model adapter routes booking reasoning through Nemotron on Token Factory.
  A qualifying Token Factory inference call satisfies the runtime route; deploying the whole application on Nebius is not universally required.
- Existing projects require significant updates during the submission window beginning August 26, explained in the submission.
- Required: public open-source-licensed repository with source, assets and run instructions, a working demo or test build, project description, technology feedback and a public demonstration video under three minutes.
- Nebius Builder Program provides Token Factory credits.
- Source: https://nebiusglobalaihackathon.devpost.com/rules

### Cross-event release rules

- Maintain one reusable codebase with independently configurable model, voice and interface adapters.
  Do not require all sponsors in every run.
- Record each event's baseline commit, new work, configuration, external execution evidence and submission materials.
  Disclose reused components honestly.
- Amazon requires multiple entries within the event to be unique and substantially different.
  Across events, verify each event's prior-work and prior-submission rules independently.
- Private strategy and the private PRD remain unpublished.
  Public source obligations still apply to the actual submitted application.
- Registration, submission and paid usage are separate actions from implementing this PRD.
