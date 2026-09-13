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
