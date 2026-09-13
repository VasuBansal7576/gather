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

const MODEL = { model: "openai-codex/gpt-5.6-luna", auth: { provider: "openai-codex", mode: "oauth" as const, profileId: "profile-test-1" } };

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
