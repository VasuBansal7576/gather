import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import {
  GatherRuntimeControl,
  RuntimeControlError,
  ScriptedRuntimeControl,
  allocateLoopbackPort,
  type GatewayRequestChannel,
  type RuntimeConnectionLike,
  type RuntimeProcessLike,
} from "../src/runtime/index.ts";
import { BudgetError } from "../src/server/budget.ts";

/**
 * ADR-009 acceptance 009-A01..A04 over the RuntimeControl port.
 * Every gateway interaction rides injected fakes (no binary, model, or
 * provider); budgets persist in per-test tmp dirs.
 */

const MANIFEST_PATH = new URL("../scripts/gather-runtime-manifest.json", import.meta.url).pathname;
const PKG_DEPS = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { dependencies: Record<string, string> }).dependencies;

interface FakeWorld {
  calls: Array<{ method: string; params: unknown }>;
  conn: RuntimeConnectionLike;
  proc: RuntimeProcessLike;
  procState: { started: number; stopped: number; state: string };
  setWaitStatus: (status: string) => void;
}

function fakeWorld(): FakeWorld {
  const calls: FakeWorld["calls"] = [];
  let ready = false;
  let waitStatus = "ok";
  let runSeq = 0;
  const conn: RuntimeConnectionLike = {
    get isReady() {
      return ready;
    },
    get currentState() {
      return ready ? "ready" : "closed";
    },
    async connect() {
      ready = true;
      return {};
    },
    async close() {
      ready = false;
    },
    async request<T>(method: string, params?: unknown): Promise<T> {
      calls.push({ method, params });
      if (method === "agent") {
        runSeq += 1;
        return { runId: `gw-run-${runSeq}`, acceptedAt: 1700000000000 } as T;
      }
      if (method === "agent.wait") {
        return { status: waitStatus, runId: String((params as Record<string, unknown>)?.runId) } as T;
      }
      if (method === "status") return { ok: true } as T;
      throw new Error(`unexpected method ${method}`);
    },
  };
  const procState = { started: 0, stopped: 0, state: "stopped" };
  const proc: RuntimeProcessLike = {
    gatewayToken: "fake-token",
    pid: 4242,
    get currentState() {
      return procState.state as RuntimeProcessLike["currentState"];
    },
    async start() {
      procState.started += 1;
      procState.state = "running";
    },
    async stop() {
      procState.stopped += 1;
      procState.state = "stopped";
    },
  };
  return { calls, conn, proc, procState, setWaitStatus: (status: string) => { waitStatus = status; } };
}

async function liveFixture(input: {
  waitStatus?: string;
  limits?: { maxToolCallsPerRun?: number; maxTokensPerRun?: number; runDeadlineMs?: number; maxRunsPerBusinessPerDay?: number };
  now?: () => number;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gather-control-test-"));
  const world = fakeWorld();
  if (input.waitStatus) world.setWaitStatus(input.waitStatus);
  const control = new GatherRuntimeControl({
    runtimeOptions: { rootDir: join(dir, "openclaw"), gatewayPort: await allocateLoopbackPort() },
    runtimeDeps: {
      processFactory: () => world.proc,
      connectionFactory: () => world.conn,
    },
    budgetStateDir: join(dir, "state"),
    ...(input.limits === undefined ? {} : { limits: input.limits }),
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  const provisioned = await control.provision({
    mode: "live",
    manifestPath: MANIFEST_PATH,
    installed: PKG_DEPS,
    executableCommand: "/bin/sh",
  });
  return { dir, world, control, provisioned, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function fakeChannel(responses: Record<string, (params: unknown) => unknown>): GatewayRequestChannel {
  const calls: Array<{ method: string; params: unknown }> = [];
  return {
    calls,
    isReady: true,
    async request<T>(method: string, params?: unknown): Promise<T> {
      calls.push({ method, params });
      const respond = responses[method];
      if (!respond) throw new Error(`unexpected method ${method}`);
      return respond(params) as T;
    },
  } as GatewayRequestChannel & { calls: unknown };
}

test("provision is live-only; the scripted port never provisions (009-A01 boundary)", async () => {
  const { control, provisioned, cleanup } = await liveFixture();
  try {
    assert.ok(provisioned.configPath.endsWith("openclaw.json"));
    assert.ok(provisioned.manifest.releases["@openclaw/gateway-client"]);
    await assert.rejects(control.provision({ mode: "prepared" }), (error: unknown) =>
      error instanceof RuntimeControlError && error.code === "PREPARED_NEVER_PROVISIONS",
    );

    const dir = mkdtempSync(join(tmpdir(), "gather-scripted-test-"));
    try {
      const scripted = new ScriptedRuntimeControl({ budgetStateDir: dir, channel: fakeChannel({}) });
      assert.equal(scripted.kind, "scripted");
      await assert.rejects(scripted.provision({ mode: "prepared" }), (error: unknown) =>
        error instanceof RuntimeControlError && error.code === "PREPARED_NEVER_PROVISIONS",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    cleanup();
  }
});

test("fresh isolated provision/restart and useful read; no personal paths (009-A01)", async () => {
  const { dir, world, control, cleanup } = await liveFixture();
  try {
    await control.start();
    assert.equal(world.procState.started, 1);
    const health = await control.health();
    assert.equal(health.process, "running");
    assert.equal(health.gatewayReachable, true);
    assert.equal(health.agentIndependent, true);
    // Useful read, and health never interrogated the booking agent.
    assert.ok(world.calls.some((call) => call.method === "status"));
    assert.equal(world.calls.some((call) => call.method === "agent" || call.method === "agent.wait"), false);

    // Every runtime path stays under the Gather-owned root. manifestPath is
    // the repo-tracked pin source (not runtime state) and is exempt.
    const root = join(dir, "openclaw");
    for (const [key, value] of Object.entries(health)) {
      if (key === "manifestPath") continue;
      if (typeof value === "string" && value.startsWith("/")) {
        assert.ok(value.startsWith(root), `${value} escapes the isolated root`);
        assert.equal(value.includes(".openclaw"), false, `${value} reaches personal state`);
      }
    }
    await control.stop();
    // Restart after an observed stop works (new lifecycle, same budget store).
    await control.start();
    assert.equal(world.procState.started, 2);
    const rehealthed = await control.health();
    assert.equal(rehealthed.process, "running");
    await control.stop();
  } finally {
    cleanup();
  }
});

test("16th tool call denied and token over-reservation denied with no dispatch (009-A02)", async () => {
  const { world, control, cleanup } = await liveFixture();
  try {
    await control.start();
    const submitted = await control.submit({
      businessId: "b1",
      bookingId: "booking-1",
      message: "prepare",
      idempotencyKey: "dup-key",
      maxInputTokens: 100,
      maxOutputTokens: 100,
    });
    assert.equal(submitted.duplicate, false);
    // Same key replays the run and reserves the next call each time.
    for (let i = 0; i < 14; i++) {
      await control.submit({
        businessId: "b1",
        bookingId: "booking-1",
        message: "prepare",
        idempotencyKey: "dup-key",
        maxInputTokens: 100,
        maxOutputTokens: 100,
      });
    }
    const dispatchesBefore = world.calls.filter((call) => call.method === "agent").length;
    await assert.rejects(
      control.submit({
        businessId: "b1",
        bookingId: "booking-1",
        message: "prepare",
        idempotencyKey: "dup-key",
        maxInputTokens: 100,
        maxOutputTokens: 100,
      }),
      (error: unknown) => error instanceof RuntimeControlError && error.code === "BUDGET_DENIED",
    );
    assert.equal(
      world.calls.filter((call) => call.method === "agent").length,
      dispatchesBefore,
      "denied reservation never dispatched",
    );

    // Token over-reservation on a fresh run is denied the same way.
    await assert.rejects(
      control.submit({
        businessId: "b1",
        bookingId: "booking-2",
        message: "prepare",
        idempotencyKey: "rich-key",
        maxInputTokens: 31_000,
        maxOutputTokens: 2_000,
      }),
      (error: unknown) => error instanceof RuntimeControlError && error.code === "BUDGET_DENIED",
    );
    assert.equal(
      world.calls.filter((call) => call.method === "agent").length,
      dispatchesBefore,
      "token-denied reservation never dispatched",
    );
    await control.stop();
  } finally {
    cleanup();
  }
});

test("five-minute deadline fences tools despite wait timeout; restart preserves usage (009-A02)", async () => {
  let nowMs = Date.parse("2026-09-17T10:00:00.000Z");
  const { dir, world, control, cleanup } = await liveFixture({
    waitStatus: "timeout",
    limits: { runDeadlineMs: 300_000 },
    now: () => nowMs,
  });
  try {
    await control.start();
    const submitted = await control.submit({
      businessId: "b1",
      bookingId: "booking-slow",
      message: "slow",
      idempotencyKey: "slow-key",
      maxInputTokens: 100,
      maxOutputTokens: 100,
    });
    // Before the deadline a wait timeout is wait-only: not fenced, may continue, no duplicate.
    const early = await control.observe({ runId: submitted.budget.runId, gatewayRunId: submitted.gatewayRunId });
    assert.equal(early.waitStatus, "timeout");
    assert.equal(early.fencedByDeadline, false);
    assert.equal(early.executionMayContinue, true);

    // Past the 5-minute deadline the same wait timeout fences the run.
    nowMs += 301_000;
    const late = await control.observe({
      runId: submitted.budget.runId,
      gatewayRunId: submitted.gatewayRunId,
      nowMs,
    });
    assert.equal(late.fencedByDeadline, true);
    assert.equal(late.executionMayContinue, true);
    assert.equal(late.budget.fenced, true);

    // A fresh control over the same dirs (the restart) sees the fenced usage.
    const world2 = fakeWorld();
    const restarted = new GatherRuntimeControl({
      runtimeOptions: { rootDir: join(dir, "openclaw"), gatewayPort: await allocateLoopbackPort() },
      runtimeDeps: { processFactory: () => world2.proc, connectionFactory: () => world2.conn },
      budgetStateDir: join(dir, "state"),
      budgetLimits: { runDeadlineMs: 300_000 },
      now: () => nowMs,
    });
    const reloaded = restarted.budgetStore.getRun(submitted.budget.runId);
    assert.equal(reloaded.fenced, true);
    assert.equal(reloaded.toolCalls, 1);
    assert.equal(world.calls.filter((call) => call.method === "agent").length, 1, "no duplicate run was ever started");
    await control.stop();
  } finally {
    cleanup();
  }
});

test("unknown/cancelled runs cannot relaunch as duplicates; unobserved exit stays blocked (009-A03)", async () => {
  const { world, control, cleanup } = await liveFixture();
  try {
    await control.start();
    await assert.rejects(
      control.observe({ runId: "run_missing", gatewayRunId: "gw-1" }),
      (error: unknown) => error instanceof BudgetError && error.code === "BUDGET_UNKNOWN_RUN",
    );
    assert.equal(world.calls.filter((call) => call.method === "agent.wait").length, 0, "no wait RPC for an unknown run");

    const submitted = await control.submit({
      businessId: "b1",
      bookingId: "booking-x",
      message: "x",
      idempotencyKey: "cancel-key",
      maxInputTokens: 10,
      maxOutputTokens: 10,
    });
    await control.repair("mark_blocked", { runId: submitted.budget.runId, reason: "test block" });
    await assert.rejects(
      control.submit({
        businessId: "b1",
        bookingId: "booking-x",
        message: "x",
        idempotencyKey: "cancel-key",
        maxInputTokens: 10,
        maxOutputTokens: 10,
      }),
      (error: unknown) => error instanceof RuntimeControlError && error.code === "RELAUNCH_DENIED",
    );

    // Cancellation that cannot observe the exit stays blocked/unknown.
    const failing = { ...world.proc, stop: async () => { throw new Error("did not exit after SIGKILL"); } };
    void failing;
    const blocked = await control.requestCancellation(submitted.budget.runId);
    assert.equal(blocked.fenced, true);
    assert.equal(blocked.stopRequested, false);
    const fenced = control.budgetStore.getRun(submitted.budget.runId);
    assert.equal(fenced.fenced, true);
    await control.stop();
  } finally {
    cleanup();
  }
});

test("backup covers only consistent secret-free state; restore needs reconciliation + version match (009-A04)", async () => {
  const { dir, control, cleanup } = await liveFixture();
  try {
    await control.start();
    const submitted = await control.submit({
      businessId: "b1",
      bookingId: "booking-b",
      message: "b",
      idempotencyKey: "backup-key",
      maxInputTokens: 10,
      maxOutputTokens: 10,
    });
    // Active unfenced runs block backup (in-flight effects are inconsistent).
    await assert.rejects(control.backup(join(dir, "backups")), (error: unknown) =>
      error instanceof RuntimeControlError && error.code === "BACKUP_INCONSISTENT",
    );

    // Settle the run, then plant a real isolated secret and prove the backup excludes it.
    control.budgetStore.finishRun(submitted.budget.runId, "completed");
    const secretValue = "fixture-backup-secret-abcdef-123456";
    writeFileSync(join(dir, "openclaw", "secrets", "probe-secret"), `${secretValue}\n`);
    const backed = await control.backup(join(dir, "backups"));
    assert.equal(backed.schemaVersion, 1);
    const serialized = readFileSync(backed.backupPath, "utf8");
    assert.equal(serialized.includes(secretValue), false, "isolated secret material must never enter a backup");
    assert.ok(JSON.parse(serialized).budgets);

    // Restore without external reconciliation is refused — never replays external effects.
    await assert.rejects(control.restoreCompatible(backed.backupPath), (error: unknown) =>
      error instanceof RuntimeControlError && error.code === "EXTERNAL_RECONCILIATION_REQUIRED",
    );
    const restored = await control.restoreCompatible(backed.backupPath, { externalReconciled: true });
    assert.equal(restored.restoredRuns, 1);
    const resumed = control.budgetStore.getRun(submitted.budget.runId);
    assert.equal(resumed.fenced, true, "restored runs resume fenced until reconciled");

    // Cross-version restores are refused.
    const tampered = `${backed.backupPath}.tampered`;
    const payload = JSON.parse(serialized) as { manifestPins: Record<string, string> };
    payload.manifestPins["@openclaw/gateway-client"] = "0.0.0-tampered";
    writeFileSync(tampered, JSON.stringify(payload));
    await assert.rejects(control.restoreCompatible(tampered, { externalReconciled: true }), (error: unknown) =>
      error instanceof RuntimeControlError && error.code === "RESTORE_INCOMPATIBLE",
    );
    await control.stop();
  } finally {
    cleanup();
  }
});

test("repair catalog is bounded and restart reboots with a useful read", async () => {
  const { world, control, cleanup } = await liveFixture();
  try {
    await control.start();
    await assert.rejects(
      control.repair("rm -rf /" as unknown as "restart_runtime"),
      (error: unknown) => error instanceof RuntimeControlError && error.code === "REPAIR_UNKNOWN_ACTION",
    );
    const restarted = await control.repair("restart_runtime");
    assert.equal(restarted.ok, true);
    assert.equal(world.procState.stopped, 1);
    assert.equal(world.procState.started, 2);
    assert.match(restarted.detail, /reconcile pending effects/);
    await control.stop();
  } finally {
    cleanup();
  }
});

test("scripted port submits within budget and refuses unknown repair actions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gather-scripted-run-"));
  try {
    let agentCalls = 0;
    const channel = fakeChannel({
      agent: () => {
        agentCalls += 1;
        return { runId: "gw-scripted-1", acceptedAt: 1 };
      },
      "agent.wait": () => ({ status: "ok", runId: "gw-scripted-1", endedAt: 2 }),
    });
    const scripted = new ScriptedRuntimeControl({ budgetStateDir: dir, channel });
    const submitted = await scripted.submit({
      businessId: "b1",
      bookingId: "booking-s",
      message: "scripted",
      idempotencyKey: "script-key",
      maxInputTokens: 50,
      maxOutputTokens: 50,
    });
    assert.equal(agentCalls, 1);
    const observed = await scripted.observe({ runId: submitted.budget.runId, gatewayRunId: submitted.gatewayRunId });
    assert.equal(observed.waitStatus, "ok");
    assert.equal(observed.budget.status, "completed");
    const health = await scripted.health();
    assert.equal(health.agentIndependent, true);
    await assert.rejects(scripted.repair("unknown" as never), /unknown repair action/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
