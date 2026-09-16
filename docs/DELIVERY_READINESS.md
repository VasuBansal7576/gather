# Delivery readiness and operational handoff

Pure evaluation layer in `src/delivery/`, covered by `tests/delivery*.test.ts`. The [booking-delivery service](BOOKING_DELIVERY.md) supplies persistence and API integration; this is not a separate release or an active ownership assignment.

## What it is

A pure, booking-specific readiness evaluator plus an operational-handoff
builder (`src/delivery/contracts.ts`, `readiness.ts`, `verifiers.ts`,
`handoff.ts`, re-exported from `index.ts`).

A resolver kind string inside evidence is **not** itself trusted, so raw
input never reaches the evaluator. The host injects `DeliveryVerifiers`
functions that fetch and verify persisted/provider proofs for the exact
business/booking/version binding; only those validated outputs are
evaluated. Policy and waivers are likewise sourced from the trusted host,
never from external payloads. Raw external claims cannot choose
`owner_authority`, mark a receipt verified, or supply the policy.
`evaluateReadiness` remains as the pure explicitly-trusted-input-only core
for callers that already hold boundary-validated inputs.

```ts
import { evaluateBookingReadiness, buildHandoff } from "./src/delivery/index.ts";

const decision = await evaluateBookingReadiness({
  nowIso, businessId, booking, proposal,
  verifiers,     // host-injected: loadPolicy + fetch* for the exact binding
  rawSignals,    // payment links, email claims: counted, never verifying
});
const handoff = buildHandoff({ decision, booking, proposal });
```

## Readiness rules (G12)

- **Binding first:** business, booking, proposal version/fingerprint, and
  host policy business must agree or evaluation throws. Acceptance binds to
  the exact proposal version **and** fingerprint; other versions conflict.
- **Lifecycle blocks:** cancelled bookings and past event windows block
  readiness regardless of evidence.
- **Per-condition verdicts:** each condition reports `verified`, `missing`,
  `stale`, or `conflicting` with source references. Required conditions
  block; optional ones are reported only.
- **Acceptance:** exact-version record verifies; revoked or
  other-version-only records conflict.
- **Deposit:** net settled receipts (amount minus refunds) in the required
  currency sum to the required amount (split payments supported). Receipts
  dedupe by receiptId: equivalent redeliveries collapse to the snapshot
  with the latest `observedAt` (freshness never depends on input order),
  while conflicting status/amount/refund snapshots for one id fail closed
  as `conflicting`. Pending receipts do not verify;
  rejected/refunded/revoked receipts are excluded; wrong currency
  conflicts; partial payment is `missing` with net paid-vs-required
  detail.
- **Availability:** a current provider attestation must fully cover the
  accepted window. A still-valid hold or hold-free current attestation
  verifies; an expired hold can never veto fresher valid evidence for the
  same window, so expiry decides only when no usable attestation remains.
  Unknown windows are `missing`, old proofs and all-expired holds are
  `stale`, unavailable slots conflict. A hold alone — without a
  current available attestation — never verifies.
- **Resources:** every required resource needs an explicit, current
  `committed` status bound to the exact proposal version/fingerprint,
  whose start/end commitment window covers the event window. Stale
  revisions and short windows are rejected as evidence; `requested` is
  `missing`, expired evidence is `stale`, rejected/revoked evidence
  conflicts, and committed-plus-revoked ambiguity conflicts. Expiry
  evidence supersedes deterministically: an `expired` record observed at
  or after the latest covering commitment ends it (`stale`), while a
  commitment observed after the expiry stands.
- **Window consistency:** the booking snapshot and accepted proposal must
  describe the same event window (availability reads the proposal, handoff
  and lifecycle guards read the booking); the check is per-field — any
  window field present on only one side, or present with divergent values,
  throws instead of averaging.
- **Trusted resolver boundary:** only `acceptance_record`,
  `deposit_ledger`, `calendar_provider`, `resource_registry`, and
  `owner_authority` outputs count. Malformed shapes, non-object items,
  unknown resolvers, and arbitrary `verified: true` flags are rejected as
  evidence (listed in `rejectedEvidence`), never verifying.
- **Waivers:** only persisted waivers scoped to business, booking,
  condition, proposal version **and** fingerprint under an owner identity
  verify. Version alone never scopes a waiver.
- **Provenance:** `live` (all binding evidence live), `demo` (all
  fictional — ready but never `liveReady`), `mixed` (blocks confirmation),
  `none`. Fixture evidence cannot produce live-ready status.

## Handoff rules (G13)

`buildHandoff` ties event details, services, responsibilities, resources,
and outstanding conditions to the accepted version identity (mismatched
revisions throw). Every entry cites its evidence source; missing services,
responsibilities, windows, or unevaluated resources appear under
`outstanding` with `ready: false`. Nothing is invented — no staff, prices,
or services are fabricated. Provenance travels with the handoff.

## Verified (module scope only)

The following describes module coverage, not a current run receipt. Test counts and live outcomes must come from the exact revision's CI or explicit verification.


- `tests/delivery.readiness.test.ts` — 17 tests (pure core).
- `tests/delivery.handoff.test.ts` — 5 tests.
- `tests/delivery.verifiers.test.ts` — 6 tests (host boundary: exact
  binding queries, hostile input rejection, cancelled/past blocks, net
  refunds, window coverage, fail-closed verifiers).
- `tests/delivery.defects.test.ts` — 11 regression tests (duplicate
  receiptId collapse, conflicting snapshot fail-closed, resource
  revision/window binding, waiver fingerprint scope, window-mismatch
  rejection, order-independent redelivery freshness, expired-hold veto,
  partial window binding, expiry supersession, non-object evidence
  rejection, fingerprint diagnostics and NaN guest count).
These are module tests with injected fakes; use current CI for results and counts. They do not establish live provider integration acceptance or prove live confirmation.

## Integration left (not claimed)

1. `src/server/booking-delivery/` already calls `evaluateReadiness` and guards confirmation with `liveReady`. End-to-end evidence from actual provider resolvers remains a separate acceptance requirement.
2. Resolver adapters producing typed outputs (deposit ledger receipts,
   calendar attestations, resource registry commitments, acceptance
   records, persisted owner waivers) from verified provider state.
3. Handoff surfacing in the owner/staff experience and revision-update
   flow when authorized changes move the accepted version.
