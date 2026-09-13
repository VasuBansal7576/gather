# Offer preparation (`src/offers`)

Pure, deterministic, source-backed preparation of business-aware event offers.
It turns validated inquiry requirements, attributable business knowledge, and
fresh availability evidence into feasible versionable offers, suitable
alternatives, or explicit missing/conflicting information and owner decisions.

This module performs no I/O, calls no connectors, grants no approval, runs no
LLM, invents no prices or costs, and creates no graph. There is no hardcoded
successful offer: every candidate is derived from the inputs.

## Entry point

`prepareOffer(input: unknown): OfferPreparationResult`

The boundary accepts `unknown` and validates shape first: malformed envelopes
(wrong types, missing structural keys) throw an `Error` naming the path.
Well-typed but undecidable inputs (empty event type, non-positive guest
count, stale availability) do not throw; they produce a `blocked` result with
`missingInformation` entries, each carrying an `ownerQuestion`.

## Inputs

- `inquiry: InquiryRequirements` — already validated upstream (`validator` +
  `validatedAt` identify who validated). Dates, guest count, event type,
  required service IDs, optional budget bounds and preferred space.
- `knowledge: BusinessKnowledge` — spaces with capacities, policy rules,
  scoped exceptions, a price book (lines with `unitCents`, costs with
  `amountCents`, floor, margin target, deposit rule), and service
  capabilities. Every entry carries `sourceReferences` and a confidence.
  Unknown prices/costs are `null`, never zero or a guess.
- `availability: AvailabilityEvidence` — calendar slots with `observedAt`,
  `asOf`, and `maxFreshnessMs`. Evidence older than the bound blocks
  preparation with `stale_availability`.
- `preparedAt` — caller clock, so identical inputs give byte-identical
  results (covered by test). `requestedVersion` (default 1) and
  `supersedesFingerprint` carry the version chain for approval binding.

## Enforcement rules

- **Capacity:** the guest count must fit the space range; if no space fits,
  `capacity_exceeded` blocks with all known capacities cited.
- **Services:** a required service with no knowledge is missing evidence; a
  required service marked unavailable is a conflict.
- **Policies:** `deny` without a scope-matching exception blocks the
  candidate (`policy_denied`); `require_owner_decision` (or a conditional
  exception) yields an `OwnerDecisionRequest` but still permits the
  candidate. Scoped exceptions apply only when their inquiry/customer/booking
  scope matches the current inquiry — the global policy list is never
  mutated (covered by test).
- **Availability:** the requested window must be fully covered by an
  available slot. Otherwise `requested_date_unavailable` is recorded and up
  to 3 evidenced available slots become `alternative` candidates dated at
  the slot's own range (covered by test).
- **Pricing floor and margin:** a total below `floorCents` (`below_floor`)
  or a margin below `minMarginBps` (`below_margin`) rejects the candidate
  with an explicit conflict instead of discounting (covered by test).
- **Unknown costs/prices:** any `null` unit or cost forces
  `profitability.claim = "unknown"` with the explanation naming the gaps.
  The offer may still be feasible, but `profitabilityClaimed` is false and
  the consequences state the claim cannot be made (covered by test).
- **Budget:** a known total above `budgetCents.max` is an `exceeds_budget`
  conflict, never a silent overrun.

## Result

`status` is `feasible` (a `primaryOffer` with no missing/conflicts),
`alternatives` (candidates exist but need review), or `blocked` (nothing to
send). Each candidate carries a SHA-256 `fingerprint` over its canonical
content, and the result carries its own `fingerprint` over offers,
profitability, status, and findings — downstream approval must bind both the
`version` and the `fingerprint`. `evidence` bundles deduped source
references per input family and flags all-fictional fixture runs.

## Adapter contract (`adapters.ts`)

Adapters reshape shared records into this module's inputs without mutating
shared domain or connector types:

- `adaptBusinessFacts(facts: unknown)` maps `space`, `policy`,
  `scoped_exception`, `price_line`, `cost`, `pricing_bounds`, and `service`
  facts (a structural subset of `BusinessFact`, so domain rows assign
  directly). Unknown keys and malformed values land in `unparseable` —
  never silently dropped, never promoted into offers.
- `buildAvailabilityEvidence(input: unknown)` normalizes fresh calendar
  observations; it checks shape only, never freshness.

## What later host/runtime integration must do

- Validate raw inquiries upstream and set `validator`/`validatedAt`.
- Fetch availability fresh immediately before calling (and recheck
  immediately before any provisional hold — this result is not a hold).
- Persist the result, bind owner approval to its exact version +
  fingerprint, and invalidate that approval on any revision.
- Never present `unknown` profitability as profitable, and never send an
  `alternatives`/`blocked` result as an offer.
- Wire `missingInformation`/`ownerDecisions` into the owner experience and
  `conflicts` into review; feed `unparseable` facts back to knowledge
  correction.

## Limitations

- Module tests use fictional fixtures and do not establish live integration
  readiness. No real availability, pricing source, or approval wiring is
  claimed here.
- Alternatives are bounded (3 slots, first fitting space each) and pricing
  is flat per event/guest/hour — tiered pricing, taxes, and multi-day
  packaging are future work for the host.
- `requestedVersion`/`supersedesFingerprint` are carried, not enforced:
  the store-side approval boundary owns invalidation.
