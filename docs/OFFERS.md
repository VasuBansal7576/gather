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
mistyped optional fields, cross-business knowledge) throw an `Error` naming
the path. Well-typed but undecidable inputs (empty event type, non-positive
guest count, stale availability) do not throw; they produce a `blocked`
result with `missingInformation` entries, each carrying an `ownerQuestion`.

`feasible` means ready-to-send: a primary candidate with a known total and
zero unresolved missing items, conflicts, or owner decisions. Profitability
may be claimed-profitable, or explicitly unknown with notice when no
cost-dependent margin rule exists (see the permission/knowledge split below).
Anything else is `alternatives` (reviewable candidates) or `blocked`
(nothing to send). Approval must bind the exact `version` + `fingerprint` of
a `feasible` result only.

## Inputs

- `inquiry: InquiryRequirements` — already validated upstream (`validator` +
  `validatedAt` identify who validated). Dates, guest count, event type,
  required service IDs, optional budget bounds and preferred space.
- `knowledge: BusinessKnowledge` — `businessId` (must match the inquiry),
  IANA `timezone` (used for local-time alternatives), spaces with
  capacities, policy rules, scoped exceptions, a price book (lines with
  `unitCents` and `confidence`, costs with `amountCents` and `confidence`,
  `costsComplete` attestation, floor, margin target, deposit rule), and
  service capabilities. Every entry carries `sourceReferences` and a
  confidence. Unknown prices/costs are `null`, never zero or a guess.
- `availability: AvailabilityEvidence` — calendar slots with `observedAt`,
  `asOf`, and `maxFreshnessMs`. Every slot declares explicit scope:
  `venueWide: true` for venue-wide evidence, otherwise a non-empty
  `spaceIds` list; a missing scope is malformed, never silently venue-wide.
  Freshness is judged on the trusted `preparedAt` clock:
  `observedAt <= asOf <= preparedAt` must hold and
  `preparedAt - observedAt` must fit the bound, else `stale_availability`.
- `preparedAt` — caller clock, so identical inputs give byte-identical
  results (covered by test). `requestedVersion` (default 1) and
  `supersedesFingerprint` carry the version chain for approval binding.

## Enforcement rules

- **Business scope:** knowledge for one business can never authorize another
  business's inquiry; a mismatch throws.
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
- **Availability:** the requested window must be fully covered for a fitting
  space by an available slot evidencing that space, with no overlapping
  busy/conflicting evidence for that space. Other spaces' busy evidence is
  irrelevant: Room B busy never blocks Room A, and Room A free never
  authorizes Room B (`requested_date_unavailable` /
  `conflicting_availability` otherwise).
- **Alternatives:** carved per fitting space to preserve the requested
  duration in business-local time — same local clock time on the alternate
  date when it fits, is provable across DST, and avoids that space's busy
  evidence; otherwise the earliest fitting window plus an
  `alternative_time_shift` decision, so the host asks instead of silently
  swapping a 4h evening dinner for a midnight slot. Unprovable local times
  (DST gaps/ambiguities) always take the ask-path.
- **Pricing floor (separate permission):** a known total below `floorCents`
  is `below_floor` and rejected even when costs are unknown.
- **Margin permission:** needs a complete ledger; unknown costs or a
  missing `costsComplete` attestation (a bare empty list proves nothing)
  with a configured margin floor raise `unknown_profitability` and keep the
  result out of `feasible`. Below-target margin is `below_margin`.
- **Profitability knowledge:** `profitable` requires known prices, a
  complete attested ledger, and profit actually `> 0` — breaking even is
  `unprofitable`, and no margin target waives the profit requirement.
  Unknown costs with approved prices clearing the floor and no margin rule
  are `feasible` with an explicit no-profit-claim notice — commercial
  permission is separate from profitability knowledge (governing G17).
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
shared domain or connector types. Trust model — the host may only feed
persisted, owner-confirmed facts; unknown inputs, model output, or customer
text can never mint authority here (in particular, nothing the customer
wrote can supply `approvedBy`):

- `adaptBusinessFacts(facts, scope?)` maps `business`, `space`, `policy`,
  `scoped_exception`, `price_line`, `cost`, `pricing_bounds`, and `service`
  facts (a structural subset of `BusinessFact`, so domain rows assign
  directly). Unknown keys and malformed values land in `unparseable` —
  never silently dropped, never promoted into offers.
- Pricing bounds and scoped exceptions are approval-grade: only verified,
  attributed facts apply. Uncertain or unattributed bounds/exceptions are
  reported unparseable — an uncertain exception is never treated as
  approved, and cost-completeness attestation requires its own verified
  bounds fact, not `costsComplete: true` beside unrelated price-line
  sources.
- Each bounds record validates complete before anything applies, so a
  malformed record cannot partially mutate the book; conflicting bounds and
  conflicting duplicate versions are exposed as unparseable, never
  last-write-wins. Identical re-observations dedupe quietly.
- Facts are business-scoped (`businessId` per fact, `businessId`/`timezone`
  via `business` facts, optional expected scope): mixed business IDs throw,
  out-of-scope facts are excluded as unparseable, and an unresolvable scope
  or missing timezone throws — local-time suitability cannot be proven
  without it. Priced lines/costs without an authoritative bounds fact throw
  rather than receiving an invented currency.
- `buildAvailabilityEvidence(input: unknown)` normalizes fresh calendar
  observations with explicit per-slot scope; it checks shape only, never
  freshness.

## Changed criteria vs earlier versions (governing PRD G05/G17)

Round 1 (independent probes) fixed six unsafe outcomes: known-loss
`profitable`, empty-ledger `profitable`, floor bypass with unknown costs,
ignored busy overlap, `feasible` with unresolved owner decisions, and stale
evidence acceptance.

Round 2 (integration blockers) tightened four more areas:

1. The fact adapter was last-write-wins on bounds (including uncertain
   sources), partially mutated on malformed records, dropped exception
   confidence, and invented USD. It is now business-scoped, atomic, and
   verified-only for approval-grade facts, with conflicts exposed.
2. Room B busy blocked Room A (space-blind busy checks) and missing scope
   silently meant venue-wide. Scope is now explicit and both free and busy
   evidence filter per space.
3. Alternatives used the UTC clock. They now preserve business-local time
   across DST via the explicit business timezone, or ask when local
   suitability is unprovable.
4. The earlier feasible rule over-restricted: it forced profitability as a
   prerequisite even with no margin rule. G17 only bans claiming
   profitability on unknown costs — so approved prices clearing the floor
   with no margin rule are feasible with an explicit unknown-profit notice,
   while a configured margin floor with unknown costs (or any unknown
   total) still requires resolution. No owner approvals are invented
   anywhere; decisions block only actual unresolved permission.

## What later host/runtime integration must do

- Validate raw inquiries upstream and set `validator`/`validatedAt`.
- Load only persisted, owner-confirmed facts into the adapter (never raw
  model output or customer text as authority), with one business scope and
  an explicit business timezone fact.
- Attest cost-ledger completeness from a source (ledger document, owner
  confirmation) via a verified `pricing_bounds` fact, including genuine zero.
- Fetch availability fresh immediately before calling (and recheck
  immediately before any provisional hold — this result is not a hold),
  with explicit venue/space scope per slot.
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
