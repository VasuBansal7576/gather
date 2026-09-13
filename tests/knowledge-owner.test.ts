import assert from "node:assert/strict";
import test from "node:test";
import {
  conflictingCandidates,
  countNeedsReview,
  describeConfirmEffect,
  describeCorrectEffect,
  describeExceptionEffect,
  describeRejectEffect,
  formatMoneyPart,
  formatValue,
  groupOf,
  isFixtureOnly,
  LoadGeneration,
  parseValueJson,
  sortCandidatesForReview,
} from "../src/knowledge-owner/state.ts";
import {
  parseCandidate,
  parseCandidatesResponse,
  parseConfirmedFact,
  parseFactsResponse,
  parseSetupBusinesses,
  parseSnapshotResponse,
  type KnowledgeCandidate,
} from "../src/knowledge-owner/types.ts";

// All fixtures are fictional; nothing here is a real connected source.

const DOC = {
  kind: "document",
  locator: "fixture://fictional/drive/pricing-sheet",
  label: "Fictional pricing sheet",
  fictional: true,
};

function candidate(overrides: Partial<KnowledgeCandidate> & { id: string }): KnowledgeCandidate {
  return {
    businessId: "biz-fictional-1",
    key: "price_line",
    subjectId: "plated-dinner",
    value: { unitCents: 9500 },
    confidence: "probable",
    sourceReferences: [DOC],
    observedAt: "2026-09-01T10:00:00.000Z",
    ingestedAt: "2026-09-01T10:00:00.000Z",
    status: "pending",
    conflictsWith: [],
    ...overrides,
  };
}

// ---------- review queue shaping ----------

test("review queue leads with conflicts, then consequential keys, then stale and decided", () => {
  const price = candidate({ id: "price", key: "price_line", ingestedAt: "2026-09-03T10:00:00.000Z" });
  const service = candidate({ id: "service", key: "service", subjectId: "toast", ingestedAt: "2026-09-01T10:00:00.000Z" });
  const conflictA = candidate({ id: "conf-a", key: "space", subjectId: "hall", value: { capacity: 40 }, conflictsWith: ["conf-b"], ingestedAt: "2026-09-02T10:00:00.000Z" });
  const conflictB = candidate({ id: "conf-b", key: "space", subjectId: "hall", value: { capacity: 60 }, conflictsWith: ["conf-a"], ingestedAt: "2026-09-02T11:00:00.000Z" });
  const staleOne = candidate({ id: "stale-1", status: "stale" });
  const decided = candidate({ id: "done-1", status: "confirmed" });
  const ordered = sortCandidatesForReview([price, service, conflictB, staleOne, decided, conflictA]);
  assert.deepEqual(
    ordered.map((entry) => entry.id),
    ["conf-a", "conf-b", "price", "service", "stale-1", "done-1"],
    "conflicts first, then consequential keys, stale before decided",
  );
  assert.equal(countNeedsReview(ordered), 4);
  assert.equal(groupOf(staleOne), "stale");
  assert.equal(groupOf(decided), "decided");
});

test("review is never forced: unreviewed candidates stay pending and sortable", () => {
  const list = [candidate({ id: "a" }), candidate({ id: "b", status: "rejected" })];
  const ordered = sortCandidatesForReview(list);
  assert.equal(ordered.length, 2, "nothing is dropped from the queue");
  assert.equal(ordered.filter((entry) => entry.status === "pending").length, 1);
});

test("conflicting candidates resolve to the differing observations", () => {
  const a = candidate({ id: "a", conflictsWith: ["b"] });
  const b = candidate({ id: "b", value: { unitCents: 12500 } });
  const c = candidate({ id: "c" });
  assert.deepEqual(conflictingCandidates([a, b, c], a).map((entry) => entry.id), ["b"]);
});

// ---------- decision effects ----------

test("decision effects state exact consequences, including scoping", () => {
  const item = candidate({ id: "a" });
  assert.match(describeConfirmEffect(item).headline, /business-wide/);
  assert.match(describeRejectEffect(item).detail, /untouched/);
  const correct = describeCorrectEffect("price_line", "plated-dinner", 2);
  assert.match(correct.headline, /revision 2/);
  assert.match(correct.detail, /superseded/);
  const exception = describeExceptionEffect("booking", "EVT-024");
  assert.match(exception.headline, /only/);
  assert.match(exception.detail, /global policy stays/);
});

test("value formatting stays bounded and source flags stay explicit", () => {
  assert.equal(formatValue({ unitCents: 9500 }), "9500 minor units (currency not stated)");
  assert.equal(formatValue({ unitCents: 9500, currency: "USD" }), "$95.00");
  const long = formatValue({ statement: "x".repeat(300) }, 60);
  assert.ok(long.length <= 60, "long values are truncated");
  assert.equal(isFixtureOnly([DOC]), true);
  assert.equal(isFixtureOnly([{ kind: "manual", locator: "gather://knowledge-exception/booking/EVT-1" }]), false);
});

test("money renders only with explicit source currency, never guessed", () => {
  assert.equal(formatMoneyPart(120000, "USD"), "$1,200.00");
  assert.equal(formatMoneyPart(135000, "GBP"), "£1,350.00");
  assert.equal(formatValue({ amountCents: 120000, currency: "USD" }), "$1,200.00");
  assert.equal(
    formatValue({ amountCents: 120000 }),
    "120000 minor units (currency not stated)",
    "missing currency is an honest minor-unit label, not a guessed dollar",
  );
  const noSymbol = formatValue({ amountCents: 5000 });
  assert.ok(!noSymbol.includes("$") && !noSymbol.includes("£") && !noSymbol.includes("₹"), "no currency symbol without source currency");
  assert.equal(
    formatValue({ amountCents: 5000, currency: "NOT-A-CURRENCY" }),
    "5000 minor units (currency not stated)",
    "invalid currency falls back to the honest label",
  );
  assert.equal(
    formatValue({ amountCents: 9500, currency: "USD", note: "per guest" }),
    "$95.00 · note: per guest",
    "extra fields still render beside the money",
  );
  assert.ok(!/profit/i.test(formatValue({ amountCents: 9500, currency: "USD" })), "never claims profit");
});

test("load generations drop stale responses so switches never show old business data", () => {
  const data = new LoadGeneration();
  const venues = new LoadGeneration();
  const slowA = data.next();
  const fastB = data.next();
  assert.equal(data.isCurrent(slowA), false, "delayed A response after B must be dropped");
  assert.equal(data.isCurrent(fastB), true);
  // Independent loaders never invalidate each other.
  const venueRun = venues.next();
  assert.equal(venues.isCurrent(venueRun), true);
  assert.equal(data.isCurrent(fastB), true);
});

test("owner-typed JSON values reject non-objects with guidance", () => {
  assert.deepEqual(parseValueJson('{"a": 1}'), { ok: true, value: { a: 1 } });
  const bad = parseValueJson("{oops");
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.error, /JSON/);
  const list = parseValueJson("[1, 2]");
  assert.equal(list.ok, false);
  if (!list.ok) assert.match(list.error, /object/);
});

// ---------- boundary parsing ----------

test("candidate parsing never invents calibrated confidence or unattributed facts", () => {
  const base = {
    id: "kc_1",
    businessId: "biz-1",
    key: "space",
    subjectId: "hall",
    value: { capacity: 40 },
    sourceReferences: [DOC],
    observedAt: "2026-09-01T10:00:00.000Z",
    ingestedAt: "2026-09-01T10:00:00.000Z",
    conflictsWith: [],
  };
  assert.equal(parseCandidate({ ...base, confidence: "probable", status: "pending" })?.confidence, "probable");
  assert.equal(
    parseCandidate({ ...base, confidence: "verified", status: "pending" }),
    undefined,
    "verified confidence can never arrive from extraction",
  );
  assert.equal(
    parseCandidate({ ...base, confidence: "probable", status: "pending", sourceReferences: [] }),
    undefined,
    "unattributed candidates are rejected",
  );
  assert.equal(parseCandidate({ ...base, confidence: "probable", status: "pending", value: "hall" }), undefined);
});

test("response parsers accept server shapes and reject malformed payloads", () => {
  const mode = { kind: "demo", label: "DEMO ONLY", fictional: true, simulated: true };
  const item = {
    id: "kc_1", businessId: "biz-1", key: "space", subjectId: "hall",
    value: { capacity: 40 }, confidence: "probable", sourceReferences: [DOC],
    observedAt: "2026-09-01T10:00:00.000Z", ingestedAt: "2026-09-01T10:00:00.000Z",
    status: "pending", conflictsWith: [],
  };
  assert.equal(parseCandidatesResponse({ mode, candidates: [item] })?.candidates.length, 1);
  assert.equal(parseCandidatesResponse({ mode, candidates: [{ ...item, confidence: "verified" }] }), undefined);
  assert.equal(parseCandidatesResponse({ mode: { ...mode, kind: "live" }, candidates: [] }), undefined);

  const fact = {
    id: "f1", businessId: "biz-1", key: "price_line", value: { unitCents: 9500 },
    confidence: "verified", sourceReferences: [DOC], observedAt: "2026-09-01T10:00:00.000Z",
    revision: 2, subjectId: "plated-dinner", scope: "global", reviewState: "none",
  };
  assert.equal(parseConfirmedFact(fact)?.revision, 2);
  assert.equal(parseConfirmedFact({ ...fact, revision: 0 }), undefined);
  assert.equal(parseFactsResponse({ mode, facts: [fact] })?.facts.length, 1);

  const snapshot = {
    mode,
    snapshot: {
      businessId: "biz-1", timezone: "Europe/London", generatedAt: "2026-09-01T10:00:00.000Z",
      facts: [{ ...fact, revision: undefined, subjectId: undefined, scope: undefined, reviewState: undefined }],
      reviewFactIds: [],
      withheld: [{ factId: "f9", key: "price_line", subjectId: "buffet", reason: "source changed" }],
      scopedFactCount: 0,
    },
  };
  const parsed = parseSnapshotResponse(snapshot);
  assert.equal(parsed?.snapshot.withheld.length, 1);
  assert.equal(parsed?.snapshot.withheld[0]?.reason, "source changed");

  assert.equal(parseSetupBusinesses({ businesses: [{ id: "b1", name: "Fictional Hall", timezone: "Europe/London" }] })?.length, 1);
  assert.equal(parseSetupBusinesses({ businesses: [{ id: "b1", name: "", timezone: "Europe/London" }] }), undefined);
});
