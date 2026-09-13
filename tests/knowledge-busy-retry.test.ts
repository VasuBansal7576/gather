/**
 * Deterministic unit tests for the bounded lock-busy retry boundary
 * (`runWithBusyRetry`, src/knowledge/service.ts). No threads, no sleeps as
 * proof: scripted flaky operations pin retry counts, immediate propagation
 * of genuine errors, and the honest busy outcome on exhaustion.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { KnowledgeError, runWithBusyRetry } from "../src/knowledge/index.ts";

function busyError(): Error {
  return Object.assign(new Error("database is locked"), {
    errcode: 5,
    code: "ERR_SQLITE_ERROR",
  });
}

test("transient lock contention retries, then reports the single outcome", () => {
  let calls = 0;
  const out = runWithBusyRetry(() => {
    calls += 1;
    if (calls <= 2) throw busyError();
    return "applied";
  }, 5);
  assert.equal(out, "applied");
  assert.equal(calls, 3, "exactly two retries, then one success — no duplication");
});

test("genuine errors propagate immediately without retry", () => {
  let calls = 0;
  assert.throws(
    () => runWithBusyRetry(() => {
      calls += 1;
      throw new KnowledgeError("stale_version", "stale correction");
    }, 5),
    /stale correction/,
  );
  assert.equal(calls, 1, "application errors must never be retried");
});

test("exhausted contention reports honest busy, never a raw lock leak", () => {
  let calls = 0;
  try {
    runWithBusyRetry(() => {
      calls += 1;
      throw busyError();
    }, 3);
    assert.fail("must throw");
  } catch (error) {
    assert.ok(error instanceof KnowledgeError, `must be typed, got ${error}`);
    assert.equal((error as KnowledgeError).code, "busy");
  }
  assert.equal(calls, 4, "one initial attempt plus three bounded retries");
});
