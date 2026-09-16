# ADR-002: One progression owner and durable execution

Status: reconciled design contract — feature implementation remains paused. Existing defect repairs are authorized.

PRD: 5, 6.1, 8.2, 8.5, 10. Related: ADR-004, ADR-006.

## Reconciled decision

Durable orchestration must compose existing execution claims, receipts, waiting-work records and connection sessions, not add a competing loop beside them. The existing booking service remains the owner of approved hold/email effects. Any future intent layer references those records and invokes the same guarded service; it does not resend effects independently or duplicate approvals/receipts.

## Contracts

- Record asynchronous work before dispatch; claim it with a lease/fencing token. One logical owner advances each operation even across process restarts or concurrent hosts.
- Exact business, booking, proposal version/fingerprint and current authority are checked before every unsent consequential step, including after awaits.
- A persisted succeeded receipt is reused, never rewritten. A provider success followed by a crash before receipt persistence is **uncertain**, not failed. Reconcile by stable operation/provider identity before considering another write.
- Provider not-found alone may reflect eventual visibility; it does not prove no effect. Continue bounded reconciliation or surface blocked uncertainty.
- Preserve a successful hold when email fails. Resume only the incomplete approved step; never create another hold merely to complete the email.
- Separate business lifecycle from action execution: replaying a completed approval/retry must not demote an already confirmed booking. Replays do not create confirmation either; confirmation remains proof-gated.
- UI state comes from durable records, not HTTP timing. Failed/uncertain work stays inspectable.
- Scheduler ownership is singular: existing waiting work dispatches through the same action boundary. Queue choice follows the selected store and actual workload, not a second custom scheduler by default.

## Existing interfaces / future scope

`src/server/booking-service.ts`, `sqlite-store.ts`, `operator-runtime/`, `coordination/` and booking/action/execution routes already own portions of this contract. A new `src/intents/` tree is not mandated. Before new orchestration, map existing records and transitions to uncovered work, and state ownership/migration explicitly.

## Required evidence

Focused existing-behavior regressions cover repeat approval/retry, exact identity, stale approvals, partial success, concurrent claims and restart. Future end-to-end evidence must additionally cover new inquiry → grounded offer → approval → hold/email, crash before receipt persistence, recovery without duplicates and current authority after restart. Do not call fixture pre-created proposals a complete golden path. That full journey remains unimplemented.
