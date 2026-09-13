/**
 * True cross-connection concurrency regression: each case fans out across
 * worker threads with independent store connections to one shared SQLite
 * file. Same-connection sequencing cannot exhibit these races.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { GatherStore } from "../src/server/sqlite-store.ts";
import { KnowledgeService } from "../src/knowledge/index.ts";
import type { SourceReference } from "../src/domain/contracts.ts";

const DOC = {
  kind: "document" as const,
  locator: "fixture://fictional/concurrency-doc",
  label: "Fictional concurrency fixture",
  fictional: true,
};
const OWNER = { kind: "owner" as const, id: "fictional-owner-1" };

interface WorkerOutcome {
  ok: boolean;
  id?: string;
  factId?: string;
  revision?: number;
  alreadyConfirmed?: boolean;
  duplicate?: boolean;
  error?: string;
}

function fanOut(path: string, calls: { op: string; payload: Record<string, unknown> }[]): Promise<WorkerOutcome[]> {
  return Promise.all(calls.map(({ op, payload }) => new Promise<WorkerOutcome>((resolve) => {
    const worker = new Worker(new URL("./knowledge-concurrency-worker.ts", import.meta.url), {
      workerData: { path, op, payload },
    });
    worker.on("message", async (message) => {
      await worker.terminate();
      resolve(message as WorkerOutcome);
    });
    worker.on("error", async (error) => {
      await worker.terminate();
      resolve({ ok: false, error: `worker:${String(error).slice(0, 120)}` });
    });
  })));
}

function spaceValue(name: string): Record<string, unknown> {
  return { spaceId: "room-race", name, capacityMin: 1, capacityMax: 9 };
}

test("concurrent same-observation intake yields one candidate row", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gather-kb-conc-"));
  const path = join(directory, "k.sqlite");
  const setup = new GatherStore(path);
  const service = new KnowledgeService(setup);
  const businessId = setup.createBusiness({ name: "Fictional Hall", timezone: "UTC" }).id;
  setup.close();
  const payload = {
    businessId, key: "space", subjectId: "room-race", value: spaceValue("R"),
    confidence: "probable", sourceReferences: [DOC],
  };
  const outcomes = await fanOut(path, Array.from({ length: 8 }, () => ({ op: "intake", payload })));
  const verify = new GatherStore(path);
  try {
    const count = (verify.db.prepare("SELECT COUNT(*) AS n FROM knowledge_candidates").get() as { n: number }).n;
    assert.equal(count, 1, `expected exactly one candidate row, got ${count}: ${JSON.stringify(outcomes)}`);
    const ids = new Set(outcomes.filter((o) => o.ok).map((o) => o.id));
    assert.equal(ids.size, 1, "every successful intake must name the same candidate");
    for (const outcome of outcomes.filter((o) => !o.ok)) {
      // Lock contention is honest and retryable; anything else is a defect.
      assert.match(outcome.error ?? "", /busy|locked/i, `unexpected failure shape: ${outcome.error}`);
    }
  } finally {
    verify.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("concurrent confirmation applies exactly once; losers see stable outcomes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gather-kb-conc-"));
  const path = join(directory, "k.sqlite");
  const setup = new GatherStore(path);
  const service = new KnowledgeService(setup);
  const businessId = setup.createBusiness({ name: "Fictional Hall", timezone: "UTC" }).id;
  const candidate = service.intakeCandidate({
    businessId, key: "space", subjectId: "room-race", value: spaceValue("R"),
    confidence: "probable", sourceReferences: [DOC],
  });
  setup.close();
  const payload = { businessId, actor: OWNER, candidateId: candidate.id };
  const outcomes = await fanOut(path, Array.from({ length: 4 }, () => ({ op: "confirm", payload })));
  const verify = new GatherStore(path);
  try {
    const facts = (verify.db.prepare("SELECT COUNT(*) AS n FROM business_facts").get() as { n: number }).n;
    const active = (verify.db.prepare("SELECT COUNT(*) AS n FROM knowledge_revisions WHERE status = 'active'").get() as { n: number }).n;
    assert.equal(facts, 1, `expected one fact, got ${facts}: ${JSON.stringify(outcomes)}`);
    assert.equal(active, 1, `expected one active revision, got ${active}`);
    const winners = outcomes.filter((o) => o.ok);
    assert.equal(winners.length, 4, `every attempt must resolve, got ${JSON.stringify(outcomes)}`);
    assert.equal(new Set(winners.map((o) => o.factId)).size, 1, "all attempts must agree on the single fact");
    assert.ok(winners.filter((o) => !o.alreadyConfirmed).length <= 1, "at most one attempt applies");
  } finally {
    verify.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("concurrent correction with one expected version applies once; losers go stale", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gather-kb-conc-"));
  const path = join(directory, "k.sqlite");
  const setup = new GatherStore(path);
  const service = new KnowledgeService(setup);
  const businessId = setup.createBusiness({ name: "Fictional Hall", timezone: "UTC" }).id;
  const candidate = service.intakeCandidate({
    businessId, key: "space", subjectId: "room-race", value: spaceValue("R"),
    confidence: "probable", sourceReferences: [DOC],
  });
  service.confirmCandidate({ businessId, actor: OWNER, candidateId: candidate.id });
  setup.close();
  const payload = {
    businessId, actor: OWNER, key: "space", subjectId: "room-race", expectedRevision: 1,
    value: spaceValue("R2"), sourceReferences: [DOC],
  };
  const outcomes = await fanOut(path, Array.from({ length: 4 }, () => ({ op: "correct", payload })));
  const verify = new GatherStore(path);
  try {
    const active = verify.db.prepare("SELECT revision FROM knowledge_revisions WHERE status = 'active'").all() as { revision: number }[];
    assert.equal(active.length, 1, `expected one active revision, got ${JSON.stringify(active)}`);
    assert.equal(active[0]?.revision, 2);
    const applied = outcomes.filter((o) => o.ok);
    assert.equal(applied.length, 1, `expected exactly one applied correction, got ${JSON.stringify(outcomes)}`);
    for (const loser of outcomes.filter((o) => !o.ok)) {
      assert.match(loser.error ?? "", /stale correction|stale_version|stale/, `loser must be stale-version, got ${loser.error}`);
    }
    const rejected = new KnowledgeService(verify).listDecisions(businessId).filter((d) => d.outcome === "rejected");
    assert.ok(rejected.some((d) => JSON.stringify(d.detail).includes("stale_version")), "stale losers must be audited");
  } finally {
    verify.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("same commandId authorizes one confirmation; concurrent duplicates replay it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gather-kb-conc-"));
  const path = join(directory, "k.sqlite");
  const setup = new GatherStore(path);
  const service = new KnowledgeService(setup);
  const businessId = setup.createBusiness({ name: "Fictional Hall", timezone: "UTC" }).id;
  const candidate = service.intakeCandidate({
    businessId, key: "space", subjectId: "room-race", value: spaceValue("R"),
    confidence: "probable", sourceReferences: [DOC],
  });
  setup.close();
  const payload = { businessId, actor: OWNER, candidateId: candidate.id, commandId: "cmd-shared-1" };
  const outcomes = await fanOut(path, Array.from({ length: 4 }, () => ({ op: "confirm", payload })));
  const verify = new GatherStore(path);
  try {
    const facts = (verify.db.prepare("SELECT COUNT(*) AS n FROM business_facts").get() as { n: number }).n;
    assert.equal(facts, 1, `one command authorizes one confirmation, got ${facts}: ${JSON.stringify(outcomes)}`);
    assert.ok(outcomes.every((o) => o.ok), `every attempt resolves, got ${JSON.stringify(outcomes)}`);
    assert.equal(new Set(outcomes.map((o) => o.factId)).size, 1, "all attempts agree on the single fact");
    assert.equal(outcomes.filter((o) => !o.alreadyConfirmed && !o.duplicate).length, 1, "exactly one attempt applies");
  } finally {
    verify.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("same commandId on an altered command conflicts, even concurrently", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gather-kb-conc-"));
  const path = join(directory, "k.sqlite");
  const setup = new GatherStore(path);
  const service = new KnowledgeService(setup);
  const businessId = setup.createBusiness({ name: "Fictional Hall", timezone: "UTC" }).id;
  const first = service.intakeCandidate({
    businessId, key: "space", subjectId: "room-one", value: spaceValue("One"),
    confidence: "probable", sourceReferences: [DOC],
  });
  const second = service.intakeCandidate({
    businessId, key: "space", subjectId: "room-two", value: spaceValue("Two"),
    confidence: "probable", sourceReferences: [DOC],
  });
  setup.close();
  const outcomes = await fanOut(path, [
    { op: "confirm", payload: { businessId, actor: OWNER, candidateId: first.id, commandId: "cmd-shared-2" } },
    { op: "confirm", payload: { businessId, actor: OWNER, candidateId: second.id, commandId: "cmd-shared-2" } },
  ]);
  const verify = new GatherStore(path);
  try {
    const facts = (verify.db.prepare("SELECT COUNT(*) AS n FROM business_facts").get() as { n: number }).n;
    assert.equal(facts, 1, `one command authorizes one mutation, got ${facts}: ${JSON.stringify(outcomes)}`);
    const applied = outcomes.filter((o) => o.ok);
    assert.equal(applied.length, 1, `exactly one attempt succeeds, got ${JSON.stringify(outcomes)}`);
    for (const loser of outcomes.filter((o) => !o.ok)) {
      assert.match(loser.error ?? "", /command_conflict|already used/, `altered reuse must conflict, got ${loser.error}`);
    }
    const decisions = (verify.db.prepare("SELECT COUNT(*) AS n FROM knowledge_decisions WHERE command_id = 'cmd-shared-2'").get() as { n: number }).n;
    assert.equal(decisions, 1, "exactly one decision row exists for the command");
  } finally {
    verify.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("sequential altered-command reuse conflicts deterministically", () => {
  const directory = mkdtempSync(join(tmpdir(), "gather-kb-conc-"));
  const path = join(directory, "k.sqlite");
  const setup = new GatherStore(path);
  const service = new KnowledgeService(setup);
  const businessId = setup.createBusiness({ name: "Fictional Hall", timezone: "UTC" }).id;
  try {
    const first = service.intakeCandidate({
      businessId, key: "space", subjectId: "room-one", value: spaceValue("One"),
      confidence: "probable", sourceReferences: [DOC],
    });
    const second = service.intakeCandidate({
      businessId, key: "space", subjectId: "room-two", value: spaceValue("Two"),
      confidence: "probable", sourceReferences: [DOC],
    });
    service.confirmCandidate({ businessId, actor: OWNER, candidateId: first.id, commandId: "cmd-seq-1" });
    let code = "";
    try {
      service.confirmCandidate({ businessId, actor: OWNER, candidateId: second.id, commandId: "cmd-seq-1" });
    } catch (error) {
      code = (error as { code?: string }).code ?? "";
    }
    assert.equal(code, "command_conflict");
    const facts = (setup.db.prepare("SELECT COUNT(*) AS n FROM business_facts").get() as { n: number }).n;
    assert.equal(facts, 1);
  } finally {
    setup.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejected decisions replay as typed rejections, never fake success", () => {
  const directory = mkdtempSync(join(tmpdir(), "gather-kb-conc-"));
  const path = join(directory, "k.sqlite");
  const setup = new GatherStore(path);
  const service = new KnowledgeService(setup);
  const businessId = setup.createBusiness({ name: "Fictional Hall", timezone: "UTC" }).id;
  try {
    const candidate = service.intakeCandidate({
      businessId, key: "space", subjectId: "room-race", value: spaceValue("R"),
      confidence: "probable", sourceReferences: [DOC],
    });
    service.rejectCandidate({ businessId, actor: OWNER, candidateId: candidate.id, commandId: "cmd-rej-1" });
    // A stale confirm under a fresh commandId is rejected and audited...
    assert.throws(
      () => service.confirmCandidate({ businessId, actor: OWNER, candidateId: candidate.id, commandId: "cmd-rej-2" }),
      /not pending/,
    );
    // ...and replaying that rejection reproduces the typed error, not a
    // ConfirmResult cast with absent fact rows — without adding audit rows.
    const second = (): void => {
      service.confirmCandidate({ businessId, actor: OWNER, candidateId: candidate.id, commandId: "cmd-rej-2" });
    };
    assert.throws(second, /not pending/);
    let replayCode = "";
    try {
      second();
    } catch (error) {
      replayCode = (error as { code?: string }).code ?? "";
    }
    assert.equal(replayCode, "stale");
    const decisions = service.listDecisions(businessId).filter((d) => d.outcome === "rejected");
    assert.ok(decisions.length >= 1);
  } finally {
    setup.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reconfirming a corrected candidate returns the live pair, never mismatched", () => {
  const directory = mkdtempSync(join(tmpdir(), "gather-kb-conc-"));
  const path = join(directory, "k.sqlite");
  const setup = new GatherStore(path);
  const service = new KnowledgeService(setup);
  const businessId = setup.createBusiness({ name: "Fictional Hall", timezone: "UTC" }).id;
  try {
    const candidate = service.intakeCandidate({
      businessId, key: "space", subjectId: "room-race", value: spaceValue("R"),
      confidence: "probable", sourceReferences: [DOC],
    });
    const first = service.confirmCandidate({ businessId, actor: OWNER, candidateId: candidate.id });
    service.correctFact({
      businessId, actor: OWNER, key: "space", subjectId: "room-race", expectedRevision: 1,
      value: spaceValue("R2"), sourceReferences: [DOC],
    });
    const again = service.confirmCandidate({ businessId, actor: OWNER, candidateId: candidate.id });
    assert.equal(again.alreadyConfirmed, true);
    assert.equal(again.revision.revision, 2);
    assert.equal(again.fact.id, again.revision.factId, "fact and revision must belong together");
    assert.notEqual(again.fact.id, first.fact.id, "the live pair reflects the correction");
    assert.deepEqual((again.fact.value as Record<string, unknown>).name, "R2");
  } finally {
    setup.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("altered provenance cannot replay as an identical correction", () => {
  const directory = mkdtempSync(join(tmpdir(), "gather-kb-conc-"));
  const path = join(directory, "k.sqlite");
  const setup = new GatherStore(path);
  const service = new KnowledgeService(setup);
  const businessId = setup.createBusiness({ name: "Fictional Hall", timezone: "UTC" }).id;
  try {
    const candidate = service.intakeCandidate({
      businessId, key: "space", subjectId: "room-race", value: spaceValue("R"),
      confidence: "probable", sourceReferences: [DOC],
    });
    service.confirmCandidate({ businessId, actor: OWNER, candidateId: candidate.id });
    const other: SourceReference = { kind: "document", locator: "fixture://other/doc", label: "Other", fictional: true };
    const base = {
      businessId, actor: OWNER, key: "space", subjectId: "room-race", expectedRevision: 1,
      value: spaceValue("R2"), commandId: "cmd-prov-1",
    };
    const first = service.correctFact({ ...base, sourceReferences: [DOC] });
    assert.equal(first.revision.revision, 2);
    // Same commandId but different authoritative sources is a different
    // command: it must conflict, never replay the first outcome as identical.
    let code = "";
    try {
      service.correctFact({ ...base, expectedRevision: 2, sourceReferences: [other] });
    } catch (error) {
      code = (error as { code?: string }).code ?? "";
    }
    assert.equal(code, "command_conflict");
  } finally {
    setup.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
