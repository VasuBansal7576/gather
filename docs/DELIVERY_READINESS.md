# Delivery readiness (G12) and operational handoff (G13)

Owner: delivery worker. Files owned: `src/delivery/**`,
`tests/delivery*.test.ts`, this document. Shared domain, server, store,
connector, API, UI, and packaging files are untouched.

## What it is

A pure, booking-specific readiness evaluator plus an operational-handoff
builder (`src/delivery/contracts.ts`, `readiness.ts`, `handoff.ts`,
re-exported from `index.ts`). It evaluates an immutable accepted proposal
identity against configured business confirmation conditions using only
typed trusted verifier outputs. It performs no store writes, changes no
booking status, runs no scheduler, sends nothing, and approves nothing: it
exports a module for later guarded-service wiring.

```ts
import { evaluateReadiness, buildHandoff } from "./src/delivery/index.ts";

const decision = evaluateReadiness({
  nowIso, businessId, booking, proposal, policy,
  evidence,      // VerifierOutput[] from the trusted resolver boundary
  rawSignals,    // payment links, email claims: counted, never verifying
  waivers,       // scoped OwnerWaiver[]; payload booleans never waive
});
const handoff = buildHandoff({ decision, booking, proposal });
```

## Readiness rules (G12)

- **Binding first:** business, booking, proposal version/fingerprint, and
  policy business must agree or evaluation throws. Acceptance binds to the
  exact proposal version **and** fingerprint; other versions conflict.
- **Per-condition verdicts:** each condition reports `verified`, `missing`,
  `stale`, or `conflicting` with source references. Required conditions
  block; optional ones are reported only.
- **Acceptance:** exact-version record verifies; revoked or
  other-version-only records conflict.
- **Deposit:** settled receipts in the required currency sum to the
  required amount (split payments supported). Pending receipts do not
  verify; rejected/refunded/revoked receipts are excluded; wrong currency
  conflicts; partial payment is `missing` with paid-vs-required detail.
- **Availability:** a current provider attestation must fully cover the
  accepted window. Unknown windows are `missing`, old proofs and expired
  holds are `stale`, unavailable slots conflict. A hold alone — without a
  current available attestation — never verifies.
- **Resources:** every required resource needs an explicit, current
  `committed` status. `requested` is `missing`, expired evidence is
  `stale`, rejected/revoked evidence conflicts, and committed-plus-revoked
  ambiguity conflicts.
- **Trusted resolver boundary:** only `acceptance_record`,
  `deposit_ledger`, `calendar_provider`, `resource_registry`, and
  `owner_authority` outputs count. Malformed shapes, unknown resolvers, and
  arbitrary `verified: true` flags are rejected as evidence (listed in
  `rejectedEvidence`), never verifying.
- **Waivers:** only persisted waivers scoped to business, booking,
  condition, and proposal version under an owner identity verify.
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

- `tests/delivery.readiness.test.ts` — 17 tests.
- `tests/delivery.handoff.test.ts` — 5 tests.
- Full suite plus `npm run typecheck` (see commit message for counts).
  These are module tests; they do not establish integration acceptance.

## Integration left (not claimed)

1. Guarded confirmation service calling `evaluateReadiness` with live
   resolver outputs and enforcing `liveReady` before marking confirmed.
2. Resolver adapters producing typed outputs (deposit ledger receipts,
   calendar attestations, resource registry commitments, acceptance
   records, persisted owner waivers) from verified provider state.
3. Handoff surfacing in the owner/staff experience and revision-update
   flow when authorized changes move the accepted version.
