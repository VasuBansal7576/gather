# Gather: Public Hackathon PRD

Status: public execution design specified; implementation and live verification are not claimed. Feature implementation remains paused; this planning change is not execution authorization. Start with the [ADR execution index](adr/README.md) and [shared contracts](adr/CONTRACTS.md).
Updated: 2026-09-16.

## 1. Product and audience

Gather is an owner-side AI booking operator for independent event venues, private-dining restaurants and caterers.
It coordinates inquiries across the business's existing applications and shows the owner outcomes, decisions and next steps.

Promise: **Connect your tools. Gather handles booking coordination. Approve the decisions that matter.**

Gather is local-first.
The target is one-command installation on the owner's machine, with local application state. Connected Google services and a configured remote model receive the data necessary for live operations; local-first does not mean offline or that source content never leaves the machine.
A hosted multi-tenant service is a later offering, not part of this release. Public prepared/live mode is one business per active installation; no SaaS operating-business or lead-recovery strategy is imported here.

This document defines the public hackathon release: one build, configured per event.
It does not publish the private product strategy or roadmap. Its local-first delivery and hackathon ADRs are independent of the private SaaS delivery model; do not replace them with SaaS requirements.

## 2. Complete user journey

1. Run one command (`npx github:VasuBansal7576/gather`) on a machine with Node; Gather builds if needed, starts on a local port and opens the browser.
2. Choose **Try the prepared business** (zero keys, zero accounts) or **Connect your own** (a model login and Google consent on your own accounts).
3. See what Gather understands about the business while import progresses.
4. Answer only consequential unanswered questions; confirm policies and operating authority.
5. Receive a grounded, evidence-cited offer for an inquiry.
6. Approve the exact proposed actions where required.
7. See verified external results, pending conditions and the current handoff.
8. When something breaks underneath, see Gather notice, repair and resume the work on its own, or say plainly that it could not.

No terminal steps beyond the one command, no Google Cloud project, no OAuth client, no Composio account and no workflow configuration are required of the person evaluating or using the prepared business.
Model login and Google consent are required only for the live path in section 2.2.

### 2.1 Local-first distribution

- Distribution is `npx github:VasuBansal7576/gather` running the packaged CLI, and `npm ci && npm start` from a clone for developers.
- Target macOS and Linux on Node 26+. The CLI resolves the invocation directory as its installation root, stages/builds the packaged app under `.runtime/app/<revision>/`, runs the doctor, starts on `127.0.0.1` with a free port and opens the browser. Test the packed artifact outside a checkout; npm cache paths are not the business-state root.
- All state lives under `.runtime/` (SQLite database, secrets, OpenClaw installation when live mode is used, repair artifacts).
- Gather-managed state stays inside the installation root; the developer's personal `~/.openclaw` is never read or modified. npm bootstrap may use its normal package cache and needs network; do not promise offline installation or zero package-manager writes. Subsequent staged builds use a cache inside `.runtime/`.
- The prepared-business path installs no runtime and asks for no credentials.

### 2.2 Prepared business and live mode

- **Try the prepared business** opens a fictional venue with seeded inquiries, documents and calendar.
  Its connectors are explicitly simulated and labeled as such on every screen where they appear.
- **Connect your own** installs the pinned OpenClaw runtime under `.runtime/` on first use, asks the user to sign into a supported model (a provider login supported by the pinned OpenClaw runtime or a user-provided API key) and then connects Gmail, Drive and Calendar through Gather's OAuth client (section 3).
  It performs real reads and writes on the user's own accounts.
- Live sends are restricted to the inquiry sender subject to an optional operator-configured test-recipient restriction; there is no free-recipient send tool.
- Prepared and live state are separate; switching never seeds fictional records into live accounts. A confirmed reset restores only the prepared state with its runner stopped and database safely closed. Existing/custom databases are never silently migrated or deleted. See contract C01 for the reference business, scenarios, mode lock and migration boundary.

## 3. Connections

Initial required applications are Gmail, Google Drive and Google Calendar.
Keep real multi-application execution in live mode; do not replace connectors with screenshots or simulated effects.

Primary path: a Gather-operated Google OAuth client using the desktop/loopback flow, direct to Google, with no third party in the data path.
The client identifier ships in the application; the loopback flow needs no shipped client secret.

- Use the narrowest scopes that support the journey: `openid`, `email`, `gmail.readonly`, `gmail.send`, `calendar.events`, `calendar.freebusy` and `drive.file` with the Google Picker for the owner to select menu, package and policy documents, instead of full Drive read access.
- Gather's operator supplies the OAuth client and Picker project/API configuration; the live user does not create a Google Cloud project. Verify the combined loopback/Picker path on an authorized fresh test account before declaring it usable.
- Show actual testing-user, scope, token-expiry and verification restrictions. Do not promise an unverified-app bypass or assume arbitrary judges can consent.
- Direct Google is the selected initial path. Composio remains a contingency, not an automatic fallback: a blocked capability test returns evidence to Chief. A broker requires a reviewed plan amendment, explicit data-flow/cost disclosure and separate deployment authority; do not implement or silently activate one just because consent failed.
- Keep credentials and connection operations server-side in the local process; tokens are stored under `.runtime/live/secrets/` with owner-only permissions, behind the existing secret-store interface.
- Derive business scope server-side from the local store, not from model arguments or untrusted callback parameters.
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
Use the visible configurable initial scope and history-expansion defaults in contract C03; validate them with representative and excluded-record tests. A scheduling window is not a universal relevance cutoff or a claim to have scanned the whole account.

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

1. Typed facts only.
   Commercial memory accepts only assertions with a domain type: package, price, capacity, space, policy, customer arrangement, owner rule, booking.
   Source documents may remain unstructured evidence; only the typed, provenance-preserving, owner-confirmed path can establish commercial assertions. Native wiki synthesis or auto-capture cannot mint policy authority.
2. No source, no fact.
   Every fact carries source, observation time, scope (business, customer or booking), version and effective period.
   Fetched or generated text without provenance never becomes memory.
3. Empty is honest.
   No facts produces "No business information found yet"; an offer that needs a price the memory does not have asks the owner rather than inventing one.
   No inquiries produces "Scanned N emails. No event inquiries found."
   State the scanned scope and completion/coverage. An in-progress import says "No event inquiries found yet; scanning continues"; failed access says the scan could not complete, never that no leads exist. Relevant inquiries without business facts remain visible with the missing-information question. Never populate connected live accounts with prepared-business fixtures to conceal an empty result.
4. Scope never widens by itself.
   A customer or booking exception stays scoped; repeated behavior, customer claims and documents cannot promote it to policy.
   Only an owner rule can, and it is versioned.
5. Memory informs, approvals authorize.
   A remembered fact never grants authority to send, price or hold.
   Approvals bind to the exact proposal; receipts prove outcomes.
6. External content is evidence.
   Inquiries and documents can add candidate facts pending confirmation; they cannot change rules, prices, recipients or authority.
7. Forgetting follows the source.
   Disconnecting, excluding or deleting a source immediately invalidates derived knowledge and blocks dependent pending work. Purge cached bodies/searchable derivatives, retain minimal tombstones and immutable accepted terms/receipts as specified in C03; reconnection requires revalidation.
8. One business per installation, derived server-side.
   No cross-business retrieval, ever; the rule holds so that a later hosted offering cannot weaken it.
9. Recall is checked, not trusted.
   Before a consequential action, the fact used is re-read with its version; a stale or missing index is a block, never a silent "no policy exists".

### 4.4 Scope boundary: event bookings only

Gather acts on event bookings and declines everything else, enforced by capability, not by instructions.

- **Domain gate and qualification are separate.** Classify messages as eligible event inquiries, clearly unrelated, or uncertain/requires review, with evidence and reasons. A legitimate inquiry missing a date, guest count or event type remains eligible; missing fields trigger qualification, not automatic rejection. Extraction/classification may use the model, but server-side validation and authority checks decide which actions can execute. Ambiguous messages cannot trigger external writes merely because the model called them bookings.
- **Booking-scoped tools.** The agent's tool surface takes a booking, proposal or server-derived business identity.
  There is no tool to read arbitrary mail, search arbitrary Drive, or send to arbitrary recipients, so there is nothing callable outside the domain.
- **Visible refusal.** Clearly unrelated messages appear in a "Not an event inquiry" list with the reason; ambiguous messages appear in review rather than being silently rejected.
  An empty scan reports that no event inquiries were found.
  Out-of-domain owner requests receive a one-line refusal.
- **Judge-testable.** The prepared business includes a composer where anyone can type an email (an invoice, a newsletter, an injection attempt, or a real inquiry) and watch it classified: unrelated requests cannot trigger business actions, while legitimate inquiries remain eligible even with missing fields or embedded malicious instructions. Injected claims never grant authority; safe qualification may continue. Show prepared/model simulation honestly.

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
The sent offer carries a signed **Accept by email** (`mailto:`) link that opens a reply with an opaque version-bound token. The customer must send the reply; opening the link is not acceptance. This local-first transport works for a remote customer without pointing to the owner's localhost or requiring a hosted acceptance server.
Bind acceptance to the exact offer version and authorized accepting mailbox using signature, expiry, correlation to the original sent offer and trusted sender-authentication evidence. A signed-token reply may start a new thread; a plain yes requires unambiguous existing-thread correlation. A forwarded token from another sender, stale version or ambiguous authentication cannot auto-accept. A plain "yes" reply is supported only when one current offer and its accepting party are unambiguously verified; otherwise ask for clarification. See contract C07.
Acceptance moves the booking to accepted; it does not confirm the booking (section 9).
Payment collection is out of scope for this release; a payment link may be included but is never treated as payment.

## 6. Self-healing operations (included)

Gather must notice, diagnose and repair recoverable technical failures on its own, verify the repair, and resume the affected work, without the owner or judge reporting the problem.
A fixed retry loop alone is not self-healing.

Required proof: a concrete failure with diagnostic evidence, a selected corrective action, verified restoration and useful continuation.
Examples: recovering interrupted synchronization, restarting a failed isolated worker through a controlled tool, refreshing or requesting reconnection of expired access, or reconciling a hold that succeeded before an email failure.

### 6.1 Durable intents

Every consequential user action (prepare offer, approve, send, connect, reset, inject a fault) is stored durably before dispatch and the interface reports progress from that record. Future intents compose existing execution claims, receipts, waiting work and connection sessions under one progression owner, not a competing scheduler.
A failure mid-way is a state on the intent, not a lost request.
After repair, the same intent resumes from its last verified step; completed receipts are never redone. A provider success lost before receipt persistence remains uncertain and must be reconciled before any new write.

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

Provide a clearly labeled fault-injection panel on the prepared business: stop the runtime instance, expire access, corrupt a sync cursor, force a provider error on the next Calendar or Gmail call, fail the email step after the hold, and one unrepairable fault that must end in an honest blocked state.
Injected faults flow through the same detection, repair and resume path as real failures and are marked as injected in the incident record. The credential-free prepared business simulates runtime/model failures; actual process restart and model diagnosis require a separately opted-in isolated runtime harness. Do not claim simulated recovery as actual runtime evidence.

Autonomous self-improvement is excluded from this release: no unsupervised strategy optimization or production code changes intended to improve future performance.
Remembering authorized business corrections remains included, and corrections feed the measured self-improvement trend in section 7.

### 6.6 Non-negotiable repair rules

1. Repairs come from the catalog only; anything else is denied.
2. A repair never touches prices, approvals, accepted records, credential scope, Gather's own running source, or any installation outside `.runtime/`.
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

1. One command starts Gather; the prepared business opens with no keys and no setup.
2. In the composer, an invoice and a purely unrelated injection attempt land in "Not an event inquiry" with reasons. A legitimate event inquiry remains eligible even when date or guest count is missing; an embedded malicious instruction cannot grant authority.
3. A seeded inquiry produces a grounded offer with cited evidence per fact.
4. Owner changes the price; the earlier approval is visibly invalidated. Approving the new version produces a hold and an email with separate receipts.
5. The judge triggers a fault mid-action from the fault panel; the repair thread appears; the action completes with no duplicate hold. A second fault ends in an honest blocked state.
6. A claim of an owner-approved discount is rejected as authority with its reason; the floor holds while legitimate inquiry qualification may continue.
7. Owner tells Gather a new rule in plain language; the next affected inquiry respects it and cites it; the trend chart shows before/after evaluation on the same versioned case set. An unchanged or worse score is reported honestly, not forced to rise.
8. A separately selectable empty/non-event fixture shows the scanned count/scope and "No event inquiries found" without generated leads or invented business facts. Separate partial-import and failed-connection fixtures demonstrate that neither is misreported as a completed empty scan.

The live-mode recording (developer's own test account) adds: Google consent, a real Gmail inquiry, and hold and email receipts re-read from Calendar and Gmail.

## 8. Reusable architecture

Live: Owner UI -> Gather backend -> isolated OpenClaw runtime -> controlled Gather tools -> connected business applications. Prepared mode uses labelled scripted runtime/knowledge/provider adapters through the same Gather contracts; it cannot prove native or live behaviour.
Intake channels enter the backend through the single contract in section 3.1; the ops agent in section 6 sits beside the business agent under a separate supervisor.

Shared foundation: runtime integration, connectors/synchronization, memory/evidence, approvals, durable work, recovery, intake, isolation and activity logs.

Product-specific layer: customer/problem, selected integrations, policies, approval categories, workflow, completion conditions, interface and domain-specific evaluations.

Optional sponsor adapters (model provider, voice, owner-facing agent interface) must be explicit, disabled unless configured, and genuinely exercised in the relevant submission.
Do not silently switch providers or send data to every sponsor.
One codebase supports different submission configurations; each must satisfy its own event rules and disclose reused versus newly built work.

### 8.1 The local OpenClaw instance

OpenClaw is the selected runtime.
One installation runs one business; the business scope is derived server-side and the model cannot select another tenant or another business's data.

- The pinned OpenClaw runtime is installed lazily under `.runtime/live/openclaw/` the first time live mode is chosen; the prepared-business path never installs it.
- The instance is configured through the existing isolation environment (own `OPENCLAW_HOME`, state, config, workspace, port, tokens and channels disabled) and never reads or writes the user's personal `~/.openclaw`.
- Gather manages provisioning, readiness, health and recovery; the recurring startup timeout observed in local verification is a tracked reliability defect that the repair path in section 6 handles, not an accepted behavior.
- The runtime boundary (`src/runtime/`) remains the only place that knows it is talking to OpenClaw.

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

- The model runs through the user's own access: a supported OpenClaw subscription login (OAuth, personal use on this machine) or a user-provided API key.
  Sponsor-provided credits are used for the relevant event's configuration.
  No Gather-managed per-user model billing is part of this release. Local source storage does not eliminate external Google/model processing; any optional broker requires explicit cost and data-flow disclosure.
- Bound every run: maximum tool calls, maximum tokens and a wall-clock timeout, all configurable.
- Secrets (OAuth tokens, gateway and MCP tokens, model credentials) live under `.runtime/live/secrets/` with owner-only permissions, behind a file-backed secret-store adapter; the macOS Keychain adapter is development-only.
- Nothing may spend money without an explicit key the user supplied; there is no operator billing path in this release.
- The fault panel (section 6.5) exists only on the prepared business and is visibly labeled.

### 8.4 Design before implementation

The PRD remains the source of truth.
Implementation proceeds through the ADRs in `docs/adr/`; each ADR cites its PRD sections, owns explicit files, forbids explicit files and defines its own acceptance evidence.
Chief owns completion and reconciliation of that plan before execution: requirement-to-ADR coverage, contracts, dependency ordering, ownership conflicts and acceptance scenarios. Orca is the execution orchestrator for the resulting ready work orders, not the owner of unfinished product design. Workers must return contradictions to Chief rather than inventing requirements. The [16-ADR index](adr/README.md) maps the full release, shared contracts, dependency waves and acceptance ownership. Its specified status does not claim implementation or authorize execution.
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
| Application connections | Gather Google OAuth client via loopback plus selected-document Picker, with capability gate | ADR-012 verifies operator configuration and consent; failure blocks live proof. Composio requires a Chief-reviewed amendment, never an automatic fallback |
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

### 8.6 Specified release defaults and capability gates

The following are the public execution decisions, not verified implementation claims. Detailed interfaces and error semantics are in [contracts C01–C12](adr/CONTRACTS.md); ownership and all requirement/gate mappings are in the [ADR index](adr/README.md). Chief owns amendments. Orca implements these contracts rather than selecting product policy during dispatch.

| Area | Execution decision |
|---|---|
| Reference business | Fictional Glasshouse private-event venue; one exclusive 100-person room, USD, America/New_York, 4-hour $50/person package, $1,000 minimum, explicit no-extra-fees fixture policy. Live businesses need their own confirmed facts. |
| Modes and packaging | Prepared is credential-free and scripted; live is separate and real; actual native-runtime proof is opt-in. macOS/Linux Node 26+, writable staged package under the invocation root; safe reset, no silent legacy migration. |
| Source scope/retention | Visible initial 30-day inbox/sent window, selected documents/calendar, bounded pages and active-thread priority; explicit older expansion and excluded-record tests. Purge disconnected/deleted source bodies and invalidate derivatives; preserve minimal audit/commitment snapshots. |
| Policy authority | Imported claims start as candidates; owner confirms inspected typed claims (batch allowed). Scoped confirmed exceptions apply only within scope. Conflicting current claims block until owner resolution. |
| Questions/readiness | Qualify incomplete event inquiries; batch unanswered questions and avoid repeats. Missing pricing/terms blocks pricing, not inquiry discovery. Fresh resource evidence and exact approval precede execution. |
| Operating authority | Exact per-action/bundle approval; no standing outbound authority by default. Concessions off unless explicit scoped/cumulative policy permits them; sending still requires exact approval. |
| Lifecycle | Stable verified identity or owner ambiguity resolution; price-only revision reuses unchanged hold; date/resource change needs approved replacement/release. 48-hour reference hold/offer expiry capped at event start; one follow-up draft after 24 hours, never automatic sending. Replies first; takeover/resume reconciles state. |
| Acceptance/confirmation | Signed acceptance-by-email link and verified reply; no localhost customer URL. Exact offer/party/expiry/replay checks. Accepted is separate from confirmed; required resource/payment evidence must exist. Reference fixture has no deposit requirement. |
| Owner experience | Today/Booking/Connections/Understanding/Recoveries/trend, in-app consequential notifications, mobile/keyboard and honest empty/partial/error states. |
| Repair | Separate supervisor/ops agent; catalog preconditions and independent probes in C09, maximum three attempts, unchanged permanent failures may block sooner. Patch/test proposals only, never running code mutation. |
| Runtime budgets | Default 15 tool calls, 32,000 total input/output tokens, five-minute execution deadline, 50 runs/day; configurable and persisted. Reserve before calls, fence after deadline, never equate wait timeout with cancellation. |
| Engineering capability gates | ADR-008 proves supported native knowledge; ADR-009 pins/proves runtime/model access; ADR-012 proves actual OAuth/Picker. Unavailable capability gives a concrete blocker, not an invented replacement architecture. Event ADRs prove sponsor-specific execution. |

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
| Local run | On a machine with only Node, one command reaches the prepared-business workspace with no keys, no OpenClaw install and no external accounts; transcript attached |
| First run | Both choices are presented; "Connect your own" states its requirements honestly and is disabled until the live path ships |
| Prepared business | Simulated connectors labeled on every screen; seed and reset verified; six seeded inbox messages including non-events |
| Scope boundary | Unrelated invoice/newsletter/pure-injection messages are separated; incomplete legitimate inquiries remain eligible. Mixed inquiry/injection content cannot change authority, recipients or commercial terms |
| Live mode | Google consent and selected-document Picker on an authorized fresh account through the configured direct flow, real inquiry to offer to hold and email with each receipt re-read from the provider |
| Local runtime | OpenClaw installs and runs under `.runtime/`; the personal `~/.openclaw` is verified untouched |
| Runtime lifecycle | Pinned version recorded; basic restart/recovery verified without duplicated actions |
| Understanding | Attributable facts, remembered owner corrections and correct handling of conflicting evidence; a plain-language owner rule applies to the next affected inquiry with citation |
| Progressive ingestion | First useful work before full import; interrupted import resumes; changed/deleted evidence and excluded-record sampling are checked without false completeness claims |
| Native knowledge selection | Test OpenClaw recall + memory-wiki on changed prices, customer-only exceptions, deleted sources and restart recall; preserve provenance. If inadequate, document the specific failure before adding a separate knowledge component |
| Knowledge lifecycle | Scoped exception and owner correction apply to the right pending work; accepted commitments stay unchanged; unavailable or stale derived context cannot silently authorize an action |
| Evaluation | Human-reviewed scenarios; deterministic authority/arithmetic/isolation checks and calibrated semantic rubrics where useful; judge output never substitutes for provider evidence |
| Booking journey | Actual model invocation and verified inquiry-to-offer-to-approval-to-provisional-hold-and-sent-email execution with per-fact evidence shown |
| Customer acceptance | Signed acceptance-by-email link binds exact version and verified sender; click alone does nothing; superseded/forwarded-wrong-sender/replayed tokens handled; accepted does not imply confirmed |
| Exact authority | Stale/changed approvals and cross-booking authorization rejected; price floor and concession limits hold against model output |
| Recovery | Duplicate delivery, partial success, uncertain outcome and restart scenarios preserve correct state |
| Self-healing | For each injected fault: automatic detection without a report, recorded diagnosis, a catalog action, verification and resumed intent with no duplicate external effect; at least one fault ends in an honest blocked state with the attempts listed |
| Budgets | Per-run tool-call, reserved input/output-token and actual execution-deadline limits enforced with visible refusal; wait timeout cannot imply cancellation |
| Isolation | One business per installation; no tool or retrieval path can reach another business or data outside the configured accounts |
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

All events are served by the same local-first application and repository.
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
- Selected track: Personal AI ("always-on, private assistant, keeping your data under your control, persistent memory, reusable skills"), for which local-first Gather on OpenClaw is a direct fit; the project remains eligible for Best Apps and Agents.
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
