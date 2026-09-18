import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { GatherStore } from "../src/server/sqlite-store.ts";
import { KnowledgeService } from "../src/knowledge/service.ts";
import { PreparedKnowledgePort } from "../src/knowledge/prepared.ts";
import {
  EVAL_CASE_SET_VERSION,
  NO_CAUSAL_CLAIM,
  loadCaseSet,
} from "../src/evals/case-set.ts";
import { compareRuns, runCaseSet, type EvalRun } from "../src/evals/runner.ts";

// All fixtures are fictional; nothing here is a real connected source.

const DOC = {
  kind: "document" as const,
  locator: "fixture://fictional/adr005/eval-seed",
  label: "Fictional eval seed",
  fictional: true,
};
const OWNER = { kind: "owner" as const, id: "fictional-owner-1" };

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "gather-adr005-evals-"));
  const store = new GatherStore(join(directory, "gather.sqlite"));
  const business = store.createBusiness({ name: "Fictional Eval Hall", timezone: "America/New_York" });
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

/** Seed the confirmed expectations the 005-v1 case set probes. */
function seedExpectations(service: KnowledgeService, businessId: string): void {
  for (const [key, subjectId, value] of [
    ["price_line", "plated", { unitCents: 9500 }],
    ["pricing_bounds", "", { currency: "USD", floorCents: 100000, costsComplete: false }],
  ] as const) {
    const candidate = service.intakeCandidate({
      businessId, key, subjectId, value: value as Record<string, unknown>,
      confidence: "probable", sourceReferences: [DOC], sourceRevision: "v1",
    });
    service.confirmCandidate({ businessId, candidateId: candidate.id, actor: OWNER });
  }
  service.addScopedException({
    businessId, actor: OWNER, policyId: "late-checkout", effect: "allow",
    scope: "booking", scopeId: "booking-7", value: { note: "owner approved late checkout" },
  });
}

test("005-A03 case-set artifact is versioned and non-empty", () => {
  const caseSet = loadCaseSet();
  assert.equal(caseSet.version, EVAL_CASE_SET_VERSION);
  assert.ok(caseSet.cases.length >= 6, "a real denominator, never an empty set");
  assert.ok(caseSet.cases.every((inquiry) => inquiry.id && inquiry.kind && inquiry.question && inquiry.detail));
});

test("005-A03 same-case-set before/after run is reproducible", () => {
  const { port, service, businessId, cleanup } = fixture();
  try {
    seedExpectations(service, businessId);
    const caseSet = loadCaseSet();
    const before = runCaseSet(port, businessId, caseSet);
    const after = runCaseSet(port, businessId, caseSet);
    assert.equal(before.caseSetVersion, EVAL_CASE_SET_VERSION);
    assert.equal(before.denominator, caseSet.cases.length, "whole set answered, honest denominator");
    assert.deepEqual(before.unmeasuredIds, []);
    assert.deepEqual(after.outcomes, before.outcomes, "reproducible: identical outcomes on unchanged knowledge");
    assert.equal(before.passedCount, before.denominator);
    const comparison = compareRuns(before, after);
    assert.equal(comparison.verdict, "unchanged");
    assert.equal(comparison.disclaimer, NO_CAUSAL_CLAIM);
    assert.match(comparison.denominatorNote, /Same \d+-case denominator/);
  } finally {
    cleanup();
  }
});

test("005-A03 unanswered cases are unmeasured, never scored", () => {
  const { port, service, businessId, cleanup } = fixture();
  try {
    seedExpectations(service, businessId);
    const run = runCaseSet(port, businessId, loadCaseSet(), { onlyIds: ["K01"] });
    assert.equal(run.denominator, 1);
    assert.deepEqual(run.answeredIds, ["K01"]);
    assert.ok(run.unmeasuredIds.length === loadCaseSet().cases.length - 1);
    assert.ok(!run.outcomes.some((outcome) => outcome.caseId !== "K01"));
  } finally {
    cleanup();
  }
});

function syntheticRun(overrides: Partial<EvalRun> & { answeredIds: string[]; outcomes: EvalRun["outcomes"] }): EvalRun {
  const passedCount = overrides.outcomes.filter((outcome) => outcome.passed).length;
  return {
    caseSetVersion: EVAL_CASE_SET_VERSION,
    businessId: "biz-1",
    generatedAt: "2026-09-17T00:00:00.000Z",
    unmeasuredIds: [],
    passedCount,
    denominator: overrides.outcomes.length,
    disclaimer: NO_CAUSAL_CLAIM,
    ...overrides,
  };
}

function pass(id: string): EvalRun["outcomes"][number] {
  return { caseId: id, kind: "confirmed-fact-applies", passed: true, detail: "ok" };
}

function fail(id: string): EvalRun["outcomes"][number] {
  return { caseId: id, kind: "confirmed-fact-applies", passed: false, detail: "changed" };
}

test("005-A03 added cases cannot masquerade as score improvement", () => {
  const before = syntheticRun({ answeredIds: ["K01", "K02"], outcomes: [pass("K01"), pass("K02")] });
  const after = syntheticRun({
    answeredIds: ["K01", "K02", "K07"],
    outcomes: [pass("K01"), pass("K02"), pass("K07")],
  });
  const comparison = compareRuns(before, after);
  assert.deepEqual(comparison.addedCaseIds, ["K07"]);
  assert.equal(comparison.verdict, "unchanged", "added cases are not improvement on the shared set");
  assert.match(comparison.denominatorNote, /Denominator changed/);
  assert.match(comparison.denominatorNote, /not presented as improvement/);
  assert.equal(comparison.before.passed, 2);
  assert.equal(comparison.after.passed, 3, "totals still report honestly with their own denominators");
  assert.equal(comparison.after.denominator, 3);
});

test("005-A03 unchanged or worse scores report honestly, never forced to rise", () => {
  const before = syntheticRun({ answeredIds: ["K01", "K02"], outcomes: [pass("K01"), pass("K02")] });
  const worse = syntheticRun({ answeredIds: ["K01", "K02"], outcomes: [fail("K01"), pass("K02")] });
  const comparison = compareRuns(before, worse);
  assert.equal(comparison.verdict, "worse");
  assert.equal(comparison.sharedBeforePassed, 2);
  assert.equal(comparison.sharedAfterPassed, 1);
  assert.equal(comparison.disclaimer, NO_CAUSAL_CLAIM);
  assert.ok(
    !JSON.stringify(comparison).match(/caused|proves|guarantees|business improved|revenue/i),
    "no affirmative causal improvement claim anywhere in the comparison",
  );
});

test("005-A03 incomparable runs refuse instead of scoring", () => {
  const base = syntheticRun({ answeredIds: ["K01"], outcomes: [pass("K01")] });
  assert.throws(
    () => compareRuns({ ...base, caseSetVersion: "005-v0" }, base),
    /same versioned case set required/,
  );
  assert.throws(
    () => compareRuns(base, { ...base, businessId: "biz-2" }),
    /per-business comparison only/,
  );
  assert.throws(
    () => runCaseSet(
      { health: () => ({ available: true }) } as never,
      "biz-1",
      { version: "005-v0", generatedAt: "", cases: [] },
    ),
    /versions must match/,
  );
});
