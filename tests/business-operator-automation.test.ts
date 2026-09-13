import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { CoordinationLedger } from "../src/coordination/ledger.ts";
import { createDemoConnectors } from "../src/connectors/demo.ts";
import { GmailInboxPoller } from "../src/connectors/google/incremental.ts";
import type { GoogleHttpTransport } from "../src/connectors/google/transport.ts";
import { GatherStore } from "../src/server/sqlite-store.ts";
import {
  getProactiveBinding,
  listProactiveBindings,
  noteProactiveRevocation,
  registerProactiveBinding,
  removeProactiveBinding,
  resetProactiveAutomation,
  startProactiveAccount,
  stopProactiveAccount,
  tickBinding,
  type OperatorRuntimeDeps,
} from "../src/server/operator-runtime/index.ts";

// All fixtures are fictional; scripted transports only, no live providers.
const NOW = "2026-06-01T12:00:00.000Z";
const ACCOUNT = "auto-acct-1";
const BUSINESS = "auto-biz-1";

function json(status: number, body: unknown) {
  return { status, headers: { "Content-Type": "application/json" }, text: JSON.stringify(body) };
}

function emptyHistory(): GoogleHttpTransport {
  return {
    request: async (req) => {
      if (req.url.includes("/profile")) return json(200, { emailAddress: "owner@example.test", historyId: "9000" });
      if (req.url.includes("/history")) return json(200, { historyId: "9000", history: [] });
      return json(200, { messages: [] });
    },
  };
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "gather-auto-"));
  const store = new GatherStore(join(dir, "gather.sqlite"));
  const ledger = new CoordinationLedger(store.db, { clock: () => NOW });
  const business = store.createBusiness({ name: "Fictional Hall", timezone: "UTC" });
  const demo = createDemoConnectors({});
  return {
    dir, store, ledger, businessId: business.id,
    cleanup: () => { resetProactiveAutomation(); store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

function runtimeFor(fx: ReturnType<typeof fixture>, transport: GoogleHttpTransport): OperatorRuntimeDeps {
  const poller = new GmailInboxPoller({ transport, tokens: () => Promise.resolve("t"), accountId: ACCOUNT });
  return {
    store: fx.store,
    ledger: fx.ledger,
    inbox: { pollInbox: poller.pollInbox.bind(poller), provenance: { simulated: true, label: "scripted" } },
    booking: { store: fx.store, calendar: createDemoConnectors({}).calendar, email: createDemoConnectors({}).email, ownerId: "test-owner", now: () => NOW },
    accountId: ACCOUNT,
    businessId: fx.businessId,
    now: () => NOW,
  };
}

function deferred() {
  let release!: () => void;
  let calls = 0;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  return {
    calls: () => calls,
    release,
    run: async () => { calls += 1; await gate; },
  };
}

test("registration validates bounds and refresh replaces the timer", () => {
  try {
    assert.throws(() => registerProactiveBinding({ accountId: "  ", businessId: BUSINESS, runSweep: async () => {} }), /accountId/);
    assert.throws(() => registerProactiveBinding({ accountId: ACCOUNT, businessId: BUSINESS, runSweep: async () => {}, intervalMs: 1000 }), /intervalMs/);
    const first = registerProactiveBinding({ accountId: ACCOUNT, businessId: BUSINESS, runSweep: async () => {}, intervalMs: 60_000 });
    assert.equal(first.status, "running");
    assert.equal(first.intervalMs, 60_000);
    const refreshed = registerProactiveBinding({ accountId: ACCOUNT, businessId: BUSINESS, runSweep: async () => {}, intervalMs: 120_000 });
    assert.equal(refreshed.intervalMs, 120_000);
    assert.equal(refreshed.totalRuns, 0);
    assert.deepEqual(listProactiveBindings().map((b) => b.accountId), [ACCOUNT]);
    assert.equal(removeProactiveBinding(ACCOUNT), true);
    assert.equal(removeProactiveBinding(ACCOUNT), false);
    assert.equal(getProactiveBinding(ACCOUNT), undefined);
  } finally {
    resetProactiveAutomation();
  }
});

test("tick runs exactly one guarded cycle and reports state", async () => {
  try {
    let calls = 0;
    registerProactiveBinding({ accountId: ACCOUNT, businessId: BUSINESS, runSweep: async () => { calls += 1; }, intervalMs: 60_000 });
    const first = await tickBinding(ACCOUNT);
    assert.equal(first.ok, true);
    assert.equal(first.skippedOverlap, false);
    assert.equal(first.state?.totalRuns, 1);
    assert.equal(first.state?.consecutiveErrors, 0);
    assert.equal(calls, 1);
    const missing = await tickBinding("no-such-account");
    assert.equal(missing.ok, false);
  } finally {
    resetProactiveAutomation();
  }
});

test("overlapping ticks skip instead of running concurrently", async () => {
  const slow = deferred();
  try {
    registerProactiveBinding({ accountId: ACCOUNT, businessId: BUSINESS, runSweep: slow.run, intervalMs: 60_000 });
    const pending = tickBinding(ACCOUNT);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const skipped = await tickBinding(ACCOUNT);
    assert.equal(skipped.ok, true);
    assert.equal(skipped.skippedOverlap, true);
    assert.equal(skipped.state?.skippedOverlaps, 1);
    slow.release();
    const done = await pending;
    assert.equal(done.ok, true);
    assert.equal(slow.calls(), 1, "exactly one sweep body ran");
  } finally {
    resetProactiveAutomation();
  }
});

test("repeated failures degrade explicitly instead of retrying forever", async () => {
  try {
    registerProactiveBinding({
      accountId: ACCOUNT, businessId: BUSINESS,
      runSweep: async () => { throw new Error("provider exploded"); },
      intervalMs: 60_000, maxConsecutiveErrors: 1,
    });
    const first = await tickBinding(ACCOUNT);
    assert.equal(first.ok, false);
    assert.equal(first.state?.status, "running");
    const second = await tickBinding(ACCOUNT);
    assert.equal(second.ok, false);
    assert.equal(second.state?.status, "degraded");
    assert.match(second.state?.lastError ?? "", /provider exploded/);
    const after = await tickBinding(ACCOUNT);
    assert.equal(after.ok, false, "degraded bindings do not run");
    assert.equal(noteProactiveRevocation("unknown-acct", "x"), undefined);
  } finally {
    resetProactiveAutomation();
  }
});

test("revocation degrades at once and stop drains in flight", async () => {
  const slow = deferred();
  try {
    registerProactiveBinding({ accountId: ACCOUNT, businessId: BUSINESS, runSweep: slow.run, intervalMs: 60_000 });
    const revoked = noteProactiveRevocation(ACCOUNT, "connection revoked by provider");
    assert.equal(revoked?.status, "degraded");
    assert.match(revoked?.lastError ?? "", /revoked/);
    const ticked = await tickBinding(ACCOUNT);
    assert.equal(ticked.ok, false, "revoked bindings do not run");
    // Fresh binding stops cleanly while a sweep is in flight.
    resetProactiveAutomation();
    registerProactiveBinding({ accountId: ACCOUNT, businessId: BUSINESS, runSweep: slow.run, intervalMs: 60_000 });
    const pending = tickBinding(ACCOUNT);
    const stopped = await stopProactiveAccount(ACCOUNT);
    assert.equal(stopped?.status, "stopped");
    slow.release();
    const done = await pending;
    assert.equal(done.ok, true, "in-flight sweep drains before stop returns");
    assert.equal((await stopProactiveAccount("missing")) ?? null, null);
  } finally {
    resetProactiveAutomation();
  }
});

test("host adapter drives real intake plus due-work drain per account", async () => {
  const fx = fixture();
  try {
    const runtime = runtimeFor(fx, emptyHistory());
    const state = startProactiveAccount({ runtime, intervalMs: 60_000 });
    assert.equal(state.status, "running");
    assert.equal(state.accountId, ACCOUNT);
    const ticked = await tickBinding(ACCOUNT);
    assert.equal(ticked.ok, true);
    assert.equal(ticked.skippedOverlap, false);
    assert.equal(ticked.state?.totalRuns, 1);
    assert.equal(removeProactiveBinding(ACCOUNT), true);
  } finally {
    fx.cleanup();
  }
});

test("scheduler only invokes the injected sweep: no sends, approvals, or links", async () => {
  const calls: string[] = [];
  try {
    registerProactiveBinding({
      accountId: ACCOUNT, businessId: BUSINESS,
      runSweep: async () => { calls.push("sweep"); return { swept: true }; },
      intervalMs: 60_000,
    });
    await tickBinding(ACCOUNT);
    await tickBinding(ACCOUNT);
    assert.deepEqual(calls, ["sweep", "sweep"]);
  } finally {
    resetProactiveAutomation();
  }
});

// ---------- reviewed-defect regressions (D1-D4) ----------

test("refresh during an in-flight sweep keeps overlap protection, then sweeps again (no wedge)", async () => {
  const slow = deferred();
  try {
    registerProactiveBinding({ accountId: ACCOUNT, businessId: BUSINESS, runSweep: slow.run, intervalMs: 60_000 });
    const first = tickBinding(ACCOUNT);
    await new Promise((resolve) => setTimeout(resolve, 25));
    let secondRuns = 0;
    // Re-register mid-flight (host refresh): overlap protection must hold
    // against the still-running old sweep, and the old completion must not
    // wedge the fresh binding.
    const refreshed = registerProactiveBinding({
      accountId: ACCOUNT, businessId: BUSINESS,
      runSweep: async () => { secondRuns += 1; },
      intervalMs: 60_000,
    });
    assert.equal(refreshed.inFlight, true, "reports the shared in-flight latch honestly");
    const skipped = await tickBinding(ACCOUNT);
    assert.equal(skipped.skippedOverlap, true, "old sweep still holds the latch");
    slow.release();
    await first;
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Old sweep's completion cleared the SHARED latch and wrote nothing to
    // the new record — the refreshed binding sweeps normally.
    const next = await tickBinding(ACCOUNT);
    assert.equal(next.skippedOverlap, false);
    assert.equal(next.ok, true);
    assert.equal(secondRuns, 1);
    assert.equal(next.state?.totalRuns, 1, "old sweep's write was suppressed by the epoch bump");
    assert.equal(getProactiveBinding(ACCOUNT)?.inFlight, false);
  } finally {
    slow.release();
    resetProactiveAutomation();
  }
});

test("stop uses real elapsed time, not the injectable clock, and reports undrained work honestly", async () => {
  const slow = deferred();
  try {
    registerProactiveBinding({
      accountId: ACCOUNT, businessId: BUSINESS,
      runSweep: slow.run, intervalMs: 60_000,
      clock: () => 1000, // frozen business clock — must not govern the drain
    });
    const pending = tickBinding(ACCOUNT);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const startedAt = Date.now();
    // The sweep never releases before the bound: stop must still settle on
    // real elapsed time and report the undrained in-flight honestly.
    const stopped = await stopProactiveAccount(ACCOUNT, 150);
    assert.ok(Date.now() - startedAt < 5000, "bounded by real time, not the frozen clock");
    assert.equal(stopped?.status, "stopped");
    assert.equal(stopped?.inFlight, true, "undrained sweep is reported, not hidden");
    // Late completion after stop writes nothing to the stopped record.
    slow.release();
    await pending;
    const after = getProactiveBinding(ACCOUNT);
    assert.equal(after?.totalRuns, 0, "no late counters on a stopped binding");
    assert.equal(after?.lastRunAt, undefined);
    // A stopped binding never ticks again.
    const ticked = await tickBinding(ACCOUNT);
    assert.equal(ticked.ok, false);
    assert.equal(ticked.error, "no running binding");
  } finally {
    slow.release();
    resetProactiveAutomation();
  }
});

test("revocation during an in-flight sweep cannot be clobbered by its late completion", async () => {
  const slow = deferred();
  try {
    registerProactiveBinding({ accountId: ACCOUNT, businessId: BUSINESS, runSweep: slow.run, intervalMs: 60_000 });
    const pending = tickBinding(ACCOUNT);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const revoked = noteProactiveRevocation(ACCOUNT, "connection revoked by provider");
    assert.equal(revoked?.status, "degraded");
    slow.release();
    const done = await pending;
    // The late completion returns its result but writes nothing over the
    // revocation state.
    const state = getProactiveBinding(ACCOUNT);
    assert.equal(state?.status, "degraded", "late completion cannot resurrect the binding");
    assert.match(state?.lastError ?? "", /revoked/, "revocation error is not clobbered");
    assert.equal(state?.totalRuns, 0, "late counters are suppressed");
    assert.equal(done.ok, true);
  } finally {
    resetProactiveAutomation();
  }
});

test("health reports the real registered/running/degraded scheduler state per account", async () => {
  const fx = fixture();
  try {
    const runtime = runtimeFor(fx, emptyHistory());
    const { operatorHealth } = await import("../src/server/operator-runtime/index.ts");
    const unwired = operatorHealth(runtime);
    assert.equal(unwired.scheduler.registered, false);
    assert.equal(unwired.scheduler.status, "pending-registration");
    startProactiveAccount({ runtime, intervalMs: 60_000 });
    const running = operatorHealth(runtime);
    assert.equal(running.scheduler.registered, true);
    assert.equal(running.scheduler.status, "running");
    noteProactiveRevocation(ACCOUNT, "provider revoked");
    const degraded = operatorHealth(runtime);
    assert.equal(degraded.scheduler.status, "degraded");
  } finally {
    fx.cleanup();
  }
});

test("scoped listing never leaks bindings for unwired accounts", async () => {
  try {
    registerProactiveBinding({ accountId: "unwired-acct", businessId: "foreign-biz", runSweep: async () => {}, intervalMs: 60_000 });
    registerProactiveBinding({ accountId: ACCOUNT, businessId: BUSINESS, runSweep: async () => {}, intervalMs: 60_000 });
    const { listProactiveBindingsForAccounts } = await import("../src/server/operator-runtime/index.ts");
    const scoped = listProactiveBindingsForAccounts([ACCOUNT]);
    assert.deepEqual(scoped.map((b) => b.accountId), [ACCOUNT], "unwired account filtered out");
    const empty = listProactiveBindingsForAccounts([]);
    assert.deepEqual(empty, [], "no authorized accounts -> no entries");
    assert.equal(listProactiveBindings().length, 2, "raw map still holds both (route applies the scope)");
  } finally {
    resetProactiveAutomation();
  }
});

// ---------- second-review regressions (timer, overlap, stuck, rebind, scope) ----------

test("stop clears its drain timer when the sweep wins early", async () => {
  const slow = deferred();
  const live = new Map<unknown, number>();
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    const handle = realSet(fn, ms as number, ...(rest as []));
    live.set(handle, ms ?? 0);
    return handle;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle: unknown) => {
    live.delete(handle);
    return realClear(handle as never);
  }) as typeof clearTimeout;
  try {
    registerProactiveBinding({ accountId: ACCOUNT, businessId: BUSINESS, runSweep: slow.run, intervalMs: 60_000 });
    const pending = tickBinding(ACCOUNT);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const stopping = stopProactiveAccount(ACCOUNT, 60_000);
    slow.release();
    await pending;
    const stopped = await stopping;
    assert.equal(stopped?.status, "stopped");
    assert.equal(stopped?.inFlight, false);
    const lingering = [...live.values()].filter((ms) => ms >= 60_000);
    assert.deepEqual(lingering, [], "drained stop must not retain the full-bound timer");
  } finally {
    slow.release();
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
    resetProactiveAutomation();
  }
});

test("remove plus re-register never runs bodies concurrently", async () => {
  const slow = deferred();
  try {
    registerProactiveBinding({ accountId: ACCOUNT, businessId: BUSINESS, runSweep: slow.run, intervalMs: 60_000 });
    const oldSweep = tickBinding(ACCOUNT);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(removeProactiveBinding(ACCOUNT), true);
    let newCalls = 0;
    registerProactiveBinding({
      accountId: ACCOUNT, businessId: BUSINESS,
      runSweep: async () => { newCalls += 1; },
      intervalMs: 60_000,
    });
    // The removed lifecycle's body is still unsettled: the fresh binding
    // must skip, not overlap it.
    const skipped = await tickBinding(ACCOUNT);
    assert.equal(skipped.skippedOverlap, true);
    assert.equal(newCalls, 0, "no concurrent body while the old one runs");
    slow.release();
    await oldSweep;
    const next = await tickBinding(ACCOUNT);
    assert.equal(next.skippedOverlap, false);
    assert.equal(newCalls, 1, "fresh body runs once the old one settles");
  } finally {
    slow.release();
    resetProactiveAutomation();
  }
});

test("a never-settling sweep is declared stuck, never forever running", async () => {
  let release!: () => void;
  const stuck = new Promise<void>((resolve) => { release = resolve; });
  try {
    registerProactiveBinding({
      accountId: ACCOUNT, businessId: BUSINESS,
      runSweep: () => stuck, intervalMs: 60_000, maxSweepMs: 150,
    });
    const pending = tickBinding(ACCOUNT);
    pending.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 400));
    const state = getProactiveBinding(ACCOUNT);
    assert.equal(state?.status, "degraded");
    assert.match(state?.lastError ?? "", /stuck/);
    assert.equal(state?.inFlight, true, "ownership retained on the stuck body");
    const ticked = await tickBinding(ACCOUNT);
    assert.equal(ticked.ok, false, "stuck binding runs nothing more");
    release();
    await pending;
    const after = getProactiveBinding(ACCOUNT);
    assert.equal(after?.status, "degraded", "late completion keeps the tombstone");
    assert.equal(after?.totalRuns, 0, "late completion writes no counters");
  } finally {
    release();
    resetProactiveAutomation();
  }
});

test("rebinding an account to another business is rejected while owned", async () => {
  try {
    registerProactiveBinding({ accountId: ACCOUNT, businessId: BUSINESS, runSweep: async () => {}, intervalMs: 60_000 });
    assert.throws(
      () => registerProactiveBinding({ accountId: ACCOUNT, businessId: "other-biz", runSweep: async () => {}, intervalMs: 60_000 }),
      /belongs to business/,
    );
    const kept = getProactiveBinding(ACCOUNT);
    assert.equal(kept?.businessId, BUSINESS);
    assert.equal(kept?.status, "running");
    // After an explicit remove the account is free to rebind elsewhere.
    assert.equal(removeProactiveBinding(ACCOUNT), true);
    const moved = registerProactiveBinding({ accountId: ACCOUNT, businessId: "other-biz", runSweep: async () => {}, intervalMs: 60_000 });
    assert.equal(moved.businessId, "other-biz");
  } finally {
    resetProactiveAutomation();
  }
});

test("health scopes waiting and paused aggregates to the calling business", async () => {
  const fx = fixture();
  try {
    const other = fx.store.createBusiness({ name: "Foreign Hall", timezone: "UTC" });
    const otherBooking = fx.store.createBooking({ businessId: other.id, eventName: "Foreign inquiry", sourceReferences: [] });
    fx.ledger.ingestEvent({ dedupeKey: "foreign-inq", kind: "inquiry", bookingId: otherBooking.id, sourceId: "t", sourceKind: "email", observedAt: NOW });
    const pausedBooking = fx.store.createBooking({ businessId: other.id, eventName: "Foreign paused", sourceReferences: [] });
    fx.ledger.applyOwnerControl({ dedupeKey: "foreign-pause", kind: "pause", bookingId: pausedBooking.id, attestedBy: "test-owner", observedAt: NOW });
    const runtime = runtimeFor(fx, emptyHistory());
    const { operatorHealth } = await import("../src/server/operator-runtime/index.ts");
    const health = operatorHealth(runtime);
    assert.deepEqual(health.waitingByStatus, {}, "foreign waiting must not leak into this business health");
    assert.deepEqual(health.pausedBookings, [], "foreign paused bookings must not leak");
  } finally {
    fx.cleanup();
  }
});
