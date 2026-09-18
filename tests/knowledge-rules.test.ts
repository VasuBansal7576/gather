import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { GatherStore } from "../src/server/sqlite-store.ts";
import { KnowledgeService } from "../src/knowledge/service.ts";
import { PreparedKnowledgePort } from "../src/knowledge/prepared.ts";
import type { KnowledgePort } from "../src/knowledge/port.ts";
import {
  batchConfirmCandidates,
  correctAndPublish,
  describeAvailability,
  inspectSourceClaims,
  listCorrectionEvents,
} from "../src/knowledge/review.ts";
import { confirmParsedRule, parseOwnerRuleText } from "../src/knowledge/rules.ts";
import { validateConcessionForm } from "../src/knowledge/concessions.ts";

// All fixtures are fictional; nothing here is a real connected source.

const DOC = {
  kind: "document" as const,
  locator: "fixture://fictional/adr005/pricing-sheet",
  label: "Fictional pricing sheet",
  fictional: true,
};
const OWNER = { kind: "owner" as const, id: "fictional-owner-1" };
const CONTENT = { kind: "content" as const, id: "fixture-doc-1" };

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "gather-adr005-rules-"));
  const store = new GatherStore(join(directory, "gather.sqlite"));
  const business = store.createBusiness({ name: "Fictional Birch Hall", timezone: "America/New_York" });
  const service = new KnowledgeService(store);
  const port = new PreparedKnowledgePort(service, business.id);
  return {
    store,
    service,
    port,
    businessId: business.id,
    cleanup: () => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function confirmPriceLine(
  service: KnowledgeService,
  businessId: string,
  subjectId = "plated",
  value: Record<string, unknown> = { unitCents: 9500 },
) {
  const candidate = service.intakeCandidate({
    businessId, key: "price_line", subjectId, value, confidence: "probable",
    sourceReferences: [DOC], sourceRevision: "v1",
  });
  return service.confirmCandidate({ businessId, candidateId: candidate.id, actor: OWNER });
}

// ---------- 005-A01: correction blast radius ----------

test("005-A01 changed price flags pending proposals only; approved snapshots stay immutable", () => {
  const { store, service, businessId, cleanup } = fixture();
  try {
    confirmPriceLine(service, businessId);
    const pending = store.createBooking({ businessId, eventName: "Pending dinner", sourceReferences: [DOC] });
    const accepted = store.createBooking({ businessId, eventName: "Accepted dinner", sourceReferences: [DOC] });
    const pendingAction = store.createProposedAction({
      bookingId: pending.id, kind: "create_provisional_hold",
      payload: { totalMinor: 200000 }, sourceReferences: [DOC],
    });
    const acceptedAction = store.createProposedAction({
      bookingId: accepted.id, kind: "create_provisional_hold",
      payload: { totalMinor: 200000 }, sourceReferences: [DOC],
    });
    store.approveProposedAction(acceptedAction.id, OWNER.id);
    const acceptedBefore = JSON.stringify(store.getProposedAction(acceptedAction.id));

    const facts = service.listFacts(businessId);
    const price = facts.find((fact) => fact.key === "price_line")!;
    const scopedBefore = facts.filter((fact) => fact.key === "scoped_exception").length;
    const { confirm, event } = correctAndPublish(service, store, {
      businessId, actor: OWNER, key: "price_line", subjectId: "plated",
      expectedRevision: price.revision, value: { unitCents: 10500 }, commandId: "cmd-005-a01",
    });

    assert.equal(confirm.revision.revision, price.revision + 1);
    assert.deepEqual(event.affectedProposalIds, [pendingAction.id]);
    assert.deepEqual(event.retainedProposalIds, [acceptedAction.id]);
    assert.equal(
      JSON.stringify(store.getProposedAction(acceptedAction.id)),
      acceptedBefore,
      "accepted snapshot is immutable: the correction never edits it",
    );
    assert.match(event.note, /No exception was promoted/);
    assert.equal(
      service.listFacts(businessId).filter((fact) => fact.key === "scoped_exception").length,
      scopedBefore,
      "no exception is promoted by a correction",
    );
    const stored = listCorrectionEvents(store, businessId);
    assert.equal(stored.length, 1);
    assert.equal(stored[0]!.id, event.id);
  } finally {
    cleanup();
  }
});

test("005-A01 customer exception cannot affect another customer", () => {
  const { service, port, businessId, cleanup } = fixture();
  try {
    service.addScopedException({
      businessId, actor: OWNER, policyId: "late-checkout", effect: "allow",
      scope: "customer", scopeId: "cust-A", value: { note: "owner approved" },
    });
    const forA = port.query({ businessId, customerId: "cust-A" });
    assert.ok(forA.facts.some((fact) => fact.key === "scoped_exception" && fact.scopeId === "cust-A"));
    const forB = port.query({ businessId, customerId: "cust-B" });
    assert.ok(!forB.facts.some((fact) => fact.scopeId === "cust-A"), "cust-A exception must not authorize for cust-B");
    const snapshotB = port.snapshotForOffer({ businessId, customerId: "cust-B" });
    assert.ok(!snapshotB.facts.some((fact) => (fact.value as Record<string, unknown>).exceptionId !== undefined && (fact.value as Record<string, unknown>).scope !== undefined && JSON.stringify((fact.value as Record<string, unknown>).scope).includes("cust-A")));
  } finally {
    cleanup();
  }
});

test("005-A01 source deletion blocks dependent work instead of serving stale facts", () => {
  const { service, port, businessId, cleanup } = fixture();
  try {
    port.ingestSource({
      sourceKey: "fixture-doc-pricing",
      provider: "fixture",
      accountId: "fixture-acct",
      channel: "document",
      externalId: "fixture://fictional/adr005/pricing-sheet",
      observedAt: "2026-09-17T00:00:00.000Z",
      receivedAt: "2026-09-17T00:00:00.000Z",
      contentVersion: "v1",
      contentHash: "hash-1",
      parserVersion: "test-1",
      text: "plated 95",
      attachments: [],
      complete: true,
      issues: [],
      provenance: [DOC],
      simulated: true,
      mode: "prepared",
    });
    confirmPriceLine(service, businessId);
    assert.equal(describeAvailability(port, { businessId }).status, "ready");
    port.invalidateSource("fixture-doc-pricing", "deleted");
    const availability = describeAvailability(port, { businessId });
    assert.equal(availability.status, "stale");
    if (availability.status === "stale") {
      assert.ok(availability.blockReasons.length > 0, "explicit reasons, never silent");
      assert.ok(availability.withheldCount >= 1);
    }
    assert.equal(port.query({ businessId }).blocked, true);
  } finally {
    cleanup();
  }
});

// ---------- 005-A02: rule authority ----------

test("005-A02 parsing alone never becomes policy; model-injected confirm is denied", () => {
  const { service, businessId, cleanup } = fixture();
  try {
    const factsBefore = service.listFacts(businessId).length;
    const parsed = parseOwnerRuleText("Give booking booking-7 10% off, up to $500 USD");
    assert.equal(parsed.status, "parsed");
    if (parsed.status !== "parsed") throw new Error("expected parsed");
    assert.equal(parsed.draft.sendAuthority, "none");
    assert.equal(service.listFacts(businessId).length, factsBefore, "parsing writes nothing");
    assert.throws(
      () => confirmParsedRule(service, { businessId, actor: CONTENT, draft: parsed.draft }),
      /can never confirm a rule/,
      "retrieved instructions can never mint policy",
    );
    assert.equal(service.listFacts(businessId).length, factsBefore);
  } finally {
    cleanup();
  }
});

test("005-A02 ambiguous rules ask clarification instead of guessing", () => {
  for (const text of ["give them a deal", "10% off", "discount for everyone 10%", "set the price"]) {
    const result = parseOwnerRuleText(text);
    assert.equal(result.status, "needs_clarification", `"${text}" must not parse silently`);
    if (result.status === "needs_clarification") {
      assert.ok(result.questions.length > 0);
    }
  }
  const moneyNoCurrency = parseOwnerRuleText("Give booking booking-7 up to 500 off");
  assert.equal(moneyNoCurrency.status, "needs_clarification", "bare amounts never assume a currency");
});

test("005-A02 owner-confirmed parsed concession stays scoped; duplicate correction is idempotent", () => {
  const { service, businessId, cleanup } = fixture();
  try {
    const parsed = parseOwnerRuleText("Give booking booking-7 10% off, up to $500 USD");
    if (parsed.status !== "parsed") throw new Error("expected parsed");
    assert.equal(parsed.draft.scope.label, "booking booking-7 only");
    const applied = confirmParsedRule(service, {
      businessId, actor: OWNER, draft: parsed.draft, commandId: "cmd-005-rule-1",
    });
    assert.equal(applied.duplicate, false);
    const facts = service.listFacts(businessId);
    const exception = facts.find((fact) => fact.key === "scoped_exception")!;
    assert.equal(exception.scope, "booking");
    assert.equal(exception.scopeId, "booking-7");

    // Duplicate correction: same commandId replays idempotently.
    const price = (() => {
      confirmPriceLine(service, businessId);
      return service.listFacts(businessId).find((fact) => fact.key === "price_line")!;
    })();
    const first = service.correctFact({
      businessId, actor: OWNER, key: "price_line", subjectId: "plated",
      expectedRevision: price.revision, value: { unitCents: 9600 }, commandId: "cmd-005-dup",
    });
    const replay = service.correctFact({
      businessId, actor: OWNER, key: "price_line", subjectId: "plated",
      expectedRevision: price.revision, value: { unitCents: 9600 }, commandId: "cmd-005-dup",
    });
    assert.equal(replay.duplicate, true);
    assert.equal(replay.fact.id, first.fact.id);
    assert.throws(
      () => service.correctFact({
        businessId, actor: OWNER, key: "price_line", subjectId: "plated",
        expectedRevision: price.revision + 1, value: { unitCents: 9700 }, commandId: "cmd-005-dup",
      }),
      /different payload/,
      "altered replay with the same commandId is a conflict, never a silent overwrite",
    );
  } finally {
    cleanup();
  }
});

// ---------- inspection + batch confirm + availability ----------

test("005 inspection shows current/missing distinction; batch confirm is per-candidate and owner-only", () => {
  const { service, businessId, cleanup } = fixture();
  try {
    const first = service.intakeCandidate({
      businessId, key: "price_line", subjectId: "plated", value: { unitCents: 9500 },
      confidence: "probable", sourceReferences: [DOC], sourceRevision: "v1",
    });
    const second = service.intakeCandidate({
      businessId, key: "space", subjectId: "hall", value: { capacityMax: 120 },
      confidence: "uncertain", sourceReferences: [DOC], sourceRevision: "v1",
    });
    const inspection = inspectSourceClaims(service, {
      businessId, sourceLocator: DOC.locator,
    });
    assert.equal(inspection.candidates.length, 2);
    assert.deepEqual(inspection.missingKeys.sort(), ["price_line", "space"]);
    assert.ok(inspection.candidates.every((candidate) => candidate.currentFact === null));

    const batch = batchConfirmCandidates(service, {
      businessId, actor: OWNER, candidateIds: [first.id, second.id], commandPrefix: "cmd-005-batch",
    });
    assert.equal(batch.confirmed.length, 2);
    assert.equal(batch.failed.length, 0);

    const repaired = inspectSourceClaims(service, { businessId, sourceLocator: DOC.locator });
    assert.equal(repaired.candidates.length, 0, "confirmed claims leave the pending queue");

    // Non-owner batch confirms nothing.
    const third = service.intakeCandidate({
      businessId, key: "policy", subjectId: "x", value: { note: "n" },
      confidence: "probable", sourceReferences: [DOC],
    });
    const denied = batchConfirmCandidates(service, {
      businessId, actor: CONTENT, candidateIds: [third.id],
    });
    assert.equal(denied.confirmed.length, 0);
    assert.equal(denied.failed.length, 1);
    assert.match(denied.failed[0]!.message, /no approval authority/);
  } finally {
    cleanup();
  }
});

test("005 availability distinguishes no-facts from unavailable and stale", () => {
  const { service, port, businessId, cleanup } = fixture();
  try {
    assert.equal(describeAvailability(port, { businessId }).status, "no-facts");
    confirmPriceLine(service, businessId);
    const ready = describeAvailability(port, { businessId });
    assert.equal(ready.status, "ready");
    if (ready.status === "ready") assert.equal(ready.factCount >= 1, true);

    const down = {
      health: () => ({
        kind: "prepared-scripted" as const,
        available: false,
        detail: "index unreachable",
        provenance: "prepared" as const,
      }),
    } as unknown as KnowledgePort;
    const unavailable = describeAvailability(down, { businessId });
    assert.equal(unavailable.status, "unavailable");
    if (unavailable.status === "unavailable") {
      assert.match(unavailable.detail, /not empty/);
    }
  } finally {
    cleanup();
  }
});

// ---------- 005-A04 concession form: scoped, never standing send authority ----------

test("005-A04 concession form validates scope/limits and never grants send authority", () => {
  const draft = validateConcessionForm({
    scopeType: "booking", scopeId: "booking-7",
    maxReduction: { percent: 10, minor: 50000, currency: "USD" },
    floor: { minor: 100000, currency: "USD" },
    dateBounds: "weekday evenings in November",
  });
  assert.equal(draft.scope.type, "booking");
  assert.equal(draft.scope.id, "booking-7");
  assert.equal(draft.scopeLabel, "booking booking-7 only");
  assert.equal(draft.sendAuthority, "none");
  assert.match(draft.approvalNotice, /no standing send authority/i);
  assert.ok(draft.limits.length >= 3);

  assert.throws(() => validateConcessionForm({ scopeId: "booking-7", maxReduction: { percent: 10 } }), /scope must be/);
  assert.throws(() => validateConcessionForm({ scopeType: "booking", maxReduction: { percent: 10 } }), /scope id is required/);
  assert.throws(
    () => validateConcessionForm({ scopeType: "booking", scopeId: "b-1", maxReduction: { minor: 5000 } }),
    /explicit currency/,
    "amounts without currency are never assumed",
  );
  assert.throws(
    () => validateConcessionForm({ scopeType: "booking", scopeId: "b-1" }),
    /maximum reduction is required/,
  );
});
