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
