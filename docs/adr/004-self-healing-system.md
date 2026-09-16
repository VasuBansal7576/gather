# ADR-004: External-supervisor recovery and truthful evidence

Status: reconciled design contract — feature implementation remains paused. Existing defect repairs are authorized.

PRD: 6, 8.1–8.2, 10. Related: ADR-002, ADR-006.

## Reconciled decision

The broken business agent cannot own its own recovery. Gather's external supervisor owns runtime lifecycle; any operations-agent diagnosis selects only a bounded catalog action through that boundary. Preserve the required detection → diagnosis → corrective action → verification → useful continuation contract. This reconciliation does not implement the future incident product or settle every repair mechanism.

## Contracts

- Evidence comes from failed work, health probes and pending/uncertain executions. Deduplicate ongoing incidents while preserving attempt history.
- Candidate repair categories remain runtime restart, cursor-based sync resume, external-effect reconciliation, authorized token refresh or owner reconnect, compatible configuration rollback, resumable-work continuation and explicit blocked state.
- Each action needs preconditions, affected business/runtime, attempt/time/spend bounds and an independent verification probe before activation. Unknown diagnosis does not gain arbitrary shell/file/network access.
- Never change commercial terms, approvals, accepted records, credential scope or production code as a repair. Never claim that restoring a database reverses Google effects.
- Reuse ADR-002 execution ownership. Missing receipts require reconciliation; successful holds are not recreated to fix email.
- Reconnection is an owner action, not a completed recovery. Repeated unchanged failure becomes blocked with the actual impact and next action.
- The public release excludes autonomous production code changes. A defect reproduction/patch proposal for operator review is not an applied repair.

## Fixture versus actual recovery

Credential-free fixtures may simulate provider faults and verify state transitions. They cannot prove a real OpenClaw restart or model diagnosis. Real lifecycle tests use a separately configured isolated runtime and label their evidence separately. A future fault panel is test-only, cannot target production businesses, and must identify injected versus actual failures. Do not add a live model requirement to the default fixture suite.

## Existing interfaces / future scope

`src/runtime/` owns process/Gateway controls; `operator-runtime/` health and waiting work and `booking-service.ts` provide existing evidence/continuation boundaries. The general incident store, catalog runner and owner-visible repair thread remain unbuilt. Concrete startup/cancellation defects in existing controls are repair work now, not permission to implement those features.

## Required future evidence

For each claimed recovery: failure, diagnosis, scoped action, independent verification, resumed useful work and no duplicate provider effect. Include an honest blocked case. Runtime recovery requires an actual isolated process; provider recovery requires corresponding provider evidence. A green timer or model statement is insufficient.
