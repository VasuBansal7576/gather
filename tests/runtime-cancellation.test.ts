import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import assert from "node:assert/strict";
import test from "node:test";
import {
  GatherOpenClawRuntime,
  OpenClawGatewayProcess,
  allocateLoopbackPort,
  ensureLayoutDirectories,
  resolveGatherOpenClawLayout,
  type SpawnLike,
} from "../src/runtime/index.ts";

// Cancellation lifecycle: every wait bounded, ownership preserved on
// unobserved exits, no respawn after cancellation. Fake children only —
// nothing here binds ports or spawns a binary, so these tests cannot clash
// with a concurrently finishing live-gateway run.

let layoutCounter = 0;

function fixtureLayout() {
  const directory = mkdtempSync(join(tmpdir(), "gather-cancel-test-"));
  const port = 32000 + ((process.pid + layoutCounter++) % 20000);
  return {
    directory,
    layout: resolveGatherOpenClawLayout({ rootDir: join(directory, "openclaw"), port }),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

/** Fake child with controllable signal handling for adversarial cases. */
class StubbornChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 4242;
  killed: string[] = [];
  exitOnSignal: boolean;
  killThrows: boolean;

  constructor(opts: { exitOnSignal?: boolean; killThrows?: boolean } = {}) {
    super();
    this.exitOnSignal = opts.exitOnSignal ?? true;
    this.killThrows = opts.killThrows ?? false;
  }

  kill(signal: string): boolean {
    this.killed.push(signal);
    if (this.killThrows) throw new Error(`kill ${signal} ESRCH (fake delivery failure)`);
    if (this.exitOnSignal) queueMicrotask(() => this.emit("exit", 0, signal));
    return true;
  }
}

/** Gateway exits 78 immediately; the repair child is scripted per test. */
function repairWorld(doctor: StubbornChild, repairTimeoutMs: number) {
  const spawned: string[][] = [];
  const spawnFn = ((command: string, args: string[]) => {
    spawned.push(args);
    if (args.includes("doctor")) return doctor;
    const gateway = new StubbornChild({});
    queueMicrotask(() => gateway.emit("exit", 78, null));
    return gateway;
  }) as unknown as SpawnLike;
  return { spawnFn, spawned };
}

test("a repair that never exits rejects bounded with ownership kept", async () => {
  const { layout, cleanup } = fixtureLayout();
  try {
    ensureLayoutDirectories(layout);
    const doctor = new StubbornChild({ exitOnSignal: false }); // ignores TERM/KILL, never exits
    const { spawnFn } = repairWorld(doctor, 150);
    const proc = new OpenClawGatewayProcess(
      { layout, executable: { command: "/bin/sh" } },
      { spawnFn, skipExecutableVerification: true, repairTimeoutMs: 150 },
    );
    const startedAt = Date.now();
    await assert.rejects(proc.start(), /did not exit after SIGKILL/);
    assert.ok(Date.now() - startedAt < 20000, "no-exit repair still settles start()");
    assert.equal(proc.currentState, "failed");
    // Ownership kept: a follow-up stop re-signals the tracked child instead
    // of reporting stopped, and stays bounded itself.
    const killsBefore = doctor.killed.length;
    await assert.rejects(proc.stop(200, 200), /did not exit after SIGKILL/);
    assert.ok(doctor.killed.length > killsBefore, "tracked repair child is reaped again, never released unseen");
    assert.equal(proc.currentState, "failed");
    assert.notEqual(proc.currentState, "stopped");
  } finally {
    cleanup();
  }
});

test("a repair kill-delivery failure preserves the live child", async () => {
  const { layout, cleanup } = fixtureLayout();
  try {
    ensureLayoutDirectories(layout);
    const doctor = new StubbornChild({ exitOnSignal: false, killThrows: true });
    const { spawnFn } = repairWorld(doctor, 60000);
    const proc = new OpenClawGatewayProcess(
      { layout, executable: { command: "/bin/sh" } },
      { spawnFn, skipExecutableVerification: true, repairTimeoutMs: 60000 },
    );
    const starting = proc.start();
    starting.catch(() => {});
    while (proc.currentState !== "repairing") {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    }
    // Kill delivery fails while the child is alive: start() rejects, but the
    // live child must stay tracked for stop() — never cleared by the error.
    doctor.emit("error", new Error("kill SIGTERM ESRCH (fake delivery failure)"));
    await assert.rejects(starting, /ESRCH/);
    const killsBefore = doctor.killed.length;
    await assert.rejects(proc.stop(200, 200), /did not exit after SIGKILL/);
    assert.ok(doctor.killed.length > killsBefore, "stop() still reaches the live repair child");
    assert.notEqual(proc.currentState, "stopped");
  } finally {
    cleanup();
  }
});

test("stop() during repair aborts the retry without respawn", async () => {
  const { layout, cleanup } = fixtureLayout();
  try {
    ensureLayoutDirectories(layout);
    const doctor = new StubbornChild({});
    const { spawnFn, spawned } = repairWorld(doctor, 60000);
    const proc = new OpenClawGatewayProcess(
      { layout, executable: { command: "/bin/sh" } },
      { spawnFn, skipExecutableVerification: true, repairTimeoutMs: 60000 },
    );
    const starting = proc.start();
    while (proc.currentState !== "repairing") {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    }
    await proc.stop(500, 200);
    await assert.rejects(starting, /after doctor repair/);
    assert.equal(spawned.length, 2, "gateway + repair only: no respawn after cancellation");
    assert.ok(["stopped", "failed"].includes(proc.currentState));
  } finally {
    cleanup();
  }
});

test("a late exit after kept ownership releases tracking cleanly", async () => {
  const { layout, cleanup } = fixtureLayout();
  try {
    ensureLayoutDirectories(layout);
    const doctor = new StubbornChild({ exitOnSignal: false });
    const { spawnFn } = repairWorld(doctor, 60000);
    const proc = new OpenClawGatewayProcess(
      { layout, executable: { command: "/bin/sh" } },
      { spawnFn, skipExecutableVerification: true, repairTimeoutMs: 60000 },
    );
    const starting = proc.start();
    while (proc.currentState !== "repairing") {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    }
    await assert.rejects(proc.stop(200, 200), /did not exit after SIGKILL/);
    // The child finally exits: tracking releases, the pending start aborts
    // without respawn, and a follow-up stop reports stopped.
    doctor.emit("exit", 0, "SIGKILL");
    await assert.rejects(starting, /after doctor repair/);
    await proc.stop(200, 200);
    assert.equal(proc.currentState, "stopped");
  } finally {
    cleanup();
  }
});

test("facade stop() during a hung repair settles bounded with no respawn", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gather-cancel-facade-"));
  try {
    const port = await allocateLoopbackPort();
    let spawns = 0;
    const spawnFn = ((command: string, args: string[]) => {
      spawns += 1;
      if (args.includes("doctor")) return new StubbornChild({ exitOnSignal: false });
      const gateway = new StubbornChild({});
      queueMicrotask(() => gateway.emit("exit", 78, null));
      return gateway;
    }) as unknown as SpawnLike;
    const runtime = new GatherOpenClawRuntime(
      { rootDir: join(directory, "openclaw"), gatewayPort: port },
      {
        processFactory: (opts) =>
          new OpenClawGatewayProcess(
            { layout: opts.layout, executable: { command: "/bin/sh" }, log: opts.log },
            { spawnFn, skipExecutableVerification: true, repairTimeoutMs: 200 },
          ),
        connectionFactory: () => {
          throw new Error("must never connect while the repair hangs");
        },
      },
    );
    const starting = runtime.start();
    starting.catch(() => {});
    // Wait until the repair child is actually in flight: prompt cancellation
    // before it spawns would abort startup earlier, which is NOT this test.
    while (runtime.state.process !== "repairing") {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    }
    const startedAt = Date.now();
    await assert.rejects(runtime.stop(), /did not exit after SIGKILL/);
    assert.ok(Date.now() - startedAt < 45000, "facade cancellation settles bounded");
    await assert.rejects(starting, /did not exit after SIGKILL/);
    assert.equal(spawns, 2, "gateway + repair only: no respawn after cancellation");
    assert.notEqual(runtime.state.process, "stopped");
    // A later stop() still settles bounded instead of hanging.
    await assert.rejects(runtime.stop(), /did not exit after SIGKILL/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// ---------- R1-R3: ownership/cancellation gap regressions ----------

test("facade stop() during a SUCCEEDING repair aborts the respawn promptly (R1)", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gather-cancel-r1-"));
  try {
    const port = await allocateLoopbackPort();
    let gatewaySpawns = 0;
    const spawnFn = ((command: string, args: string[]) => {
      if (args.includes("doctor")) {
        const doctor = new StubbornChild({});
        // Repair SUCCEEDS after 150ms — under the old code the facade
        // waited for startPromise first, so the gateway respawned before
        // stop() ever ran. Now stop() must reach the tracked repair
        // promptly and prevent the respawn.
        setTimeout(() => doctor.emit("exit", 0, null), 150);
        return doctor;
      }
      gatewaySpawns += 1;
      const gateway = new StubbornChild({});
      queueMicrotask(() => gateway.emit("exit", 78, null));
      return gateway;
    }) as unknown as SpawnLike;
    const runtime = new GatherOpenClawRuntime(
      { rootDir: join(directory, "openclaw"), gatewayPort: port },
      {
        processFactory: (opts) =>
          new OpenClawGatewayProcess(
            { layout: opts.layout, executable: { command: "/bin/sh" }, log: opts.log },
            { spawnFn, skipExecutableVerification: true, repairTimeoutMs: 60000 },
          ),
        connectionFactory: () => {
          throw new Error("must never connect after cancellation");
        },
      },
    );
    const starting = runtime.start();
    starting.catch(() => {});
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50)); // repair in flight
    const startedAt = Date.now();
    await runtime.stop();
    assert.ok(Date.now() - startedAt < 10000, "stop cancelled promptly, not after the repair deadline");
    await assert.rejects(starting, /stop requested during doctor repair|doctor --fix failed/);
    assert.equal(gatewaySpawns, 1, "no respawn after cancellation — public facade path");
    assert.equal(runtime.state.process, "stopped");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("facade stop() kills a hung repair promptly instead of waiting its deadline (R1)", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gather-cancel-r1b-"));
  try {
    const port = await allocateLoopbackPort();
    const spawnFn = ((command: string, args: string[]) => {
      if (args.includes("doctor")) return new StubbornChild({}); // exits on SIGKILL
      const gateway = new StubbornChild({});
      queueMicrotask(() => gateway.emit("exit", 78, null));
      return gateway;
    }) as unknown as SpawnLike;
    const runtime = new GatherOpenClawRuntime(
      { rootDir: join(directory, "openclaw"), gatewayPort: port },
      {
        processFactory: (opts) =>
          new OpenClawGatewayProcess(
            { layout: opts.layout, executable: { command: "/bin/sh" }, log: opts.log },
            { spawnFn, skipExecutableVerification: true, repairTimeoutMs: 60000 },
          ),
        connectionFactory: () => {
          throw new Error("must never connect while repair is cancelled");
        },
      },
    );
    const starting = runtime.start();
    starting.catch(() => {});
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    const startedAt = Date.now();
    await runtime.stop();
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 10000, `stop settled in ${elapsed}ms — the repair child was killed promptly, not after 60s+grace`);
    await assert.rejects(starting);
    assert.equal(runtime.state.process, "stopped");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("concurrent start() during repair is rejected and cannot overwrite the owned child (R2)", async () => {
  const { layout, cleanup } = fixtureLayout();
  try {
    ensureLayoutDirectories(layout);
    const doctor = new StubbornChild({});
    let gatewaySpawns = 0;
    const spawnFn = ((command: string, args: string[]) => {
      if (args.includes("doctor")) return doctor;
      gatewaySpawns += 1;
      const gateway = new StubbornChild({});
      queueMicrotask(() => gateway.emit("exit", 78, null));
      return gateway;
    }) as unknown as SpawnLike;
    const proc = new OpenClawGatewayProcess(
      { layout, executable: { command: "/bin/sh" } },
      { spawnFn, skipExecutableVerification: true, repairTimeoutMs: 60000 },
    );
    const starting = proc.start();
    starting.catch(() => {});
    while (proc.currentState !== "repairing") {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    }
    await assert.rejects(proc.start(), /already repairing/);
    await proc.stop(500, 200);
    await assert.rejects(starting, /doctor --fix failed|stop requested/);
    assert.equal(gatewaySpawns, 1, "no second spawn, no clobbered child tracking");
  } finally {
    cleanup();
  }
});

test("start() after a failed stop refuses until the owned child exits; late exit frees it (R3)", async () => {
  const { layout, cleanup } = fixtureLayout();
  try {
    ensureLayoutDirectories(layout);
    const gateways: StubbornChild[] = [];
    const spawnFn = (() => {
      const gateway = new StubbornChild({ exitOnSignal: false });
      gateways.push(gateway);
      return gateway;
    }) as unknown as SpawnLike;
    const proc = new OpenClawGatewayProcess(
      { layout, executable: { command: "/bin/sh" } },
      { spawnFn, skipExecutableVerification: true },
    );
    const starting = proc.start();
    starting.catch(() => {});
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1700)); // past early-exit window -> running
    await starting;
    assert.equal(proc.currentState, "running");
    // stop() cannot reap a child that never exits: failed, ownership kept.
    await assert.rejects(proc.stop(100, 100), /did not exit after SIGKILL/);
    assert.equal(proc.currentState, "failed");
    // Restart must REFUSE while the possibly-live child is still owned —
    // never overwrite the tracked reference into an orphan.
    await assert.rejects(proc.start(), /still owned without an observed exit/);
    assert.equal(gateways.length, 1, "no respawn while the old child is owned");
    // The observed exit releases ownership; a new start is then allowed.
    gateways[0].emit("exit", 137, "SIGKILL");
    const restarted = proc.start();
    await restarted;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1700));
    assert.equal(proc.currentState, "running");
    assert.equal(gateways.length, 2);
    // A redundant late 'exit' on the old generation cannot clear the new
    // child's ownership (generational guard).
    gateways[0].emit("exit", 0, null);
    assert.equal(proc.currentState, "running", "stale generation exit cannot disturb the new child");
    gateways[1].emit("exit", 0, "cleanup");
    await proc.stop(200, 200);
  } finally {
    cleanup();
  }
});
