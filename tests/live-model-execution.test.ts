import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  GoogleHttpRequest,
  GoogleHttpResponse,
} from "../src/connectors/google/transport.ts";
import type { GoogleProviderApp, OAuthTokenResponse, OAuthTransport } from "../src/server/connections/index.ts";
import {
  ConnectionService,
  MemorySecretStore,
} from "../src/server/connections/index.ts";
import { createDemoConnectors } from "../src/connectors/demo.ts";
import { demoFixtureSlots } from "../src/server/demo-fixtures.ts";
import { DurableDemoCalendar, DurableDemoEmail } from "../src/server/durable-demo-connectors.ts";
import type { GatewayRequestChannel } from "../src/runtime/client.ts";
import { GatherRuntimeTasks } from "../src/runtime/tasks.ts";
import {
  CONTROLLED_TEST_RECIPIENT,
  getLiveRun,
  listToolCalls,
  LiveModelError,
  runLiveExecution,
  type ExecutionPlanner,
  type ScopedExecution,
} from "../src/server/live-model/index.ts";
import { bindBusinessCalendar } from "../src/server/proactive/calendar.ts";
import { createProviderConnectors, type ProviderConnectors } from "../src/server/provider-runtime/index.ts";
import { GatherStore } from "../src/server/sqlite-store.ts";

/**
 * Scripted MCP execution regression: a real MCP client drives the four
 * registered Gather tools over loopback HTTP against scripted fictional
 * provider transports. Facts come only from /tmp/gather-live-test-seed
 * (explicitly FICTIONAL, reused never regenerated). No live model runs
 * (scripted planner stands in), no approval, no send, no live reads.
 */

const SEED_DIR = "/tmp/gather-live-test-seed";
const INQUIRY_TEXT = readFileSync(join(SEED_DIR, "inquiry.txt"), "utf8");
const POLICY_TEXT = readFileSync(join(SEED_DIR, "venue-policy.md"), "utf8");

const APP: GoogleProviderApp = {
  clientId: "gather-test-client",
  authEndpoint: "https://accounts.example.test/auth",
  tokenEndpoint: "https://oauth2.example.test/token",
  userinfoEndpoint: "https://openid.example.test/userinfo",
  revokeEndpoint: "https://oauth2.example.test/revoke",
  redirectUri: "http://localhost:3000/api/connections/google/callback",
  requiredScopes: [
    "openid",
    "email",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/drive.readonly",
  ],
};

const THREAD_ID = "t-gather-test-1";
const MESSAGE_ID = "m-gather-test-1";
const FILE_ID = "f-gather-test-policy";
const CALENDAR_ID = "gather-test-calendar";
const BODY_B64URL = Buffer.from(INQUIRY_TEXT, "utf-8").toString("base64url");
const SLOT = { startAt: "2026-09-18T18:00:00+01:00", endAt: "2026-09-18T20:00:00+01:00" };

const MODEL = { model: "openai/gpt-5.6-luna", auth: { provider: "openai", mode: "oauth" as const, profileId: "openai:owner@example.invalid" } };

class ScriptedOAuth implements OAuthTransport {
  async exchangeCode(): Promise<OAuthTokenResponse> {
    return { accessToken: "access-sub-test", refreshToken: "refresh-sub-test", expiresInSec: 3600, scope: APP.requiredScopes.join(" ") };
  }
  async refresh(): Promise<OAuthTokenResponse> {
    return { accessToken: "access-sub-test", expiresInSec: 3600, scope: APP.requiredScopes.join(" ") };
  }
  async fetchAccountIdentity(): Promise<{ accountKey: string; displayName: string }> {
    return { accountKey: "google-sub-test", displayName: "Fictional Test Owner" };
  }
  async revokeToken(): Promise<void> {}
}

class ScriptedGoogle {
  requests: GoogleHttpRequest[] = [];
  json(status: number, body: unknown): GoogleHttpResponse {
    return { status, headers: {}, text: JSON.stringify(body) };
  }
  async request(req: GoogleHttpRequest): Promise<GoogleHttpResponse> {
    this.requests.push(req);
    if (req.url.includes("/profile")) return this.json(200, { emailAddress: "owner@example.test", historyId: "9000" });
    if (req.url.includes("/messages") && req.method === "GET" && !/\/messages\/[^?]+/.test(req.url)) {
      return this.json(200, { messages: [{ id: MESSAGE_ID, threadId: THREAD_ID }], historyId: "9001" });
    }
    if (req.url.includes("/history")) return this.json(200, { historyId: "9002", history: [] });
    const threadMatch = /\/threads\/([^/?]+)/.exec(req.url);
    if (threadMatch) {
      return this.json(200, {
        id: THREAD_ID,
        messages: [
          {
            id: MESSAGE_ID,
            threadId: THREAD_ID,
            labelIds: ["INBOX"],
            payload: {
              headers: [
                { name: "From", value: "Customer <customer@example.test>" },
                { name: "To", value: "owner@example.test" },
                { name: "Subject", value: "[GATHER TEST] Private dinner inquiry" },
                { name: "Date", value: "Thu, 10 Sep 2026 09:00:00 +0000" },
              ],
              mimeType: "text/plain",
              body: { data: BODY_B64URL },
            },
          },
        ],
      });
    }
    if (req.url.includes("/drive/v3/files/") && req.url.includes("alt=media")) {
      return { status: 200, headers: {}, text: POLICY_TEXT };
    }
    if (req.url.includes("/drive/v3/files/")) {
      return this.json(200, { id: FILE_ID, name: "venue-policy.md", mimeType: "text/markdown", capabilities: { canDownload: true } });
    }
    if (req.url.includes("/freeBusy")) {
      return this.json(200, { calendars: { [CALENDAR_ID]: { busy: [] } } });
    }
    return this.json(404, {});
  }
}

/** Scripted tasks channel: submit/wait/history envelopes without a live gateway. */
class FakeTasksChannel implements GatewayRequestChannel {
  readonly isReady = true;
  submits: Array<{ bookingId: string; idempotencyKey: string }> = [];
  runIds: string[] = [];
  private nextRun = 0;
  private byIdempotencyKey = new Map<string, string>();
  waitMode: "ok" | "timeout" = "ok";
  async request<T>(method: string, params?: unknown): Promise<T> {
    const p = (params ?? {}) as Record<string, unknown>;
    if (method === "agent") {
      // Gateway idempotency: same key replays the accepted run, no duplicate.
      const known = this.byIdempotencyKey.get(String(p.idempotencyKey));
      if (known) return { runId: known, acceptedAt: 1700000000000 } as T;
      this.nextRun += 1;
      const runId = `gateway-run-${this.nextRun}`;
      this.submits.push({ bookingId: String(p.bookingId), idempotencyKey: String(p.idempotencyKey) });
      this.runIds.push(runId);
      this.byIdempotencyKey.set(String(p.idempotencyKey), runId);
      return { runId, acceptedAt: 1700000000000 } as T;
    }
    if (method === "agent.wait") {
      if (this.waitMode === "timeout") return { status: "timeout", runId: String(p.runId) } as T;
      return { status: "ok", runId: String(p.runId), endedAt: 1700000001000 } as T;
    }
    if (method === "chat.history") return { messages: [] } as T;
    throw new Error(`unexpected method ${method}`);
  }
}

interface Fx {
  dir: string;
  store: GatherStore;
  service: ConnectionService;
  providers: ProviderConnectors;
  gmail: ScriptedGoogle;
  tasks: FakeTasksChannel;
  businessId: string;
}

async function fixture(): Promise<Fx> {
  const dir = mkdtempSync(join(tmpdir(), "gather-live-exec-"));
  const store = new GatherStore(join(dir, "gather.sqlite"));
  const service = new ConnectionService({
    store,
    secrets: new MemorySecretStore(),
    transport: new ScriptedOAuth(),
    googleApp: APP,
    ownerId: "local-owner",
  });
  const gmail = new ScriptedGoogle();
  const demo = createDemoConnectors({ calendarSlots: demoFixtureSlots() });
  const providers = createProviderConnectors({
    store,
    ownerId: "local-owner",
    demo: { calendar: new DurableDemoCalendar(store, demo.calendar), email: new DurableDemoEmail(store, demo.email) },
    connectionService: service,
    transport: { request: (req) => gmail.request(req) },
  });
  const business = store.createBusiness({ name: "Gather Test Venue", timezone: "Europe/London" });
  const start = service.startAuthorization({ businessId: business.id, provider: "google" });
  const state = new URL(start.authorizationUrl).searchParams.get("state") ?? "";
  await service.completeAuthorization({ code: "code-test", state });
  bindBusinessCalendar({ store, connectionService: service, ownerId: "local-owner", businessId: business.id, calendarId: CALENDAR_ID });
  return { dir, store, service, providers, gmail, tasks: new FakeTasksChannel(), businessId: business.id };
}

function cleanupFx(fx: Fx): void {
  try {
    fx.store.close();
  } catch {
    // Already closed.
  }
  rmSync(fx.dir, { recursive: true, force: true });
}

function journeyPlanner(): ExecutionPlanner {
  let step = 0;
  return {
    async planCall(history) {
      step += 1;
      if (step === 1) return { tool: "gather.read_inquiry", args: {} };
      if (step === 2) {
        const body = String((history[0]?.result as { body?: unknown })?.body ?? "");
        assert.ok(body.includes(INQUIRY_TEXT.slice(0, 40)), "planner works from the read inquiry");
        return { tool: "gather.read_venue_policy", args: {} };
      }
      if (step === 3) return { tool: "gather.check_availability", args: { ...SLOT } };
      if (step === 4) {
        return {
          tool: "gather.prepare_proposal",
          args: { ...SLOT, guestCount: 12, notes: "Two vegetarian meals on request; GATHER TEST only." },
        };
      }
      return { done: true };
    },
  };
}

function baseInput(fx: Fx, extra?: Record<string, unknown>) {
  return {
    businessId: fx.businessId,
    threadId: THREAD_ID,
    fileId: FILE_ID,
    calendarId: CALENDAR_ID,
    mode: "scripted" as const,
    ...(extra ?? {}),
  };
}

function baseDeps(fx: Fx, extra?: Record<string, unknown>) {
  return {
    store: fx.store,
    providers: fx.providers,
    model: MODEL,
    tasks: new GatherRuntimeTasks(fx.tasks as unknown as import("../src/runtime/client.ts").GatewayRequestChannel),
    planner: journeyPlanner(),
    now: () => "2026-09-14T00:00:00.000Z",
    ...(extra ?? {}),
  };
}

test("model-called MCP journey prepares the exact source-linked proposal", async () => {
  const fx = await fixture();
  try {
    const record = await runLiveExecution(baseInput(fx, { idempotencyKey: "exec-1" }), baseDeps(fx));
    assert.equal(record.status, "ok");
    assert.equal(record.simulated, true);
    assert.equal(record.steps.length, 4);
    assert.ok(record.steps.every((step) => step.ok));
    const proposal = record.proposal!;
    assert.deepEqual(proposal.terms, {
      startAt: SLOT.startAt,
      endAt: SLOT.endAt,
      guestCount: 12,
      perPersonGbp: 50,
      totalGbp: 600,
      notes: "Two vegetarian meals on request; GATHER TEST only.",
    });
    const locators = proposal.evidence.map((source) => source.locator).sort();
    assert.deepEqual(locators, [`calendar://${CALENDAR_ID}`, `drive://file/${FILE_ID}`, `gmail://thread/${THREAD_ID}`]);
    // Controlled recipient is server-scoped, never model-chosen.
    const action = fx.store.getProposedAction(proposal.proposedActionId);
    assert.equal(action.status, "pending_approval");
    assert.deepEqual((action.payload as { emailTo?: string[] }).emailTo, [CONTROLLED_TEST_RECIPIENT]);
    // Durable tool-call audit mirrors the four MCP invocations.
    const calls = listToolCalls(fx.store, record.runId);
    assert.deepEqual(calls.map((call) => [call.tool, call.ok]), [
      ["gather.read_inquiry", true],
      ["gather.read_venue_policy", true],
      ["gather.check_availability", true],
      ["gather.prepare_proposal", true],
    ]);
    // Task lifecycle rode the channel exactly once; capture wrote nothing.
    assert.equal(fx.tasks.submits.length, 1);
    const writes = fx.gmail.requests.filter((req) => req.method === "POST" && !req.url.includes("/freeBusy"));
    assert.deepEqual(writes, []);
    assert.deepEqual(getLiveRun(fx.store, record.runId)?.status, "ok");
  } finally {
    cleanupFx(fx);
  }
});

test("prepare-first is refused: the model cannot forge same-run evidence", async () => {
  const fx = await fixture();
  try {
    const planner: ExecutionPlanner = {
      async planCall(history) {
        if (history.length === 0) {
          return { tool: "gather.prepare_proposal", args: { ...SLOT, guestCount: 12, notes: "forged" } };
        }
        return { done: true };
      },
    };
    await assert.rejects(
      runLiveExecution(baseInput(fx), baseDeps(fx, { planner })),
      (error: unknown) => error instanceof LiveModelError && error.code === "TOOL_FAILURE",
    );
    const count = (fx.store.db.prepare("SELECT COUNT(*) AS n FROM proposed_actions").all() as Array<{ n: number }>)[0]?.n ?? 0;
    assert.equal(count, 0, "no proposal row from forged evidence");
    const countBookings = (fx.store.db.prepare("SELECT COUNT(*) AS n FROM bookings").all() as Array<{ n: number }>)[0]?.n ?? 0;
    assert.equal(countBookings, 0);
  } finally {
    cleanupFx(fx);
  }
});

test("run timeout preserves the continuing id without duplicates", async () => {
  const fx = await fixture();
  try {
    const hanging: ExecutionPlanner = { planCall: () => new Promise(() => {}) };
    const first = await runLiveExecution(baseInput(fx, { idempotencyKey: "exec-slow", runTimeoutMs: 200 }), baseDeps(fx, { planner: hanging }));
    assert.equal(first.status, "continuing");
    assert.match(first.error ?? "", /deadline/);
    // Resume under the same caller key: no duplicate gateway submit, one proposal total.
    const second = await runLiveExecution(baseInput(fx, { idempotencyKey: "exec-slow" }), baseDeps(fx));
    assert.equal(second.status, "ok");
    assert.notEqual(second.runId, first.runId);
    assert.equal(fx.tasks.submits.length, 1, "gateway idempotency key dedupes the provider run");
    const proposals = (fx.store.db.prepare("SELECT COUNT(*) AS n FROM proposed_actions").all() as Array<{ n: number }>)[0]?.n ?? 0;
    assert.equal(proposals, 1);
  } finally {
    cleanupFx(fx);
  }
});

test("unauthenticated MCP transport is refused before any tool runs", async () => {
  const fx = await fixture();
  let scoped: ScopedExecution | undefined;
  try {
    const gmail = fx.providers.resolveAccountPorts({ businessId: fx.businessId, capability: "gmail" });
    const drive = fx.providers.resolveAccountPorts({ businessId: fx.businessId, capability: "google_drive" });
    assert.ok(gmail.ok && drive.ok);
    if (!gmail.ok || !drive.ok) throw new Error("ports required");
    const { createLiveMcpTools, startScopedExecutionHost } = await import("../src/server/live-model/index.ts");
    const audit: Array<unknown> = [];
    scoped = await startScopedExecutionHost({
      model: MODEL,
      tools: createLiveMcpTools({
        store: fx.store,
        businessId: fx.businessId,
        accountId: "acct-test",
        runId: "lmr-probe",
        threadId: THREAD_ID,
        fileId: FILE_ID,
        calendarId: CALENDAR_ID,
        recipient: CONTROLLED_TEST_RECIPIENT,
        threads: gmail.ports.threads!,
        documents: drive.ports.documents!,
        calendar: fx.providers.calendar,
        execution: "simulated",
        audit: (entry) => audit.push(entry),
        state: {},
      }),
    });
    const response = await fetch(scoped.boundaryUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "0" } } }),
    });
    assert.equal(response.status, 401, "no bearer token means no session and no tool dispatch");
    assert.equal(audit.length, 0, "refused transport reaches no handler");
  } finally {
    await scoped?.close().catch(() => undefined);
    cleanupFx(fx);
  }
});
test("same key with changed designated inputs rejects instead of aliasing", async () => {
  const fx = await fixture();
  try {
    const first = await runLiveExecution(baseInput(fx, { idempotencyKey: "exec-fixed" }), baseDeps(fx));
    assert.equal(first.status, "ok");
    const submitsBefore = fx.tasks.submits.length;
    await assert.rejects(
      runLiveExecution(baseInput(fx, { idempotencyKey: "exec-fixed", threadId: "t-other" }), baseDeps(fx)),
      (error: unknown) => error instanceof LiveModelError && error.code === "INVALID_REQUEST",
    );
    assert.equal(fx.tasks.submits.length, submitsBefore, "rejected resubmit never reaches the provider");
  } finally {
    cleanupFx(fx);
  }
});

test("concurrent duplicates collapse onto one run without duplicate work", async () => {
  const fx = await fixture();
  try {
    const input = baseInput(fx, { idempotencyKey: "exec-race" });
    const [left, right] = await Promise.all([
      runLiveExecution(input, baseDeps(fx)),
      runLiveExecution(input, baseDeps(fx)),
    ]);
    assert.equal(left.runId, right.runId, "loser receives the winner's claimed run");
    assert.equal(fx.tasks.submits.length, 1, "one provider run for concurrent duplicates");
    const proposals = (fx.store.db.prepare("SELECT COUNT(*) AS n FROM proposed_actions").all() as Array<{ n: number }>)[0]?.n ?? 0;
    assert.equal(proposals, 1);
  } finally {
    cleanupFx(fx);
  }
});

test("live mode without consent reads nothing; missing model is explicit", async () => {
  const fx = await fixture();
  try {
    const callsBefore = fx.gmail.requests.length;
    await assert.rejects(
      runLiveExecution({ ...baseInput(fx), mode: "live", allowLive: true }, baseDeps(fx)),
      (error: unknown) => error instanceof LiveModelError && error.code === "LIVE_NOT_AUTHORIZED",
    );
    assert.equal(fx.gmail.requests.length, callsBefore);
    await assert.rejects(
      runLiveExecution(baseInput(fx), { ...baseDeps(fx), model: undefined }),
      (error: unknown) => error instanceof LiveModelError && error.code === "MODEL_UNCONFIGURED",
    );
  } finally {
    cleanupFx(fx);
  }
});

/**
 * Live-path scripted verification: the REAL lifecycle (runtime.start() ->
 * run-scoped MCP boundary on loopback -> runtime.tasks submit/wait ->
 * server-side audit/proposal read-back) runs end-to-end. The only stand-in
 * is the gateway child + WS connection pair; a scripted "model" drives the
 * four tools over the real boundary, exactly what the isolated agent would
 * do through the gateway's own MCP client. No planner exists on this path.
 */
test("live path: runtime.tasks drives the run and the proposal is read server-side", async () => {
  const fx = await fixture();
  process.env.GATHER_LIVE_CONSENT = "1";
  try {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const { GatherOpenClawRuntime } = await import("../src/runtime/openclaw-runtime.ts");
    const agentCalls: Array<{ sessionKey?: unknown; idempotencyKey?: unknown; message?: unknown }> = [];
    let rt: InstanceType<typeof GatherOpenClawRuntime> | undefined;
    let processStopped = false;
    const conn = {
      ready: false,
      get isReady() { return this.ready; },
      currentState: "disconnected" as const,
      async connect() { this.ready = true; },
      async close() { this.ready = false; },
      async request<T>(method: string, params?: unknown): Promise<T> {
        const p = (params ?? {}) as Record<string, unknown>;
        if (method === "agent") {
          agentCalls.push(p);
          // The scripted model stand-in: drive the four tools over the REAL
          // boundary the started runtime is serving (loopback + bearer).
          const client = new Client({ name: "scripted-model", version: "0.1.0" });
          await client.connect(new StreamableHTTPClientTransport(new URL(rt!.mcpUrl!), {
            requestInit: { headers: { authorization: `Bearer ${rt!.mcpAuthToken}` } },
          }));
          await client.callTool({ name: "gather.read_inquiry", arguments: {} });
          await client.callTool({ name: "gather.read_venue_policy", arguments: {} });
          await client.callTool({ name: "gather.check_availability", arguments: { ...SLOT } });
          await client.callTool({ name: "gather.prepare_proposal", arguments: { ...SLOT, guestCount: 12, notes: "GATHER TEST only." } });
          await client.close();
          return { runId: "gw-live-run-1", acceptedAt: 1700000000000 } as T;
        }
        if (method === "agent.wait") {
          return { status: "ok", runId: String(p.runId), endedAt: 1700000001000 } as T;
        }
        throw new Error(`unexpected method ${method}`);
      },
    };
    const record = await runLiveExecution(
      { ...baseInput(fx), mode: "live", allowLive: true, idempotencyKey: "exec-live-1" },
      baseDeps(fx, {
        tasks: undefined,
        planner: undefined,
        runtimeFactory: (options: unknown, deps: unknown) => {
          rt = new GatherOpenClawRuntime(
            options as ConstructorParameters<typeof GatherOpenClawRuntime>[0],
            {
              ...(deps as object),
              processFactory: () => ({
                gatewayToken: "gw-token",
                pid: 4242,
                currentState: processStopped ? "stopped" : "running",
                async start() {},
                async stop() { processStopped = true; },
              }),
              connectionFactory: () => conn as never,
            },
          );
          return rt;
        },
      }),
    );
    assert.equal(record.status, "ok");
    assert.equal(record.simulated, false);
    // One submit through runtime.tasks carrying the instruction; the run
    // record's steps come from the durable audit, not the model's reply.
    assert.equal(agentCalls.length, 1);
    assert.match(String(agentCalls[0]?.message ?? ""), /gather\.read_inquiry/);
    assert.deepEqual(
      record.steps.map((step) => [step.tool, step.ok]),
      [["readInquiry", true], ["readVenuePolicy", true], ["checkAvailability", true], ["prepareProposal", true]],
    );
    const proposal = record.proposal!;
    assert.equal(proposal.terms.totalGbp, 600);
    const action = fx.store.getProposedAction(proposal.proposedActionId);
    assert.equal(action.status, "pending_approval");
    const calls = listToolCalls(fx.store, record.runId);
    assert.equal(calls.length, 4);
    // The owned runtime was reaped by close().
    assert.equal(processStopped, true);
  } finally {
    delete process.env.GATHER_LIVE_CONSENT;
    cleanupFx(fx);
  }
});

test("live path: wait timeout preserves the run identity as continuing", async () => {
  const fx = await fixture();
  process.env.GATHER_LIVE_CONSENT = "1";
  try {
    const { GatherOpenClawRuntime } = await import("../src/runtime/openclaw-runtime.ts");
    const conn = {
      get isReady() { return true; },
      currentState: "ready" as const,
      async connect() {},
      async close() {},
      async request<T>(method: string, params?: unknown): Promise<T> {
        const p = (params ?? {}) as Record<string, unknown>;
        if (method === "agent") return { runId: "gw-live-run-slow", acceptedAt: 1700000000000 } as T;
        if (method === "agent.wait") return { status: "timeout", runId: String(p.runId) } as T;
        throw new Error(`unexpected method ${method}`);
      },
    };
    const record = await runLiveExecution(
      { ...baseInput(fx), mode: "live", allowLive: true, idempotencyKey: "exec-live-slow", runTimeoutMs: 300 },
      baseDeps(fx, {
        tasks: undefined,
        planner: undefined,
        runtimeFactory: (options: unknown, deps: unknown) =>
          new GatherOpenClawRuntime(
            options as ConstructorParameters<typeof GatherOpenClawRuntime>[0],
            {
              ...(deps as object),
              processFactory: () => ({ gatewayToken: "gw-token", pid: 1, currentState: "running", async start() {}, async stop() {} }),
              connectionFactory: () => conn as never,
            },
          ),
      }),
    );
    assert.equal(record.status, "continuing");
    assert.match(record.error ?? "", /gw-live-run-slow/);
  } finally {
    delete process.env.GATHER_LIVE_CONSENT;
    cleanupFx(fx);
  }
});

test("live path: replaying a continuing run returns pending without a duplicate submit", async () => {
  const fx = await fixture();
  process.env.GATHER_LIVE_CONSENT = "1";
  try {
    const { GatherOpenClawRuntime } = await import("../src/runtime/openclaw-runtime.ts");
    let agentSubmits = 0;
    const conn = {
      get isReady() { return true; },
      currentState: "ready" as const,
      async connect() {},
      async close() {},
      async request<T>(method: string, params?: unknown): Promise<T> {
        const p = (params ?? {}) as Record<string, unknown>;
        if (method === "agent") { agentSubmits += 1; return { runId: "gw-live-run-slow", acceptedAt: 1700000000000 } as T; }
        if (method === "agent.wait") return { status: "timeout", runId: String(p.runId) } as T;
        throw new Error(`unexpected method ${method}`);
      },
    };
    const deps = baseDeps(fx, {
      tasks: undefined,
      planner: undefined,
      runtimeFactory: (options: unknown, runtimeDeps: unknown) =>
        new GatherOpenClawRuntime(
          options as ConstructorParameters<typeof GatherOpenClawRuntime>[0],
          {
            ...(runtimeDeps as object),
            processFactory: () => ({ gatewayToken: "gw-token", pid: 1, currentState: "running", async start() {}, async stop() {} }),
            connectionFactory: () => conn as never,
          },
        ),
    });
    const input = { ...baseInput(fx), mode: "live" as const, allowLive: true, idempotencyKey: "exec-live-dupe", runTimeoutMs: 300 };
    const first = await runLiveExecution(input, deps);
    assert.equal(first.status, "continuing");
    assert.equal(first.gatewayRunId, "gw-live-run-slow");
    // Same key while the remote run may still be executing: honest pending,
    // never a second remote run under the same caller key.
    const second = await runLiveExecution(input, deps);
    assert.equal(second.runId, first.runId);
    assert.equal(second.status, "continuing");
    assert.equal(second.gatewayRunId, "gw-live-run-slow");
    assert.equal(agentSubmits, 1, "a continuing live run is never re-submitted");
  } finally {
    delete process.env.GATHER_LIVE_CONSENT;
    cleanupFx(fx);
  }
});

// --- Proposal-contract composition regression -----------------------------
// The generated proposal must compose with the REAL approval pipeline:
// create_provisional_hold kind, explicit calendarId/expiresAt, then
// previewConsequences -> approveAndExecute -> scripted hold + email receipts.

import { approveAndExecute, previewConsequences } from "../src/server/booking-service.ts";
import type { BookingServiceDeps } from "../src/server/booking-service.ts";
import type {
  CalendarConnector,
  CheckAvailabilityRequest,
  CreateProvisionalHoldRequest,
  EmailSender,
  ProvisionalHold,
  SendEmailRequest,
  SentEmail,
} from "../src/connectors/contracts.ts";
import type { SourceReference } from "../src/domain/contracts.ts";
import { DEMO_MODE } from "../src/connectors/contracts.ts";

const SCRIPTED_META = (operationKey: string) => ({ operationKey, sourceReferences: [SCRIPTED_SOURCE], mode: DEMO_MODE, simulated: true as const });

const SCRIPTED_SOURCE: SourceReference = { kind: "calendar", locator: "scripted://approval-connectors", label: "Scripted approval connectors", fictional: true };

class ScriptedApprovalCalendar implements CalendarConnector {
  holds: ProvisionalHold[] = [];
  async checkAvailability(req: CheckAvailabilityRequest) {
    return {
      status: "succeeded" as const,
      metadata: SCRIPTED_META(req.operationKey),
      data: {
        slots: [{ slotId: "s-free", calendarId: req.calendarId, startAt: req.startAt, endAt: req.endAt, available: true, sourceReferences: [SCRIPTED_SOURCE] }],
        provenance: [SCRIPTED_SOURCE],
      },
    };
  }
  async createProvisionalHold(req: CreateProvisionalHoldRequest) {
    const hold: ProvisionalHold = {
      holdId: `hold-${this.holds.length + 1}`,
      operationKey: req.operationKey,
      bookingId: req.bookingId,
      calendarId: req.calendarId,
      startAt: req.startAt,
      endAt: req.endAt,
      expiresAt: req.expiresAt,
      status: "provisional_hold",
      createdAt: "2026-09-14T00:00:00.000Z",
      sourceReferences: [SCRIPTED_SOURCE],
    };
    this.holds.push(hold);
    return { status: "succeeded" as const, metadata: SCRIPTED_META(req.operationKey), data: { hold, provenance: [SCRIPTED_SOURCE] } };
  }
  async reconcileProvisionalHold(req: { operationKey: string }) {
    const hold = this.holds.find((entry) => entry.operationKey === req.operationKey);
    if (!hold) return { status: "failed" as const, metadata: SCRIPTED_META(req.operationKey), error: { kind: "not_found" as const, message: "no such hold", retryable: false } };
    return { status: "succeeded" as const, metadata: SCRIPTED_META(req.operationKey), data: { hold, provenance: [SCRIPTED_SOURCE] } };
  }
}

class ScriptedApprovalEmail implements EmailSender {
  sent: SentEmail[] = [];
  async sendEmail(req: SendEmailRequest) {
    const sentEmail: SentEmail = {
      messageId: `sent-${this.sent.length + 1}`,
      operationKey: req.operationKey,
      to: req.to,
      cc: req.cc ?? [],
      subject: req.subject,
      body: req.body,
      sentAt: "2026-09-14T00:00:00.000Z",
      sourceReferences: [SCRIPTED_SOURCE],
    };
    this.sent.push(sentEmail);
    return { status: "succeeded" as const, metadata: SCRIPTED_META(req.operationKey), data: { sentEmail, provenance: [SCRIPTED_SOURCE] } };
  }
  async reconcileSentEmail(req: { operationKey: string }) {
    const sentEmail = this.sent.find((entry) => entry.operationKey === req.operationKey);
    if (!sentEmail) return { status: "failed" as const, metadata: SCRIPTED_META(req.operationKey), error: { kind: "not_found" as const, message: "no such email", retryable: false } };
    return { status: "succeeded" as const, metadata: SCRIPTED_META(req.operationKey), data: { sentEmail, provenance: [SCRIPTED_SOURCE] } };
  }
}

test("generated proposal composes through the real approval pipeline to hold + email receipts", async () => {
  const fx = await fixture();
  try {
    const record = await runLiveExecution(baseInput(fx, { idempotencyKey: "exec-compose" }), baseDeps(fx));
    assert.equal(record.status, "ok");
    const proposal = record.proposal!;
    const action = fx.store.getProposedAction(proposal.proposedActionId);
    assert.equal(action.kind, "create_provisional_hold", "proposal kind matches the only executable plan");
    const payload = action.payload as Record<string, unknown>;
    assert.equal(payload.calendarId, CALENDAR_ID, "server-bound calendar, never a model argument");
    const expiresAt = String(payload.expiresAt);
    assert.ok(Date.parse(expiresAt) > Date.parse("2026-09-14T00:00:00.000Z"), "hold expiry is in the future");
    assert.ok(Date.parse(expiresAt) < Date.parse(SLOT.startAt), "hold expiry precedes the event start");

    // GET preview: same resolver the owner review screen uses.
    const preview = previewConsequences(payload, { nowMs: Date.parse("2026-09-14T00:00:00.000Z") });
    assert.ok(preview.consequences, `preview resolves: ${preview.consequencesError ?? ""}`);
    assert.deepEqual(preview.consequences!.emailTo, [CONTROLLED_TEST_RECIPIENT]);
    assert.equal(preview.consequences!.expiresAt, expiresAt);

    // An altered (tampered fingerprint) approval is refused before any write.
    const calendar = new ScriptedApprovalCalendar();
    const email = new ScriptedApprovalEmail();
    const bookingDeps: BookingServiceDeps = {
      store: fx.store,
      calendar,
      email,
      ownerId: "local-owner",
      now: () => "2026-09-14T00:00:00.000Z",
    };
    await assert.rejects(
      () => approveAndExecute(bookingDeps, {
        bookingId: proposal.bookingId,
        proposedActionId: action.id,
        proposalVersion: action.proposalVersion,
        proposalFingerprint: "0".repeat(64),
      }),
      /Stale proposal/,
    );
    assert.equal(calendar.holds.length, 0, "refused approval writes nothing");
    assert.equal(email.sent.length, 0);

    // Exact approval executes the real plan: fresh availability, durable
    // hold on the bound calendar, then the rendered offer email.
    const approved = await approveAndExecute(bookingDeps, {
      bookingId: proposal.bookingId,
      proposedActionId: action.id,
      proposalVersion: action.proposalVersion,
      proposalFingerprint: action.proposalFingerprint,
    });
    assert.equal(approved.hold?.execution.status, "succeeded");
    assert.equal(approved.email?.execution.status, "succeeded");
    assert.equal(approved.booking.status, "provisional_hold");
    assert.equal(approved.confirmedBooking, false, "a hold is never a confirmed booking");
    assert.equal(calendar.holds.length, 1);
    assert.equal(calendar.holds[0]!.calendarId, CALENDAR_ID);
    assert.equal(calendar.holds[0]!.expiresAt, expiresAt);
    assert.equal(email.sent.length, 1);
    const sent = email.sent[0]!;
    assert.deepEqual(sent.to, [CONTROLLED_TEST_RECIPIENT]);
    assert.ok(sent.body.includes("Guests: 12"), "exact guest count in the rendered offer");
    assert.ok(sent.body.includes("GBP 600"), "exact total in the rendered offer");
    assert.ok(sent.body.includes("Europe/London"), "venue timezone in the rendered offer");
    // Times render in the business timezone: 18:00 local, never raw UTC ISO.
    assert.ok(sent.body.includes("18:00"), "event start rendered as 18:00 local");
    assert.ok(!sent.body.includes("17:00"), "UTC rendering would wrongly show 17:00");
    assert.ok(!sent.body.includes(SLOT.startAt), "raw ISO timestamp is not the displayed time");
    assert.ok(sent.body.includes("provisional"), "provisional terms in the rendered offer");
    assert.ok(sent.body.includes("customer accepts the exact date, time, guest count and price"), "customer acceptance of exact terms required");
    assert.ok(sent.body.includes("reservation is verified"), "verified reservation required before confirmation");
    assert.ok(sent.body.includes("Venue approval alone does not confirm a booking"), "venue approval alone never confirms");
    // No automatic-release promise: no provider release is wired.
    assert.ok(!/releas/i.test(sent.body), "no automatic release claim in the sent offer");
    assert.ok(!sent.body.includes("Nothing sent"), "the sent body is the offer, not a placeholder");
    assert.ok(!sent.body.includes("\u2014"), "no em dash in sent copy");
  } finally {
    cleanupFx(fx);
  }
});

test("the old send_offer shape fails the real pipeline", async () => {
  const fx = await fixture();
  try {
    const booking = fx.store.createBooking({ businessId: fx.businessId, eventName: "legacy", status: "inquiry" });
    const action = fx.store.createProposedAction({
      bookingId: booking.id,
      kind: "send_offer",
      payload: {
        startAt: SLOT.startAt,
        endAt: SLOT.endAt,
        emailTo: [CONTROLLED_TEST_RECIPIENT],
        emailSubject: "legacy",
        emailBody: "legacy body",
      },
      sourceReferences: [],
    });
    const deps: BookingServiceDeps = {
      store: fx.store,
      calendar: new ScriptedApprovalCalendar(),
      email: new ScriptedApprovalEmail(),
      ownerId: "local-owner",
      now: () => "2026-09-14T00:00:00.000Z",
    };
    await assert.rejects(
      () => approveAndExecute(deps, {
        bookingId: booking.id,
        proposedActionId: action.id,
        proposalVersion: action.proposalVersion,
        proposalFingerprint: action.proposalFingerprint,
      }),
      /Unsupported proposal kind "send_offer"/,
    );
  } finally {
    cleanupFx(fx);
  }
});
