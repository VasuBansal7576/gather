import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import type {
  GoogleHttpRequest,
  GoogleHttpResponse,
  GoogleHttpTransport,
} from "../src/connectors/google/index.ts";
import { googleEventIdFor } from "../src/connectors/google/index.ts";
import { createDemoConnectors } from "../src/connectors/demo.ts";
import type { SourceReference } from "../src/domain/contracts.ts";
import { emailOperationKey, holdOperationKey } from "../src/server/booking-service.ts";
import {
  ConnectionService,
  MemorySecretStore,
  type GoogleProviderApp,
  type OAuthTokenResponse,
  type OAuthTransport,
} from "../src/server/connections/index.ts";
import { demoFixtureSlots, seedDemoFixtures } from "../src/server/demo-fixtures.ts";
import { DurableDemoCalendar, DurableDemoEmail } from "../src/server/durable-demo-connectors.ts";
import { createProviderConnectors, resetConnectionServicesForTests } from "../src/server/provider-runtime/index.ts";
import type { ProviderConnectors } from "../src/server/provider-runtime/index.ts";
import { GatherStore } from "../src/server/sqlite-store.ts";

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
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/calendar",
  ],
};

const LIVE_CALENDAR_ID = "live-calendar-1";
const HOLD = {
  startAt: "2026-11-01T16:00:00.000Z",
  endAt: "2026-11-01T20:00:00.000Z",
  expiresAt: "2026-11-02T20:00:00.000Z",
};

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

/** Scripted provider HTTP: records every request (incl. headers) and answers by URL. */
class ScriptedGoogle implements GoogleHttpTransport {
  requests: GoogleHttpRequest[] = [];
  /** Override per test; default answers cover freeBusy, event insert/get, and gmail send. */
  onRequest?: (req: GoogleHttpRequest) => GoogleHttpResponse | undefined;
  request(req: GoogleHttpRequest): Promise<GoogleHttpResponse> {
    this.requests.push(req);
    const custom = this.onRequest?.(req);
    if (custom) return Promise.resolve(custom);
    if (req.url.includes("/freeBusy")) {
      return Promise.resolve({ status: 200, headers: {}, text: JSON.stringify({ calendars: { [LIVE_CALENDAR_ID]: { busy: [] } } }) });
    }
    if (req.url.includes("/events") && req.method === "POST") {
      const body = JSON.parse(req.body ?? "{}") as Record<string, unknown>;
      return Promise.resolve({
        status: 200,
        headers: {},
        text: JSON.stringify({ ...body, status: "confirmed", created: "2026-10-01T00:00:00.000Z", updated: "2026-10-01T00:00:00.000Z" }),
      });
    }
    if (req.url.includes("/messages/send") && req.method === "POST") {
      return Promise.resolve({ status: 200, headers: {}, text: JSON.stringify({ id: "gmail-msg-1", threadId: "thread-1", labelIds: ["SENT"] }) });
    }
    return Promise.resolve({ status: 404, headers: {}, text: "{}" });
  }
  bearerTokens(): string[] {
    return this.requests.map((req) => req.headers.Authorization ?? "");
  }
}

const REAL_SOURCE: SourceReference = { kind: "email", locator: "gmail://thread-99", label: "Owner inbox" };

interface Fx {
  store: GatherStore;
  dir: string;
  businessId: string;
  oauth: ScriptedOAuth;
  http: ScriptedGoogle;
  secrets: MemorySecretStore;
  service: ConnectionService;
  providers: ProviderConnectors;
  cleanup: () => void;
}

function fixture(): Fx {
  const dir = mkdtempSync(join(tmpdir(), "gather-provider-runtime-"));
  const store = new GatherStore(join(dir, "gather.sqlite"));
  const business = store.createBusiness({ name: "Fictional Cedar Hall", timezone: "America/New_York" });
  const secrets = new MemorySecretStore();
  const oauth = new ScriptedOAuth();
  const http = new ScriptedGoogle();
  const service = new ConnectionService({
    store,
    secrets,
    transport: oauth,
    googleApp: APP,
    ownerId: "local-owner",
  });
  const demo = createDemoConnectors({ calendarSlots: demoFixtureSlots() });
  const providers = createProviderConnectors({
    store,
    ownerId: "local-owner",
    demo: {
      calendar: new DurableDemoCalendar(store, demo.calendar),
      email: new DurableDemoEmail(store, demo.email),
    },
    connectionService: service,
    transport: http,
  });
  return {
    store,
    dir,
    businessId: business.id,
    oauth,
    http,
    secrets,
    service,
    providers,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
      resetConnectionServicesForTests();
    },
  };
}

async function connectAccount(fx: Fx, businessId: string, code = "code-1"): Promise<void> {
  const start = fx.service.startAuthorization({ businessId, provider: "google" });
  const state = new URL(start.authorizationUrl).searchParams.get("state") ?? "";
  await fx.service.completeAuthorization({ code, state });
}

function realBooking(fx: Fx, businessId = fx.businessId) {
  const booking = fx.store.createBooking({
    businessId,
    eventName: "Real wedding dinner",
    startAt: HOLD.startAt,
    endAt: HOLD.endAt,
    guestCount: 40,
    sourceReferences: [REAL_SOURCE],
  });
  const action = fx.store.createProposedAction({
    bookingId: booking.id,
    kind: "create_provisional_hold",
    payload: {
      startAt: HOLD.startAt,
      endAt: HOLD.endAt,
      expiresAt: HOLD.expiresAt,
      calendarId: LIVE_CALENDAR_ID,
      emailTo: ["guest@example.test"],
      emailSubject: "Your Cedar Hall proposal",
      emailBody: "Proposal body",
    },
    sourceReferences: [REAL_SOURCE],
  });
  fx.store.approveProposedAction(action.id, "local-owner");
  const hold = fx.store.reserveStepExecution(action.id, 1, holdOperationKey(action.id, 1), { nowMs: Date.now() });
  const email = fx.store.reserveStepExecution(action.id, 1, emailOperationKey(action.id, 1), { nowMs: Date.now() });
  return { booking, action, holdKey: holdOperationKey(action.id, 1), emailKey: emailOperationKey(action.id, 1), hold, email };
}

test("fixture bookings stay on demo connectors and never touch credentials or provider HTTP", async () => {
  const fx = fixture();
  try {
    seedDemoFixtures(fx.store);
    const result = await fx.providers.calendar.checkAvailability({
      operationKey: "op-fixture-availability",
      calendarId: "demo-calendar-001",
      startAt: "2026-10-18T15:00:00.000Z",
      endAt: "2026-10-18T19:00:00.000Z",
    });
    assert.equal(result.status, "succeeded");
    assert.equal(result.metadata.simulated, true);
    assert.equal(fx.http.requests.length, 0, "no provider HTTP for fixture scope");
    assert.equal(fx.oauth.tokenCalls, 0, "no token supply for fixture scope");
  } finally {
    fx.cleanup();
  }
});

test("a real booking dispatches hold and email to its business's verified Google account", async () => {
  const fx = fixture();
  try {
    await connectAccount(fx, fx.businessId);
    const { booking, action, holdKey, emailKey } = realBooking(fx);

    const availability = await fx.providers.calendar.checkAvailability({
      operationKey: "op-availability-1",
      calendarId: LIVE_CALENDAR_ID,
      startAt: HOLD.startAt,
      endAt: HOLD.endAt,
    });
    assert.equal(availability.status, "succeeded");
    assert.equal(availability.metadata.simulated, false);
    assert.ok(availability.data.slots.some((slot) => slot.available));

    const hold = await fx.providers.calendar.createProvisionalHold({
      operationKey: holdKey,
      bookingId: booking.id,
      calendarId: LIVE_CALENDAR_ID,
      startAt: HOLD.startAt,
      endAt: HOLD.endAt,
      expiresAt: HOLD.expiresAt,
    });
    assert.equal(hold.status, "succeeded");
    assert.equal(hold.metadata.simulated, false);
    const insert = fx.http.requests.find((req) => req.url.includes("/events") && req.method === "POST");
    assert.ok(insert, "calendar insert reached the provider");
    assert.equal(insert.headers.Authorization, "Bearer access-google-sub-1");
    assert.ok(insert.url.includes(encodeURIComponent(LIVE_CALENDAR_ID)));
    assert.ok((insert.body ?? "").includes(booking.id));

    const sent = await fx.providers.email.sendEmail({
      operationKey: emailKey,
      to: ["guest@example.test"],
      subject: "Your Cedar Hall proposal",
      body: "Proposal body",
    });
    assert.equal(sent.status, "succeeded");
    assert.equal(sent.metadata.simulated, false);
    const send = fx.http.requests.find((req) => req.url.includes("/messages/send"));
    assert.ok(send);
    assert.equal(send.headers.Authorization, "Bearer access-google-sub-1");
    void action;
  } finally {
    fx.cleanup();
  }
});

test("missing, revoked, or ambiguous bindings fail closed — never silent demo", async () => {
  const fx = fixture();
  try {
    const { booking, holdKey } = realBooking(fx);
    // No connection at all.
    const missing = await fx.providers.calendar.createProvisionalHold({
      operationKey: holdKey,
      bookingId: booking.id,
      calendarId: LIVE_CALENDAR_ID,
      startAt: HOLD.startAt,
      endAt: HOLD.endAt,
      expiresAt: HOLD.expiresAt,
    });
    assert.equal(missing.status, "failed");
    if (missing.status === "failed") assert.equal(missing.error.kind, "not_found");
    assert.equal(fx.http.requests.length, 0);

    await connectAccount(fx, fx.businessId);
    // Revoked: disconnect the account, then the hold must fail access_revoked.
    const account = fx.service.getConnections(fx.businessId).providers[0].accounts.find((a) => a.provider === "google_calendar");
    assert.ok(account);
    await fx.service.disconnect({ accountId: account.id, businessId: fx.businessId });
    const revoked = await fx.providers.calendar.createProvisionalHold({
      operationKey: holdKey,
      bookingId: booking.id,
      calendarId: LIVE_CALENDAR_ID,
      startAt: HOLD.startAt,
      endAt: HOLD.endAt,
      expiresAt: HOLD.expiresAt,
    });
    assert.equal(revoked.status, "failed");
    if (revoked.status === "failed") assert.equal(revoked.error.kind, "access_revoked");

    // Ambiguous: the revoked account reconnects AND a second google account
    // is connected — two live google_calendar bindings for one business.
    await connectAccount(fx, fx.businessId);
    fx.oauth.identities.set("code-2", { accountKey: "google-sub-2", displayName: "Second account" });
    await connectAccount(fx, fx.businessId, "code-2");
    const ambiguous = await fx.providers.calendar.createProvisionalHold({
      operationKey: holdKey,
      bookingId: booking.id,
      calendarId: LIVE_CALENDAR_ID,
      startAt: HOLD.startAt,
      endAt: HOLD.endAt,
      expiresAt: HOLD.expiresAt,
    });
    assert.equal(ambiguous.status, "failed");
    if (ambiguous.status === "failed") assert.equal(ambiguous.error.kind, "conflict");
    assert.match(ambiguous.status === "failed" ? ambiguous.error.message : "", /ambiguous/i);
  } finally {
    fx.cleanup();
  }
});

test("availability on an unbound calendar fails explicitly; tokens stay lazy and out of results", async () => {
  const fx = fixture();
  try {
    await connectAccount(fx, fx.businessId);
    const unbound = await fx.providers.calendar.checkAvailability({
      operationKey: "op-unbound",
      calendarId: "calendar-nobody-uses",
      startAt: HOLD.startAt,
      endAt: HOLD.endAt,
    });
    assert.equal(unbound.status, "failed");
    if (unbound.status === "failed") assert.equal(unbound.error.kind, "not_found");

    const { booking, holdKey } = realBooking(fx);
    const hold = await fx.providers.calendar.createProvisionalHold({
      operationKey: holdKey,
      bookingId: booking.id,
      calendarId: LIVE_CALENDAR_ID,
      startAt: HOLD.startAt,
      endAt: HOLD.endAt,
      expiresAt: HOLD.expiresAt,
    });
    assert.equal(hold.status, "succeeded");
    // The token was supplied exactly at the authorized call and never leaks
    // into the result payload.
    assert.ok(fx.http.bearerTokens().every((header) => header.startsWith("Bearer ")));
    assert.ok(!JSON.stringify(hold).includes("access-google-sub-1"));
  } finally {
    fx.cleanup();
  }
});

test("hold reconcile resolves its durable scope from the action payload after restart", async () => {
  const fx = fixture();
  try {
    await connectAccount(fx, fx.businessId);
    const { booking, holdKey } = realBooking(fx);
    const eventId = googleEventIdFor(holdKey);
    fx.http.onRequest = (req) =>
      req.url.includes(`/events/${eventId}`)
        ? {
            status: 200,
            headers: {},
            text: JSON.stringify({
              id: eventId,
              status: "confirmed",
              created: "2026-10-01T00:00:00.000Z",
              updated: "2026-10-01T00:00:00.000Z",
              start: { dateTime: HOLD.startAt },
              end: { dateTime: HOLD.endAt },
              extendedProperties: {
                private: { gatherOperationKey: holdKey, gatherBookingId: booking.id, gatherExpiresAt: HOLD.expiresAt },
              },
            }),
          }
        : undefined;
    const reconciled = await fx.providers.calendar.reconcileProvisionalHold({ operationKey: holdKey });
    assert.equal(reconciled.status, "succeeded");
    assert.equal(reconciled.metadata.simulated, false);
    assert.ok(fx.http.requests.some((req) => req.method === "GET" && req.url.includes(eventId)));
  } finally {
    fx.cleanup();
  }
});

test("resolveAccountPorts supplies Google read ports only for verified bound accounts", async () => {
  const fx = fixture();
  try {
    // No connection: ports fail closed for a real business.
    const missing = fx.providers.resolveAccountPorts({ businessId: fx.businessId, capability: "gmail" });
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.error.kind, "not_found");

    // Fixture account rows are unbound — they never qualify as live ports.
    seedDemoFixtures(fx.store);
    const fixtureBusiness = fx.store.listConnectedAccounts()[0]?.businessId;
    if (fixtureBusiness) {
      const fixturePorts = fx.providers.resolveAccountPorts({ businessId: fixtureBusiness, capability: "gmail" });
      assert.equal(fixturePorts.ok, false);
    }

    await connectAccount(fx, fx.businessId);
    const ports = fx.providers.resolveAccountPorts({ businessId: fx.businessId, capability: "gmail" });
    assert.equal(ports.ok, true);
    if (ports.ok) {
      assert.ok(ports.ports.inbox, "gmail capability supplies the inbox poller");
      assert.ok(ports.ports.threads, "gmail capability supplies the thread reader");
      assert.equal(ports.ports.documents, undefined, "gmail capability never hands out drive ports");
    }
    // Eligibility was decided without touching any secret or provider HTTP.
    assert.equal(fx.http.requests.length, 0);

    // Drive scope was never granted — no documents port exists.
    const drive = fx.providers.resolveAccountPorts({ businessId: fx.businessId, capability: "google_drive" });
    assert.equal(drive.ok, false);
    if (!drive.ok) assert.equal(drive.error.kind, "not_found");
  } finally {
    fx.cleanup();
  }
});

test("tenant scope: a second business's bookings never use the first business's account", async () => {
  const fx = fixture();
  try {
    await connectAccount(fx, fx.businessId);
    const other = fx.store.createBusiness({ name: "Fictional Other Venue", timezone: "UTC" });
    const { booking, holdKey } = realBooking(fx, other.id);
    const hold = await fx.providers.calendar.createProvisionalHold({
      operationKey: holdKey,
      bookingId: booking.id,
      calendarId: LIVE_CALENDAR_ID,
      startAt: HOLD.startAt,
      endAt: HOLD.endAt,
      expiresAt: HOLD.expiresAt,
    });
    assert.equal(hold.status, "failed");
    if (hold.status === "failed") assert.equal(hold.error.kind, "not_found");
    assert.equal(fx.http.requests.length, 0);
  } finally {
    fx.cleanup();
  }
});
