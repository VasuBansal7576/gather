import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import {
  BUDGET_STATE_VERSION,
  BudgetError,
  BudgetStore,
  DEFAULT_MAX_RUNS_PER_BUSINESS_PER_DAY,
  DEFAULT_MAX_TOKENS_PER_RUN,
  DEFAULT_MAX_TOOL_CALLS_PER_RUN,
  DEFAULT_RUN_DEADLINE_MS,
  leaseEvidence,
} from "../src/server/budget.ts";

/**
 * ADR-009 step 3 (budgets) + acceptance 009-A02 (budget half):
 * persistent per-call/run/day reservations, tool-count and token caps,
 * and the real execution deadline. All fixtures are local and scripted;
 * no gateway, model, or provider is touched.
 */

function storeFixture(limits?: ConstructorParameters<typeof BudgetStore>[0]["limits"], now?: () => number) {
  const dir = mkdtempSync(join(tmpdir(), "gather-budget-test-"));
  const store = new BudgetStore({
    stateDir: dir,
    ...(limits === undefined ? {} : { limits }),
    ...(now === undefined ? {} : { now }),
  });
  return { dir, store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("release defaults match C08 (15 calls, 32000 tokens, 5-minute deadline, 50 runs/day)", () => {
  const { store, cleanup } = storeFixture();
  try {
    assert.equal(store.limits.maxToolCallsPerRun, DEFAULT_MAX_TOOL_CALLS_PER_RUN);
    assert.equal(store.limits.maxToolCallsPerRun, 15);
    assert.equal(store.limits.maxTokensPerRun, DEFAULT_MAX_TOKENS_PER_RUN);
    assert.equal(store.limits.maxTokensPerRun, 32_000);
    assert.equal(store.limits.runDeadlineMs, DEFAULT_RUN_DEADLINE_MS);
    assert.equal(store.limits.runDeadlineMs, 300_000);
    assert.equal(store.limits.maxRunsPerBusinessPerDay, DEFAULT_MAX_RUNS_PER_BUSINESS_PER_DAY);
    assert.equal(store.limits.maxRunsPerBusinessPerDay, 50);
  } finally {
    cleanup();
  }
});

test("16th tool call is denied; token over-reservation is denied before dispatch", () => {
  const { store, cleanup } = storeFixture();
  try {
    const { run } = store.startRun({ businessId: "b1", idempotencyKey: "k-1" });
    for (let i = 0; i < 15; i++) {
      store.reserveToolCall(run.runId, { maxInputTokens: 100, maxOutputTokens: 100 });
    }
    assert.throws(() => store.reserveToolCall(run.runId, { maxInputTokens: 1, maxOutputTokens: 1 }), (error: unknown) =>
      error instanceof BudgetError && error.code === "BUDGET_TOOL_EXHAUSTED" && error.httpStatus === 429,
    );

    const second = store.startRun({ businessId: "b1", idempotencyKey: "k-2" });
    assert.throws(
      () => store.reserveToolCall(second.run.runId, { maxInputTokens: 31_000, maxOutputTokens: 2_000 }),
      (error: unknown) => error instanceof BudgetError && error.code === "BUDGET_TOKEN_EXHAUSTED",
    );
    // A fitting reservation still works on the same run.
    store.reserveToolCall(second.run.runId, { maxInputTokens: 1_000, maxOutputTokens: 1_000 });
  } finally {
    cleanup();
  }
});

test("daily run cap denies the 51st run; usage restarts the next day", () => {
  let nowMs = Date.parse("2026-09-17T10:00:00.000Z");
  const { store, cleanup } = storeFixture(undefined, () => nowMs);
  try {
    for (let i = 0; i < 50; i++) {
      store.startRun({ businessId: "b1", idempotencyKey: `day-key-${i}` });
    }
    assert.throws(() => store.startRun({ businessId: "b1", idempotencyKey: "day-key-50" }), (error: unknown) =>
      error instanceof BudgetError && error.code === "BUDGET_RUNS_EXHAUSTED",
    );
    // Another business is unaffected.
    store.startRun({ businessId: "b2", idempotencyKey: "other-biz" });
    // Next UTC day resets the counter.
    nowMs = Date.parse("2026-09-18T00:00:01.000Z");
    store.startRun({ businessId: "b1", idempotencyKey: "next-day" });
    assert.equal(store.dailyUsage("b1", "2026-09-18"), 1);
  } finally {
    cleanup();
  }
});

test("usage and reservations persist over restart (reload from disk)", () => {
  const dir = mkdtempSync(join(tmpdir(), "gather-budget-restart-"));
  try {
    const first = new BudgetStore({ stateDir: dir });
    const { run } = first.startRun({ businessId: "b1", idempotencyKey: "persist-1" });
    first.reserveToolCall(run.runId, { maxInputTokens: 500, maxOutputTokens: 500 });
    first.commitUsage(run.runId, { inputTokens: 400, outputTokens: 300, reservedEstimate: 1000 });

    // A fresh store over the same dir (the restart) sees everything.
    const second = new BudgetStore({ stateDir: dir });
    const reloaded = second.getRun(run.runId);
    assert.equal(reloaded.toolCalls, 1);
    assert.equal(reloaded.tokensUsed, 700);
    // Reserved is the cumulative ceiling (settled actuals + outstanding
    // estimates): 1000 estimated, 700 settled, 300 released.
    assert.equal(reloaded.tokensReserved, 700);
    assert.equal(second.dailyUsage("b1", reloaded.day), 1);
    // The cap still applies after restart: 14 more calls ok, the 16th denied.
    for (let i = 0; i < 14; i++) {
      second.reserveToolCall(run.runId, { maxInputTokens: 10, maxOutputTokens: 10 });
    }
    assert.throws(() => second.reserveToolCall(run.runId, { maxInputTokens: 10, maxOutputTokens: 10 }), (error: unknown) =>
      error instanceof BudgetError && error.code === "BUDGET_TOOL_EXHAUSTED",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unknown runs cannot relaunch as duplicates; cancelled runs stay denied", () => {
  const { store, cleanup } = storeFixture();
  try {
    assert.throws(() => store.getRun("run_does_not_exist"), (error: unknown) =>
      error instanceof BudgetError && error.code === "BUDGET_UNKNOWN_RUN" && error.httpStatus === 409,
    );
    const { run } = store.startRun({ businessId: "b1", idempotencyKey: "cancel-me" });
    store.finishRun(run.runId, "cancelled");
    assert.throws(() => store.startRun({ businessId: "b1", idempotencyKey: "cancel-me" }), (error: unknown) =>
      error instanceof BudgetError && error.code === "BUDGET_RELAUNCH_DENIED",
    );
    // Completed runs replay without duplicating the day counter.
    const ok = store.startRun({ businessId: "b1", idempotencyKey: "done" });
    store.finishRun(ok.run.runId, "completed");
    const replay = store.startRun({ businessId: "b1", idempotencyKey: "done" });
    assert.equal(replay.duplicate, true);
    assert.equal(replay.run.runId, ok.run.runId);
  } finally {
    cleanup();
  }
});

test("expired deadline fences the run: further tools denied until reconciled", () => {
  let nowMs = Date.parse("2026-09-17T10:00:00.000Z");
  const { store, cleanup } = storeFixture({ runDeadlineMs: 60_000 }, () => nowMs);
  try {
    const { run } = store.startRun({ businessId: "b1", idempotencyKey: "slow" });
    assert.equal(store.deadlineStatus(run.runId), "ok");
    nowMs += 61_000;
    assert.equal(store.deadlineStatus(run.runId), "expired");
    const fenced = store.fenceRun(run.runId);
    assert.equal(fenced.fenced, true);
    assert.equal(fenced.status, "continuing");
    assert.throws(() => store.reserveToolCall(run.runId, { maxInputTokens: 1, maxOutputTokens: 1 }), (error: unknown) =>
      error instanceof BudgetError && error.code === "BUDGET_DEADLINE_EXCEEDED",
    );
  } finally {
    cleanup();
  }
});

test("lease composition is read-only: evidence without acquiring a lock", () => {
  const dir = mkdtempSync(join(tmpdir(), "gather-budget-lease-"));
  try {
    const status = leaseEvidence(dir);
    assert.equal(status.held, false);
    assert.equal(status.alive, false);
    assert.equal(BUDGET_STATE_VERSION, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
