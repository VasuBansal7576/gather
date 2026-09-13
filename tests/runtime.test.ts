import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import {
  GatherGatewayConnection,
  GatherMcpBoundary,
  GatherRuntimeTasks,
  GatewayRequestFailed,
  bookingSessionKey,
  buildGatewayChildEnv,
  buildGatewayConfig,
  ensureLayoutDirectories,
  resolveGatherOpenClawLayout,
  stableTaskIdempotencyKey,
  writeGatewayConfig,
  type GatewayTransport,
  type GatherToolDefinition,
} from "../src/runtime/index.ts";
import type { GatewayClientOptions } from "@openclaw/gateway-client";

// All fixtures are fictional/simulated; nothing here is a verified integration.

function fixtureLayout() {
  const directory = mkdtempSync(join(tmpdir(), "gather-runtime-test-"));
  return {
    layout: resolveGatherOpenClawLayout({ rootDir: join(directory, "openclaw"), port: 19199 }),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

test("isolated layout keeps every path under the Gather-owned root", () => {
  const { layout, cleanup } = fixtureLayout();
  try {
    for (const path of [layout.homeDir, layout.stateDir, layout.configPath, layout.workspaceDir, layout.secretsDir]) {
      assert.equal(path.startsWith(layout.rootDir), true, `${path} escapes root`);
    }
    ensureLayoutDirectories(layout);
  } finally {
    cleanup();
  }
});

test("materialized config binds loopback, substitutes the token, and contains no secrets", () => {
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
    assert.equal(config.mcp.servers.gather.transport, "streamable-http");
    assert.deepEqual(config.mcp.servers.gather.toolFilter.include, ["check_availability"]);
    assert.equal(raw.includes("gather-gw-"), false, "config must not embed a literal token");
  } finally {
    cleanup();
  }
});

test("child env is minimal, Gather-owned, and cannot leak personal or provider vars", () => {
  const { layout, cleanup } = fixtureLayout();
  try {
    const env = buildGatewayChildEnv(layout, "gather-gw-test-token");
    assert.equal(env.OPENCLAW_HOME, layout.homeDir);
    assert.equal(env.HOME, layout.homeDir);
    assert.equal(env.TMPDIR, layout.tmpDir);
    assert.equal(env.OPENCLAW_STATE_DIR, layout.stateDir);
    assert.equal(env.OPENCLAW_CONFIG_PATH, layout.configPath);
    assert.equal(env.OPENCLAW_WORKSPACE_DIR, layout.workspaceDir);
    assert.equal(env.OPENCLAW_GATEWAY_PORT, String(layout.port));
    assert.equal(env.OPENCLAW_GATEWAY_TOKEN, "gather-gw-test-token");
    assert.equal(env.OPENCLAW_CONFIG_READONLY, "1");
    assert.equal(env.OPENCLAW_SKIP_CHANNELS, "1");
    assert.equal(env.OPENCLAW_NO_RESPAWN, "1");
    assert.equal(env.OPENCLAW_DISABLE_BONJOUR, "1");
    assert.equal(env.OPENCLAW_EXEC_SHELL_SNAPSHOT, "0");
    // Minimal env: personal process vars must not propagate.
    assert.equal("OPENCLAW_LOAD_SHELL_ENV" in env, false);
    assert.equal("ANTHROPIC_API_KEY" in env, false);
    assert.equal("OPENAI_API_KEY" in env, false);
    assert.equal("OPENCLAW_PROFILE" in env, false);
    // extraEnv may not override isolation keys.
    assert.throws(
      () => buildGatewayChildEnv(layout, "t", { OPENCLAW_STATE_DIR: "/tmp/evil" }),
      /isolation variable/,
    );
    assert.throws(
      () => buildGatewayChildEnv(layout, "t", { HOME: "/Users/personal" }),
      /isolation variable/,
    );
  } finally {
    cleanup();
  }
});

test("per-booking session keys are deterministic, sanitized, and agent-namespaced", () => {
  const first = bookingSessionKey("booking-001");
  const second = bookingSessionKey("booking-001");
  assert.equal(first, second);
  assert.equal(first, "agent:main:gather:booking:booking-001");
  assert.equal(bookingSessionKey("booking 002/odd"), "agent:main:gather:booking:booking-002-odd");
  assert.equal(bookingSessionKey("b1", "ops"), "agent:ops:gather:booking:b1");
  assert.notEqual(bookingSessionKey("booking-002"), first);
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

// ---- Mock-transport protocol tests ----

interface FakeTransport extends GatewayTransport {
  options: GatewayClientOptions;
  calls: Array<{ method: string; params: unknown }>;
  respond: (method: string, params: unknown) => unknown;
}

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
  const factory = (options: GatewayClientOptions): FakeTransport => {
    const transport: FakeTransport = {
      options,
      calls,
      respond: behavior.respond ?? (() => ({})),
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
        return transport.respond(method, params) as T;
      },
    };
    return transport;
  };
  return { factory, calls };
}

test("connect resolves on hello-ok and presents operator role, token and scopes", async () => {
  const { factory, calls } = fakeTransportFactory({ hello: true });
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
  void calls;
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
  const connection = new GatherGatewayConnection(
    { url: "ws://127.0.0.1:19199", token: "t" },
    {
      transportFactory: (options) => {
        closeHandler = options.onClose;
        return fakeTransportFactory({ hello: true }).factory(options);
      },
    },
  );
  const states: string[] = [];
  const tracked = new GatherGatewayConnection(
    { url: "ws://127.0.0.1:19199", token: "t", onStateChange: (s) => states.push(s) },
    {
      transportFactory: (options) => {
        closeHandler = options.onClose;
        return fakeTransportFactory({ hello: true }).factory(options);
      },
    },
  );
  await tracked.connect({ timeoutMs: 1000 });
  closeHandler?.(1012, "service restart");
  assert.equal(states[states.length - 1], "reconnecting");
  await tracked.close();
  await connection.close().catch(() => {});
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
  assert.equal(submitted.sessionKey, "agent:main:gather:booking:booking-001");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, "agent");
  const params = calls[0]!.params as Record<string, unknown>;
  assert.equal(params.sessionKey, "agent:main:gather:booking:booking-001");
  assert.equal(params.idempotencyKey, "gather:runtime:prepare-offer:abc123");
  assert.equal(params.deliver, false);
  await connection.close();
});

test("agent.wait timeout is wait-only and never proves the run stopped", async () => {
  const { factory } = fakeTransportFactory({
    hello: true,
    respond: (method) =>
      method === "agent.wait" ? { status: "timeout" } : {},
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

test("terminal ok and superseded error results map faithfully", async () => {
  const { factory } = fakeTransportFactory({
    hello: true,
    respond: (method) =>
      method === "agent.wait"
        ? { status: "error", stopReason: "superseded", endedAt: 1700000001000 }
        : {},
  });
  const connection = new GatherGatewayConnection(
    { url: "ws://127.0.0.1:19199", token: "t" },
    { transportFactory: factory },
  );
  await connection.connect({ timeoutMs: 1000 });
  const tasks = new GatherRuntimeTasks(connection);
  const result = await tasks.waitForRun({ runId: "run-10" });
  assert.equal(result.status, "error");
  assert.equal(result.stopReason, "superseded");
  assert.equal(result.executionMayContinue, false);
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

// ---- MCP boundary tests (real HTTP loopback, simulated handlers) ----

function simulatedAvailabilityTool(): GatherToolDefinition<{ bookingId: string }> {
  return {
    name: "check_availability",
    description: "Check calendar availability for a slot",
    inputSchema: { bookingId: z.string() },
    execution: "simulated",
    handler: async (args, context) => ({
      content: [{ type: "text", text: `fixture availability for ${args.bookingId}` }],
      structuredContent: { available: true, verified: true, bookingId: args.bookingId, execution: context.execution },
    }),
  };
}

async function mcpPost(url: string, body: unknown, sessionId?: string) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = text.startsWith("event:") ? parseSse(text) : safeJson(text);
  return { response, parsed, sessionId: response.headers.get("mcp-session-id") ?? sessionId };
}

function safeJson(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function parseSse(text: string) {
  const dataLines = text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim());
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

test("MCP boundary serves initialize and tool calls; simulated results are labeled", async () => {
  const boundary = new GatherMcpBoundary({ tools: [simulatedAvailabilityTool()] });
  const { url } = await boundary.listen({ host: "127.0.0.1", port: 0 });
  try {
    const init = await mcpPost(url, MCP_INITIALIZE);
    assert.equal(init.response.status, 200);
    assert.equal(init.parsed.result?.serverInfo?.name, "gather");
    const sessionId = init.sessionId;

    const listed = await mcpPost(
      url,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      sessionId,
    );
    const names = (listed.parsed.result?.tools ?? []).map((t: { name: string }) => t.name);
    assert.deepEqual(names, ["check_availability"]);
    const description = listed.parsed.result?.tools?.[0]?.description ?? "";
    assert.match(description, /SIMULATED/);

    const called = await mcpPost(
      url,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "check_availability", arguments: { bookingId: "booking-001" } },
      },
      sessionId,
    );
    const result = called.parsed.result;
    assert.equal(result.isError, undefined);
    const text = (result.content ?? []).map((c: { text?: string }) => c.text).join("\n");
    assert.match(text, /SIMULATED/);
    assert.match(text, /fixture availability for booking-001/);
    // A simulated handler can never emit a verified receipt.
    assert.equal(result.structuredContent["gather:simulated"], true);
    assert.equal(result.structuredContent["gather:authority"], "advisory");
    assert.equal("verified" in result.structuredContent, false);
  } finally {
    await boundary.close();
  }
});

test("live-declared tools keep advisory authority and are not labeled simulated", async () => {
  const liveTool: GatherToolDefinition<{ q: string }> = {
    name: "read_inquiry",
    description: "Read an inquiry thread",
    inputSchema: { q: z.string() },
    execution: "live",
    handler: async (args) => ({
      content: [{ type: "text", text: `live handler saw ${args.q}` }],
      structuredContent: { seen: args.q },
    }),
  };
  const boundary = new GatherMcpBoundary({ tools: [liveTool] });
  const { url } = await boundary.listen({ host: "127.0.0.1", port: 0 });
  try {
    const init = await mcpPost(url, MCP_INITIALIZE);
    const called = await mcpPost(
      url,
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read_inquiry", arguments: { q: "x" } } },
      init.sessionId,
    );
    const result = called.parsed.result;
    const text = (result.content ?? []).map((c: { text?: string }) => c.text).join("\n");
    assert.doesNotMatch(text, /SIMULATED/);
    assert.equal(result.structuredContent["gather:authority"], "advisory");
    assert.equal(result.structuredContent["gather:simulated"], false);
  } finally {
    await boundary.close();
  }
});

test("MCP boundary rejects wrong paths and refuses non-loopback binds", async () => {
  const boundary = new GatherMcpBoundary({ tools: [simulatedAvailabilityTool()] });
  const { url } = await boundary.listen({ host: "127.0.0.1", port: 0 });
  try {
    const wrong = await fetch(url.replace("/mcp", "/other"), { method: "POST", body: "{}" });
    assert.equal(wrong.status, 404);
    const badJson = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    assert.equal(badJson.status, 400);
  } finally {
    await boundary.close();
  }
  const refused = new GatherMcpBoundary({ tools: [] });
  await assert.rejects(refused.listen({ host: "0.0.0.0", port: 0 }), /loopback/);
});
