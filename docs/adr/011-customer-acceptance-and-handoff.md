# ADR-011: Version-bound customer acceptance and delivery handoff

Status: specified — implementation paused
Depends on: ADR-010
Authorization: planning only; explicit owner instruction is required to start implementation.
PRD: 5.1, 9; gates Customer acceptance, Booking journey, Exact authority
Contracts: C02, C05, C06, C07 in [shared contracts](CONTRACTS.md)

## Decision

Provide remote-customer-compatible acceptance by signed email link and verified reply processing, then reuse existing delivery-readiness evidence evaluation. Customer acceptance never directly means confirmed.

## Existing code and scope

Read the source paths below and their module guides before editing. Existing implementations are reusable foundations, not evidence that this ADR is complete. Follow the [execution index](README.md) and shared contracts; references are not competing work orders.

## Owns

- `src/server/acceptance/**` (new)
- `src/delivery/**`
- `src/server/booking-delivery/**`
- `src/server/business-operator/operator.ts` (acceptance link composition)
- `src/server/operator-runtime/intake.ts` (acceptance dispatch)
- `app/api/bookings/**` (acceptance/readiness/handoff endpoints only)
- `tests/customer-acceptance*.test.ts` (new)
- `tests/booking-delivery.test.ts`
- `docs/BOOKING_DELIVERY.md`
- `docs/DELIVERY_READINESS.md`

## Must not touch

- Personal `~/.openclaw`, unrelated installations, private SaaS files, credentials or live customer data.
- Paths outside Owns, including other in-flight ADR files. Shared paths require the index's exclusive write lock and predecessor integration; no simultaneous writers.
- Product requirements, acceptance criteria or shared contract semantics. Return a contradiction to Chief with source evidence; do not silently redesign.

## Inputs, outputs and integration

C07 signed mailto link -> authenticated token-correlated reply -> atomic nonce/version-bound acceptance record. Existing delivery service consumes that record plus independent resource/payment evidence and exports readiness/handoff DTO. Explicitly distinguish mailto send from web-click acceptance.

## Implementation steps

1. Generate bounded signed tokens with key rotation/expiry/reissue, no logged bearer material, no customer account and no localhost URL sent to remote customers.
2. Route existing-booking replies and token candidates before the new-inquiry gate. Validate sender/provider authentication and token-to-original-offer receipt correlation (new thread permitted for signed tokens), exact current offer/fingerprint and expiry; ambiguous yes routes to clarification, replay is idempotent, different-sender forwarding denied.
3. Persist acceptance and token-use atomically. Re-evaluate configured readiness conditions without inventing deposit evidence or changing accepted terms.
4. Produce version-linked handoff with outstanding conditions and business-local dates; no payment processor or public acceptance web server introduced.

## Failure and recovery

Use the cited contracts' durable, scoped error paths. A capability/credential gate may block real verification without blocking scripted development; name the exact missing evidence. Do not substitute simulated success, relax authority, add a second progression owner or change vendors to make acceptance pass.

## Out of scope

Private hosted SaaS, billing, revenue-recovery strategy and autonomous code deployment. Adjacent subsystems belong to their named ADRs in the index. No merge, external deployment, purchases or submission is authorized here.

## Acceptance

- **011-A01:** Separate customer mailbox receives link, sends a new-thread token reply and is accepted only after verified intake; opening link alone does nothing.
- **011-A02:** An unambiguous authenticated plain yes binds only the single current offer; multiple/uncertain offers require clarification. Tampered, expired, superseded, forwarded-wrong-sender, unauthenticated and cross-booking token cases rejected/reviewed; duplicate produces one acceptance.
- **011-A03:** Accepted but missing resource/payment evidence stays provisional; verified required conditions yield confirmed.
- **011-A04:** Owner price correction after acceptance leaves accepted terms unchanged; handoff cites exact version and missing conditions.
- **011-CHECKS:** `npm test`, `npm run typecheck`, `npm run build` pass; report optional skips honestly. Run the existing golden suite after ADR-002 introduces it; do not claim later release cases before their owning ADR lands. Attach source/command evidence, and rendered evidence for UI changes.

## Completion handoff

Return changed files, local/remote commit IDs, acceptance-ID evidence and remaining blockers to the Orca coordinator. Commit and push the task branch; verify matching remote SHA. Do not self-mark shipped or merge. The coordinator reviews actual artifacts and integrated behaviour, not only the worker summary.
