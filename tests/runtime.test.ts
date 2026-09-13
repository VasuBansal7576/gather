import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import {
  GatherGatewayConnection,
  GatherMcpBoundary,
  GatherRuntimeTasks,
  GatewayRequestFailed,
  OpenClawGatewayProcess,
  bookingSessionKey,
  buildGatewayChildEnv,
  buildGatewayConfig,
  defineGatherTool,
  ensureLayoutDirectories,
  resolveGatherOpenClawLayout,
  resolveOpenClawExecutable,
  stableTaskIdempotencyKey,
  writeGatewayConfig,
  type GatewayTransport,
  type SpawnLike,
} from "../src/runtime/index.ts";
import type { GatewayClientOptions } from "@openclaw/gateway-client";

// All fixtures are fictional/simulated; nothing here is a verified integration.

const TEST_MCP_TOKEN = "gather-mcp-test-token-0123456789abcdef";

function fixtureLayout() {
  const directory = mkdtempSync(join(tmpdir(), "gather-runtime-test-"));
  return {
    layout: resolveGatherOpenClawLayout({ rootDir: join(directory, "openclaw"), port: 19199 }),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

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
    { url: "ws://127.0.0.1:19199", token: "gather-gw-test" },
    {
      transportFactory: (options) => {
        captured = options;
        return factory(options);
      },
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
    { url: "ws://127.0.0.1:19199", token: "t" },
    { transportFactory: factory },
  );
  await assert.rejects(connection.connect({ timeoutMs: 50 }), /hello-ok not received/);
  assert.equal(connection.currentState, "closed");
});

test("a socket close after readiness surfaces a reconnecting state", async () => {
  let closeHandler: ((code: number, reason: string) => void) | undefined;
  const states: string[] = [];
  const connection = new GatherGatewayConnection(
    { url: "ws://127.0.0.1:19199", token: "t", onStateChange: (s) => states.push(s) },
    {
      transportFactory: (options) => {
        closeHandler = options.onClose;
        return fakeTransportFactory({ hello: true }).factory(options);
      },
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
    { url: "ws://127.0.0.1:19199", token: "t" },
    { transportFactory: factory },
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
      { url: "ws://127.0.0.1:19199", token: "t" },
      { transportFactory: factory },
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
    { url: "ws://127.0.0.1:19199", token: "t" },
    { transportFactory: factory },
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
      { url: "ws://127.0.0.1:19199", token: "t" },
      { transportFactory: factory },
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
    { url: "ws://127.0.0.1:19199", token: "t" },
    { transportFactory: factory },
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
    { url: "ws://127.0.0.1:19199", token: "t" },
    { transportFactory: factory },
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

// ---------- actual isolated gateway boot (doctor end-to-end) ----------

test(
  "doctor: real isolated boot preserves pre-existing .runtime state (sentinel)",
  { timeout: 90000 },
  async () => {
    let binary: string | null = null;
    try {
      binary = execFileSync("which", ["openclaw"], { encoding: "utf8" }).trim() || null;
    } catch {
      binary = null;
    }
    if (!binary) {
      console.log("SKIP: openclaw binary not installed; doctor boot not run");
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
      const output = execFileSync(
        process.execPath,
        [join(process.cwd(), "scripts", "openclaw-doctor.mjs"), "--port", "19391"],
        { cwd: projectDir, encoding: "utf8", timeout: 80000, env: { ...process.env, GATHER_OPENCLAW_BIN: binary } },
      );
      assert.match(output, /PASS gateway boot/);
      assert.match(output, /PASS hello-ok/);
      assert.match(output, /PASS shutdown/);

      // Sentinel: pre-existing state untouched; doctor dir removed.
      assert.equal(readFileSync(join(realState, "sentinel.txt"), "utf8"), "pre-existing gather state\n");
      assert.equal(readFileSync(configBefore, "utf8"), '{"gateway":{"mode":"local"}}\n');
      assert.equal(existsSync(join(realState, "openclaw-doctor-marker")), false);
      const leftovers = execFileSync("ls", ["-A", join(projectDir, ".runtime")], { encoding: "utf8" })
        .split("\n")
        .filter((name) => name.startsWith("openclaw-doctor-"));
      assert.deepEqual(leftovers, [], "doctor-owned dir must be removed after verified shutdown");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  },
);
