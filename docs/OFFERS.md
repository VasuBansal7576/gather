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
(wrong types, missing structural keys, unknown source-reference kinds,
mistyped optional fields) throw an `Error` naming the path. Well-typed but
undecidable inputs (empty event type, non-positive guest count, stale
availability) do not throw; they produce a `blocked` result with
`missingInformation` entries, each carrying an `ownerQuestion`.

`feasible` means ready-to-send: a primary candidate with a known total, a
claimed-profitable assessment, and zero unresolved missing items, conflicts,
or owner decisions. Anything else is `alternatives` (reviewable candidates)
or `blocked` (nothing to send). Approval must bind the exact `version` +
`fingerprint` of a `feasible` result only.

## Inputs

- `inquiry: InquiryRequirements` — already validated upstream (`validator` +
  `validatedAt` identify who validated). Dates, guest count, event type,
  required service IDs, optional budget bounds and preferred space.
- `knowledge: BusinessKnowledge` — spaces with capacities, policy rules,
  scoped exceptions, a price book (lines with `unitCents` and `confidence`,
  costs with `amountCents` and `confidence`, `costsComplete` attestation,
  floor, margin target, deposit rule), and service capabilities. Every entry
  carries `sourceReferences` and a confidence. Unknown prices/costs are
  `null`, never zero or a guess.
- `availability: AvailabilityEvidence` — calendar slots with `observedAt`,
  `asOf`, and `maxFreshnessMs`. Slots may name `spaceIds`; when present,
  only those spaces may use the slot. Freshness is judged on the trusted
  `preparedAt` clock: `observedAt <= asOf <= preparedAt` must hold and
  `preparedAt - observedAt` must fit the bound, else `stale_availability`.
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
  exception) yields an `OwnerDecisionRequest` and keeps the result out of
  `feasible`. Scoped exceptions apply only when their inquiry/customer/
  booking scope matches the current inquiry — the global policy list is never
  mutated (covered by test).
- **Availability:** the requested window must be fully covered by an
  available slot evidencing that space, and any overlapping busy/conflicting
  slot blocks the claimed window (`requested_date_unavailable` /
  `conflicting_availability`), even when a wider available slot exists.
- **Alternatives:** carved to preserve the requested duration — same clock
  time on the alternate date when it fits and avoids busy evidence,
  otherwise the earliest fitting window plus an `alternative_time_shift`
  decision so the host asks instead of silently swapping a 4h evening dinner
  for a midnight slot.
- **Pricing floor (separate permission):** a known total below `floorCents`
  is `below_floor` and rejected even when costs are unknown.
- **Margin permission:** needs a complete ledger; unknown costs or a
  missing `costsComplete` attestation (a bare empty list proves nothing)
  keep profitability `unknown`. Below-target margin is `below_margin`.
- **Profitability knowledge:** `profitable` requires known prices, a
  complete attested ledger, and profit actually `> 0` — breaking even is
  `unprofitable`, and no margin target waives the profit requirement.
- **Confidence:** probable/uncertain (or unattributed, empty-provenance)
  capacity, policy, price, or cost evidence yields explicit
  `unverified_*` / `unknown_profitability` decisions that keep the result
  out of `feasible`.
- **Budget:** binds every candidate. A known-over-budget total is demoted
  to `alternative` with `exceeds_budget` plus `over_budget_approval` —
  never offered as suitable without an explicit decision.
- **Money:** all display strings use `formatMoney` (proper currency units,
  e.g. `$1,400.00`), never raw cents glued to a code.

## Result

`status` is `feasible`, `alternatives`, or `blocked` (see above). Each
candidate carries a SHA-256 `fingerprint` over its canonical content, and
the result carries its own `fingerprint` over offers, profitability, status,
and findings. `evidence` bundles deduped source references per input family
and flags all-fictional fixture runs. `profitability` is the principal
(first-evaluated) assessment; each candidate additionally records its own
totals, unknown-cost/price IDs, and `profitabilityClaimed` flag.

## Adapter contract (`adapters.ts`)

Adapters reshape shared records into this module's inputs without mutating
shared domain or connector types:

- `adaptBusinessFacts(facts: unknown)` maps `space`, `policy`,
  `scoped_exception`, `price_line`, `cost`, `pricing_bounds` (including the
  `costsComplete` attestation, default `false`), and `service` facts (a
  structural subset of `BusinessFact`, so domain rows assign directly).
  Fact-level confidence flows into price/cost lines. Unknown keys and
  malformed values land in `unparseable` — never silently dropped, never
  promoted into offers.
- `buildAvailabilityEvidence(input: unknown)` normalizes fresh calendar
  observations (including per-slot `spaceIds`); it checks shape only, never
  freshness.

## Changed criteria vs the first version (governing PRD G05/G17)

The first suite accepted six unsafe outcomes the independent probes caught;
all are now rejected and covered by regression tests:

1. Known loss with no margin target claimed `profitable` → now
   `unprofitable`, blocked. Positive profit must be `> 0`.
2. Empty `costs[]` claimed `profitable` → now `unknown` without a
   source-backed `costsComplete` attestation (attested empty = genuine
   zero-cost, still feasible).
3. Known total below floor bypassed the floor when costs were unknown →
   floor permission is now independent of cost knowledge.
4. Overlapping busy evidence was ignored when a wider available slot
   existed → any overlapping busy slot now blocks the claimed window, and
   space-bound slots (`spaceIds`) stop Room A evidence authorizing Room B.
5. `require_owner_decision` policies returned `feasible` → any unresolved
   decision (policy, confidence, budget, time-shift, unknown profitability)
   now keeps the result at `alternatives` or `blocked`.
6. `preparedAt` a week after the evidence was accepted → freshness now uses
   the trusted preparation clock and rejects future/inconsistent stamps.

Two earlier tests also encoded weaker behavior and were corrected: unknown
costs and over-budget totals previously yielded `feasible`/primary and now
yield `alternatives` with explicit decisions, per G17's margin honesty and
budget discipline.

## What later host/runtime integration must do

- Validate raw inquiries upstream and set `validator`/`validatedAt`.
- Fetch availability fresh immediately before calling (and recheck
  immediately before any provisional hold — this result is not a hold).
- Attest cost-ledger completeness from a source (ledger document, owner
  confirmation) via `pricing_bounds.costsComplete`, including genuine zero.
- Persist the result, bind owner approval to a `feasible` version +
  fingerprint only, and invalidate that approval on any revision.
- Never present `unknown`/`unprofitable` profitability as profitable, and
  never send an `alternatives`/`blocked` result as an offer.
- Wire `missingInformation`/`ownerDecisions` into the owner experience and
  `conflicts` into review; feed `unparseable` facts back to knowledge
  correction.

## Limitations

- Module tests use fictional fixtures and do not establish live integration
  readiness. No real availability, pricing source, or approval wiring is
  claimed here.
- Alternatives are bounded (3 carved windows, first fitting space each) and
  pricing is flat per event/guest/hour — tiered pricing, taxes, and multi-day
  packaging are future work for the host.
- `requestedVersion`/`supersedesFingerprint` are carried, not enforced:
  the store-side approval boundary owns invalidation.
