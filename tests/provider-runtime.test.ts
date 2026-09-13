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

/** ConnectionService with a scripted async gate in front of token supply. */
class GatedConnectionService extends ConnectionService {
  gate: Promise<void> = Promise.resolve();
  override async accessToken(input: { accountId: string; businessId: string }): Promise<string> {
    await this.gate;
    return super.accessToken(input);
  }
}

function fixture(
  makeService?: (init: { store: GatherStore; secrets: MemorySecretStore; oauth: ScriptedOAuth }) => ConnectionService,
): Fx {
  const dir = mkdtempSync(join(tmpdir(), "gather-provider-runtime-"));
  const store = new GatherStore(join(dir, "gather.sqlite"));
  const business = store.createBusiness({ name: "Fictional Cedar Hall", timezone: "America/New_York" });
  const secrets = new MemorySecretStore();
  const oauth = new ScriptedOAuth();
  const http = new ScriptedGoogle();
  const service = makeService
    ? makeService({ store, secrets, oauth })
    : new ConnectionService({
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
    const bound = fx.providers.bindCalendar({ businessId: fx.businessId, calendarId: LIVE_CALENDAR_ID });
    assert.deepEqual(bound, { ok: true });
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
    // No connection at all — and no binding.
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

    // Connected but UNBOUND: a real booking still cannot route — the
    // proposal payload alone never establishes tenant scope.
    await connectAccount(fx, fx.businessId);
    const unbound = await fx.providers.calendar.createProvisionalHold({
      operationKey: holdKey,
      bookingId: booking.id,
      calendarId: LIVE_CALENDAR_ID,
      startAt: HOLD.startAt,
      endAt: HOLD.endAt,
      expiresAt: HOLD.expiresAt,
    });
    assert.equal(unbound.status, "failed");
    if (unbound.status === "failed") assert.equal(unbound.error.kind, "not_found");

    // Host binds the calendar durably, then the account is revoked.
    assert.deepEqual(fx.providers.bindCalendar({ businessId: fx.businessId, calendarId: LIVE_CALENDAR_ID }), { ok: true });
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

    // Ambiguous: two live calendar accounts and an unbound calendar cannot
    // be pinned — bind without an explicit account fails closed.
    await connectAccount(fx, fx.businessId);
    fx.oauth.identities.set("code-2", { accountKey: "google-sub-2", displayName: "Second account" });
    await connectAccount(fx, fx.businessId, "code-2");
    const ambiguous = fx.providers.bindCalendar({ businessId: fx.businessId, calendarId: "cal-second" });
    assert.equal(ambiguous.ok, false);
    if (!ambiguous.ok) assert.equal(ambiguous.error.kind, "conflict");
    assert.match(ambiguous.ok ? "" : ambiguous.error.message, /ambiguous/i);
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

    assert.deepEqual(fx.providers.bindCalendar({ businessId: fx.businessId, calendarId: LIVE_CALENDAR_ID }), { ok: true });
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
    assert.deepEqual(fx.providers.bindCalendar({ businessId: fx.businessId, calendarId: LIVE_CALENDAR_ID }), { ok: true });
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

test("tenant scope: a bound calendar can never be claimed or used by another business", async () => {
  const fx = fixture();
  try {
    await connectAccount(fx, fx.businessId);
    assert.deepEqual(fx.providers.bindCalendar({ businessId: fx.businessId, calendarId: LIVE_CALENDAR_ID }), { ok: true });

    const other = fx.store.createBusiness({ name: "Fictional Other Venue", timezone: "UTC" });
    // The foreign business cannot claim the bound calendar.
    const claim = fx.providers.bindCalendar({ businessId: other.id, calendarId: LIVE_CALENDAR_ID });
    assert.equal(claim.ok, false);
    if (!claim.ok) assert.equal(claim.error.kind, "conflict");

    // Its bookings cannot route through it either — even with an approved payload.
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
    if (hold.status === "failed") assert.equal(hold.error.kind, "conflict");
    assert.equal(fx.http.requests.length, 0);
  } finally {
    fx.cleanup();
  }
});

test("resolveCalendarPorts gives offer/intake composition an explicitly bound calendar connector", async () => {
  const fx = fixture();
  try {
    await connectAccount(fx, fx.businessId);

    // Before any proposal exists, the host port resolves only bound calendars.
    const unbound = fx.providers.resolveCalendarPorts({ businessId: fx.businessId, calendarId: LIVE_CALENDAR_ID });
    assert.equal(unbound.ok, false);
    if (!unbound.ok) assert.equal(unbound.error.kind, "not_found");

    assert.deepEqual(fx.providers.bindCalendar({ businessId: fx.businessId, calendarId: LIVE_CALENDAR_ID }), { ok: true });
    const ports = fx.providers.resolveCalendarPorts({ businessId: fx.businessId, calendarId: LIVE_CALENDAR_ID });
    assert.equal(ports.ok, true);
    if (!ports.ok) return;
    assert.equal(ports.ports.account.provider, "google_calendar");

    // The port is a working live connector — usable before any proposal.
    const availability = await ports.ports.calendar.checkAvailability({
      operationKey: "op-offer-prep-1",
      calendarId: LIVE_CALENDAR_ID,
      startAt: HOLD.startAt,
      endAt: HOLD.endAt,
    });
    assert.equal(availability.status, "succeeded");
    assert.equal(availability.metadata.simulated, false);

    // A foreign business and a fixture calendar both fail closed.
    const other = fx.store.createBusiness({ name: "Fictional Other", timezone: "UTC" });
    const foreign = fx.providers.resolveCalendarPorts({ businessId: other.id, calendarId: LIVE_CALENDAR_ID });
    assert.equal(foreign.ok, false);
    if (!foreign.ok) assert.equal(foreign.error.kind, "conflict");
    const fixturePorts = fx.providers.resolveCalendarPorts({ businessId: fx.businessId, calendarId: "demo-calendar-001" });
    assert.equal(fixturePorts.ok, false);
    if (!fixturePorts.ok) assert.equal(fixturePorts.error.kind, "unsupported");

    // Listing is owner-scoped and durable.
    assert.deepEqual(fx.providers.listCalendarBindings(fx.businessId).map((b) => b.calendarId), [LIVE_CALENDAR_ID]);
    assert.deepEqual(fx.providers.unbindCalendar({ businessId: fx.businessId, calendarId: LIVE_CALENDAR_ID }), { ok: true });
    assert.equal(fx.providers.resolveCalendarPorts({ businessId: fx.businessId, calendarId: LIVE_CALENDAR_ID }).ok, false);
  } finally {
    fx.cleanup();
  }
});

test("retained ports fail closed after unbind: the Astra stale-port sequence", async () => {
  const fx = fixture();
  try {
    await connectAccount(fx, fx.businessId);
    assert.deepEqual(fx.providers.bindCalendar({ businessId: fx.businessId, calendarId: LIVE_CALENDAR_ID }), { ok: true });
    const resolved = fx.providers.resolveCalendarPorts({ businessId: fx.businessId, calendarId: LIVE_CALENDAR_ID });
    assert.equal(resolved.ok, true);
    if (!resolved.ok) return;
    assert.deepEqual(fx.providers.unbindCalendar({ businessId: fx.businessId, calendarId: LIVE_CALENDAR_ID }), { ok: true });
    // The previously resolved port must NOT act: no fresh resolve happened here.
    const httpBefore = fx.http.requests.length;
    const stale = await resolved.ports.calendar.checkAvailability({
      operationKey: "op-stale-port-1",
      calendarId: LIVE_CALENDAR_ID,
      startAt: HOLD.startAt,
      endAt: HOLD.endAt,
    });
    assert.equal(stale.status, "failed");
    if (stale.status === "failed") assert.equal(stale.error.kind, "not_found");
    assert.equal(fx.http.requests.length, httpBefore, "no provider HTTP on a stale port");
  } finally {
    fx.cleanup();
  }
});

test("same-account rebind after unbind invalidates the old port via generation", async () => {
  const fx = fixture();
  try {
    await connectAccount(fx, fx.businessId);
    assert.deepEqual(fx.providers.bindCalendar({ businessId: fx.businessId, calendarId: LIVE_CALENDAR_ID }), { ok: true });
    const first = fx.providers.resolveCalendarPorts({ businessId: fx.businessId, calendarId: LIVE_CALENDAR_ID });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.deepEqual(fx.providers.unbindCalendar({ businessId: fx.businessId, calendarId: LIVE_CALENDAR_ID }), { ok: true });
    assert.deepEqual(fx.providers.bindCalendar({ businessId: fx.businessId, calendarId: LIVE_CALENDAR_ID }), { ok: true });
    // The old port is stale even though business and account match again.
    const httpBefore = fx.http.requests.length;
    const old = await first.ports.calendar.checkAvailability({
      operationKey: "op-old-gen-1",
      calendarId: LIVE_CALENDAR_ID,
      startAt: HOLD.startAt,
      endAt: HOLD.endAt,
    });
    assert.equal(old.status, "failed");
    if (old.status === "failed") assert.equal(old.error.kind, "conflict");
    assert.equal(fx.http.requests.length, httpBefore);
    // A fresh resolve carries the new generation and works.
    const fresh = fx.providers.resolveCalendarPorts({ businessId: fx.businessId, calendarId: LIVE_CALENDAR_ID });
    assert.equal(fresh.ok, true);
    if (!fresh.ok) return;
    const availability = await fresh.ports.calendar.checkAvailability({
      operationKey: "op-new-gen-1",
      calendarId: LIVE_CALENDAR_ID,
      startAt: HOLD.startAt,
      endAt: HOLD.endAt,
    });
    assert.equal(availability.status, "succeeded");
  } finally {
    fx.cleanup();
  }
});

test("revocation after resolve fails retained ports as access_revoked", async () => {
  const fx = fixture();
  try {
    await connectAccount(fx, fx.businessId);
    assert.deepEqual(fx.providers.bindCalendar({ businessId: fx.businessId, calendarId: LIVE_CALENDAR_ID }), { ok: true });
    const resolved = fx.providers.resolveCalendarPorts({ businessId: fx.businessId, calendarId: LIVE_CALENDAR_ID });
    assert.equal(resolved.ok, true);
    if (!resolved.ok) return;
    const accountId = resolved.ports.account.id;
    await fx.service.disconnect({ accountId, businessId: fx.businessId });
    const httpBefore = fx.http.requests.length;
    const revoked = await resolved.ports.calendar.checkAvailability({
      operationKey: "op-revoked-port-1",
      calendarId: LIVE_CALENDAR_ID,
      startAt: HOLD.startAt,
      endAt: HOLD.endAt,
    });
    assert.equal(revoked.status, "failed");
    if (revoked.status === "failed") assert.equal(revoked.error.kind, "access_revoked");
    assert.equal(fx.http.requests.length, httpBefore, "no provider HTTP once revoked");
  } finally {
    fx.cleanup();
  }
});

test("concurrent and foreign binds surface typed conflicts, never raw constraint errors", async () => {
  const fx = fixture();
  try {
    await connectAccount(fx, fx.businessId);
    assert.deepEqual(fx.providers.bindCalendar({ businessId: fx.businessId, calendarId: LIVE_CALENDAR_ID }), { ok: true });
    // A second handle (foreign owner) racing the same calendar id hits the
    // primary key: it must read back a typed conflict, not a raw throw.
    const foreignSecrets = new MemorySecretStore();
    const foreignService = new ConnectionService({
      store: fx.store,
      secrets: foreignSecrets,
      transport: fx.oauth,
      googleApp: APP,
      ownerId: "foreign-owner",
    });
    const foreignProviders = createProviderConnectors({
      store: fx.store,
      ownerId: "foreign-owner",
      demo: {
        calendar: new DurableDemoCalendar(fx.store, createDemoConnectors({ calendarSlots: demoFixtureSlots() }).calendar),
        email: new DurableDemoEmail(fx.store, createDemoConnectors({ calendarSlots: demoFixtureSlots() }).email),
      },
      connectionService: foreignService,
      transport: fx.http,
    });
    // Give the foreign owner a distinct connected account so its bind
    // reaches the contested INSERT (the row is invisible to it): the
    // primary-key loss must read back as a typed conflict, not a raw throw.
    fx.oauth.identities.set("foreign-code-1", { accountKey: "google-sub-9", displayName: "Fictional Foreign" });
    const foreignStart = foreignService.startAuthorization({ businessId: fx.businessId, provider: "google" });
    await foreignService.completeAuthorization({
      code: "foreign-code-1",
      state: new URL(foreignStart.authorizationUrl).searchParams.get("state") ?? "",
    });
    const raced = foreignProviders.bindCalendar({ businessId: fx.businessId, calendarId: LIVE_CALENDAR_ID });
    assert.equal(raced.ok, false);
    if (!raced.ok) assert.equal(raced.error.kind, "conflict");
    // Raw conflicting row, same story: typed conflict, original proof kept.
    const other = fx.store.createBusiness({ name: "Fictional Rival", timezone: "UTC" });
    fx.store.db
      .prepare(
        "INSERT INTO provider_calendar_bindings (calendar_id, business_id, owner_id, connection_account_id, generation, status, created_at) VALUES ('race-cal-1', $b, 'local-owner', 'x', 1, 'bound', '2026-01-01T00:00:00.000Z')",
      )
      .run({ $b: other.id });
    const clash = fx.providers.bindCalendar({ businessId: fx.businessId, calendarId: "race-cal-1" });
    assert.equal(clash.ok, false);
    if (!clash.ok) assert.equal(clash.error.kind, "conflict");
  } finally {
    fx.cleanup();
  }
});

test("unbind compares exact business and account; tombstone preserves rebinding", async () => {
  const fx = fixture();
  try {
    await connectAccount(fx, fx.businessId);
    assert.deepEqual(fx.providers.bindCalendar({ businessId: fx.businessId, calendarId: LIVE_CALENDAR_ID }), { ok: true });
    const accountId = fx.providers.listCalendarBindings(fx.businessId)[0]!.accountId;
    // Wrong account pin refuses to release another account's binding.
    const mismatch = fx.providers.unbindCalendar({ businessId: fx.businessId, calendarId: LIVE_CALENDAR_ID, accountId: "ghost-acct" });
    assert.equal(mismatch.ok, false);
    if (!mismatch.ok) assert.equal(mismatch.error.kind, "conflict");
    // Foreign business cannot release it either.
    const other = fx.store.createBusiness({ name: "Fictional Other", timezone: "UTC" });
    const foreign = fx.providers.unbindCalendar({ businessId: other.id, calendarId: LIVE_CALENDAR_ID });
    assert.equal(foreign.ok, false);
    if (!foreign.ok) assert.equal(foreign.error.kind, "not_found");
    // Exact match releases; the tombstone keeps history and rebinding works.
    assert.deepEqual(
      fx.providers.unbindCalendar({ businessId: fx.businessId, calendarId: LIVE_CALENDAR_ID, accountId }),
      { ok: true },
    );
    assert.deepEqual(fx.providers.listCalendarBindings(fx.businessId), []);
    assert.deepEqual(fx.providers.bindCalendar({ businessId: fx.businessId, calendarId: LIVE_CALENDAR_ID }), { ok: true });
    assert.deepEqual(fx.providers.listCalendarBindings(fx.businessId).map((b) => b.calendarId), [LIVE_CALENDAR_ID]);
  } finally {
    fx.cleanup();
  }
});

test("ASTRA async repro: unbind landing while a resolved port awaits its token fails closed with zero HTTP", async () => {
  const fx = fixture();
  try {
    await connectAccount(fx, fx.businessId);
    assert.deepEqual(fx.providers.bindCalendar({ businessId: fx.businessId, calendarId: LIVE_CALENDAR_ID }), { ok: true });
    const resolved = fx.providers.resolveCalendarPorts({ businessId: fx.businessId, calendarId: LIVE_CALENDAR_ID });
    assert.equal(resolved.ok, true);
    if (!resolved.ok) return;
    // Start the availability check but do NOT await: the token fetch is still
    // in flight when the host releases the binding.
    const pending = resolved.ports.calendar.checkAvailability({
      operationKey: "op-async-unbind-1",
      calendarId: LIVE_CALENDAR_ID,
      startAt: HOLD.startAt,
      endAt: HOLD.endAt,
    });
    assert.deepEqual(fx.providers.unbindCalendar({ businessId: fx.businessId, calendarId: LIVE_CALENDAR_ID }), { ok: true });
    const httpBefore = fx.http.requests.length;
    const result = await pending;
    assert.equal(result.status, "failed");
    if (result.status === "failed") assert.equal(result.error.kind, "not_found");
    assert.equal(fx.http.requests.length, httpBefore, "no provider HTTP once the binding lapsed mid-flight");
  } finally {
    fx.cleanup();
  }
});

test("dispatching calendar: the same mid-flight unbind fails closed with zero HTTP", async () => {
  const fx = fixture();
  try {
    await connectAccount(fx, fx.businessId);
    assert.deepEqual(fx.providers.bindCalendar({ businessId: fx.businessId, calendarId: LIVE_CALENDAR_ID }), { ok: true });
    const pending = fx.providers.calendar.checkAvailability({
      operationKey: "op-async-dispatch-1",
      calendarId: LIVE_CALENDAR_ID,
      startAt: HOLD.startAt,
      endAt: HOLD.endAt,
    });
    assert.deepEqual(fx.providers.unbindCalendar({ businessId: fx.businessId, calendarId: LIVE_CALENDAR_ID }), { ok: true });
    const httpBefore = fx.http.requests.length;
    const result = await pending;
    assert.equal(result.status, "failed");
    if (result.status === "failed") assert.equal(result.error.kind, "not_found");
    assert.equal(fx.http.requests.length, httpBefore, "no provider HTTP once the binding lapsed mid-flight");
  } finally {
    fx.cleanup();
  }
});

test("scripted async token gate: nothing dispatches while waiting, unbind during the wait fails closed", async () => {
  let gated: GatedConnectionService | undefined;
  const fx = fixture(({ store, secrets, oauth }) => {
    gated = new GatedConnectionService({ store, secrets, transport: oauth, googleApp: APP, ownerId: "local-owner" });
    return gated;
  });
  try {
    assert.ok(gated);
    await connectAccount(fx, fx.businessId);
    assert.deepEqual(fx.providers.bindCalendar({ businessId: fx.businessId, calendarId: LIVE_CALENDAR_ID }), { ok: true });
    const resolved = fx.providers.resolveCalendarPorts({ businessId: fx.businessId, calendarId: LIVE_CALENDAR_ID });
    assert.equal(resolved.ok, true);
    if (!resolved.ok || !gated) return;
    let release!: () => void;
    gated.gate = new Promise<void>((resolve) => { release = resolve; });
    const pending = resolved.ports.calendar.checkAvailability({
      operationKey: "op-token-gate-1",
      calendarId: LIVE_CALENDAR_ID,
      startAt: HOLD.startAt,
      endAt: HOLD.endAt,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Parked at the token gate: no HTTP has moved yet.
    assert.equal(fx.http.requests.length, 0);
    assert.deepEqual(fx.providers.unbindCalendar({ businessId: fx.businessId, calendarId: LIVE_CALENDAR_ID }), { ok: true });
    release();
    const result = await pending;
    assert.equal(result.status, "failed");
    if (result.status === "failed") assert.equal(result.error.kind, "not_found");
    assert.equal(fx.http.requests.length, 0, "token arrived too late: zero provider HTTP");
  } finally {
    fx.cleanup();
  }
});

test("rebind mid-flight invalidates the in-flight dispatch even when the account matches again", async () => {
  const fx = fixture();
  try {
    await connectAccount(fx, fx.businessId);
    assert.deepEqual(fx.providers.bindCalendar({ businessId: fx.businessId, calendarId: LIVE_CALENDAR_ID }), { ok: true });
    const resolved = fx.providers.resolveCalendarPorts({ businessId: fx.businessId, calendarId: LIVE_CALENDAR_ID });
    assert.equal(resolved.ok, true);
    if (!resolved.ok) return;
    const { holdKey } = realBooking(fx);
    const pending = resolved.ports.calendar.createProvisionalHold({
      operationKey: holdKey,
      bookingId: "booking-ignored-by-port",
      calendarId: LIVE_CALENDAR_ID,
      startAt: HOLD.startAt,
      endAt: HOLD.endAt,
      expiresAt: HOLD.expiresAt,
    });
    // Release and rebind to the SAME account: the generation bump still
    // invalidates the in-flight write.
    assert.deepEqual(fx.providers.unbindCalendar({ businessId: fx.businessId, calendarId: LIVE_CALENDAR_ID }), { ok: true });
    assert.deepEqual(fx.providers.bindCalendar({ businessId: fx.businessId, calendarId: LIVE_CALENDAR_ID }), { ok: true });
    const httpBefore = fx.http.requests.length;
    const result = await pending;
    assert.equal(result.status, "failed");
    if (result.status === "failed") assert.equal(result.error.kind, "conflict");
    assert.equal(fx.http.requests.length, httpBefore, "rebound generation never authorizes the old dispatch");
  } finally {
    fx.cleanup();
  }
});

test("revocation mid-flight fails the in-flight dispatch closed with zero HTTP", async () => {
  let gated: GatedConnectionService | undefined;
  const fx = fixture(({ store, secrets, oauth }) => {
    gated = new GatedConnectionService({ store, secrets, transport: oauth, googleApp: APP, ownerId: "local-owner" });
    return gated;
  });
  try {
    assert.ok(gated);
    await connectAccount(fx, fx.businessId);
    assert.deepEqual(fx.providers.bindCalendar({ businessId: fx.businessId, calendarId: LIVE_CALENDAR_ID }), { ok: true });
    const resolved = fx.providers.resolveCalendarPorts({ businessId: fx.businessId, calendarId: LIVE_CALENDAR_ID });
    assert.equal(resolved.ok, true);
    if (!resolved.ok || !gated) return;
    const accountId = resolved.ports.account.id;
    // Park the dispatch at the token gate: disconnect() itself awaits a
    // provider round-trip, so without the gate the revocation could not be
    // forced to land mid-flight deterministically.
    let release!: () => void;
    gated.gate = new Promise<void>((resolve) => { release = resolve; });
    const pending = resolved.ports.calendar.checkAvailability({
      operationKey: "op-revoke-flight-1",
      calendarId: LIVE_CALENDAR_ID,
      startAt: HOLD.startAt,
      endAt: HOLD.endAt,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(fx.http.requests.length, 0);
    await fx.service.disconnect({ accountId, businessId: fx.businessId });
    release();
    const result = await pending;
    assert.equal(result.status, "failed");
    if (result.status === "failed") assert.ok(result.error.kind === "access_revoked" || result.error.kind === "not_found");
    assert.equal(fx.http.requests.length, 0, "no provider HTTP once revoked mid-flight");
  } finally {
    fx.cleanup();
  }
});

test("foreign interference mid-flight neither hijacks nor breaks the authorized dispatch", async () => {
  const fx = fixture();
  try {
    await connectAccount(fx, fx.businessId);
    assert.deepEqual(fx.providers.bindCalendar({ businessId: fx.businessId, calendarId: LIVE_CALENDAR_ID }), { ok: true });
    const other = fx.store.createBusiness({ name: "Fictional Rival", timezone: "UTC" });
    const pending = fx.providers.calendar.checkAvailability({
      operationKey: "op-foreign-flight-1",
      calendarId: LIVE_CALENDAR_ID,
      startAt: HOLD.startAt,
      endAt: HOLD.endAt,
    });
    // A foreign scope cannot claim the bound calendar mid-flight.
    const claim = fx.providers.bindCalendar({ businessId: other.id, calendarId: LIVE_CALENDAR_ID });
    assert.equal(claim.ok, false);
    if (!claim.ok) assert.equal(claim.error.kind, "conflict");
    const result = await pending;
    assert.equal(result.status, "succeeded", "the authorized dispatch still completes");
    assert.equal(fx.http.requests.filter((req) => req.url.includes("/freeBusy")).length, 1);
  } finally {
    fx.cleanup();
  }
});

test("write follow-up is guarded: 409 verify GET after a mid-write unbind fails closed", async () => {
  const fx = fixture();
  try {
    await connectAccount(fx, fx.businessId);
    assert.deepEqual(fx.providers.bindCalendar({ businessId: fx.businessId, calendarId: LIVE_CALENDAR_ID }), { ok: true });
    const { booking, holdKey } = realBooking(fx);
    const eventId = googleEventIdFor(holdKey);
    fx.http.onRequest = (req) => {
      if (req.url.includes("/events") && req.method === "POST") {
        // The insert response races the host change: release the binding
        // before the adapter's follow-up verify GET dispatches.
        fx.providers.unbindCalendar({ businessId: fx.businessId, calendarId: LIVE_CALENDAR_ID });
        return { status: 409, headers: {}, text: "{}" };
      }
      return undefined;
    };
    const result = await fx.providers.calendar.createProvisionalHold({
      operationKey: holdKey,
      bookingId: booking.id,
      calendarId: LIVE_CALENDAR_ID,
      startAt: HOLD.startAt,
      endAt: HOLD.endAt,
      expiresAt: HOLD.expiresAt,
    });
    assert.equal(result.status, "failed");
    if (result.status === "failed") assert.equal(result.error.kind, "not_found");
    assert.ok(!fx.http.requests.some((req) => req.method === "GET" && req.url.includes(eventId)), "verify GET never dispatched");
  } finally {
    fx.cleanup();
  }
});

test("known effects survive a later authority change; reconcile then demands honest re-resolution", async () => {
  const fx = fixture();
  try {
    await connectAccount(fx, fx.businessId);
    assert.deepEqual(fx.providers.bindCalendar({ businessId: fx.businessId, calendarId: LIVE_CALENDAR_ID }), { ok: true });
    const resolved = fx.providers.resolveCalendarPorts({ businessId: fx.businessId, calendarId: LIVE_CALENDAR_ID });
    assert.equal(resolved.ok, true);
    if (!resolved.ok) return;
    const { booking, holdKey } = realBooking(fx);
    const hold = await resolved.ports.calendar.createProvisionalHold({
      operationKey: holdKey,
      bookingId: booking.id,
      calendarId: LIVE_CALENDAR_ID,
      startAt: HOLD.startAt,
      endAt: HOLD.endAt,
      expiresAt: HOLD.expiresAt,
    });
    assert.equal(hold.status, "succeeded");
    const httpAfterWrite = fx.http.requests.length;
    assert.ok(httpAfterWrite > 0, "the write actually dispatched");
    // Authority lapses AFTER dispatch: the known effect stands — nothing is
    // pretended-undone and no DELETE is attempted.
    assert.deepEqual(fx.providers.unbindCalendar({ businessId: fx.businessId, calendarId: LIVE_CALENDAR_ID }), { ok: true });
    assert.equal(hold.status, "succeeded");
    // Reconcile through the stale port fails closed instead of verifying
    // against a scope it no longer holds; nothing new dispatches.
    const reconciled = await resolved.ports.calendar.reconcileProvisionalHold({ operationKey: holdKey });
    assert.equal(reconciled.status, "failed");
    assert.equal(fx.http.requests.length, httpAfterWrite, "no follow-up IO on stale authority");
    assert.ok(!fx.http.requests.some((req) => req.method === "DELETE"), "never a pretend undo");
  } finally {
    fx.cleanup();
  }
});

test("pre-generation binding rows migrate and stay enforceable", async () => {
  const fx = fixture();
  try {
    await connectAccount(fx, fx.businessId);
    // Simulate a legacy database: drop and recreate the table without the
    // new columns, insert a legacy row, then rebuild the resolver view.
    fx.store.db.exec("DROP TABLE provider_calendar_bindings");
    fx.store.db.exec(
      "CREATE TABLE provider_calendar_bindings (calendar_id TEXT PRIMARY KEY, business_id TEXT NOT NULL, owner_id TEXT NOT NULL, connection_account_id TEXT NOT NULL, created_at TEXT NOT NULL)",
    );
    const accountId = fx.service
      .getConnections(fx.businessId)
      .providers.find((p) => p.provider === "google")!
      .accounts.find((a) => a.provider === "google_calendar")!.id;
    fx.store.db
      .prepare("INSERT INTO provider_calendar_bindings VALUES ('legacy-cal-1', $b, 'local-owner', $a, '2026-01-01T00:00:00.000Z')")
      .run({ $b: fx.businessId, $a: accountId });
    // A fresh resolver migrates the schema; the legacy row reads as bound
    // generation 1 and guards ports like any other binding.
    const migrated = createProviderConnectors({
      store: fx.store,
      ownerId: "local-owner",
      demo: {
        calendar: new DurableDemoCalendar(fx.store, createDemoConnectors({ calendarSlots: demoFixtureSlots() }).calendar),
        email: new DurableDemoEmail(fx.store, createDemoConnectors({ calendarSlots: demoFixtureSlots() }).email),
      },
      connectionService: fx.service,
      transport: fx.http,
    });
    const ports = migrated.resolveCalendarPorts({ businessId: fx.businessId, calendarId: "legacy-cal-1" });
    assert.equal(ports.ok, true);
  } finally {
    fx.cleanup();
  }
});
