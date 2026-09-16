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
- The store supports multiple business rows and setup allows creating them; the PRD's one-business-per-installation rule is a target, not an enforced installation invariant today.
- Default tests exercise local logic, SQLite, loopback servers and scripted transports. They do not run paid models or prove Google effects. Optional real-OpenClaw process tests are explicitly opted into and separately reported.

## Design conflicts to resolve before implementation

The original ADR task lists remain available for review, but [ADRs 001–006](adr/) are **paused proposals**, not an implementation queue.

Chief owns the remaining PRD/ADR reconciliation, complete requirement coverage, dependency contracts and safe execution order. Orca will execute the prepared plan using the configured workers; it is not being assigned the missing design work. Until that preparation is complete, do not describe these proposals as ready for Orca or ask its workers to fill product gaps. The next planning pass must close the unassigned release requirements listed below and reconcile the existing ADR dependency/ownership conflicts before any execution handoff.

The public local-first product and its hackathon task lists are restored; the private hosted SaaS must not override them. The following corrections stay within hackathon scope:

1. **Distribution/state:** keep the one-command local target; require Node 26 and inventory runtime/store owners before any path migration. Existing records are not moved by this cleanup.
2. **Progression/recovery:** reuse existing claims, receipts and waiting work under one owner; explicitly reconcile success lost before a receipt was persisted. Preserve confirmed/cancelled state on replay.
3. **Qualification:** missing dates/counts do not disqualify legitimate inquiries. Embedded instructions cannot grant authority, but legitimate qualification remains permitted.
4. **Prepared-mode evidence:** default fixtures simulate runtime/model failures. Actual process/model recovery requires a separate opt-in harness and separately labeled evidence.
5. **Knowledge:** native recall/wiki is first-choice and gated before adoption. Preserve prototype modules without authorizing a second general knowledge engine.
6. **Live connections:** retain the local-account/loopback proposal. The proposed client, Picker, secret adapter and model-login paths need actual feasibility evidence; an optional broker is not free or automatically exempt from provider obligations.
7. **Release coverage:** these six proposals are not a complete implemented release. Customer acceptance, progressive import UX and other PRD gates remain required; existing acceptance/deposit records do not prove customer-facing integration.

Feature implementation stays paused. Existing defects and contradictions may be repaired; unbuilt journeys and provider feasibility must not be presented as complete. Hackathon-specific choices are not defects merely because the private SaaS differs.

## Reading technical guides

Module guides explain code contracts and test boundaries. Older module-level verification descriptions do not certify today's checkout or a complete live workflow. Use the current PR/CI receipts for exact validation; keep historical lane ownership and test totals out of new work instructions. No video or submission-ready journey is claimed by these documents.
