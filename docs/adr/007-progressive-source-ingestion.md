# ADR-007: Progressive sources, coverage and invalidation

Status: specified — implementation paused
Depends on: ADR-003
Authorization: planning only; explicit owner instruction is required to start implementation.
PRD: 3, 3.1, 4.2, 4.3; gates Progressive ingestion, Connections (Live mode), Isolation
Contracts: C02, C03, C04 in [shared contracts](CONTRACTS.md)

## Decision

Extend existing Google read adapters and intake cursors into a resumable source pipeline. Record coverage and invalidate stale evidence; authentication is not complete import.

## Existing code and scope

Read the source paths below and their module guides before editing. Existing implementations are reusable foundations, not evidence that this ADR is complete. Follow the [execution index](README.md) and shared contracts; references are not competing work orders.

## Owns

- `src/connectors/google/documents.ts`
- `src/connectors/google/gmail.ts` (read paths)
- `src/connectors/google/incremental.ts`
- `src/server/operator-runtime/intake.ts`
- `src/server/operator-runtime/store.ts`
- `src/server/operator-runtime/types.ts`
- `src/server/sources/**` (new)
- `app/api/operator/intake/**`
- `tests/source-sync*.test.ts` (new)
- `tests/google-read*.test.ts`
- `tests/google-incremental-scope.test.ts`
- `docs/GOOGLE_READS.md`

## Must not touch

- Personal `~/.openclaw`, unrelated installations, private SaaS files, credentials or live customer data.
- Paths outside Owns, including other in-flight ADR files. Shared paths require the index's exclusive write lock and predecessor integration; no simultaneous writers.
- Product requirements, acceptance criteria or shared contract semantics. Return a contradiction to Chief with source evidence; do not silently redesign.

## Inputs, outputs and integration

C03 SourcePort emits C02 envelopes and source-version/deletion events. Knowledge consumer is injected; this ADR exposes the port using a recording test consumer, not a competing knowledge implementation. Reuse provider/account scoping and source-key encoding.

## Implementation steps

1. Implement initial visible scope, paging/cursor transactions, active-thread priority, sent-context correlation and explicit history expansion.
2. Cache by content/parser version, bounded concurrency and stable-key dedupe; reject incompatible cursor scope.
3. Expose no-leads/partial/failed states from scan evidence; distinguish no business facts from no inquiries.
4. Emit deletion/disconnect invalidations before subsequent dependent work; purge cached bodies as C03 requires and retain minimal tombstones. Prefer existing text exports; no parser dependency unless a reproduced required document fails.

## Failure and recovery

Use the cited contracts' durable, scoped error paths. A capability/credential gate may block real verification without blocking scripted development; name the exact missing evidence. Do not substitute simulated success, relax authority, add a second progression owner or change vendors to make acceptance pass.

## Out of scope

Private hosted SaaS, billing, revenue-recovery strategy and autonomous code deployment. Adjacent subsystems belong to their named ADRs in the index. No merge, external deployment, purchases or submission is authorized here.

## Acceptance

- **007-A01:** Fresh no-event account yields accurate scoped count, no bookings/facts; partial/error never reports completed empty scan.
- **007-A02:** Restart mid-page, duplicate delivery, changed and deleted document, revoked scope and expired cursor handled without skipped records.
- **007-A03:** Useful inquiry can proceed before historical import ends; older/excluded sample finds omissions and permits scope expansion.
- **007-A04:** Cross-account/mode source read denied; raw source instructions remain evidence, never confirmed facts.
- **007-CHECKS:** `npm test`, `npm run typecheck`, `npm run build` pass; report optional skips honestly. Run the existing golden suite after ADR-002 introduces it; do not claim later release cases before their owning ADR lands. Attach source/command evidence, and rendered evidence for UI changes.

## Completion handoff

Return changed files, local/remote commit IDs, acceptance-ID evidence and remaining blockers to the Orca coordinator. Commit and push the task branch; verify matching remote SHA. Do not self-mark shipped or merge. The coordinator reviews actual artifacts and integrated behaviour, not only the worker summary.
