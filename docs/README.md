# Repository guide

## Product intent versus existing code

Gather is intended to coordinate event bookings on behalf of a business owner, using the business's existing tools. The owner supplies policy and operating authority, reviews consequential decisions, and sees evidence of completed work. The product is not a generic email agent, a workflow builder, or a collection of independent model demos.

The [PRD](HACKATHON_PRD.md) describes that destination. It is not an inventory of shipped behavior. The current code is a partially integrated prototype, and feature implementation is paused while its design and repository are reconciled. The [README](../README.md) describes the runnable inspection path; [AGENTS.md](../AGENTS.md) governs changes.

## Existing code map

| Area | Source and role | Reference |
| --- | --- | --- |
| Owner UI | `app/`, `src/host/`, `src/components/gather/`, `src/setup/`: setup, workspace DTO validation, view adapters and callbacks | [Setup](SETUP_UI.md), [workspace](UI.md) |
| Transactional booking state | `src/server/sqlite-store.ts`, `src/domain/`, `src/server/booking-service.ts`: proposals, exact approvals, execution claims and receipts | [Booking API](BOOKING_API.md), [backup/recovery](DATA_RECOVERY.md) |
| Provider boundary | `src/connectors/`, `src/server/connections/`, `src/server/provider-runtime/`: simulated versus Google adapters, OAuth, credentials and scoped dispatch | [Contracts](CONNECTORS.md), [connections](CONNECTIONS.md), [Google writes](GOOGLE_CONNECTORS.md), [Google reads](GOOGLE_READS.md), [dispatch](PROVIDER_RUNTIME.md), [hold release](HOLD_RELEASE.md) |
| Identity and progression | `src/identity/`, `src/coordination/`, `src/server/operator-runtime/`, `src/server/proactive/`: source identity, durable waiting work, intake and process-local scheduling | [Identity](BOOKING_IDENTITY.md), [ledger](PROACTIVE_WORK.md), [operator](OPERATOR_RUNTIME.md), [automation](PROACTIVE_AUTOMATION.md), [bootstrap](PROACTIVE_BOOTSTRAP.md) |
| Knowledge and offers | `src/knowledge/`, `src/offers/`, `src/server/business-operator/`: candidates, owner-confirmed facts, deterministic offer preparation and API assembly | [Knowledge](BUSINESS_KNOWLEDGE.md), [extraction](KNOWLEDGE_EXTRACTION.md), [offers](OFFERS.md), [business operator](BUSINESS_OPERATOR.md) |
| OpenClaw integration | `src/runtime/`, `src/server/live-model/`: isolated process/Gateway/MCP boundary and designated-source model proposal runner | [Runtime](OPENCLAW.md), [model configuration](MODEL_CONFIG.md), [execution runner](LIVE_MODEL_RUN.md) |
| Confirmation and handoff | `src/delivery/`, `src/server/booking-delivery/`: evaluate configured conditions, persist accepted-version evidence and produce handoff | [Readiness](DELIVERY_READINESS.md), [delivery service](BOOKING_DELIVERY.md) |
| Developer checks | `tests/`, `scripts/`, `evaluation/knowledge/`, `.github/workflows/`: regression tests, diagnostics and offline evaluation | [Local setup](LOCAL_SETUP.md), [knowledge evaluation](../evaluation/knowledge/README.md) |

The similarly named modules above are not automatically duplicates. For example, `src/delivery/` evaluates evidence while `src/server/booking-delivery/` persists and exposes it; `src/runtime/` supervises OpenClaw while `src/server/operator-runtime/` owns business intake. Preserve these contracts until a separately approved design decides otherwise.

## Actual boundaries

- The root UI reads `/api/workspace`; the fixture initializer creates two existing proposals. Approving one exercises simulated hold/email execution, not fresh-inquiry understanding.
- Google adapters exist, but live setup requires developer configuration and the default Google secret store is macOS Keychain. An `EnvSecretStore` exists for development; there is no shipped file-backed Google secret adapter or document picker.
- The model config currently accepts `openai/gpt-5.6-luna` with OAuth metadata. This describes the code's allowlist, not a guarantee of provider availability. The runner requires explicitly designated sources and a controlled recipient; broad user-selectable model onboarding is not implemented.
- The existing knowledge service stores confirmed facts in SQLite. The PRD selects native OpenClaw recall/wiki as the first-choice future direction, subject to evidence gates. No migration or second knowledge system is authorized by this cleanup.
- Intake currently records inquiries/replies without the proposed event-domain gate. Existing source identity and approval checks must not be confused with that missing classifier.
- Durable execution claims, receipts and waiting-work records already exist. A general durable user-intent runner, incident catalog and owner-facing repair thread do not. Any later design must reuse/reconcile existing progression owners rather than stack another runner on top.
- The store supports multiple business rows and setup allows creating them; the PRD's authenticated per-business runtime isolation is a target, not an enforced installation invariant today.
- Default tests exercise local logic, SQLite, loopback servers and scripted transports. They do not run paid models or prove Google effects. Optional real-OpenClaw process tests are explicitly opted into and separately reported.

## Design conflicts to resolve before implementation

The earlier conflicts are reconciled in ADRs 001–006. The heading remains stable for existing links. These are design contracts, not an implementation queue; their earlier contradictory task lists are superseded and remain available in Git history.

| Boundary | Reconciled direction |
| --- | --- |
| Delivery/state (ADR-001) | Managed customer hosting; local checkout is inspection only. Preserve existing database paths and records; no implicit migration/reset. |
| Progression (ADR-002) | One logical progression owner, reusing execution claims/receipts and waiting work. Reconcile provider success lost before receipt persistence; never blind-replay. |
| Qualification (ADR-003) | Incomplete inquiries remain eligible. Reject injected authority, not all legitimate content; enforce exact scoped actions deterministically. |
| Recovery (ADR-004) | External supervisor, bounded actions, verified useful continuation. Simulated fixtures cannot prove real runtime/model recovery. |
| Knowledge (ADR-005) | Native recall/wiki first, gated before adoption. Existing SQLite modules are prototype code; no second knowledge engine or destructive migration by default. |
| Connections (ADR-006) | Managed web OAuth/model access with protected credentials and explicit provider requirements; no customer installer or unverified-app bypass strategy. |

### Release coverage, not an implied six-ADR release plan

The PRD also requires customer acceptance, confirmation/handoff, progressive ingestion, budgets and owner UX. Existing acceptance/deposit/readiness records do not establish a customer acceptance link, payment integration or full journey. No ADR set covers all of these as implementation-ready tasks.

- Acceptance must bind to the exact offer and authorized party; superseded offers cannot be accepted. Acceptance alone never confirms a booking.
- Confirmation/handoff consume authoritative configured-condition evidence and preserve accepted terms. Existing code/tests may be repaired without adding missing customer-facing flows.
- Ingestion must preserve source provenance and incomplete-coverage states; live provider/model integration remains independently gated.
- Specific retention defaults, full repair preconditions and hosted operational configuration still need their proper design evidence. Do not invent settled behavior or execute the backlog to hide those gaps.

Repository recovery includes existing application defects, documentation and PRD/ADR contradictions, plus build/test/CI problems. It does not start unbuilt product features. A green test count alone never closes a behavioral audit.

## Reading technical guides

Module guides explain code contracts and test boundaries. Older module-level verification descriptions do not certify today's checkout or a complete live workflow. Use the current PR/CI receipts for exact validation; keep historical lane ownership and test totals out of new work instructions. No video or submission-ready journey is claimed by these documents.
