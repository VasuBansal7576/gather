import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { GatherStore } from "../src/server/sqlite-store.ts";
import {
  KnowledgeService,
  type KnowledgeDecision,
} from "../src/knowledge/index.ts";

// All fixtures are fictional; nothing here is a real connected source.
// These tests pin the five review defects D1..D5 plus the offers-adapter
// input contract (mirrored from the integrated offers lane trust model:
// verified + attributed + known key + single business).

const DOC = {
  kind: "document" as const,
  locator: "fixture://fictional/drive/pricing-sheet",
  label: "Fictional pricing sheet",
  fictional: true,
};
const OWNER = { kind: "owner" as const, id: "fictional-owner-1" };
const KNOWN_KEYS = new Set([
  "business", "space", "policy", "scoped_exception",
  "price_line", "cost", "service", "pricing_bounds",
]);

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "gather-knowledge-offers-"));
  const store = new GatherStore(join(directory, "gather.sqlite"));
  const business = store.createBusiness({ name: "Fictional Cedar Hall", timezone: "America/New_York" });
  const service = new KnowledgeService(store);
  return {
    store,
    service,
    businessId: business.id,
    cleanup: () => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function decisionsOf(service: KnowledgeService, businessId: string): KnowledgeDecision[] {
  return service.listDecisions(businessId);
}

// ---------- D1: review-flagged facts are withheld from consequential use ----------

test("D1 source-changed pricing is withheld from snapshot facts until reconfirmed", () => {
  const { service, businessId, cleanup } = fixture();
  try {
    const candidate = service.intakeCandidate({
      businessId, key: "pricing_bounds", subjectId: "",
      value: { currency: "USD", floorCents: 200000, costsComplete: false },
      confidence: "probable", sourceReferences: [DOC], sourceRevision: "v1",
    });
    service.confirmCandidate({ businessId, candidateId: candidate.id, actor: OWNER });
    service.intakeCandidate({
      businessId, key: "pricing_bounds", subjectId: "",
      value: { currency: "USD", floorCents: 300000, costsComplete: false },
      confidence: "probable", sourceReferences: [DOC], sourceRevision: "v2",
    });

    const snapshot = service.snapshotForOffers(businessId);
    assert.equal(snapshot.facts.some((fact) => fact.key === "pricing_bounds"), false,
      "stale pricing must not reach consequential offers");
    assert.equal(snapshot.reviewFactIds.length, 1);
    assert.equal(snapshot.withheld.length, 1);
    assert.equal(snapshot.withheld[0]!.key, "pricing_bounds");
    assert.ok(snapshot.withheld[0]!.reason.length > 0, "explicit reason, never a silent flag");

    // Reconfirm via correction: the fact returns to the snapshot, review cleared.
    const facts = service.listFacts(businessId);
    service.correctFact({
      businessId, key: "pricing_bounds", expectedRevision: facts[0]!.revision,
      value: { currency: "USD", floorCents: 300000, costsComplete: false },
      actor: OWNER,
    });
    const healed = service.snapshotForOffers(businessId);
    assert.equal(healed.facts.some((fact) => fact.key === "pricing_bounds"), true);
    assert.deepEqual(healed.reviewFactIds, []);
    assert.deepEqual(healed.withheld, []);
  } finally {
    cleanup();
  }
});

// ---------- D2: commandId binds the full canonical request ----------

test("D2 replaying a commandId with an altered payload is command_conflict", () => {
  const { service, businessId, cleanup } = fixture();
  try {
    const a = service.intakeCandidate({
      businessId, key: "space", subjectId: "a",
      value: { capacity: 10 }, confidence: "probable", sourceReferences: [DOC],
    });
    const b = service.intakeCandidate({
      businessId, key: "space", subjectId: "b",
      value: { capacity: 20 }, confidence: "probable", sourceReferences: [DOC],
    });
    const first = service.confirmCandidate({ businessId, candidateId: a.id, actor: OWNER, commandId: "cmd-X" });
    assert.throws(
      () => service.confirmCandidate({ businessId, candidateId: b.id, actor: OWNER, commandId: "cmd-X" }),
      /different payload/,
      "altered payload replay must not return an unrelated duplicate",
    );
    assert.equal(service.listCandidates(businessId).find((c) => c.id === b.id)!.status, "pending");

    // Identical replay still returns the recorded outcome.
    const replay = service.confirmCandidate({ businessId, candidateId: a.id, actor: OWNER, commandId: "cmd-X" });
    assert.equal(replay.duplicate, true);
    assert.equal(replay.fact.id, first.fact.id);

    // Same for corrections: same id, different value is a conflict.
    const facts = service.listFacts(businessId);
    const spaceA = facts.find((f) => f.subjectId === "a")!;
    service.correctFact({
      businessId, key: "space", subjectId: "a", expectedRevision: spaceA.revision,
      value: { capacity: 11 }, actor: OWNER, commandId: "cmd-C",
    });
    assert.throws(
      () => service.correctFact({
        businessId, key: "space", subjectId: "a", expectedRevision: spaceA.revision + 1,
        value: { capacity: 12 }, actor: OWNER, commandId: "cmd-C",
      }),
      /different payload/,
    );
  } finally {
    cleanup();
  }
});

// ---------- D3: canonical dedupe, no spurious change flags ----------

test("D3 key order never duplicates candidates or flags spurious review", () => {
  const { service, businessId, cleanup } = fixture();
  try {
    const first = service.intakeCandidate({
      businessId, key: "space", subjectId: "hall",
      value: { capacity: 120, name: "Hall" }, confidence: "probable",
      sourceReferences: [DOC], sourceRevision: "v1",
    });
    service.confirmCandidate({ businessId, candidateId: first.id, actor: OWNER });
    // Semantically identical value, different key order, bumped revision:
    // a re-observation, not a change.
    const second = service.intakeCandidate({
      businessId, key: "space", subjectId: "hall",
      value: { name: "Hall", capacity: 120 }, confidence: "probable",
      sourceReferences: [DOC], sourceRevision: "v2",
    });
    assert.equal(second.id, first.id, "canonical dedupe returns the same candidate");
    assert.equal(service.listFacts(businessId)[0]!.reviewState, "none");
    assert.equal(service.listCandidates(businessId).filter((c) => c.status === "pending").length, 0);
  } finally {
    cleanup();
  }
});

// ---------- D4: bounded key registry ----------

test("D4 only booking-business vocabulary enters knowledge; wiki keys rejected", () => {
  const { service, businessId, cleanup } = fixture();
  try {
    for (const key of ["wiki_note", "freebusy_cache", "slots", "windows", "schedule_blob"]) {
      assert.throws(
        () => service.intakeCandidate({
          businessId, key, value: { x: 1 }, confidence: "probable", sourceReferences: [DOC],
        }),
        /outside the booking-business fact vocabulary|reserved/,
        `key ${key} must not enter static knowledge`,
      );
    }
    for (const key of [...KNOWN_KEYS].filter((k) => k !== "business" && k !== "scoped_exception")) {
      const candidate = service.intakeCandidate({
        businessId, key, subjectId: "s", value: { v: 1 },
        confidence: "probable", sourceReferences: [DOC],
      });
      assert.equal(candidate.status, "pending");
    }
    assert.throws(
      () => service.correctFact({ businessId, key: "wiki_note", expectedRevision: 1, value: { v: 1 }, actor: OWNER }),
      /outside the booking-business fact vocabulary/,
    );
  } finally {
    cleanup();
  }
});

// ---------- D5: uniform sanitized rejection audit ----------

test("D5 every rejected decision is audited without raw sensitive content", () => {
  const { service, businessId, cleanup } = fixture();
  try {
    const secret = "SECRET-XYZ-999";
    const candidate = service.intakeCandidate({
      businessId, key: "policy", subjectId: "x",
      value: { note: secret }, confidence: "probable", sourceReferences: [DOC],
    });
    // Stale confirm (non-pending after rejection) is audited.
    service.rejectCandidate({ businessId, candidateId: candidate.id, actor: OWNER });
    assert.throws(() => service.confirmCandidate({ businessId, candidateId: candidate.id, actor: OWNER }), /not pending/);
    // Missing fact correction is audited.
    assert.throws(
      () => service.correctFact({ businessId, key: "policy", subjectId: "ghost", expectedRevision: 1, value: { note: secret }, actor: OWNER }),
      /no active confirmed fact/,
    );
    // Invalid exception is audited.
    assert.throws(
      () => service.addScopedException({ businessId, scope: "booking", scopeId: "", policyId: "p1", effect: "allow", value: { note: secret }, actor: OWNER }),
      /scopeId/,
    );
    // Empty owner id is denied and audited.
    assert.throws(
      () => service.rejectCandidate({ businessId, candidateId: candidate.id, actor: { kind: "owner", id: "  " } }),
      /non-empty id/,
    );
    const rejected = decisionsOf(service, businessId).filter((d) => d.outcome === "rejected");
    const kinds = new Set(rejected.map((d) => `${d.kind}`));
    assert.ok(kinds.has("confirm") && kinds.has("correct") && kinds.has("exception"),
      `rejections cover confirm/correct/exception, got ${[...kinds]}`);
    const auditJson = JSON.stringify(decisionsOf(service, businessId));
    assert.equal(auditJson.includes(secret), false, "raw sensitive values must not land in the decision log");
    assert.equal(auditJson.includes("SECRET"), false);
  } finally {
    cleanup();
  }
});

// ---------- offers-adapter input contract (mirrors the integrated lane) ----------

test("snapshot facts satisfy the offers adapter acceptance contract", () => {
  const { service, businessId, cleanup } = fixture();
  try {
    const bounds = service.intakeCandidate({
      businessId, key: "pricing_bounds",
      value: { currency: "EUR", floorCents: 150000, costsComplete: true },
      confidence: "probable", sourceReferences: [DOC],
    });
    const price = service.intakeCandidate({
      businessId, key: "price_line", subjectId: "plated",
      value: { unitCents: 9500 }, confidence: "probable", sourceReferences: [DOC],
    });
    service.confirmCandidate({ businessId, candidateId: bounds.id, actor: OWNER });
    service.confirmCandidate({ businessId, candidateId: price.id, actor: OWNER });
    service.addScopedException({
      businessId, scope: "booking", scopeId: "booking-7",
      policyId: "late-checkout", effect: "allow",
      value: { note: "owner approved late checkout" }, actor: OWNER,
    });

    const snapshot = service.snapshotForOffers(businessId);
    // Mirrors adaptBusinessFacts acceptance: objects with string id/key,
    // verified confidence, non-empty attributed sources, one business.
    for (const fact of snapshot.facts) {
      assert.ok(fact.id.length > 0 && fact.key.length > 0 && typeof fact.value === "object");
      assert.equal(fact.confidence, "verified");
      assert.ok(Array.isArray(fact.sourceReferences) && fact.sourceReferences.length > 0);
      for (const ref of fact.sourceReferences) {
        assert.ok(typeof ref.locator === "string" && ref.locator.length > 0);
      }
      assert.equal(fact.businessId, businessId);
      assert.ok(KNOWN_KEYS.has(fact.key), `snapshot key ${fact.key} is adapter-mapped`);
    }
    assert.ok(snapshot.facts.some((f) => f.key === "business"));
    assert.equal(snapshot.scopedFactCount, 1);
  } finally {
    cleanup();
  }
});

test("snapshot exceptions carry the adapter-consumable canonical shape", () => {
  const { service, businessId, cleanup } = fixture();
  try {
    const created = service.addScopedException({
      businessId, scope: "booking", scopeId: "booking-7",
      policyId: "late-checkout", effect: "allow",
      value: { note: "owner approved late checkout" }, actor: OWNER,
    });
    // Canonical value: server-minted id, explicit policy/effect, owner-derived
    // authority, adapter-shaped scope — matching the accepted offers adapter.
    const value = created.fact.value as Record<string, unknown>;
    assert.ok(typeof value.exceptionId === "string" && (value.exceptionId as string).length > 0);
    assert.equal(value.policyId, "late-checkout");
    assert.equal(value.effect, "allow");
    assert.equal(value.approvedBy, OWNER.id);
    assert.deepEqual(value.scope, { bookingId: "booking-7" });
    const snapshot = service.snapshotForOffers(businessId);
    const facts = snapshot.facts.filter((f) => f.key === "scoped_exception");
    assert.equal(facts.length, 1);
    assert.deepEqual((facts[0]?.value as Record<string, unknown>).scope, { bookingId: "booking-7" });
    // Unauthorized minting is denied and audited, never applied.
    assert.throws(
      () => service.addScopedException({
        businessId, scope: "booking", scopeId: "booking-8",
        policyId: "late-checkout", effect: "allow",
        value: {}, actor: { kind: "content", id: "doc-1" },
      }),
      /no approval authority/,
    );
    // A second live exception for the same scope+subject versions forward:
    // history is preserved, exactly one stays active.
    const revised = service.addScopedException({
      businessId, scope: "booking", scopeId: "booking-7",
      policyId: "late-checkout", effect: "allow",
      value: {}, actor: OWNER,
    });
    assert.equal(revised.revision.revision, 2);
    const live = service.snapshotForOffers(businessId).facts.filter((f) => f.key === "scoped_exception");
    assert.equal(live.length, 1);
    const denied = decisionsOf(service, businessId).filter((d) => d.outcome === "rejected");
    assert.ok(denied.some((d) => d.kind === "exception"));
  } finally {
    cleanup();
  }
});
