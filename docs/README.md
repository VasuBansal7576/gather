# Repository guide

## Product intent versus existing code

Gather is intended to coordinate event bookings on behalf of a business owner, using the business's existing tools. The owner supplies policy and operating authority, reviews consequential decisions, and sees evidence of completed work. The product is not a generic email agent, a workflow builder, or a collection of independent model demos.

The [PRD](HACKATHON_PRD.md) describes that destination. It is not an inventory of shipped behavior. The current code is a partially integrated prototype, and feature implementation is paused; the reconciled execution design is now in the ADR index. The [README](../README.md) describes the runnable inspection path; [AGENTS.md](../AGENTS.md) governs changes.

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
- The store supports multiple business rows and setup allows creating them; the PRD's one-business-per-installation rule is a target, not an enforced installation invariant today.
- Default tests exercise local logic, SQLite, loopback servers and scripted transports. They do not run paid models or prove Google effects. Optional real-OpenClaw process tests are explicitly opted into and separately reported.

## Execution design and remaining evidence

Chief has specified the public [16-ADR execution plan](adr/README.md), its [shared contracts](adr/CONTRACTS.md), requirement coverage, dependency waves and bounded file ownership. This replaces the earlier six-proposal partial plan; it is not a shipped-product claim or implementation authorization.

The plan resolves the previously conflicting incomplete-inquiry gate, honest empty versus failed scans, prepared/native/live evidence, one progression owner, price-only hold reuse, runtime cancellation versus wait timeout, customer acceptance from a remote mailbox, and Chief-versus-Orca responsibility. It assigns progressive ingestion, native knowledge, runtime provisioning, Google onboarding, full booking lifecycle, acceptance/handoff and all three sponsor profiles.

Existing code remains the partial prototype mapped above. Engineering proof still belongs to the named tasks: native recall/wiki capability and migration (008), isolated pinned runtime/model budgets (009), configured Google client/Picker (012), full live composition (006), and real sponsor use plus release evidence (013–016). No client credential, consent bypass, model capability or paid service is assumed. A failed capability gate returns concrete evidence to Chief; workers do not choose another product architecture.

Orca receives the index's execution prompt after the owner resumes implementation. It does not receive an instruction to redesign the PRD, discover missing requirements or silently import private SaaS decisions. The current planning pass changes no application behavior.

## Reading technical guides

Module guides explain code contracts and test boundaries. Older module-level verification descriptions do not certify today's checkout or a complete live workflow. Use the current PR/CI receipts for exact validation; keep historical lane ownership and test totals out of new work instructions. No video or submission-ready journey is claimed by these documents.
