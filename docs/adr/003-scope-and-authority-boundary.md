# ADR-003: Intake domain gate and deterministic authority

Status: specified — implementation paused
Depends on: ADR-002
Authorization: planning only; explicit owner instruction is required to start implementation.
PRD: 3.1, 4, 4.1, 4.4, 5; gates Scope boundary, Exact authority, External-content boundary
Contracts: C02, C05, C06 in [shared contracts](CONTRACTS.md)

## Decision

Separate event relevance from completeness, and enforce commercial/tool authority in code. Incomplete genuine leads remain eligible; untrusted messages cannot approve, select another business or widen recipient scope.

## Existing code and scope

Read the source paths below and their module guides before editing. Existing implementations are reusable foundations, not evidence that this ADR is complete. Follow the [execution index](README.md) and shared contracts; references are not competing work orders.

## Owns

- `src/intake/**` (new)
- `src/server/operator-runtime/intake.ts`
- `src/server/live-model/tools.ts`
- `src/server/live-model/mcp-tools.ts`
- `src/server/operator-runtime/mcp-tools.ts`
- `src/server/booking-service.ts` (authority checks)
- `app/api/inbox/compose/route.ts` (new)
- `tests/intake-gate*.test.ts` (new)
- `tests/tool-allowlist*.test.ts` (new)
- `tests/authority-floors*.test.ts` (new)

## Must not touch

- Personal `~/.openclaw`, unrelated installations, private SaaS files, credentials or live customer data.
- Paths outside Owns, including other in-flight ADR files. Shared paths require the index's exclusive write lock and predecessor integration; no simultaneous writers.
- Product requirements, acceptance criteria or shared contract semantics. Return a contradiction to Chief with source evidence; do not silently redesign.

## Inputs, outputs and integration

C02 intake -> C05 eligible/unrelated/needs_review with reasons and missing fields. Register a prepared-only compose API; do not add unrestricted email/Drive tools. Tools consume server-derived mode/business and existing owner approval objects.

## Implementation steps

1. Reuse actual registered tool boundaries and record a capability inventory in PR evidence. Extraction may call the configured model adapter; deterministic validation grants no authority from output.
2. Implement missing-date/count eligibility, uncertainty review and source-tagged dedupe. Prepared classification is scripted and labelled.
3. Check exact approval, recipient, version, expiry and cumulative concessions at proposal creation and before execution. Preserve optional test-recipient restriction as an additional restriction only.
4. Return displayable refusal/review reasons for ADR-006 UI. No UI ownership in this ADR.

## Failure and recovery

Use the cited contracts' durable, scoped error paths. A capability/credential gate may block real verification without blocking scripted development; name the exact missing evidence. Do not substitute simulated success, relax authority, add a second progression owner or change vendors to make acceptance pass.

## Out of scope

Private hosted SaaS, billing, revenue-recovery strategy and autonomous code deployment. Adjacent subsystems belong to their named ADRs in the index. No merge, external deployment, purchases or submission is authorized here.

## Acceptance

- **003-A01:** Invoice/newsletter/pure unrelated instructions cannot cause booking writes; legitimate incomplete inquiry qualifies; mixed injection cannot alter price/recipient/approval.
- **003-A02:** Customer claim of owner discount cannot authorize it; cumulative concessions/floors/expiry and cross-booking attempts rejected.
- **003-A03:** Unknown model classification is review, never permission; unavailable model does not turn all messages into no leads.
- **003-A04:** Compose API is denied in live mode; tool inventory has no arbitrary recipient/account/business escape.
- **003-CHECKS:** `npm test`, `npm run typecheck`, `npm run build` pass; report optional skips honestly. Run the existing golden suite after ADR-002 introduces it; do not claim later release cases before their owning ADR lands. Attach source/command evidence, and rendered evidence for UI changes.

## Completion handoff

Return changed files, local/remote commit IDs, acceptance-ID evidence and remaining blockers to the Orca coordinator. Commit and push the task branch; verify matching remote SHA. Do not self-mark shipped or merge. The coordinator reviews actual artifacts and integrated behaviour, not only the worker summary.
