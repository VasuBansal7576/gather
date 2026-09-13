import assert from "node:assert/strict";
import test from "node:test";
import {
  adaptBusinessFacts,
  prepareOffer,
  type BusinessKnowledge,
  type InquiryRequirements,
} from "../src/offers/index.ts";
import type { SourceReference } from "../src/domain/contracts.ts";

// Clearly fictional fixture data. It is never presented as a verified integration.
const fixtureSource: SourceReference = {
  kind: "fixture",
  locator: "fixture://fictional/offers-corrections-001",
  label: "Fictional corrections fixture",
  fictional: true,
};

function fact(id: string, key: string, value: unknown, confidence: "verified" | "probable" | "uncertain", sources: unknown = [fixtureSource], businessId = "biz-001") {
  return { id, key, value, confidence, sourceReferences: sources, businessId };
}

test("absent currency in a verified bounds fact is unparseable, never USD", () => {
  const adapted = adaptBusinessFacts([
    fact("f-biz", "business", { businessId: "biz-001", timezone: "America/New_York" }, "verified"),
    fact("f-b", "pricing_bounds", { floorCents: 100_000, costsComplete: true }, "verified"),
  ]);
  assert.ok(adapted.unparseable.some((entry) => entry.factId === "f-b" && /currency/i.test(entry.reason)));
  assert.equal(adapted.knowledge.priceBook.floorCents, null);
  assert.equal(adapted.knowledge.priceBook.costsComplete, false);
});

test("malformed currency codes are rejected, never defaulted", () => {
  for (const currency of ["XX", "usd", "", "USDD", 42]) {
    const adapted = adaptBusinessFacts([
      fact("f-biz", "business", { businessId: "biz-001", timezone: "America/New_York" }, "verified"),
      fact("f-b", "pricing_bounds", { currency, floorCents: 100_000 }, "verified"),
    ]);
    assert.ok(adapted.unparseable.some((entry) => entry.factId === "f-b"), `currency ${String(currency)} must be unparseable`);
    assert.equal(adapted.knowledge.priceBook.floorCents, null);
  }
});

test("bounds without currency plus priced lines throw atomically instead of inventing USD", () => {
  assert.throws(
    () =>
      adaptBusinessFacts([
        fact("f-biz", "business", { businessId: "biz-001", timezone: "America/New_York" }, "verified"),
        fact("f-b", "pricing_bounds", { floorCents: 100_000 }, "verified"),
        fact("f-l", "price_line", { lineId: "l1", label: "L", pricingBasis: "per_event" }, "verified"),
      ]),
    /authoritative pricing_bounds/,
  );
});

test("malformed source elements cannot mint verified authority", () => {
  const adapted = adaptBusinessFacts([
    fact("f-biz", "business", { businessId: "biz-001", timezone: "America/New_York" }, "verified"),
    fact("f-b", "pricing_bounds", { currency: "USD", floorCents: 100_000 }, "verified",
      [{ kind: "telepathy", locator: "mind://x" }]),
    fact("f-s", "space", { spaceId: "s1", name: "S", capacityMin: 1, capacityMax: 10 }, "verified",
      [{ kind: "document" }]),
  ]);
  assert.ok(adapted.unparseable.some((entry) => entry.factId === "f-b"), "bad-kind sources must be unparseable");
  assert.ok(adapted.unparseable.some((entry) => entry.factId === "f-s"), "locator-less sources must be unparseable");
  assert.equal(adapted.knowledge.priceBook.floorCents, null);
  assert.equal(adapted.knowledge.spaces.length, 0);
});

function inquiry(): InquiryRequirements {
  return {
    inquiryId: "inq-001",
    businessId: "biz-001",
    eventType: "dinner",
    startAt: "2030-06-12T17:00:00.000Z",
    endAt: "2030-06-12T21:00:00.000Z",
    guestCount: 40,
    serviceRequirements: ["dinner"],
    sourceReferences: [fixtureSource],
    validatedAt: "2030-01-01T00:00:00.000Z",
    validator: "fixture-check",
  };
}

function knowledge(spaces: BusinessKnowledge["spaces"]): BusinessKnowledge {
  return {
    businessId: "biz-001",
    timezone: "America/New_York",
    spaces,
    policies: [],
    scopedExceptions: [],
    priceBook: {
      currency: "USD",
      lines: [{ lineId: "l1", label: "Dinner", pricingBasis: "per_guest", unitCents: 10_000, confidence: "verified", sourceReferences: [fixtureSource] }],
      costs: [],
      costsComplete: false,
      floorCents: 100_000,
      minMarginBps: null,
      depositBps: null,
      sourceReferences: [fixtureSource],
    },
    services: [{ serviceId: "dinner", label: "Dinner", available: true, sourceReferences: [fixtureSource] }],
    sourceReferences: [fixtureSource],
  };
}

function availability() {
  return {
    calendarId: "cal-001",
    observedAt: "2030-01-01T00:00:00.000Z",
    asOf: "2030-01-01T00:00:00.000Z",
    maxFreshnessMs: 31_536_000_000,
    slots: [
      {
        startAt: "2030-06-12T00:00:00.000Z",
        endAt: "2030-06-13T00:00:00.000Z",
        available: true,
        venueWide: true as const,
        sourceReferences: [fixtureSource],
      },
      {
        startAt: "2030-06-12T18:00:00.000Z",
        endAt: "2030-06-12T20:00:00.000Z",
        available: false,
        reason: "Room A busy",
        spaceIds: ["room-a"],
        sourceReferences: [fixtureSource],
      },
    ],
    sourceReferences: [fixtureSource],
  };
}

function room(id: string, confidence: "verified" | "probable" = "verified") {
  return { spaceId: id, name: id === "room-a" ? "Room A" : "Room B", capacityMin: 10, capacityMax: 100, confidence, sourceReferences: [fixtureSource] };
}

test("blocked Room A with free Room B of identical capacity selects viable Room B", () => {
  const result = prepareOffer({
    inquiry: inquiry(),
    knowledge: knowledge([room("room-a"), room("room-b")]),
    availability: availability(),
    preparedAt: "2030-01-01T00:00:00.000Z",
  });
  assert.equal(result.status, "feasible");
  assert.equal(result.primaryOffer?.spaceId, "room-b");
  assert.equal(result.primaryOffer?.profitabilityClaimed, false);
});

test("a decision-blocked first fit does not hide a clean room", () => {
  const slots = [
    {
      startAt: "2030-06-12T00:00:00.000Z",
      endAt: "2030-06-13T00:00:00.000Z",
      available: true,
      venueWide: true as const,
      sourceReferences: [fixtureSource],
    },
  ];
  const result = prepareOffer({
    inquiry: inquiry(),
    knowledge: knowledge([room("room-a", "probable"), room("room-b")]),
    availability: { ...availability(), slots },
    preparedAt: "2030-01-01T00:00:00.000Z",
  });
  assert.equal(result.status, "feasible");
  assert.equal(result.primaryOffer?.spaceId, "room-b");
  assert.ok(result.ownerDecisions.length === 0, "no other room's pending decision may gate the clean offer");
  assert.ok(result.offers.every((offer) => offer.spaceId === "room-b"));
});

test("all rooms needing decisions keep the first as primary with its decision", () => {
  const slots = [
    {
      startAt: "2030-06-12T00:00:00.000Z",
      endAt: "2030-06-13T00:00:00.000Z",
      available: true,
      venueWide: true as const,
      sourceReferences: [fixtureSource],
    },
  ];
  const result = prepareOffer({
    inquiry: inquiry(),
    knowledge: knowledge([room("room-a", "probable"), room("room-b", "probable")]),
    availability: { ...availability(), slots },
    preparedAt: "2030-01-01T00:00:00.000Z",
  });
  assert.notEqual(result.status, "feasible");
  assert.equal(result.primaryOffer?.spaceId, "room-a");
  assert.ok(result.ownerDecisions.some((decision) => decision.code === "unverified_capacity"));
});
