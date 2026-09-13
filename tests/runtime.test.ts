import { EventEmitter } from "node:events";
import { execFileSync, spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import {
  GatherGatewayConnection,
  GatherMcpBoundary,
  GatherOpenClawRuntime,
  GatherRuntimeTasks,
  GatewayRequestFailed,
  OpenClawGatewayProcess,
  allocateLoopbackPort,
  bookingSessionKey,
  buildGatewayChildEnv,
  buildGatewayConfig,
  checkLoopbackPortOccupied,
  defineGatherTool,
  ensureLayoutDirectories,
  resolveGatherOpenClawLayout,
  resolveOpenClawExecutable,
  stableTaskIdempotencyKey,
  writeGatewayConfig,
  type GatewayTransport,
  type SpawnLike,
  type RuntimeProcessLike,
  type RuntimeConnectionLike,
  type RuntimeMcpBoundaryLike,
} from "../src/runtime/index.ts";
import type { GatewayClientOptions } from "@openclaw/gateway-client";

// All fixtures are fictional/simulated; nothing here is a verified integration.

const TEST_MCP_TOKEN = "gather-mcp-test-token-0123456789abcdef";

// No fixed loopback ports anywhere in this file: every bound port is
// OS-allocated per run (bind 127.0.0.1:0). A "free" probe result only reduces
// collision probability — the eventual bind is authoritative (TOCTOU
// remains), which the occupied-port regressions below exercise directly.
function fixtureLayout() {
  const directory = mkdtempSync(join(tmpdir(), "gather-runtime-test-"));
  // Config/env-only fixture: this port is never bound here, so a per-run
  // unique placeholder (pid + counter) suffices; real binds always use
  // freeLoopbackPort() below.
  const port = 32000 + ((process.pid + fixturePortCounter++) % 20000);
  return {
    layout: resolveGatherOpenClawLayout({ rootDir: join(directory, "openclaw"), port }),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}
let fixturePortCounter = 0;

/** OS-allocate a currently-free loopback port (bind 127.0.0.1:0, release). */
async function freeLoopbackPort(): Promise<number> {
  return allocateLoopbackPort();
}

/** Hold a loopback port with a real listener (simulates a foreign occupant). */
async function holdLoopbackPort(port: number, host = "127.0.0.1"): Promise<Server> {
  const server = createServer();
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(port, host, () => resolvePromise());
  });
  return server;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
}

/**
 * Explicit absolute binary for real-boot tests. The task host provides
 * /opt/homebrew/bin/openclaw; `which` is only a fallback because PATH can
 * differ per launcher. Never declare "not installed" from PATH alone.
 */
function resolveTestBinary(): string | null {
  const explicit = "/opt/homebrew/bin/openclaw";
  try {
    if (existsSync(explicit)) return explicit;
  } catch {
    // fall through to which
  }
  try {
    const found = execFileSync("which", ["openclaw"], { encoding: "utf8" }).trim();
    return found || null;
  } catch {
    return null;
  }
}

// Placeholder URL for mock-transport tests: the fake transport never dials,
// so no port here is ever bound. Kept as a constant to make that explicit.
const FAKE_WS_URL = "ws://127.0.0.1:1";
/** Fake-transport tests never dial a real port: the listener gate is stubbed open. */
const listenerOpen = async () => true;

// ---------- isolation ----------

test("isolated layout keeps every path under the Gather-owned root", () => {
  const { layout, cleanup } = fixtureLayout();
  try {
    for (const path of [
      layout.homeDir,
      layout.stateDir,
      layout.configPath,
      layout.workspaceDir,
      layout.secretsDir,
      layout.tmpDir,
      layout.logsDir,
    ]) {
      assert.equal(path.startsWith(layout.rootDir), true, `${path} escapes root`);
    }
    ensureLayoutDirectories(layout);
  } finally {
    cleanup();
  }
});

test("materialized config: loopback, token substitution, constrained tools, Gather-local logs", () => {
  const { layout, cleanup } = fixtureLayout();
  try {
    ensureLayoutDirectories(layout);
    writeGatewayConfig(layout, {
      gatherMcp: { url: "http://127.0.0.1:4567/mcp", toolInclude: ["check_availability"] },
    });
    const raw = readFileSync(layout.configPath, "utf8");
    const config = JSON.parse(raw);
    assert.equal(config.gateway.mode, "local");
    assert.equal(config.gateway.bind, "loopback");
    assert.equal(config.gateway.port, layout.port);
    assert.equal(config.gateway.auth.mode, "token");
    assert.equal(config.gateway.auth.token, "${OPENCLAW_GATEWAY_TOKEN}");
    assert.equal(config.agents.defaults.workspace, layout.workspaceDir);
    // Tool boundary: messaging profile keeps MCP visible while deny is the
    // hard stop for exec/fs/web/cron/browser/subagent surfaces.
    assert.equal(config.tools.profile, "messaging");
    for (const denied of ["group:runtime", "group:fs", "group:web", "browser", "cron", "subagents"]) {
      assert.ok(config.tools.deny.includes(denied), `deny missing ${denied}`);
    }
    // Logs stay inside the Gather-owned root (supported logging.file).
    assert.equal(config.logging.file, join(layout.logsDir, "gateway.log"));
    // MCP auth header uses env substitution — never a literal secret.
    const server = config.mcp.servers.gather;
    assert.equal(server.transport, "streamable-http");
    assert.equal(server.headers.authorization, "Bearer ${GATHER_MCP_TOKEN}");
    assert.deepEqual(server.toolFilter.include, ["check_availability"]);
    assert.equal(raw.includes("gather-gw-"), false);
    assert.equal(raw.includes("gather-mcp-"), false);
  } finally {
    cleanup();
  }
});

test("child env is minimal, Gather-owned, and cannot leak personal or provider vars", () => {
  const { layout, cleanup } = fixtureLayout();
  try {
    const env = buildGatewayChildEnv(layout, "gather-gw-test-token", {}, { mcpToken: "gather-mcp-x" });
    assert.equal(env.OPENCLAW_HOME, layout.homeDir);
    assert.equal(env.HOME, layout.homeDir);
    assert.equal(env.TMPDIR, layout.tmpDir);
    assert.equal(env.OPENCLAW_STATE_DIR, layout.stateDir);
    assert.equal(env.OPENCLAW_CONFIG_PATH, layout.configPath);
    assert.equal(env.OPENCLAW_WORKSPACE_DIR, layout.workspaceDir);
    assert.equal(env.OPENCLAW_GATEWAY_PORT, String(layout.port));
    assert.equal(env.OPENCLAW_GATEWAY_TOKEN, "gather-gw-test-token");
    assert.equal(env.GATHER_MCP_TOKEN, "gather-mcp-x");
    assert.equal(env.OPENCLAW_CONFIG_READONLY, "1");
    assert.equal(env.OPENCLAW_SKIP_CHANNELS, "1");
    assert.equal(env.OPENCLAW_NO_RESPAWN, "1");
    assert.equal(env.OPENCLAW_DISABLE_BONJOUR, "1");
    assert.equal(env.OPENCLAW_EXEC_SHELL_SNAPSHOT, "0");
    assert.equal("OPENCLAW_LOAD_SHELL_ENV" in env, false);
    assert.equal("OPENCLAW_PROFILE" in env, false);
    assert.equal("NODE_OPTIONS" in env, false);
    assert.equal("ANTHROPIC_API_KEY" in env, false);
    assert.equal("OPENAI_API_KEY" in env, false);
  } finally {
    cleanup();
  }
});

test("extraEnv is restricted to the diagnostic allowlist", () => {
  const { layout, cleanup } = fixtureLayout();
  try {
    for (const bad of [
      "OPENCLAW_NO_RESPAWN",
      "OPENCLAW_SKIP_CHANNELS",
      "OPENCLAW_CONFIG_READONLY",
      "OPENCLAW_EXEC_SHELL_SNAPSHOT",
      "OPENCLAW_LOAD_SHELL_ENV",
      "NODE_OPTIONS",
      "OPENCLAW_GATEWAY_TOKEN",
      "GATHER_MCP_TOKEN",
      "HOME",
      "OPENCLAW_STATE_DIR",
    ]) {
      assert.throws(
        () => buildGatewayChildEnv(layout, "t", { [bad]: "x" }),
        /isolation variable|diagnostic allowlist/,
        `${bad} must be rejected`,
      );
    }
    const ok = buildGatewayChildEnv(layout, "t", { OPENCLAW_LOG_LEVEL: "debug" });
    assert.equal(ok.OPENCLAW_LOG_LEVEL, "debug");
  } finally {
    cleanup();
  }
});

test("executable resolution: no bare PATH commands, explicit paths validated", () => {
  assert.throws(
    () => resolveOpenClawExecutable({ executable: { command: "openclaw" } }),
    /absolute validated path/,
  );
  assert.throws(
    () => resolveOpenClawExecutable({ executable: { command: "/nonexistent/openclaw-xyz" } }),
    /does not exist/,
  );
  const explicit = resolveOpenClawExecutable({ executable: { command: "/bin/sh" } });
  assert.equal(explicit.source, "explicit");
});

// ---------- loopback port allocation / occupancy probes ----------

test("allocated loopback port is bindable; probe reports free-held-released faithfully", async () => {
  const port = await freeLoopbackPort();
  assert.equal(await checkLoopbackPortOccupied(port), false);
  // A port we can actually bind is the only meaningful "free" evidence.
  const server = await holdLoopbackPort(port);
  try {
    assert.equal(await checkLoopbackPortOccupied(port), true);
  } finally {
    await closeServer(server);
  }
  assert.equal(await checkLoopbackPortOccupied(port), false);
});

test("occupancy probe rejects non-port inputs instead of probing them", async () => {
  for (const bad of [0, -1, 70000, 1.5, Number.NaN]) {
    await assert.rejects(checkLoopbackPortOccupied(bad), /invalid loopback port/);
  }
});

test("occupancy probe catches a wildcard-bound occupant, not just loopback", async () => {
  // SO_REUSEADDR lets a 127.0.0.1 probe coexist with a 0.0.0.0 listener —
  // the probe must check the wildcard address too or it reports FREE for
  // an occupied port.
  const port = await freeLoopbackPort();
  const wildcard = await holdLoopbackPort(port, "0.0.0.0");
  try {
    assert.equal(await checkLoopbackPortOccupied(port), true, "0.0.0.0-bound occupant must be detected");
  } finally {
    await closeServer(wildcard);
  }
  assert.equal(await checkLoopbackPortOccupied(port), false);
});

test("two per-run allocations do not collide", async () => {
  const first = await freeLoopbackPort();
  const second = await freeLoopbackPort();
  // Sequential allocate-release may legitimately recycle the same port, so
  // hold the first while allocating the second: they must differ.
  const held = await holdLoopbackPort(first);
  try {
    const third = await freeLoopbackPort();
    assert.notEqual(third, first);
    assert.equal(await checkLoopbackPortOccupied(third), false);
    assert.equal(second >= 1 && second <= 65535, true);
  } finally {
    await closeServer(held);
  }
});

// ---------- session / idempotency keys ----------

test("per-booking session keys are deterministic and cannot alias distinct bookings", () => {
  const first = bookingSessionKey("booking-001");
  assert.equal(first, bookingSessionKey("booking-001"));
  assert.match(first, /^agent:main:gather:booking:booking-001-[0-9a-f]{12}$/);
  // The exact blocker: sanitization must not alias "a/b" and "a-b".
  assert.notEqual(bookingSessionKey("a/b"), bookingSessionKey("a-b"));
  assert.notEqual(bookingSessionKey("a b"), bookingSessionKey("a_b"));
  assert.notEqual(bookingSessionKey("booking-002"), first);
  assert.equal(bookingSessionKey("b1", "ops"), bookingSessionKey("b1", "ops"));
  assert.notEqual(bookingSessionKey("b1", "ops"), bookingSessionKey("b1"));
  assert.throws(() => bookingSessionKey("   "), /usable character/);
});

test("idempotency keys are stable across identity key order and unique per step", () => {
  const left = stableTaskIdempotencyKey({
    bookingId: "booking-001",
    step: "prepare-offer",
    identity: { version: 1, proposal: "p-1" },
  });
  const right = stableTaskIdempotencyKey({
    bookingId: "booking-001",
    step: "prepare-offer",
    identity: { proposal: "p-1", version: 1 },
  });
  assert.equal(left, right);
  assert.match(left, /^gather:runtime:prepare-offer:[0-9a-f]{16}$/);
  assert.notEqual(
    stableTaskIdempotencyKey({ bookingId: "booking-001", step: "send-offer", identity: { version: 1, proposal: "p-1" } }),
    left,
  );
});

// ---------- mock-transport protocol tests ----------

function fakeHello() {
  return {
    type: "hello-ok" as const,
    protocol: 4,
    server: { version: "2026.9.4", connId: "conn-test" },
    features: { methods: ["agent", "agent.wait", "chat.history", "sessions.list", "status"], events: [] },
    snapshot: { presence: [], health: {} },
    policy: {},
    auth: { role: "operator", scopes: ["operator.read", "operator.write"] },
  };
}

function fakeTransportFactory(behavior: {
  hello?: boolean;
  respond?: (method: string, params: unknown) => unknown;
}) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const factory = (options: GatewayClientOptions): GatewayTransport & { calls: typeof calls } => ({
    calls,
    get connected() {
      return true;
    },
    start() {
      if (behavior.hello !== false) {
        queueMicrotask(() => options.onHelloOk?.(fakeHello() as never));
      }
    },
    stop() {},
    async stopAndWait() {},
    async request<T>(method: string, params?: unknown): Promise<T> {
      calls.push({ method, params });
      return (behavior.respond?.(method, params) ?? {}) as T;
    },
  });
  return { factory, calls };
}

test("connect resolves on hello-ok and presents operator role, token and scopes", async () => {
  const { factory } = fakeTransportFactory({ hello: true });
  let captured: GatewayClientOptions | null = null;
  const connection = new GatherGatewayConnection(
    { url: FAKE_WS_URL, token: "gather-gw-test" },
    {
      transportFactory: (options) => {
        captured = options;
        return factory(options);
      },
      probeListener: listenerOpen,
    },
  );
  const hello = await connection.connect({ timeoutMs: 2000 });
  assert.equal(connection.isReady, true);
  assert.equal(hello.protocol, 4);
  assert.equal(captured!.role, "operator");
  assert.deepEqual(captured!.scopes, ["operator.read", "operator.write"]);
  assert.equal(captured!.token, "gather-gw-test");
  assert.equal(captured!.mode, "backend");
  await connection.close();
});

test("connect rejects when hello-ok never arrives", async () => {
  const { factory } = fakeTransportFactory({ hello: false });
  const connection = new GatherGatewayConnection(
    { url: FAKE_WS_URL, token: "t" },
    { transportFactory: factory, probeListener: listenerOpen },
  );
  await assert.rejects(connection.connect({ timeoutMs: 50 }), /hello-ok not received/);
  assert.equal(connection.currentState, "closed");
});

test("connect waits for a delayed listener before starting the transport", async () => {
  // Cold-start regression: the gateway binds its loopback port only after
  // plugin load. The WS transport must not start (and burn reconnect
  // backoff) until the listener accepts — TCP accept is liveness, never
  // readiness; hello-ok still proves readiness.
  const server = createServer();
  let port = 0;
  const { factory } = fakeTransportFactory({ hello: true });
  let transportStartedAt = 0;
  const t0 = Date.now();
  try {
    port = await new Promise<number>((resolvePort) => {
      // Bound but then closed: bind only to learn a free port, listen later.
      const probe = createServer();
      probe.listen(0, "127.0.0.1", () => {
        const p = (probe.address() as { port: number }).port;
        probe.close(() => resolvePort(p));
      });
    });
    // Listener arrives 600ms into connect — inside the budget, after the
    // first probes have already been refused.
    setTimeout(() => server.listen(port, "127.0.0.1"), 600).unref();
    const connection = new GatherGatewayConnection(
      { url: `ws://127.0.0.1:${port}`, token: "t" },
      {
        transportFactory: (options) => {
          const transport = factory(options);
          const innerStart = transport.start;
          transport.start = () => { transportStartedAt = Date.now() - t0; innerStart(); };
          return transport;
        },
      },
    );
    const hello = await connection.connect({ timeoutMs: 5000 });
    assert.equal(hello.protocol, 4);
    assert.ok(transportStartedAt >= 550, `transport started before the listener accepted (${transportStartedAt}ms)`);
    await connection.close();
  } finally {
    server.close();
  }
});

test("connect rejects honestly when the listener never appears", async () => {
  // A port that never binds: the probe consumes the shared deadline and the
  // error names the listener, not a phantom handshake.
  const probe = createServer();
  const port = await new Promise<number>((resolvePort) => {
    probe.listen(0, "127.0.0.1", () => {
      const p = (probe.address() as { port: number }).port;
      probe.close(() => resolvePort(p));
    });
  });
  let factoryCalled = false;
  const connection = new GatherGatewayConnection(
    { url: `ws://127.0.0.1:${port}`, token: "t" },
    { transportFactory: (options) => { factoryCalled = true; return fakeTransportFactory({ hello: true }).factory(options); } },
  );
  const t0 = Date.now();
  await assert.rejects(connection.connect({ timeoutMs: 800 }), /listener did not accept/);
  assert.ok(Date.now() - t0 < 2500, "absent listener rejects near the deadline, not slowly");
  assert.equal(factoryCalled, false, "transport is never created for a dead port");
  assert.equal(connection.currentState, "closed");
});

test("close() racing a late-accepting probe never creates or starts a transport", async () => {
  // The probe's final attempt resolves true AFTER close() ran — the factory
  // and start() must still not run, or a dead connection resurrects.
  let probeCalls = 0;
  let factoryCalled = false;
  let transportStarted = false;
  const connection = new GatherGatewayConnection(
    { url: FAKE_WS_URL, token: "t" },
    {
      probeListener: async () => {
        probeCalls += 1;
        if (probeCalls === 1) return false; // first probe refused
        // Second probe: close lands while this await is in flight, then
        // accept arrives — must NOT reach the factory below.
        await new Promise((r) => setTimeout(r, 30));
        return true;
      },
      transportFactory: (options) => {
        factoryCalled = true;
        const transport = fakeTransportFactory({ hello: true }).factory(options);
        const innerStart = transport.start;
        transport.start = () => { transportStarted = true; innerStart(); };
        return transport;
      },
    },
  );
  const pending = connection.connect({ timeoutMs: 10000 });
  setTimeout(() => void connection.close(), 10).unref();
  await assert.rejects(pending, /closed/);
  // Let the second probe's resolution land.
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(factoryCalled, false, "transport factory ran after close");
  assert.equal(transportStarted, false, "transport.start ran after close");
});

test("concurrent connect calls produce at most one transport", async () => {
  // Two connects before the transport is allocated: the second must reject
  // immediately and exactly one transport may exist.
  let factoryCalls = 0;
  const connection = new GatherGatewayConnection(
    { url: FAKE_WS_URL, token: "t" },
    {
      probeListener: async () => { await new Promise((r) => setTimeout(r, 20)); return true; },
      transportFactory: (options) => {
        factoryCalls += 1;
        return fakeTransportFactory({ hello: true }).factory(options);
      },
    },
  );
  const first = connection.connect({ timeoutMs: 5000 });
  const second = connection.connect({ timeoutMs: 5000 });
  await assert.rejects(second, /already started/);
  await first;
  assert.equal(factoryCalls, 1);
  assert.equal(connection.isReady, true);
  await connection.close();
});

test("close during the listener probe aborts connect promptly", async () => {
  const probe = createServer();
  const port = await new Promise<number>((resolvePort) => {
    probe.listen(0, "127.0.0.1", () => {
      const p = (probe.address() as { port: number }).port;
      probe.close(() => resolvePort(p));
    });
  });
  const connection = new GatherGatewayConnection(
    { url: `ws://127.0.0.1:${port}`, token: "t" },
    { transportFactory: fakeTransportFactory({ hello: true }).factory },
  );
  const pending = connection.connect({ timeoutMs: 30000 });
  setTimeout(() => void connection.close(), 100).unref();
  const t0 = Date.now();
  await assert.rejects(pending, /closed while waiting/);
  assert.ok(Date.now() - t0 < 2000, "cancellation aborts the probe promptly");
  assert.equal(connection.currentState, "closed");
});

test("a socket close after readiness surfaces a reconnecting state", async () => {
  let closeHandler: ((code: number, reason: string) => void) | undefined;
  const states: string[] = [];
  const connection = new GatherGatewayConnection(
    { url: FAKE_WS_URL, token: "t", onStateChange: (s) => states.push(s) },
    {
      transportFactory: (options) => {
        closeHandler = options.onClose;
        return fakeTransportFactory({ hello: true }).factory(options);
      },
      probeListener: listenerOpen,
    },
  );
  await connection.connect({ timeoutMs: 1000 });
  closeHandler?.(1012, "service restart");
  assert.equal(states[states.length - 1], "reconnecting");
  await connection.close();
});

test("submitTask calls the agent RPC with sessionKey, idempotencyKey and no delivery", async () => {
  const { factory, calls } = fakeTransportFactory({
    hello: true,
    respond: () => ({ runId: "run-1", acceptedAt: 1700000000000 }),
  });
  const connection = new GatherGatewayConnection(
    { url: FAKE_WS_URL, token: "t" },
    { transportFactory: factory, probeListener: listenerOpen },
  );
  await connection.connect({ timeoutMs: 1000 });
  const tasks = new GatherRuntimeTasks(connection);
  const submitted = await tasks.submitTask({
    bookingId: "booking-001",
    message: "Prepare a source-linked offer",
    idempotencyKey: "gather:runtime:prepare-offer:abc123",
  });
  assert.equal(submitted.runId, "run-1");
  assert.equal(submitted.sessionKey, bookingSessionKey("booking-001"));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, "agent");
  const params = calls[0]!.params as Record<string, unknown>;
  assert.equal(params.sessionKey, submitted.sessionKey);
  assert.equal(params.idempotencyKey, "gather:runtime:prepare-offer:abc123");
  assert.equal(params.deliver, false);
  await connection.close();
});

test("malformed agent responses are rejected, never trusted", async () => {
  for (const bad of [null, "nope", {}, { runId: 42 }, { runId: "r1" }, { runId: "r1", acceptedAt: "soon" }]) {
    const { factory } = fakeTransportFactory({ hello: true, respond: () => bad });
    const connection = new GatherGatewayConnection(
      { url: FAKE_WS_URL, token: "t" },
      { transportFactory: factory, probeListener: listenerOpen },
    );
    await connection.connect({ timeoutMs: 1000 });
    const tasks = new GatherRuntimeTasks(connection);
    await assert.rejects(
      tasks.submitTask({ bookingId: "b", message: "m", idempotencyKey: "k" }),
      /malformed agent response/,
    );
    await connection.close();
  }
});

test("agent.wait timeout is wait-only and never proves the run stopped", async () => {
  const { factory } = fakeTransportFactory({
    hello: true,
    respond: (method) => (method === "agent.wait" ? { status: "timeout" } : {}),
  });
  const connection = new GatherGatewayConnection(
    { url: FAKE_WS_URL, token: "t" },
    { transportFactory: factory, probeListener: listenerOpen },
  );
  await connection.connect({ timeoutMs: 1000 });
  const tasks = new GatherRuntimeTasks(connection);
  const result = await tasks.waitForRun({ runId: "run-9", timeoutMs: 5 });
  assert.equal(result.status, "timeout");
  assert.equal(result.executionMayContinue, true);
  await connection.close();
});

test("terminal and unrecognized wait statuses map faithfully", async () => {
  // error + superseded is terminal; unrecognized status is NOT terminal.
  for (const [given, expected, mayContinue] of [
    [{ status: "error", stopReason: "superseded" }, "error", false],
    [{ status: "ok" }, "ok", false],
    [{ status: "in-progress" }, "unknown", true],
    [{ status: "melted" }, "unknown", true],
    [{}, "unknown", true],
  ] as const) {
    const { factory } = fakeTransportFactory({
      hello: true,
      respond: (method) => (method === "agent.wait" ? given : {}),
    });
    const connection = new GatherGatewayConnection(
      { url: FAKE_WS_URL, token: "t" },
      { transportFactory: factory, probeListener: listenerOpen },
    );
    await connection.connect({ timeoutMs: 1000 });
    const tasks = new GatherRuntimeTasks(connection);
    const result = await tasks.waitForRun({ runId: "run-x" });
    assert.equal(result.status, expected);
    assert.equal(result.executionMayContinue, mayContinue);
    if (expected === "unknown") assert.equal(result.rawStatus, given.status);
    await connection.close();
  }
});

test("malformed chat.history responses are rejected", async () => {
  const { factory } = fakeTransportFactory({
    hello: true,
    respond: () => ({ messages: "not-an-array" }),
  });
  const connection = new GatherGatewayConnection(
    { url: FAKE_WS_URL, token: "t" },
    { transportFactory: factory, probeListener: listenerOpen },
  );
  await connection.connect({ timeoutMs: 1000 });
  const tasks = new GatherRuntimeTasks(connection);
  await assert.rejects(tasks.sessionHistory({ sessionKey: "agent:main:x" }), /malformed chat\.history/);
  await connection.close();
});

test("non-timeout RPC failures are wrapped as GatewayRequestFailed", async () => {
  const { factory } = fakeTransportFactory({
    hello: true,
    respond: () => {
      throw new Error("method not found");
    },
  });
  const connection = new GatherGatewayConnection(
    { url: FAKE_WS_URL, token: "t" },
    { transportFactory: factory, probeListener: listenerOpen },
  );
  await connection.connect({ timeoutMs: 1000 });
  const tasks = new GatherRuntimeTasks(connection);
  await assert.rejects(tasks.listSessions(), GatewayRequestFailed);
  await connection.close();
});

// ---------- process lifecycle (fake children) ----------

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 4242;
  killed: string[] = [];
  exitOnSignal: boolean;

  constructor(exitOnSignal: boolean) {
    super();
    this.exitOnSignal = exitOnSignal;
  }

  kill(signal: string) {
    this.killed.push(signal);
    if (this.exitOnSignal) queueMicrotask(() => this.emit("exit", 0, signal));
    return true;
  }
}

function fakeSpawn(child: FakeChild): { spawnFn: SpawnLike; spawned: Array<{ command: string; args: string[] }> } {
  const spawned: Array<{ command: string; args: string[] }> = [];
  const spawnFn = ((command: string, args: string[]) => {
    spawned.push({ command, args });
    return child;
  }) as unknown as SpawnLike;
  return { spawnFn, spawned };
}

test("a spawn-level error rejects start() instead of pretending to run", async () => {
  const { layout, cleanup } = fixtureLayout();
  try {
    ensureLayoutDirectories(layout);
    const child = new FakeChild(true);
    const { spawnFn } = fakeSpawn(child);
    queueMicrotask(() => child.emit("error", new Error("spawn ENOENT")));
    const process = new OpenClawGatewayProcess(
      { layout, executable: { command: "/bin/sh" } },
      { spawnFn, skipExecutableVerification: true },
    );
    await assert.rejects(process.start(), /failed to spawn.*ENOENT/);
    assert.equal(process.currentState, "failed");
  } finally {
    cleanup();
  }
});

test("an early non-78 exit fails start with the stderr tail", async () => {
  const { layout, cleanup } = fixtureLayout();
  try {
    ensureLayoutDirectories(layout);
    const child = new FakeChild(true);
    const { spawnFn } = fakeSpawn(child);
    const process = new OpenClawGatewayProcess(
      { layout, executable: { command: "/bin/sh" } },
      { spawnFn, skipExecutableVerification: true },
    );
    queueMicrotask(() => {
      child.stderr.write("fatal: config exploded\n");
      child.emit("exit", 2, null);
    });
    await assert.rejects(process.start(), /exited early with code 2.*config exploded/s);
    assert.equal(process.currentState, "failed");
  } finally {
    cleanup();
  }
});

test("stop() waits for the observed exit and reports stopped", async () => {
  const { layout, cleanup } = fixtureLayout();
  try {
    ensureLayoutDirectories(layout);
    const child = new FakeChild(true);
    const { spawnFn } = fakeSpawn(child);
    const process = new OpenClawGatewayProcess(
      { layout, executable: { command: "/bin/sh" } },
      { spawnFn, skipExecutableVerification: true },
    );
    await process.start();
    assert.equal(process.currentState, "running");
    await process.stop(500, 200);
    assert.equal(process.currentState, "stopped");
    assert.deepEqual(child.killed, ["SIGTERM"]);
  } finally {
    cleanup();
  }
});

test("stop() escalates to SIGKILL and never reports stopped without an observed exit", async () => {
  const { layout, cleanup } = fixtureLayout();
  try {
    ensureLayoutDirectories(layout);
    const child = new FakeChild(false); // never exits
    const { spawnFn } = fakeSpawn(child);
    const process = new OpenClawGatewayProcess(
      { layout, executable: { command: "/bin/sh" } },
      { spawnFn, skipExecutableVerification: true },
    );
    await process.start();
    await assert.rejects(process.stop(50, 50), /did not exit after SIGKILL/);
    assert.equal(process.currentState, "failed");
    assert.deepEqual(child.killed, ["SIGTERM", "SIGKILL"]);
  } finally {
    cleanup();
  }
});

/** Gateway child exits 78; the spawned "doctor" child is the repair. */
function repairSpawn(gateway: () => FakeChild, doctor: FakeChild) {
  const spawned: string[][] = [];
  const spawnFn = ((_command: string, args: string[]) => {
    spawned.push(args);
    return args.includes("doctor") ? doctor : gateway();
  }) as unknown as SpawnLike;
  return { spawnFn, spawned };
}

test("a hung doctor repair is bounded: deadline kills the tracked repair child and start rejects", async () => {
  const { layout, cleanup } = fixtureLayout();
  try {
    ensureLayoutDirectories(layout);
    const doctorChild = new FakeChild(true); // exits when killed
    const { spawnFn } = repairSpawn(() => {
      const child = new FakeChild(true);
      queueMicrotask(() => child.emit("exit", 78, null));
      return child;
    }, doctorChild);
    const process = new OpenClawGatewayProcess(
      { layout, executable: { command: "/bin/sh" } },
      { spawnFn, skipExecutableVerification: true, repairTimeoutMs: 60 },
    );
    const startedAt = Date.now();
    await assert.rejects(process.start(), /doctor --fix exceeded 60ms/);
    assert.ok(Date.now() - startedAt < 5000, "repair is bounded, never hangs start()");
    assert.equal(process.currentState, "failed");
    assert.ok(doctorChild.killed.includes("SIGTERM"), "hung repair child is terminated at the deadline");
    await process.stop(500, 200);
    assert.equal(process.currentState, "stopped");
  } finally {
    cleanup();
  }
});

test("stop() during an in-flight repair kills the tracked repair child and cannot wedge", async () => {
  const { layout, cleanup } = fixtureLayout();
  try {
    ensureLayoutDirectories(layout);
    const doctorChild = new FakeChild(true);
    const { spawnFn } = repairSpawn(() => {
      const child = new FakeChild(true);
      queueMicrotask(() => child.emit("exit", 78, null));
      return child;
    }, doctorChild);
    const process = new OpenClawGatewayProcess(
      { layout, executable: { command: "/bin/sh" } },
      // 60s real deadline: the stop(), not the timer, must kill the repair.
      { spawnFn, skipExecutableVerification: true, repairTimeoutMs: 60000 },
    );
    const starting = process.start();
    while (process.currentState !== "repairing") {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    }
    const stopping = process.stop(500, 200);
    await assert.rejects(starting, /after doctor repair|after repair retry|exceeded/);
    await stopping;
    assert.ok(doctorChild.killed.includes("SIGKILL"), "stop() reached and killed the repair child");
    assert.ok(["stopped", "failed"].includes(process.currentState));
  } finally {
    cleanup();
  }
});

// ---------- MCP boundary (real loopback HTTP) ----------

function simulatedAvailabilityTool() {
  return defineGatherTool<{ bookingId: string }>({
    name: "check_availability",
    description: "Check calendar availability for a slot",
    inputSchema: { bookingId: z.string() },
    execution: "simulated",
    handler: async (args, context) => ({
      content: [{ type: "text", text: `fixture availability for ${args.bookingId}` }],
      structuredContent: { available: true, verified: true, bookingId: args.bookingId, execution: context.execution },
    }),
  });
}

interface McpReply {
  status: number;
  parsed: Record<string, unknown>;
  sessionId?: string;
}

async function mcpPost(
  url: string,
  body: unknown,
  opts: { sessionId?: string; token?: string; origin?: string } = {},
): Promise<McpReply> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${opts.token ?? TEST_MCP_TOKEN}`,
  };
  if (opts.sessionId) headers["mcp-session-id"] = opts.sessionId;
  if (opts.origin) headers.origin = opts.origin;
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await response.text();
  const parsed = text.startsWith("event:") ? parseSse(text) : safeJson(text);
  return {
    status: response.status,
    parsed,
    sessionId: response.headers.get("mcp-session-id") ?? opts.sessionId,
  };
}

function safeJson(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function parseSse(text: string) {
  const dataLines = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
  for (const line of dataLines) {
    try {
      return JSON.parse(line);
    } catch {
      continue;
    }
  }
  return { raw: text };
}

const MCP_INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "gather-test", version: "0.0.0" },
  },
};

async function listenBoundary(tools = [simulatedAvailabilityTool()]) {
  const boundary = new GatherMcpBoundary({ tools, authToken: TEST_MCP_TOKEN });
  const { url } = await boundary.listen({ host: "127.0.0.1", port: 0 });
  return { boundary, url };
}

test("MCP boundary serves initialize and tool calls; simulated results are labeled", async () => {
  const { boundary, url } = await listenBoundary();
  try {
    const init = await mcpPost(url, MCP_INITIALIZE);
    assert.equal(init.status, 200);
    assert.equal((init.parsed.result as Record<string, unknown>)?.serverInfo && true, true);
    const sessionId = init.sessionId;
    assert.ok(sessionId);

    const listed = await mcpPost(url, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, { sessionId });
    const tools = (listed.parsed.result as { tools?: Array<{ name: string; description: string }> })?.tools ?? [];
    assert.deepEqual(tools.map((t) => t.name), ["check_availability"]);
    assert.match(tools[0]!.description, /SIMULATED/);

    const called = await mcpPost(
      url,
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "check_availability", arguments: { bookingId: "booking-001" } } },
      { sessionId },
    );
    const result = called.parsed.result as { content?: Array<{ text?: string }>; structuredContent?: Record<string, unknown> };
    const text = (result.content ?? []).map((c) => c.text).join("\n");
    assert.match(text, /SIMULATED/);
    assert.match(text, /fixture availability for booking-001/);
    assert.equal(result.structuredContent!["gather:simulated"], true);
    assert.equal(result.structuredContent!["gather:authority"], "advisory");
    assert.equal("verified" in result.structuredContent!, false);
  } finally {
    await boundary.close();
  }
});

test("a second initialize opens a new session (client reconnect/reinit)", async () => {
  const { boundary, url } = await listenBoundary();
  try {
    const first = await mcpPost(url, { ...MCP_INITIALIZE, id: 10 });
    const second = await mcpPost(url, { ...MCP_INITIALIZE, id: 20 });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.ok(first.sessionId);
    assert.ok(second.sessionId);
    assert.notEqual(first.sessionId, second.sessionId);
    assert.equal(boundary.sessionCount, 2);
    // Both sessions can call tools — reconnect did not strand the boundary.
    const called = await mcpPost(
      url,
      { jsonrpc: "2.0", id: 21, method: "tools/call", params: { name: "check_availability", arguments: { bookingId: "b2" } } },
      { sessionId: second.sessionId },
    );
    assert.equal(called.status, 200);
    // A stale session id from a different boundary is rejected.
    const stale = await mcpPost(url, { jsonrpc: "2.0", id: 22, method: "tools/list", params: {} }, { sessionId: "stale-session" });
    assert.equal(stale.status, 404);
  } finally {
    await boundary.close();
  }
  assert.equal(boundary.sessionCount, 0);
});

test("MCP boundary enforces bearer auth, Host and Origin checks", async () => {
  const { boundary, url } = await listenBoundary();
  try {
    // No token -> 401
    const noAuth = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(MCP_INITIALIZE),
    });
    assert.equal(noAuth.status, 401);
    // Wrong token -> 401
    const badToken = await mcpPost(url, MCP_INITIALIZE, { token: "wrong-token-wrong-token" });
    assert.equal(badToken.status, 401);
    // External Origin -> 403 (DNS-rebinding defense)
    const badOrigin = await mcpPost(url, MCP_INITIALIZE, { origin: "http://evil.example.com" });
    assert.equal(badOrigin.status, 403);
    // Forged Host -> 403 (raw HTTP: fetch() cannot set Host)
    const forgedStatus = await new Promise<number>((resolvePromise, rejectPromise) => {
      const target = new URL(url);
      const req = httpRequest(
        {
          hostname: target.hostname,
          port: target.port,
          path: target.pathname,
          method: "POST",
          headers: {
            host: "evil.example.com:80",
            "content-type": "application/json",
            authorization: `Bearer ${TEST_MCP_TOKEN}`,
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolvePromise(res.statusCode ?? 0));
        },
      );
      req.on("error", rejectPromise);
      req.end(JSON.stringify(MCP_INITIALIZE));
    });
    assert.equal(forgedStatus, 403);
    // Loopback origin is fine.
    const good = await mcpPost(url, MCP_INITIALIZE, { origin: url.replace("/mcp", "") });
    assert.equal(good.status, 200);
  } finally {
    await boundary.close();
  }
});

test("live-declared tools keep advisory authority and are not labeled simulated", async () => {
  const liveTool = defineGatherTool<{ q: string }>({
    name: "read_inquiry",
    description: "Read an inquiry thread",
    inputSchema: { q: z.string() },
    execution: "live",
    handler: async (args) => ({
      content: [{ type: "text", text: `live handler saw ${args.q}` }],
      structuredContent: { seen: args.q },
    }),
  });
  const { boundary, url } = await listenBoundary([liveTool]);
  try {
    const init = await mcpPost(url, MCP_INITIALIZE);
    const called = await mcpPost(
      url,
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read_inquiry", arguments: { q: "x" } } },
      { sessionId: init.sessionId },
    );
    const result = called.parsed.result as { content?: Array<{ text?: string }>; structuredContent?: Record<string, unknown> };
    const text = (result.content ?? []).map((c) => c.text).join("\n");
    assert.doesNotMatch(text, /SIMULATED/);
    assert.equal(result.structuredContent!["gather:authority"], "advisory");
    assert.equal(result.structuredContent!["gather:simulated"], false);
  } finally {
    await boundary.close();
  }
});

test("MCP boundary rejects wrong paths, bad JSON, short tokens and non-loopback binds", async () => {
  const { boundary, url } = await listenBoundary();
  try {
    const wrong = await fetch(url.replace("/mcp", "/other"), {
      method: "POST",
      headers: { authorization: `Bearer ${TEST_MCP_TOKEN}` },
      body: "{}",
    });
    assert.equal(wrong.status, 404);
    const badJson = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TEST_MCP_TOKEN}` },
      body: "{not json",
    });
    assert.equal(badJson.status, 400);
  } finally {
    await boundary.close();
  }
  assert.throws(() => new GatherMcpBoundary({ tools: [], authToken: "short" }), /at least 16/);
  const refused = new GatherMcpBoundary({ tools: [], authToken: TEST_MCP_TOKEN });
  await assert.rejects(refused.listen({ host: "0.0.0.0", port: 0 }), /loopback/);
});

// ---------- facade lifecycle (injected seams, no real gateway) ----------

interface FakeProcessBehavior {
  failStart?: string;
  /** Number of stop() calls that must fail before one succeeds. */
  stopFails?: number;
  /** Artificial delay before stop() resolves, to hold stop() in flight. */
  stopDelayMs?: number;
}

function fakeProcess(behavior: FakeProcessBehavior = {}) {
  const state = {
    startCalls: 0,
    stopCalls: 0,
    currentState: "stopped" as "stopped" | "running" | "failed" | "stopping",
  };
  let stopFailuresLeft = behavior.stopFails ?? 0;
  const proc: RuntimeProcessLike = {
    gatewayToken: "fake-token",
    pid: 5555,
    get currentState() {
      return state.currentState;
    },
    async start() {
      state.startCalls += 1;
      if (behavior.failStart) {
        state.currentState = "failed";
        throw new Error(behavior.failStart);
      }
      state.currentState = "running";
    },
    async stop() {
      state.stopCalls += 1;
      if (behavior.stopDelayMs) {
        await new Promise((r) => setTimeout(r, behavior.stopDelayMs));
      }
      if (stopFailuresLeft > 0) {
        stopFailuresLeft -= 1;
        state.currentState = "failed";
        throw new Error("did not exit after SIGKILL");
      }
      state.currentState = "stopped";
    },
  };
  return { proc, state };
}

function fakeConnection(behavior: { failConnect?: string } = {}) {
  const state = { ready: false, closeCalls: 0 };
  const conn: RuntimeConnectionLike = {
    get isReady() {
      return state.ready;
    },
    get currentState() {
      return state.ready ? "ready" : "closed";
    },
    async connect() {
      if (behavior.failConnect) throw new Error(behavior.failConnect);
      state.ready = true;
      return fakeHello();
    },
    async close() {
      state.closeCalls += 1;
      state.ready = false;
    },
    async request<T>(): Promise<T> {
      return {} as T;
    },
  };
  return { conn, state };
}

async function runtimeFixture(overrides: {
  processFactory?: (count: { n: number }) => RuntimeProcessLike;
  connectionFactory?: () => RuntimeConnectionLike;
  mcpBoundaryFactory?: () => RuntimeMcpBoundaryLike;
  mcpPort?: number;
  gatewayPort?: number;
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "gather-facade-test-"));
  const count = { n: 0 };
  const runtime = new GatherOpenClawRuntime(
    {
      rootDir: join(directory, "openclaw"),
      // Fake child never binds this port; per-run unique placeholder keeps
      // parallel runs from sharing even the config value.
      gatewayPort: overrides.gatewayPort ?? (await freeLoopbackPort()),
      mcpTools: [simulatedAvailabilityTool()],
      // Ephemeral by default. Tests that must prove a leaked listener was
      // released pass one per-run allocated port and rebind the SAME port.
      mcpPort: overrides.mcpPort ?? 0,
    },
    {
      processFactory: () => {
        count.n += 1;
        return overrides.processFactory
          ? overrides.processFactory(count)
          : fakeProcess().proc;
      },
      connectionFactory:
        overrides.connectionFactory ?? (() => fakeConnection().conn),
      mcpBoundaryFactory: overrides.mcpBoundaryFactory,
    },
  );
  return { runtime, count, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test("failed start rolls back the MCP boundary the invocation created", async () => {
  const behaviors = { proc: { failStart: "spawn denied" as string | undefined }, conn: {} };
  // Per-run allocated port, rebound after rollback: proves the first
  // listener was actually released rather than orphaned.
  const mcpPort = await freeLoopbackPort();
  const { runtime, cleanup } = await runtimeFixture({
    processFactory: () => fakeProcess(behaviors.proc).proc,
    connectionFactory: () => fakeConnection(behaviors.conn).conn,
    mcpPort,
  });
  try {
    await assert.rejects(runtime.start(), /spawn denied/);
    // MCP listener + token ref were created then rolled back.
    assert.equal(runtime.mcpUrl, null);
    // Config no longer references the torn-down MCP server.
    const config = JSON.parse(readFileSync(runtime.layout.configPath, "utf8"));
    assert.equal(config.mcp, undefined);
    // A second start rebinds the SAME MCP port — proving the first listener
    // was actually released rather than orphaned.
    delete behaviors.proc.failStart;
    await runtime.start();
    assert.ok(runtime.mcpUrl);
    await runtime.stop();
    assert.equal(runtime.mcpUrl, null);
  } finally {
    cleanup();
  }
});

test("a failed MCP close keeps ownership: error surfaces, release only after observed close", async () => {
  const proc = fakeProcess();
  const connBehavior: { failConnect?: string } = { failConnect: "ws gone" };
  let closeCalls = 0;
  let failCloses = 1;
  const boundary: RuntimeMcpBoundaryLike = {
    toolNames: ["check_availability"],
    listen: async () => ({ url: "http://127.0.0.1:0/mcp", port: 1 }),
    close: async () => {
      closeCalls += 1;
      if (closeCalls <= failCloses) throw new Error("mcp close exploded");
    },
  };
  const { runtime, cleanup } = await runtimeFixture({
    processFactory: () => proc.proc,
    connectionFactory: () => fakeConnection(connBehavior).conn,
    mcpBoundaryFactory: () => boundary,
  });
  try {
    // The original start failure propagates; the close failure does NOT
    // mask it — but ownership is retained, not dropped.
    await assert.rejects(runtime.start(), /ws gone/);
    assert.equal(closeCalls, 1);
    // The runtime still owns the boundary: a new start is refused, not
    // silently allowed over a possibly-live listener.
    await assert.rejects(runtime.start(), /still owns resources.*mcp=listening/s);
    // stop() retries the close; a persistent failure rejects AND keeps
    // ownership (the ref is never dropped on error).
    failCloses = 2;
    await assert.rejects(runtime.stop(), /mcp close exploded/);
    await assert.rejects(runtime.start(), /still owns resources/);
    // Once the close is observed, the boundary releases and lifecycle
    // resumes.
    await runtime.stop();
    assert.equal(closeCalls, 3);
    delete connBehavior.failConnect;
    await runtime.start();
    await runtime.stop();
    assert.equal(runtime.mcpUrl, null);
  } finally {
    cleanup();
  }
});

test("connect failure stops the spawned child and tears down MCP", async () => {
  const proc = fakeProcess();
  const conn = fakeConnection({ failConnect: "ws handshake refused" });
  const { runtime, cleanup } = await runtimeFixture({
    processFactory: () => proc.proc,
    connectionFactory: () => conn.conn,
  });
  try {
    await assert.rejects(runtime.start(), /ws handshake refused/);
    assert.equal(proc.state.stopCalls, 1);
    assert.equal(conn.state.closeCalls, 1);
    assert.equal(runtime.mcpUrl, null);
  } finally {
    cleanup();
  }
});

test("concurrent and repeated start() produce exactly one startup", async () => {
  const { runtime, count, cleanup } = await runtimeFixture();
  try {
    const first = runtime.start();
    const second = runtime.start();
    await Promise.all([first, second]);
    assert.equal(count.n, 1, "one process for two concurrent starts");
    await assert.rejects(runtime.start(), /still owns resources/);
    assert.equal(count.n, 1);
    await runtime.stop();
    assert.equal(runtime.state.process, "stopped");
    // After an observed stop, a fresh start is allowed again.
    await runtime.start();
    assert.equal(count.n, 2);
    await runtime.stop();
  } finally {
    cleanup();
  }
});

test("uncertain child exit keeps the process owned: retry start is blocked", async () => {
  // First process: start ok, connect throws, rollback stop() throws (exit
  // uncertain) -> process ref must remain owned, and a second start() must
  // NOT overwrite it with a second process.
  const flaky = fakeProcess({ stopFails: 1 });
  const connBehavior: { failConnect?: string } = { failConnect: "ws gone" };
  const { runtime, count, cleanup } = await runtimeFixture({
    processFactory: () => flaky.proc,
    connectionFactory: () => fakeConnection(connBehavior).conn,
  });
  try {
    await assert.rejects(runtime.start(), /ws gone/);
    assert.equal(count.n, 1);
    assert.equal(flaky.state.stopCalls, 1, "rollback attempted one stop");
    // The regression: prior implementation overwrote the process ref here.
    await assert.rejects(runtime.start(), /still owns resources/);
    assert.equal(count.n, 1, "no second process while exit is unobserved");
    assert.equal(flaky.state.stopCalls, 1);
    // Recovery only through stop(), which retries the child stop and observes
    // the exit this time.
    await runtime.stop();
    assert.equal(flaky.state.stopCalls, 2);
    assert.equal(runtime.state.process, "stopped");
    delete connBehavior.failConnect;
    await runtime.start();
    assert.equal(count.n, 2);
    await runtime.stop();
  } finally {
    cleanup();
  }
});

test("a running child with a disconnected WS still blocks a new start", async () => {
  const proc = fakeProcess();
  const conn = fakeConnection();
  const { runtime, count, cleanup } = await runtimeFixture({
    processFactory: () => proc.proc,
    connectionFactory: () => conn.conn,
  });
  try {
    await runtime.start();
    // Simulate a dropped socket: connection ref exists but isReady is false
    // while the child keeps running — the guard must not rely on isReady.
    conn.state.ready = false;
    await assert.rejects(runtime.start(), /still owns resources/);
    assert.equal(count.n, 1);
    await runtime.stop();
  } finally {
    cleanup();
  }
});

test("start() during an in-flight stop() is rejected, then allowed after", async () => {
  const proc = fakeProcess({ stopDelayMs: 50 });
  const { runtime, count, cleanup } = await runtimeFixture({
    processFactory: () => proc.proc,
  });
  try {
    await runtime.start();
    const stopping = runtime.stop(); // in flight while child stop takes 50ms
    await assert.rejects(runtime.start(), /stopping/);
    await stopping;
    await runtime.start();
    assert.equal(count.n, 2);
    await runtime.stop();
  } finally {
    cleanup();
  }
});

// ---------- actual isolated gateway boot (doctor end-to-end) ----------
//
// No fixed ports: each doctor run gets a per-run dynamically allocated
// loopback port (doctor default --port auto, or an explicitly allocated port
// passed via --port). A "free" probe never proves the port stays free
// (TOCTOU) — the gateway bind is authoritative — so a dedicated busy-port
// test below proves the occupied case fails clear. No load-related root
// cause is claimed: these tests only remove the fixed-port weakness and
// prove busy ports fail safe.

function doctorLeftovers(projectDir: string): string[] {
  return execFileSync("ls", ["-A", join(projectDir, ".runtime")], { encoding: "utf8" })
    .split("\n")
    .filter((name) => name.startsWith("openclaw-doctor-"));
}

test(
  "doctor: real isolated boot preserves pre-existing .runtime state (sentinel)",
  { timeout: 90000 },
  async () => {
    const binary = resolveTestBinary();
    if (!binary) {
      console.log("SKIP: no openclaw binary (explicit /opt/homebrew/bin/openclaw or PATH); doctor boot not run");
      return;
    }

    // Fake project root with pre-existing "real" Gather runtime state.
    const projectDir = mkdtempSync(join(tmpdir(), "gather-doctor-project-"));
    const realState = join(projectDir, ".runtime", "openclaw");
    mkdirSync(join(realState, "state", "sessions"), { recursive: true });
    writeFileSync(join(realState, "sentinel.txt"), "pre-existing gather state\n");
    const configBefore = join(realState, "openclaw.json");
    writeFileSync(configBefore, '{"gateway":{"mode":"local"}}\n');

    try {
      // No --port flag: the doctor allocates its own per-run loopback port.
      const output = execFileSync(
        process.execPath,
        [join(process.cwd(), "scripts", "openclaw-doctor.mjs"), "--openclaw-bin", binary],
        { cwd: projectDir, encoding: "utf8", timeout: 80000, env: { ...process.env, GATHER_OPENCLAW_BIN: binary } },
      );
      // Staging is explicit: child-spawned (liveness) is NOT readiness;
      // only protocol-ready (hello-ok) proves the gateway is up. The
      // hello-ok deadline is unchanged at 30 s — not raised to hide failure.
      assert.match(output, /PASS port/);
      assert.match(output, /PASS child spawned/);
      assert.match(output, /PASS protocol-ready \(hello-ok\)/);
      assert.match(output, /PASS shutdown/);
      assert.doesNotMatch(output, /FAIL/);

      // Sentinel: pre-existing state untouched; doctor dir removed.
      assert.equal(readFileSync(join(realState, "sentinel.txt"), "utf8"), "pre-existing gather state\n");
      assert.equal(readFileSync(configBefore, "utf8"), '{"gateway":{"mode":"local"}}\n');
      assert.equal(existsSync(join(realState, "openclaw-doctor-marker")), false);
      assert.deepEqual(doctorLeftovers(projectDir), [], "doctor-owned dir must be removed after verified shutdown");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  },
);

test(
  "doctor: SIGTERM mid-run still observes child exit and preserves sentinel",
  { timeout: 90000 },
  async () => {
    const binary = resolveTestBinary();
    if (!binary) {
      console.log("SKIP: no openclaw binary (explicit /opt/homebrew/bin/openclaw or PATH); doctor signal run not run");
      return;
    }

    const projectDir = mkdtempSync(join(tmpdir(), "gather-doctor-signal-"));
    const realState = join(projectDir, ".runtime", "openclaw");
    mkdirSync(join(realState, "state"), { recursive: true });
    writeFileSync(join(realState, "sentinel.txt"), "pre-existing gather state\n");

    // Explicit per-run allocated port: exercises the preflight-free path
    // while avoiding every fixed port (including 19391, held by another run).
    const port = await freeLoopbackPort();
    try {
      const result = await new Promise<{ code: number | null; signal: string | null; output: string }>(
        (resolvePromise, rejectPromise) => {
          const child = spawn(
            process.execPath,
            [
              join(process.cwd(), "scripts", "openclaw-doctor.mjs"),
              "--openclaw-bin",
              binary,
              "--port",
              String(port),
            ],
            {
              cwd: projectDir,
              env: { ...process.env, GATHER_OPENCLAW_BIN: binary },
            },
          );
          let output = "";
          let signaled = false;
          child.stdout.on("data", (chunk: Buffer) => {
            output += chunk.toString("utf8");
            // Signal while the run is in flight — child is spawned,
            // later RPCs pending. Trigger on the spawn record, NOT on
            // readiness: readiness may never arrive under load.
            if (!signaled && output.includes("PASS child spawned")) {
              signaled = true;
              child.kill("SIGTERM");
            }
          });
          child.stderr.on("data", (chunk: Buffer) => {
            output += chunk.toString("utf8");
          });
          child.on("error", rejectPromise);
          child.on("close", (code, signal) => resolvePromise({ code, signal, output }));
        },
      );

      // The doctor's coordinated shutdown must still record an observed child
      // exit even though the run was interrupted.
      assert.match(result.output, /PASS shutdown: gateway child exit observed/);
      assert.doesNotMatch(result.output, /refusing cleanup/);
      assert.equal(
        readFileSync(join(realState, "sentinel.txt"), "utf8"),
        "pre-existing gather state\n",
      );
      assert.deepEqual(doctorLeftovers(projectDir), [], "doctor-owned dir must be removed after observed signal shutdown");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  },
);

test(
  "doctor: occupied port fails at preflight without touching the foreign listener",
  { timeout: 90000 },
  async () => {
    const binary = resolveTestBinary();
    if (!binary) {
      console.log("SKIP: no openclaw binary (explicit /opt/homebrew/bin/openclaw or PATH); busy-port run not run");
      return;
    }

    // Foreign occupant on a per-run allocated port: the doctor must fail
    // clear, leave the occupant listening, and preserve sentinel state.
    const busyPort = await freeLoopbackPort();
    const occupant = await holdLoopbackPort(busyPort);
    const projectDir = mkdtempSync(join(tmpdir(), "gather-doctor-busy-"));
    const realState = join(projectDir, ".runtime", "openclaw");
    mkdirSync(join(realState, "state"), { recursive: true });
    writeFileSync(join(realState, "sentinel.txt"), "pre-existing gather state\n");

    try {
      let output = "";
      let exitCode: number | null = null;
      try {
        output = execFileSync(
          process.execPath,
          [
            join(process.cwd(), "scripts", "openclaw-doctor.mjs"),
            "--openclaw-bin",
            binary,
            "--port",
            String(busyPort),
          ],
          { cwd: projectDir, encoding: "utf8", timeout: 80000, env: { ...process.env, GATHER_OPENCLAW_BIN: binary } },
        );
      } catch (error) {
        // execFileSync throws on nonzero exit; the doctor output is what matters.
        const err = error as { stdout?: string; status?: number };
        output = typeof err.stdout === "string" ? err.stdout : String(error);
        exitCode = err.status ?? 1;
      }
      assert.match(output, /FAIL port preflight/);
      assert.match(output, new RegExp(`port ${busyPort} is already occupied`));
      assert.match(output, /not stopping/);
      assert.doesNotMatch(output, /PASS child spawned/);
      assert.doesNotMatch(output, /PASS protocol-ready/);
      // The foreign listener was never stopped or taken over.
      assert.equal(await checkLoopbackPortOccupied(busyPort), true);
      // Sentinel preserved; only the doctor-owned dir was cleaned.
      assert.equal(readFileSync(join(realState, "sentinel.txt"), "utf8"), "pre-existing gather state\n");
      assert.deepEqual(doctorLeftovers(projectDir), [], "doctor-owned dir must be removed after preflight failure");
      assert.notEqual(exitCode, 0);
    } finally {
      await closeServer(occupant);
      rmSync(projectDir, { recursive: true, force: true });
    }
  },
);

test(
  "doctor: bare --port flag fails preflight instead of silently allocating",
  { timeout: 90000 },
  async () => {
    const binary = resolveTestBinary();
    if (!binary) {
      console.log("SKIP: no openclaw binary (explicit /opt/homebrew/bin/openclaw or PATH); bare-port run not run");
      return;
    }
    const projectDir = mkdtempSync(join(tmpdir(), "gather-doctor-bareport-"));
    try {
      let output = "";
      try {
        output = execFileSync(
          process.execPath,
          [join(process.cwd(), "scripts", "openclaw-doctor.mjs"), "--openclaw-bin", binary, "--port"],
          { cwd: projectDir, encoding: "utf8", timeout: 80000, env: { ...process.env, GATHER_OPENCLAW_BIN: binary } },
        );
      } catch (error) {
        const err = error as { stdout?: string };
        output = typeof err.stdout === "string" ? err.stdout : String(error);
      }
      assert.match(output, /FAIL port preflight/);
      assert.match(output, /--port requires a value/);
      assert.doesNotMatch(output, /PASS child spawned/);
      assert.deepEqual(doctorLeftovers(projectDir), [], "doctor-owned dir must be removed after preflight failure");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  },
);
