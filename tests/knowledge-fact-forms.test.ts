import assert from "node:assert/strict";
import test from "node:test";
import {
  assembleFieldValues,
  correctFieldsFor,
  correctQuestionFor,
  extractFieldValues,
  isSupportedCurrencyCode,
  moneyPreview,
  preservedUnknownKeys,
} from "../src/components/knowledge/factSchemas.ts";
import {
  bookingsForBusiness,
  scopeTargetLabel,
} from "../src/knowledge-owner/state.ts";
import { parseWorkspaceBookings } from "../src/knowledge-owner/types.ts";

// All fixtures are fictional; nothing here is a real connected source.

test("every consequential key has guided fields; unknown keys fail closed", () => {
  for (const key of ["price_line", "cost", "policy", "space", "service", "pricing_bounds"]) {
    const fields = correctFieldsFor(key);
    assert.ok(fields && fields.length > 0, `${key} has guided inputs`);
    assert.ok(!fields.some((f) => f.type === "textarea" && f.name === "value"), "no raw value editor");
  }
  assert.equal(correctFieldsFor("wiki_trivia"), null);
  assert.equal(correctFieldsFor("business"), null);
  assert.equal(
    correctQuestionFor("price_line", "plated-dinner").includes("Corrected value"),
    false,
    "focused question replaces the JSON prompt",
  );
});

test("price correction edits business fields and preserves unknown extras", () => {
  const original = { lineId: "plated", label: "Plated dinner", pricingBasis: "per_guest", unitCents: 9500, note: "keep me" };
  const inputs = { ...extractFieldValues("price_line", original), label: "Plated dinner (2026)", unitCents: "9900" };
  const out = assembleFieldValues("price_line", original, inputs);
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.value.label, "Plated dinner (2026)");
  assert.equal(out.value.unitCents, 9900);
  assert.equal(out.value.lineId, "plated");
  assert.equal(out.value.note, "keep me", "unrendered fields survive untouched");
  assert.deepEqual(preservedUnknownKeys("price_line", original), ["note"]);
});

test("empty money reads as unknown-null, never zero; negatives fail closed", () => {
  const original = { costId: "linen", label: "Linen", amountCents: 4000 };
  const cleared = assembleFieldValues("cost", original, { ...extractFieldValues("cost", original), amountCents: "" });
  assert.equal(cleared.ok, true);
  if (cleared.ok) assert.equal(cleared.value.amountCents, null);
  const negative = assembleFieldValues("cost", original, { ...extractFieldValues("cost", original), amountCents: "-5" });
  assert.equal(negative.ok, false);
  const text = assembleFieldValues("cost", original, { ...extractFieldValues("cost", original), amountCents: "abc" });
  assert.equal(text.ok, false);
});

test("currency is explicit and never guessed", () => {
  assert.equal(isSupportedCurrencyCode("GBP"), true);
  assert.equal(isSupportedCurrencyCode("USD"), true);
  assert.equal(isSupportedCurrencyCode("US"), false);
  assert.equal(isSupportedCurrencyCode("USDX"), false);
  assert.equal(isSupportedCurrencyCode(""), false);
  const original = { currency: "GBP", floorCents: null, minMarginBps: null, depositBps: null, costsComplete: false };
  const lower = assembleFieldValues("pricing_bounds", original, { ...extractFieldValues("pricing_bounds", original), currency: "gbp" });
  assert.equal(lower.ok, true, "lowercase entry is normalized, not rejected");
  if (lower.ok) assert.equal(lower.value.currency, "GBP");
  const bad = assembleFieldValues("pricing_bounds", original, { ...extractFieldValues("pricing_bounds", original), currency: "XX" });
  assert.equal(bad.ok, false);
  assert.match(!bad.ok ? bad.error : "", /never guessed/);
});

test("space capacities validate and policy lists parse from plain text", () => {
  const space = { spaceId: "hall", name: "Hall", capacityMin: 20, capacityMax: 40 };
  const badRange = assembleFieldValues("space", space, { ...extractFieldValues("space", space), capacityMax: "10" });
  assert.equal(badRange.ok, false);
  assert.match(!badRange.ok ? badRange.error : "", /Maximum capacity/);
  const policy = { policyId: "p", statement: "No music.", effect: "deny" };
  const withLists = assembleFieldValues("policy", policy, {
    ...extractFieldValues("policy", policy),
    appliesToEventTypes: "wedding,  corporate,",
    minGuests: "",
  });
  assert.equal(withLists.ok, true);
  if (withLists.ok) {
    assert.deepEqual(withLists.value.appliesToEventTypes, ["wedding", "corporate"]);
    assert.equal(withLists.value.minGuests, null, "cleared optional reads as null");
  }
  const badEffect = assembleFieldValues("policy", policy, { ...extractFieldValues("policy", policy), effect: "maybe" });
  assert.equal(badEffect.ok, false);
});

test("service availability is an explicit boolean and required text fails closed", () => {
  const service = { serviceId: "s", label: "Drinks", available: true };
  const off = assembleFieldValues("service", service, { ...extractFieldValues("service", service), available: false });
  assert.equal(off.ok, true);
  if (off.ok) assert.equal(off.value.available, false);
  const blank = assembleFieldValues("service", service, { ...extractFieldValues("service", service), label: "  " });
  assert.equal(blank.ok, false);
});

test("money previews use the bounds currency or an honest minor-unit label", () => {
  assert.ok(moneyPreview(9900, "GBP").includes("99"), "renders in currency units");
  assert.match(moneyPreview(9900, undefined), /minor units/);
  assert.match(moneyPreview(9900, "XX"), /minor units/, "unsupported codes fall back honestly");
});

test("workspace bookings parse nested and bare rows and reject malformed ones", () => {
  const nested = { bookings: [{ booking: { id: "b1", businessId: "biz", eventName: "Dinner", status: "inquiry" } }] };
  assert.equal(parseWorkspaceBookings(nested)?.length, 1);
  const bare = { bookings: [{ id: "b2", businessId: "biz", eventName: "Lunch", status: "confirmed" }] };
  assert.equal(parseWorkspaceBookings(bare)?.[0]?.eventName, "Lunch");
  assert.equal(parseWorkspaceBookings({ bookings: [{ id: "b3" }] }), undefined);
  assert.equal(parseWorkspaceBookings({ bookings: "nope" }), undefined);
});

test("scope labels prefer event names and never invent records", () => {
  const bookings = [
    { id: "b1", businessId: "biz", eventName: "Fictional dinner", status: "inquiry" },
    { id: "b2", businessId: "other", eventName: "Elsewhere", status: "inquiry" },
  ];
  assert.deepEqual(bookingsForBusiness(bookings, "biz").map((b) => b.id), ["b1"]);
  assert.equal(scopeTargetLabel("booking", "b1", bookings), "Fictional dinner (b1)");
  assert.equal(scopeTargetLabel("booking", "unknown-id", bookings), "unknown-id");
  assert.equal(scopeTargetLabel("customer", "c1", bookings), "customer c1");
});
