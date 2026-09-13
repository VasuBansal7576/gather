/**
 * Cross-connection worker for tests/knowledge-concurrency.test.ts. Each
 * worker opens its OWN store connection to the shared file, so races here
 * are true SQLite-level concurrency, not same-connection sequencing.
 */
import { parentPort, workerData } from "node:worker_threads";
import { GatherStore } from "../src/server/sqlite-store.ts";
import { KnowledgeService } from "../src/knowledge/service.ts";

function isBusy(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /database is locked|database table is locked/i.test(message);
}

/**
 * Open the shared store tolerating cold-start DDL contention: schema setup
 * itself needs brief locks, so simultaneous worker starts may hit BUSY
 * before any test logic runs. Bounded retries; anything else propagates.
 */
function openStore(path: string): GatherStore {
  let last: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      return new GatherStore(path);
    } catch (error) {
      last = error;
      if (!isBusy(error)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  throw last;
}

const store = openStore((workerData as { path: string }).path);
const service = new KnowledgeService(store);

try {
    const { op, payload } = workerData as { op: string; payload: Record<string, unknown> };
    if (op === "intake") {
      const candidate = service.intakeCandidate(payload as unknown as Parameters<KnowledgeService["intakeCandidate"]>[0]);
      parentPort?.postMessage({ ok: true, id: candidate.id });
    } else if (op === "confirm") {
      const result = service.confirmCandidate(payload as unknown as Parameters<KnowledgeService["confirmCandidate"]>[0]);
    parentPort?.postMessage({
      ok: true,
      factId: result.fact.id,
      revision: result.revision.revision,
      alreadyConfirmed: result.alreadyConfirmed,
      duplicate: result.duplicate,
    });
    } else if (op === "correct") {
      const result = service.correctFact(payload as unknown as Parameters<KnowledgeService["correctFact"]>[0]);
    parentPort?.postMessage({ ok: true, factId: result.fact.id, revision: result.revision.revision });
  } else {
    parentPort?.postMessage({ ok: false, error: `unknown op ${op}` });
  }
} catch (error) {
  parentPort?.postMessage({ ok: false, error: error instanceof Error ? `${error.name}:${error.message}`.slice(0, 200) : String(error).slice(0, 200) });
} finally {
  store.close();
}
