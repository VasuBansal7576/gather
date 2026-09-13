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
        { lineId: "venue", label: "Venue hire", pricingBasis: "per_event", unitCents: 80_000, sourceReferences: [fixtureSource] },
        { lineId: "catering", label: "Catering", pricingBasis: "per_guest", unitCents: 1_500, sourceReferences: [fixtureSource] },
      ],
      costs: [{ costId: "food", label: "Food cost", amountCents: 30_000, sourceReferences: [fixtureSource] }],
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

test("feasible primary offer is deterministic and source-backed", () => {
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
  assert.match(first.primaryOffer?.fingerprint ?? "", /^[0-9a-f]{64}$/);
  assert.ok(first.primaryOffer?.consequences.length !== undefined && (first.primaryOffer?.consequences.length ?? 0) > 0);
  assert.equal(first.evidence.allFictional, true);
  assert.ok(first.evidence.provenanceNote.includes("fictional"));
});

test("unavailable requested date yields a feasible alternative", () => {
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
  assert.equal(result.offers[0]?.startAt, "2026-06-13T00:00:00.000Z");
  assert.ok(result.conflicts.some((conflict) => conflict.code === "requested_date_unavailable"));
  assert.ok((result.offers[0]?.note ?? "").includes("Alternative date"));
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

test("unknown costs prevent any profitability claim without blocking the offer", () => {
  const knowledge = baseKnowledge();
  knowledge.priceBook.costs = [{ costId: "food", label: "Food cost", amountCents: null, sourceReferences: [fixtureSource] }];
  const result = prepareOffer({ inquiry: baseInquiry(), knowledge, availability: baseAvailability(), preparedAt: PREPARED_AT });
  assert.equal(result.status, "feasible");
  assert.equal(result.profitability.claim, "unknown");
  assert.deepEqual(result.profitability.unknownCostIds, ["food"]);
  assert.equal(result.primaryOffer?.profitabilityClaimed, false);
  assert.ok(result.primaryOffer?.consequences.some((line) => line.includes("cannot be claimed")) === true);
});

test("unknown unit prices leave the total unknown and unclaimed", () => {
  const knowledge = baseKnowledge();
  knowledge.priceBook.lines[1] = {
    lineId: "catering",
    label: "Catering",
    pricingBasis: "per_guest",
    unitCents: null,
    sourceReferences: [fixtureSource],
  };
  const result = prepareOffer({ inquiry: baseInquiry(), knowledge, availability: baseAvailability(), preparedAt: PREPARED_AT });
  assert.equal(result.primaryOffer?.totalCents, null);
  assert.equal(result.primaryOffer?.totalKnown, false);
  assert.equal(result.profitability.claim, "unknown");
  assert.deepEqual(result.profitability.unknownPriceIds, ["catering"]);
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

test("over-budget totals are explicit conflicts, never silent overruns", () => {
  const result = prepareOffer({
    inquiry: baseInquiry({ budgetCents: { max: 100_000 } }),
    knowledge: baseKnowledge(),
    availability: baseAvailability(),
    preparedAt: PREPARED_AT,
  });
  assert.equal(result.status, "alternatives");
  assert.ok(result.conflicts.some((conflict) => conflict.code === "exceeds_budget"));
});

test("malformed envelopes throw instead of inventing an offer", () => {
  assert.throws(() => prepareOffer("not-an-object"), /must be an object/);
  assert.throws(
    () => prepareOffer({ inquiry: { inquiryId: 42 }, knowledge: baseKnowledge(), availability: baseAvailability(), preparedAt: PREPARED_AT }),
    /inquiryId/,
  );
});

test("fact adapter maps attributable facts and reports the rest", () => {
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
      value: { currency: "USD", floorCents: 100_000, minMarginBps: 1_000, depositBps: 2_000 },
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
  assert.equal(result.status, "feasible");
  assert.equal(result.primaryOffer?.totalCents, 140_000);
});
