import assert from "node:assert/strict";
import test from "node:test";
import {
  adaptBusinessFacts,
  buildAvailabilityEvidence,
  prepareOffer,
  type AvailabilityEvidence,
  type BusinessKnowledge,
  type InquiryRequirements,
} from "../src/offers/index.ts";
import type { SourceReference } from "../src/domain/contracts.ts";

// Clearly fictional fixture data. It is never presented as a verified integration.
const fixtureSource: SourceReference = {
  kind: "fixture",
  locator: "fixture://fictional/offers-business-001",
  label: "Fictional offers fixture",
  fictional: true,
};

const PREPARED_AT = "2026-06-01T12:00:00.000Z";
const OBSERVED_AT = "2026-06-01T12:00:00.000Z";

function baseInquiry(overrides: Partial<InquiryRequirements> = {}): InquiryRequirements {
  return {
    inquiryId: "inq-001",
    businessId: "biz-001",
    eventType: "rehearsal_dinner",
    startAt: "2026-06-12T17:00:00.000Z",
    endAt: "2026-06-12T23:00:00.000Z",
    guestCount: 40,
    serviceRequirements: ["private_dining"],
    budgetCents: { max: 200_000 },
    customerId: "cust-001",
    sourceReferences: [fixtureSource],
    validatedAt: "2026-06-01T11:00:00.000Z",
    validator: "fixture-inquiry-check",
    ...overrides,
  };
}

function baseKnowledge(overrides: Partial<BusinessKnowledge> = {}): BusinessKnowledge {
  return {
    spaces: [
      {
        spaceId: "hall-a",
        name: "Fictional Cedar Hall",
        capacityMin: 20,
        capacityMax: 80,
        confidence: "verified",
        sourceReferences: [fixtureSource],
      },
      {
        spaceId: "hall-b",
        name: "Fictional Oak Room",
        capacityMin: 10,
        capacityMax: 30,
        confidence: "verified",
        sourceReferences: [fixtureSource],
      },
    ],
    policies: [],
    scopedExceptions: [],
    priceBook: {
      currency: "USD",
      lines: [
        { lineId: "venue", label: "Venue hire", pricingBasis: "per_event", unitCents: 80_000, confidence: "verified", sourceReferences: [fixtureSource] },
        { lineId: "catering", label: "Catering", pricingBasis: "per_guest", unitCents: 1_500, confidence: "verified", sourceReferences: [fixtureSource] },
      ],
      costs: [{ costId: "food", label: "Food cost", amountCents: 30_000, confidence: "verified", sourceReferences: [fixtureSource] }],
      costsComplete: true,
      floorCents: 100_000,
      minMarginBps: 1_000,
      depositBps: 2_000,
      sourceReferences: [fixtureSource],
    },
    services: [
      { serviceId: "private_dining", label: "Private dining", available: true, sourceReferences: [fixtureSource] },
      { serviceId: "outside_catering", label: "Outside catering", available: true, sourceReferences: [fixtureSource] },
    ],
    sourceReferences: [fixtureSource],
    ...overrides,
  };
}

function baseAvailability(overrides: Partial<AvailabilityEvidence> = {}): AvailabilityEvidence {
  return {
    calendarId: "cal-001",
    observedAt: OBSERVED_AT,
    asOf: OBSERVED_AT,
    maxFreshnessMs: 900_000,
    slots: [
      {
        startAt: "2026-06-12T00:00:00.000Z",
        endAt: "2026-06-13T00:00:00.000Z",
        available: true,
        sourceReferences: [fixtureSource],
      },
    ],
    sourceReferences: [fixtureSource],
    ...overrides,
  };
}

test("feasible primary offer is deterministic, source-backed, and money-formatted", () => {
  const input = { inquiry: baseInquiry(), knowledge: baseKnowledge(), availability: baseAvailability(), preparedAt: PREPARED_AT };
  const first = prepareOffer(input);
  const second = prepareOffer(input);
  assert.equal(first.status, "feasible");
  assert.deepEqual(first, second);
  assert.ok(first.primaryOffer !== undefined);
  // 80_000 + 40 * 1_500
  assert.equal(first.primaryOffer?.totalCents, 140_000);
  assert.equal(first.primaryOffer?.depositCents, 28_000);
  assert.equal(first.profitability.claim, "profitable");
  assert.equal(first.primaryOffer?.profitabilityClaimed, true);
  assert.match(first.fingerprint, /^[0-9a-f]{64}$/);
  assert.ok(first.primaryOffer?.consequences.some((line) => line.includes("$1,400.00")) === true);
  assert.ok(first.primaryOffer?.consequences.every((line) => !line.includes("140000 USD")) === true);
  assert.equal(first.evidence.allFictional, true);
});

test("probe: known loss with no margin target is unprofitable, never profitable", () => {
  const knowledge = baseKnowledge();
  knowledge.priceBook.lines = [
    { lineId: "venue", label: "Venue hire", pricingBasis: "per_event", unitCents: 10_000, confidence: "verified", sourceReferences: [fixtureSource] },
  ];
  knowledge.priceBook.costs = [
    { costId: "food", label: "Food cost", amountCents: 20_000, confidence: "verified", sourceReferences: [fixtureSource] },
  ];
  knowledge.priceBook.costsComplete = true;
  knowledge.priceBook.floorCents = null;
  knowledge.priceBook.minMarginBps = null;
  const result = prepareOffer({ inquiry: baseInquiry(), knowledge, availability: baseAvailability(), preparedAt: PREPARED_AT });
  assert.equal(result.profitability.claim, "unprofitable");
  assert.equal(result.status, "blocked");
  assert.equal(result.offers.length, 0);
  assert.ok(result.conflicts.some((conflict) => conflict.code === "unprofitable"));
});

test("probe: empty cost ledger without attestation stays unknown; attested empty means genuine zero-cost", () => {
  const unattested = baseKnowledge();
  unattested.priceBook.costs = [];
  unattested.priceBook.costsComplete = false;
  const unknown = prepareOffer({ inquiry: baseInquiry(), knowledge: unattested, availability: baseAvailability(), preparedAt: PREPARED_AT });
  assert.equal(unknown.profitability.claim, "unknown");
  assert.equal(unknown.primaryOffer?.profitabilityClaimed, false);
  // Corrected criterion (governing PRD G17): an unresolved profitability
  // question keeps the result not ready-to-send, so this is alternatives,
  // not feasible as the previous suite wrongly accepted.
  assert.equal(unknown.status, "alternatives");
  assert.ok(unknown.ownerDecisions.some((decision) => decision.code === "unknown_profitability"));

  const attested = baseKnowledge();
  attested.priceBook.costs = [];
  attested.priceBook.costsComplete = true;
  const zeroCost = prepareOffer({ inquiry: baseInquiry(), knowledge: attested, availability: baseAvailability(), preparedAt: PREPARED_AT });
  assert.equal(zeroCost.profitability.claim, "profitable");
  assert.equal(zeroCost.status, "feasible");
});

test("probe: known total below floor is rejected even when costs are unknown", () => {
  const knowledge = baseKnowledge();
  knowledge.priceBook.lines = [
    { lineId: "venue", label: "Venue hire", pricingBasis: "per_event", unitCents: 10_000, confidence: "verified", sourceReferences: [fixtureSource] },
  ];
  knowledge.priceBook.costs = [
    { costId: "food", label: "Food cost", amountCents: null, confidence: "verified", sourceReferences: [fixtureSource] },
  ];
  knowledge.priceBook.costsComplete = false;
  knowledge.priceBook.floorCents = 20_000;
  const result = prepareOffer({ inquiry: baseInquiry(), knowledge, availability: baseAvailability(), preparedAt: PREPARED_AT });
  assert.equal(result.profitability.claim, "below_floor");
  assert.equal(result.status, "blocked");
  assert.equal(result.offers.length, 0);
});

test("probe: overlapping busy evidence blocks the claimed window; fallback preserves duration with a time decision", () => {
  const availability = baseAvailability({
    slots: [
      {
        startAt: "2026-06-12T00:00:00.000Z",
        endAt: "2026-06-13T00:00:00.000Z",
        available: true,
        sourceReferences: [fixtureSource],
      },
      {
        startAt: "2026-06-12T19:00:00.000Z",
        endAt: "2026-06-12T20:00:00.000Z",
        available: false,
        reason: "Fixture marks 19-20 as busy.",
        sourceReferences: [fixtureSource],
      },
    ],
  });
  const result = prepareOffer({
    inquiry: baseInquiry({ startAt: "2026-06-12T18:00:00.000Z", endAt: "2026-06-12T22:00:00.000Z" }),
    knowledge: baseKnowledge(),
    availability,
    preparedAt: PREPARED_AT,
  });
  assert.equal(result.primaryOffer, undefined);
  assert.ok(result.offers.every((offer) => !(offer.startAt < "2026-06-12T22:00:00.000Z" && offer.endAt > "2026-06-12T18:00:00.000Z" && offer.startAt >= "2026-06-12T18:00:00.000Z")));
  assert.ok(result.conflicts.some((conflict) => conflict.code === "requested_date_unavailable"));
  // The only fitting window keeps the 4h duration (midnight fallback) and marks the time shift as a decision.
  assert.equal(result.offers.length, 1);
  const windows = result.offers[0];
  assert.equal(Date.parse(windows?.endAt ?? "") - Date.parse(windows?.startAt ?? ""), 4 * 3_600_000);
  assert.ok(result.ownerDecisions.some((decision) => decision.code === "alternative_time_shift"));
});

test("probe: Room A availability cannot authorize Room B", () => {
  const knowledge = baseKnowledge();
  knowledge.spaces = [
    {
      spaceId: "hall-b",
      name: "Fictional Oak Room",
      capacityMin: 10,
      capacityMax: 30,
      confidence: "verified",
      sourceReferences: [fixtureSource],
    },
  ];
  const availability = baseAvailability({
    slots: [
      {
        startAt: "2026-06-12T00:00:00.000Z",
        endAt: "2026-06-13T00:00:00.000Z",
        available: true,
        spaceIds: ["hall-a"],
        sourceReferences: [fixtureSource],
      },
    ],
  });
  const result = prepareOffer({
    inquiry: baseInquiry({ guestCount: 20 }),
    knowledge,
    availability,
    preparedAt: PREPARED_AT,
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.offers.length, 0);
  assert.ok(result.conflicts.some((conflict) => conflict.code === "conflicting_availability"));
});

test("probe: require_owner_decision policy keeps the result not feasible", () => {
  const knowledge = baseKnowledge();
  knowledge.policies = [
    {
      policyId: "pol-approval",
      statement: "Large events need owner sign-off",
      effect: "require_owner_decision",
      minGuests: 30,
      confidence: "verified",
      sourceReferences: [fixtureSource],
    },
  ];
  const result = prepareOffer({ inquiry: baseInquiry(), knowledge, availability: baseAvailability(), preparedAt: PREPARED_AT });
  assert.notEqual(result.status, "feasible");
  assert.equal(result.status, "alternatives");
  assert.ok(result.ownerDecisions.some((decision) => decision.code === "policy_requires_owner"));
});

test("probe: preparation clock rejects week-old evidence and future-stamped evidence", () => {
  const weekLate = prepareOffer({
    inquiry: baseInquiry(),
    knowledge: baseKnowledge(),
    availability: baseAvailability({ observedAt: "2026-06-01T12:00:00.000Z", asOf: "2026-06-01T12:00:00.000Z" }),
    preparedAt: "2026-06-08T12:00:00.000Z",
  });
  assert.equal(weekLate.status, "blocked");
  assert.ok(weekLate.missingInformation.some((item) => item.code === "stale_availability"));

  const futureStamped = prepareOffer({
    inquiry: baseInquiry(),
    knowledge: baseKnowledge(),
    availability: baseAvailability({ observedAt: "2026-06-02T12:00:00.000Z", asOf: "2026-06-02T12:00:00.000Z" }),
    preparedAt: PREPARED_AT,
  });
  assert.equal(futureStamped.status, "blocked");
  assert.ok(futureStamped.missingInformation.some((item) => item.code === "stale_availability"));
});

test("unavailable requested date yields a duration-preserving same-clock alternative", () => {
  const availability = baseAvailability({
    slots: [
      {
        startAt: "2026-06-12T00:00:00.000Z",
        endAt: "2026-06-13T00:00:00.000Z",
        available: false,
        reason: "Fixture marks the requested date as booked.",
        sourceReferences: [fixtureSource],
      },
      {
        startAt: "2026-06-13T00:00:00.000Z",
        endAt: "2026-06-14T00:00:00.000Z",
        available: true,
        sourceReferences: [fixtureSource],
      },
    ],
  });
  const result = prepareOffer({ inquiry: baseInquiry(), knowledge: baseKnowledge(), availability, preparedAt: PREPARED_AT });
  assert.equal(result.status, "alternatives");
  assert.equal(result.primaryOffer, undefined);
  assert.equal(result.offers.length, 1);
  assert.equal(result.offers[0]?.rank, "alternative");
  // Same 6h duration at the same clock time on the next date — not a 24h slot.
  assert.equal(result.offers[0]?.startAt, "2026-06-13T17:00:00.000Z");
  assert.equal(result.offers[0]?.endAt, "2026-06-13T23:00:00.000Z");
  assert.ok(!(result.ownerDecisions.some((decision) => decision.code === "alternative_time_shift")));
  assert.ok(result.conflicts.some((conflict) => conflict.code === "requested_date_unavailable"));
});

test("total below the approved floor is rejected, not discounted", () => {
  const knowledge = baseKnowledge();
  knowledge.priceBook.floorCents = 150_000;
  const result = prepareOffer({ inquiry: baseInquiry(), knowledge, availability: baseAvailability(), preparedAt: PREPARED_AT });
  assert.equal(result.status, "blocked");
  assert.equal(result.offers.length, 0);
  assert.equal(result.profitability.claim, "below_floor");
  assert.ok(result.conflicts.some((conflict) => conflict.code === "below_price_floor"));
});

test("margin below the approved minimum is rejected", () => {
  const knowledge = baseKnowledge();
  knowledge.priceBook.minMarginBps = 9_000;
  const result = prepareOffer({ inquiry: baseInquiry(), knowledge, availability: baseAvailability(), preparedAt: PREPARED_AT });
  assert.equal(result.status, "blocked");
  assert.equal(result.profitability.claim, "below_margin");
  assert.ok((result.profitability.marginBps ?? 0) < 9_000);
  assert.ok(result.conflicts.some((conflict) => conflict.code === "below_margin"));
});

test("unknown costs prevent any profitability claim and keep the result not ready-to-send", () => {
  const knowledge = baseKnowledge();
  knowledge.priceBook.costs = [{ costId: "food", label: "Food cost", amountCents: null, confidence: "verified", sourceReferences: [fixtureSource] }];
  knowledge.priceBook.costsComplete = false;
  const result = prepareOffer({ inquiry: baseInquiry(), knowledge, availability: baseAvailability(), preparedAt: PREPARED_AT });
  // Corrected criterion (governing PRD G17): unknown costs must prevent
  // profitability claims AND the unresolved question keeps the result not
  // feasible. The previous suite wrongly accepted feasible here.
  assert.equal(result.status, "alternatives");
  assert.equal(result.profitability.claim, "unknown");
  assert.deepEqual(result.profitability.unknownCostIds, ["food"]);
  assert.equal(result.primaryOffer?.profitabilityClaimed, false);
  assert.ok(result.ownerDecisions.some((decision) => decision.code === "unknown_profitability"));
  assert.ok(result.primaryOffer?.consequences.some((line) => line.includes("cannot be claimed")) === true);
});

test("unknown unit prices leave the total unknown and undecided", () => {
  const knowledge = baseKnowledge();
  knowledge.priceBook.lines[1] = {
    lineId: "catering",
    label: "Catering",
    pricingBasis: "per_guest",
    unitCents: null,
    confidence: "verified",
    sourceReferences: [fixtureSource],
  };
  const result = prepareOffer({ inquiry: baseInquiry(), knowledge, availability: baseAvailability(), preparedAt: PREPARED_AT });
  assert.equal(result.primaryOffer?.totalCents, null);
  assert.equal(result.primaryOffer?.totalKnown, false);
  assert.equal(result.profitability.claim, "unknown");
  assert.deepEqual(result.profitability.unknownPriceIds, ["catering"]);
  assert.notEqual(result.status, "feasible");
  assert.ok(result.ownerDecisions.some((decision) => decision.code === "unknown_profitability"));
});

function cateringDenyKnowledge(): BusinessKnowledge {
  const knowledge = baseKnowledge();
  knowledge.policies = [
    {
      policyId: "pol-catering",
      statement: "Outside catering needs prior approval",
      effect: "deny",
      appliesToServices: ["outside_catering"],
      confidence: "verified",
      sourceReferences: [fixtureSource],
    },
  ];
  knowledge.scopedExceptions = [
    {
      exceptionId: "exc-001",
      policyId: "pol-catering",
      scope: { inquiryId: "inq-001" },
      effect: "allow",
      approvedBy: "fictional-owner",
      sourceReferences: [fixtureSource],
    },
  ];
  return knowledge;
}

test("scoped exception stays scoped and never rewrites global policy", () => {
  const knowledge = cateringDenyKnowledge();
  const before = JSON.stringify(knowledge.policies);
  const inquiry = baseInquiry({ serviceRequirements: ["private_dining", "outside_catering"] });
  const matching = prepareOffer({ inquiry, knowledge, availability: baseAvailability(), preparedAt: PREPARED_AT });
  assert.equal(matching.status, "feasible");
  assert.ok(matching.primaryOffer?.consequences.some((line) => line.includes("exc-001") && line.includes("global policy is unchanged")) === true);
  assert.equal(JSON.stringify(knowledge.policies), before);

  // Same policy, different inquiry scope: the exception must not apply.
  const other = prepareOffer({
    inquiry: baseInquiry({ inquiryId: "inq-002", serviceRequirements: ["private_dining", "outside_catering"] }),
    knowledge,
    availability: baseAvailability(),
    preparedAt: PREPARED_AT,
  });
  assert.equal(other.status, "blocked");
  assert.ok(other.conflicts.some((conflict) => conflict.code === "policy_denied"));
  assert.equal(JSON.stringify(knowledge.policies), before);
});

test("probable or unattributed consequential evidence needs explicit decisions", () => {
  const weakCapacity = baseKnowledge();
  weakCapacity.spaces[0] = { ...weakCapacity.spaces[0] as BusinessKnowledge["spaces"][number], confidence: "probable" };
  const capacityResult = prepareOffer({ inquiry: baseInquiry(), knowledge: weakCapacity, availability: baseAvailability(), preparedAt: PREPARED_AT });
  assert.notEqual(capacityResult.status, "feasible");
  assert.ok(capacityResult.ownerDecisions.some((decision) => decision.code === "unverified_capacity"));

  const weakPrice = baseKnowledge();
  weakPrice.priceBook.lines[0] = { ...weakPrice.priceBook.lines[0] as BusinessKnowledge["priceBook"]["lines"][number], confidence: "uncertain" };
  const priceResult = prepareOffer({ inquiry: baseInquiry(), knowledge: weakPrice, availability: baseAvailability(), preparedAt: PREPARED_AT });
  assert.notEqual(priceResult.status, "feasible");
  assert.ok(priceResult.ownerDecisions.some((decision) => decision.code === "unverified_pricing"));

  const unattributed = baseKnowledge();
  unattributed.spaces[0] = { ...unattributed.spaces[0] as BusinessKnowledge["spaces"][number], sourceReferences: [] };
  const unattributedResult = prepareOffer({ inquiry: baseInquiry(), knowledge: unattributed, availability: baseAvailability(), preparedAt: PREPARED_AT });
  assert.notEqual(unattributedResult.status, "feasible");
  assert.ok(unattributedResult.ownerDecisions.some((decision) => decision.code === "unverified_capacity"));
});

test("guest count beyond every space is an explicit conflict", () => {
  const result = prepareOffer({
    inquiry: baseInquiry({ guestCount: 500 }),
    knowledge: baseKnowledge(),
    availability: baseAvailability(),
    preparedAt: PREPARED_AT,
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.offers.length, 0);
  assert.ok(result.conflicts.some((conflict) => conflict.code === "capacity_exceeded"));
});

test("missing inputs block preparation with owner questions", () => {
  const missingGuests = prepareOffer({
    inquiry: baseInquiry({ guestCount: 0 }),
    knowledge: baseKnowledge(),
    availability: baseAvailability(),
    preparedAt: PREPARED_AT,
  });
  assert.equal(missingGuests.status, "blocked");
  assert.ok(missingGuests.missingInformation.some((item) => item.code === "missing_guest_count"));
  assert.ok(missingGuests.missingInformation.every((item) => item.ownerQuestion.length > 0));

  const stale = prepareOffer({
    inquiry: baseInquiry(),
    knowledge: baseKnowledge(),
    availability: baseAvailability({ observedAt: "2026-05-01T00:00:00.000Z" }),
    preparedAt: PREPARED_AT,
  });
  assert.equal(stale.status, "blocked");
  assert.ok(stale.missingInformation.some((item) => item.code === "stale_availability"));
});

test("unknown required service needs evidence; unavailable service conflicts", () => {
  const unknownService = prepareOffer({
    inquiry: baseInquiry({ serviceRequirements: ["string_quartet"] }),
    knowledge: baseKnowledge(),
    availability: baseAvailability(),
    preparedAt: PREPARED_AT,
  });
  assert.equal(unknownService.status, "blocked");
  assert.ok(unknownService.missingInformation.some((item) => item.code === "missing_service_evidence"));

  const knowledge = baseKnowledge();
  knowledge.services[0] = {
    serviceId: "private_dining",
    label: "Private dining",
    available: false,
    sourceReferences: [fixtureSource],
  };
  const unavailable = prepareOffer({
    inquiry: baseInquiry(),
    knowledge,
    availability: baseAvailability(),
    preparedAt: PREPARED_AT,
  });
  assert.ok(unavailable.conflicts.some((conflict) => conflict.code === "service_unavailable"));
});

test("known-over-budget candidates are demoted, never offered as suitable", () => {
  const result = prepareOffer({
    inquiry: baseInquiry({ budgetCents: { max: 100_000 } }),
    knowledge: baseKnowledge(),
    availability: baseAvailability(),
    preparedAt: PREPARED_AT,
  });
  // Corrected criterion: the old suite accepted a primary here with a mere
  // conflict. A known-over-budget candidate is never suitable without an
  // explicit decision, so no primary may be offered.
  assert.equal(result.primaryOffer, undefined);
  assert.equal(result.status, "alternatives");
  assert.ok(result.conflicts.some((conflict) => conflict.code === "exceeds_budget"));
  assert.ok(result.ownerDecisions.some((decision) => decision.code === "over_budget_approval"));
  assert.ok(result.offers.every((offer) => offer.rank === "alternative"));
});

test("source references with unknown kinds or mistyped fields are rejected", () => {
  const badKind = baseInquiry();
  badKind.sourceReferences = [{ kind: "telepathy", locator: "x" } as unknown as SourceReference];
  assert.throws(
    () => prepareOffer({ inquiry: badKind, knowledge: baseKnowledge(), availability: baseAvailability(), preparedAt: PREPARED_AT }),
    /source reference/,
  );
  const badFlag = baseInquiry();
  badFlag.sourceReferences = [{ kind: "fixture", locator: "x", fictional: "yes" } as unknown as SourceReference];
  assert.throws(
    () => prepareOffer({ inquiry: badFlag, knowledge: baseKnowledge(), availability: baseAvailability(), preparedAt: PREPARED_AT }),
    /source reference/,
  );
});

test("malformed envelopes throw instead of inventing an offer", () => {
  assert.throws(() => prepareOffer("not-an-object"), /must be an object/);
  assert.throws(
    () => prepareOffer({ inquiry: { inquiryId: 42 }, knowledge: baseKnowledge(), availability: baseAvailability(), preparedAt: PREPARED_AT }),
    /inquiryId/,
  );
});

test("fact adapter maps attributable facts, attests completeness, and reports the rest", () => {
  const adapted = adaptBusinessFacts([
    {
      id: "fact-space-1",
      key: "space",
      value: { spaceId: "hall-a", name: "Fictional Cedar Hall", capacityMin: 20, capacityMax: 80 },
      confidence: "verified",
      sourceReferences: [fixtureSource],
    },
    {
      id: "fact-line-1",
      key: "price_line",
      value: { lineId: "venue", label: "Venue hire", pricingBasis: "per_event", unitCents: 80_000 },
      confidence: "verified",
      sourceReferences: [fixtureSource],
    },
    {
      id: "fact-line-2",
      key: "price_line",
      value: { lineId: "catering", label: "Catering", pricingBasis: "per_guest", unitCents: 1_500 },
      confidence: "verified",
      sourceReferences: [fixtureSource],
    },
    {
      id: "fact-cost-1",
      key: "cost",
      value: { costId: "food", label: "Food cost", amountCents: 30_000 },
      confidence: "probable",
      sourceReferences: [fixtureSource],
    },
    {
      id: "fact-bounds-1",
      key: "pricing_bounds",
      value: { currency: "USD", floorCents: 100_000, minMarginBps: 1_000, depositBps: 2_000, costsComplete: true },
      confidence: "verified",
      sourceReferences: [fixtureSource],
    },
    {
      id: "fact-service-1",
      key: "service",
      value: { serviceId: "private_dining", label: "Private dining", available: true },
      confidence: "verified",
      sourceReferences: [fixtureSource],
    },
    { id: "fact-mystery-1", key: "future_key", value: {}, confidence: "uncertain", sourceReferences: [fixtureSource] },
  ]);
  assert.equal(adapted.unparseable.length, 1);
  assert.equal(adapted.unparseable[0]?.factId, "fact-mystery-1");
  const availability = buildAvailabilityEvidence({
    calendarId: "cal-001",
    observedAt: OBSERVED_AT,
    asOf: OBSERVED_AT,
    slots: [
      {
        startAt: "2026-06-12T00:00:00.000Z",
        endAt: "2026-06-13T00:00:00.000Z",
        available: true,
        sourceReferences: [fixtureSource],
      },
    ],
    sourceReferences: [fixtureSource],
  });
  const result = prepareOffer({ inquiry: baseInquiry(), knowledge: adapted.knowledge, availability, preparedAt: PREPARED_AT });
  // The probable cost fact is honestly carried through, so the result is
  // not ready-to-send — but the total and margin still compute.
  assert.equal(result.status, "alternatives");
  assert.equal(result.primaryOffer?.totalCents, 140_000);
  assert.ok(result.ownerDecisions.some((decision) => decision.code === "unverified_pricing"));
});
