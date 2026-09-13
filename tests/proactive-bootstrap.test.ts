import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
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
import {
  getProactiveBinding,
  listProactiveBindings,
  operatorHealth,
  resetProactiveAutomation,
  tickBinding,
} from "../src/server/operator-runtime/index.ts";
import {
  getOperatorDepsFor,
  listOperatorAccounts,
  resetOperatorDeps,
} from "../src/server/operator-runtime/host.ts";
import {
  bindBusinessCalendar,
  CalendarBindError,
  ensureProactiveHost,
  getBusinessCalendar,
  proactiveHostStatus,
  refreshProactiveHost,
  resetProactiveHostForTests,
  stopProactiveHost,
} from "../src/server/proactive/index.ts";
import { createProviderConnectors, type ProviderConnectors } from "../src/server/provider-runtime/index.ts";
import { GatherStore } from "../src/server/sqlite-store.ts";
import type { BookingServiceDeps } from "../src/server/booking-service.ts";

/**
 * Production registration tests for the proactive host bootstrap. Every
 * provider surface is scripted fictional HTTP (FakeGmail below answers the
 * real GmailInboxPoller + thread reader through the real provider-runtime
 * ports); no live model, gateway, provider, keychain, or credentials.
 * The loop under test captures inquiries into durable rows — it never
 * generates offers (no model exists on this path by construction).
 */

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

const NOW = "2026-06-01T12:00:00.000Z";
const BODY_TEXT = "Hello, we would like a wedding dinner for 40 guests on 2026-11-01.";
const BODY_B64URL = Buffer.from(BODY_TEXT, "utf-8").toString("base64url");

function threadPayload(threadId: string, messageId: string): Record<string, unknown> {
  return {
    id: threadId,
    messages: [
      {
        id: messageId,
        threadId,
        labelIds: ["INBOX"],
        snippet: BODY_TEXT.slice(0, 40),
        payload: {
          headers: [
            { name: "From", value: "Customer <customer@example.test>" },
            { name: "To", value: "owner@example.test" },
            { name: "Subject", value: "Wedding dinner inquiry" },
            { name: "Date", value: "Mon, 01 Jun 2026 12:00:00 +0000" },
          ],
          mimeType: "text/plain",
          body: { data: BODY_B64URL },
        },
      },
    ],
  };
}

class ScriptedOAuth implements OAuthTransport {
  tokenCalls = 0;
  identities = new Map<string, { accountKey: string; displayName: string }>();
  async exchangeCode(input: { code: string } & Record<string, unknown>): Promise<OAuthTokenResponse> {
    this.tokenCalls += 1;
    const identity = this.identities.get(input.code) ?? { accountKey: "google-sub-1", displayName: "Fictional Owner" };
    return {
      accessToken: `access-${identity.accountKey}`,
      refreshToken: `refresh-${identity.accountKey}`,
      expiresInSec: 3600,
      scope: APP.requiredScopes.join(" "),
    };
  }
  async refresh(): Promise<OAuthTokenResponse> {
    this.tokenCalls += 1;
    return { accessToken: "access-refreshed", expiresInSec: 3600, scope: APP.requiredScopes.join(" ") };
  }
  async fetchAccountIdentity(input: { accessToken: string }): Promise<{ accountKey: string; displayName: string }> {
    const accountKey = input.accessToken.replace("access-", "");
    return { accountKey, displayName: `Fictional ${accountKey}` };
  }
  async revokeToken(): Promise<void> {}
}

interface MailboxScript {
  historyId: string;
  listed: Array<{ id: string; threadId: string }>;
  added: Array<{ id: string; threadId: string }>;
  failInbox: boolean;
}

/** Scripted fictional Gmail: per-bearer-token mailboxes over the real poller/reader. */
class ScriptedGmail {
  requests: GoogleHttpRequest[] = [];
  boxes = new Map<string, MailboxScript>();
  boxFor(auth: string): MailboxScript {
    let box = this.boxes.get(auth);
    if (!box) {
      box = { historyId: "9000", listed: [], added: [], failInbox: false };
      this.boxes.set(auth, box);
    }
    return box;
  }
  json(status: number, body: unknown): GoogleHttpResponse {
    return { status, headers: {}, text: JSON.stringify(body) };
  }
  async request(req: GoogleHttpRequest): Promise<GoogleHttpResponse> {
    this.requests.push(req);
    const auth = req.headers.Authorization ?? "";
    const box = this.boxFor(auth);
    if (box.failInbox && (req.url.includes("/history") || req.url.includes("/messages") || req.url.includes("/profile"))) {
      return this.json(500, { error: { message: "fictional mailbox failure" } });
    }
    if (req.url.includes("/profile")) {
      return this.json(200, { emailAddress: "owner@example.test", historyId: box.historyId });
    }
    const threadMatch = /\/threads\/([^/?]+)/.exec(req.url);
    if (threadMatch && req.method === "GET") {
      const threadId = decodeURIComponent(threadMatch[1]);
      const known = [...box.listed, ...box.added].find((item) => item.threadId === threadId);
      if (!known) return this.json(404, {});
      return this.json(200, threadPayload(threadId, known.id));
    }
    if (req.url.includes("/history") && req.method === "GET") {
      const added = box.added.splice(0, box.added.length);
      return this.json(200, {
        historyId: box.historyId,
        history: added.length === 0 ? [] : [{ id: box.historyId, messagesAdded: added.map((item) => ({ message: item })) }],
      });
    }
    if (req.url.includes("/messages") && req.method === "GET") {
      return this.json(200, {
        messages: box.listed.map((item) => ({ id: item.id, threadId: item.threadId })),
        resultSizeEstimate: box.listed.length,
        historyId: box.historyId,
      });
    }
    return this.json(404, {});
  }
  getPosts(): GoogleHttpRequest[] {
    return this.requests.filter((req) => req.method === "POST");
  }
}

interface Fx {
  dir: string;
  dbPath: string;
  store: GatherStore;
  oauth: ScriptedOAuth;
  gmail: ScriptedGmail;
  secrets: MemorySecretStore;
  service: ConnectionService;
  providers: ProviderConnectors;
  booking: BookingServiceDeps;
}

function fixture(googleApp: GoogleProviderApp | null = APP): Fx {
  const dir = mkdtempSync(join(tmpdir(), "gather-proactive-bootstrap-"));
  const dbPath = join(dir, "gather.sqlite");
  const store = new GatherStore(dbPath);
  const secrets = new MemorySecretStore();
  const oauth = new ScriptedOAuth();
  const gmail = new ScriptedGmail();
  const service = new ConnectionService({ store, secrets, transport: oauth, googleApp: googleApp ?? undefined, ownerId: "local-owner" });
  const demo = createDemoConnectors({ calendarSlots: demoFixtureSlots() });
  const providers = createProviderConnectors({
    store,
    ownerId: "local-owner",
    demo: { calendar: new DurableDemoCalendar(store, demo.calendar), email: new DurableDemoEmail(store, demo.email) },
    connectionService: service,
    transport: { request: (req) => gmail.request(req) },
  });
  const booking: BookingServiceDeps = {
    store,
    calendar: providers.calendar,
    email: providers.email,
    ownerId: "local-owner",
    now: () => NOW,
  };
  return { dir, dbPath, store, oauth, gmail, secrets, service, providers, booking };
}

function cleanupFx(fx: Fx): void {
  resetProactiveHostForTests();
  resetProactiveAutomation();
  resetOperatorDeps();
  try {
    fx.store.close();
  } catch {
    // Already closed (restart path closes its first handle early).
  }
  rmSync(fx.dir, { recursive: true, force: true });
}

async function connectAccount(fx: Fx, businessId: string, code: string, accountKey: string): Promise<void> {
  fx.oauth.identities.set(code, { accountKey, displayName: `Fictional ${accountKey}` });
  const start = fx.service.startAuthorization({ businessId, provider: "google" });
  const state = new URL(start.authorizationUrl).searchParams.get("state") ?? "";
  await fx.service.completeAuthorization({ code, state });
}

function gmailAccountId(fx: Fx, businessId: string): string {
  const summary = fx.service.getConnections(businessId);
  const account = summary.providers.flatMap((provider) => provider.accounts).find((entry) => entry.provider === "gmail");
  assert.ok(account, "connected gmail account");
  return account.id;
}

function hosted(fx: Fx): void {
  ensureProactiveHost({
    store: fx.store,
    ownerId: "local-owner",
    providers: fx.providers,
    booking: fx.booking,
    connectionService: fx.service,
    intervalMs: 30_000,
    maxConsecutiveErrors: 1,
    now: () => NOW,
    provenance: { simulated: true, label: "scripted-fictional-http" },
  });
}

function intakeItemCount(fx: Fx, messageId?: string): number {
  const rows = fx.store.db
    .prepare(
      messageId === undefined
        ? "SELECT COUNT(*) AS n FROM intake_items"
        : "SELECT COUNT(*) AS n FROM intake_items WHERE message_id = $m",
    )
    .all(messageId === undefined ? {} : { $m: messageId }) as Array<{ n: number }>;
  return Number(rows[0]?.n ?? 0);
}

function tableCount(fx: Fx, table: string): number {
  const rows = fx.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).all() as Array<{ n: number }>;
  return Number(rows[0]?.n ?? 0);
}

test("composed loop captures a live-resolved inquiry without generating offers", async () => {
  const fx = fixture();
  try {
    const business = fx.store.createBusiness({ name: "Fictional Hall", timezone: "UTC" });
    await connectAccount(fx, business.id, "code-a", "google-sub-a");
    const bearer = "Bearer access-google-sub-a";
    fx.gmail.boxFor(bearer).listed.push({ id: "m-1", threadId: "t-1" });
    hosted(fx);

    const report = await refreshProactiveHost();
    assert.equal(report.errors.length, 0);
    const accountId = gmailAccountId(fx, business.id);
    assert.ok(listOperatorAccounts().includes(accountId), "operator deps wired without a typed prompt");
    // No watching claim before a real sweep has succeeded.
    assert.equal(proactiveHostStatus().accounts.find((entry) => entry.accountId === accountId)?.watching, false);

    const tick = await tickBinding(accountId);
    assert.equal(tick.ok, true);
    assert.equal(tick.skippedOverlap, false);
    assert.equal(intakeItemCount(fx, "m-1"), 1, "inquiry captured into a durable row");
    assert.ok(tableCount(fx, "intake_batches") >= 1, "capture batch receipt persisted");
    // Capture only: no proposals, no holds, no sends, no model anywhere.
    assert.equal(tableCount(fx, "proposed_actions"), 0);
    assert.deepEqual(fx.gmail.getPosts(), [], "no provider writes on the capture path");
    assert.equal(proactiveHostStatus().accounts.find((entry) => entry.accountId === accountId)?.watching, true);
    const binding = getProactiveBinding(accountId);
    assert.equal(binding?.status, "running");
  } finally {
    await stopProactiveHost(1000).catch(() => undefined);
    cleanupFx(fx);
  }
});

test("demo-only and unconfigured setups register nothing and trigger no external calls", async () => {
  const fx = fixture();
  try {
    fx.store.createBusiness({ name: "Demo Hall", timezone: "UTC" });
    hosted(fx);
    const report = await refreshProactiveHost();
    assert.deepEqual(report.accounts, []);
    assert.deepEqual(listOperatorAccounts(), []);
    assert.deepEqual(listProactiveBindings(), []);
    assert.equal(fx.gmail.requests.length, 0, "no provider HTTP without a connection");
    assert.equal(fx.oauth.tokenCalls, 0, "no token supply without a connection");
  } finally {
    await stopProactiveHost(1000).catch(() => undefined);
    cleanupFx(fx);
  }
});

test("missing provider configuration exposes the truth and stays silent", async () => {
  const fx = fixture(null);
  try {
    const business = fx.store.createBusiness({ name: "Naked Hall", timezone: "UTC" });
    void business;
    hosted(fx);
    const report = await refreshProactiveHost();
    assert.equal(report.providerConfigured, false);
    assert.deepEqual(listProactiveBindings(), []);
    assert.equal(fx.gmail.requests.length, 0);
  } finally {
    await stopProactiveHost(1000).catch(() => undefined);
    cleanupFx(fx);
  }
});

test("restart reuses the durable cursor: no duplicates on redelivery", async () => {
  const fx = fixture();
  let second: GatherStore | undefined;
  try {
    const business = fx.store.createBusiness({ name: "Restart Hall", timezone: "UTC" });
    await connectAccount(fx, business.id, "code-a", "google-sub-a");
    const bearer = "Bearer access-google-sub-a";
    fx.gmail.boxFor(bearer).listed.push({ id: "m-1", threadId: "t-1" });
    hosted(fx);
    await refreshProactiveHost();
    const accountId = gmailAccountId(fx, business.id);
    assert.equal((await tickBinding(accountId)).ok, true);
    assert.equal(intakeItemCount(fx, "m-1"), 1);

    // Redelivery of the same provider message dedupes to the canonical row.
    fx.gmail.boxFor(bearer).added.push({ id: "m-1", threadId: "t-1" });
    assert.equal((await tickBinding(accountId)).ok, true);
    assert.equal(intakeItemCount(fx, "m-1"), 1, "redelivered message dedupes instead of duplicating");

    // Restart: new handles over the same database file keep the watermark.
    fx.store.close();
    resetProactiveHostForTests();
    resetProactiveAutomation();
    resetOperatorDeps();
    second = new GatherStore(fx.dbPath);
    const service2 = new ConnectionService({ store: second, secrets: fx.secrets, transport: fx.oauth, googleApp: APP, ownerId: "local-owner" });
    const demo = createDemoConnectors({ calendarSlots: demoFixtureSlots() });
    const providers2 = createProviderConnectors({
      store: second,
      ownerId: "local-owner",
      demo: { calendar: new DurableDemoCalendar(second, demo.calendar), email: new DurableDemoEmail(second, demo.email) },
      connectionService: service2,
      transport: { request: (req) => fx.gmail.request(req) },
    });
    ensureProactiveHost({
      store: second,
      ownerId: "local-owner",
      providers: providers2,
      booking: { store: second, calendar: providers2.calendar, email: providers2.email, ownerId: "local-owner", now: () => NOW },
      connectionService: service2,
      intervalMs: 30_000,
      now: () => NOW,
      provenance: { simulated: true, label: "scripted-fictional-http" },
    });
    await refreshProactiveHost();
    fx.gmail.boxFor(bearer).added.push({ id: "m-1", threadId: "t-1" });
    assert.equal((await tickBinding(accountId)).ok, true);
    const rows = second.db
      .prepare("SELECT COUNT(*) AS n FROM intake_items WHERE message_id = $m")
      .all({ $m: "m-1" }) as Array<{ n: number }>;
    assert.equal(Number(rows[0]?.n ?? 0), 1, "post-restart redelivery still dedupes via the durable cursor");
  } finally {
    await stopProactiveHost(1000).catch(() => undefined);
    try {
      second?.close();
    } catch {
      // Already closed on the happy path.
    }
    cleanupFx(fx);
  }
});

test("revoked bindings degrade at once and stop calling the provider", async () => {
  const fx = fixture();
  try {
    const business = fx.store.createBusiness({ name: "Revoke Hall", timezone: "UTC" });
    await connectAccount(fx, business.id, "code-a", "google-sub-a");
    hosted(fx);
    await refreshProactiveHost();
    const accountId = gmailAccountId(fx, business.id);
    assert.ok(getProactiveBinding(accountId), "binding registered while connected");

    await fx.service.disconnect({ accountId, businessId: business.id });
    const callsBefore = fx.gmail.requests.length;
    const report = await refreshProactiveHost();
    assert.equal(report.errors.length, 0);
    assert.equal(getOperatorDepsFor(accountId), null, "operator wiring removed with the binding");
    const binding = getProactiveBinding(accountId);
    assert.ok(binding === undefined || binding.status !== "running", "no running binding after revoke");
    const tick = await tickBinding(accountId);
    assert.equal(tick.ok, false, "manual sweep refuses the revoked account");
    assert.equal(fx.gmail.requests.length, callsBefore, "no provider calls after revoke");
  } finally {
    await stopProactiveHost(1000).catch(() => undefined);
    cleanupFx(fx);
  }
});

test("paused businesses stop without losing wiring; unpause resumes", async () => {
  const fx = fixture();
  try {
    const business = fx.store.createBusiness({ name: "Pause Hall", timezone: "UTC" });
    await connectAccount(fx, business.id, "code-a", "google-sub-a");
    hosted(fx);
    await refreshProactiveHost();
    const accountId = gmailAccountId(fx, business.id);
    assert.equal(getProactiveBinding(accountId)?.status, "running");

    fx.store.db.prepare("UPDATE businesses SET status = 'paused' WHERE id = $id").run({ $id: business.id });
    await refreshProactiveHost();
    assert.equal(getProactiveBinding(accountId)?.status, "stopped", "paused business stops sweeping");
    assert.equal(proactiveHostStatus().accounts.find((entry) => entry.accountId === accountId)?.watching, false);

    fx.store.db.prepare("UPDATE businesses SET status = 'active' WHERE id = $id").run({ $id: business.id });
    await refreshProactiveHost();
    assert.equal(getProactiveBinding(accountId)?.status, "running", "unpause resumes without re-onboarding");
  } finally {
    await stopProactiveHost(1000).catch(() => undefined);
    cleanupFx(fx);
  }
});

test("one failing account neither blocks nor degrades its neighbor", async () => {
  const fx = fixture();
  try {
    const hallA = fx.store.createBusiness({ name: "Hall A", timezone: "UTC" });
    const hallB = fx.store.createBusiness({ name: "Hall B", timezone: "UTC" });
    await connectAccount(fx, hallA.id, "code-a", "google-sub-a");
    await connectAccount(fx, hallB.id, "code-b", "google-sub-b");
    fx.gmail.boxFor("Bearer access-google-sub-a").listed.push({ id: "ma-1", threadId: "ta-1" });
    fx.gmail.boxFor("Bearer access-google-sub-b").listed.push({ id: "mb-1", threadId: "tb-1" });
    // Hall B's fictional mailbox is down from the start.
    fx.gmail.boxFor("Bearer access-google-sub-b").failInbox = true;
    hosted(fx);
    const report = await refreshProactiveHost();
    assert.equal(report.errors.length, 0, "registration itself never sweeps, so B registers cleanly");
    const accountA = gmailAccountId(fx, hallA.id);
    const accountB = gmailAccountId(fx, hallB.id);

    assert.equal((await tickBinding(accountA)).ok, true);
    assert.equal(intakeItemCount(fx, "ma-1"), 1);
    // B's poll fails: the shared sweep records a durable failure (visible
    // in operator health) without throwing, so the tick resolves while
    // B captures nothing — A is unaffected throughout.
    assert.equal((await tickBinding(accountB)).ok, true);
    assert.equal(intakeItemCount(fx, "mb-1"), 0);
    const healthB = operatorHealth(getOperatorDepsFor(accountB)!);
    assert.ok(healthB.failures.length >= 1, "B's poll failure is durably logged for the owner");
    assert.equal(getProactiveBinding(accountA)?.status, "running");
    assert.equal((await tickBinding(accountA)).ok, true);

    // The mailbox heals: B captures on the next sweep with no re-onboarding.
    fx.gmail.boxFor("Bearer access-google-sub-b").failInbox = false;
    assert.equal((await tickBinding(accountB)).ok, true);
    assert.equal(intakeItemCount(fx, "mb-1"), 1, "healed mailbox captures without re-registration");
  } finally {
    await stopProactiveHost(1000).catch(() => undefined);
    cleanupFx(fx);
  }
});

test("owner calendar choice pins one verified account and hides technical mappings", async () => {
  const fx = fixture();
  try {
    const business = fx.store.createBusiness({ name: "Calendar Hall", timezone: "UTC" });
    // No calendar account yet: the owner gets an actionable code, not a guess.
    try {
      bindBusinessCalendar({ store: fx.store, connectionService: fx.service, ownerId: "local-owner", businessId: business.id, calendarId: "primary" });
      assert.fail("expected CALENDAR_ACCOUNT_MISSING");
    } catch (error) {
      assert.ok(error instanceof CalendarBindError);
      assert.equal(error.code, "CALENDAR_ACCOUNT_MISSING");
    }
    await connectAccount(fx, business.id, "code-a", "google-sub-a");
    const view = bindBusinessCalendar({ store: fx.store, connectionService: fx.service, ownerId: "local-owner", businessId: business.id, calendarId: "primary" });
    assert.equal(view.bound, true);
    assert.equal(view.calendarId, "primary");
    assert.ok(!("connectionAccountId" in view) && !("accountId" in view), "no technical mappings leak");
    assert.deepEqual(getBusinessCalendar({ store: fx.store, connectionService: fx.service, businessId: business.id }), view);

    // A second connected calendar account makes choice ambiguous instead of guessed.
    await connectAccount(fx, business.id, "code-b", "google-sub-b");
    try {
      bindBusinessCalendar({ store: fx.store, connectionService: fx.service, ownerId: "local-owner", businessId: business.id, calendarId: "primary" });
      assert.fail("expected CALENDAR_ACCOUNT_AMBIGUOUS");
    } catch (error) {
      assert.ok(error instanceof CalendarBindError);
      assert.equal(error.code, "CALENDAR_ACCOUNT_AMBIGUOUS");
    }
  } finally {
    cleanupFx(fx);
  }
});
