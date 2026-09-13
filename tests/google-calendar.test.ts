/**
 * SIMULATED contract tests for the live Google Calendar adapter.
 * Every HTTP exchange below is scripted through an injected fake transport;
 * no live account verification has been performed and the live gate is BLOCKED.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { GoogleCalendarConnector, googleEventIdFor } from "../src/connectors/google/calendar.ts";
import { TransportTimeoutError, type GoogleHttpRequest, type GoogleHttpResponse, type GoogleHttpTransport } from "../src/connectors/google/transport.ts";

const CAL = "owner-calendar-001";
const START = "2030-06-12T17:00:00.000Z";
const END = "2030-06-12T23:00:00.000Z";

function json(status: number, body: unknown): GoogleHttpResponse {
  return { status, headers: { "Content-Type": "application/json" }, text: JSON.stringify(body) };
}

function googleError(status: number, reason: string, message: string): GoogleHttpResponse {
  return json(status, { error: { code: status, message, errors: [{ domain: "global", reason, message }] } });
}

function scripted(handler: (req: GoogleHttpRequest) => GoogleHttpResponse | Promise<GoogleHttpResponse>): {
  transport: GoogleHttpTransport;
  log: GoogleHttpRequest[];
} {
  const log: GoogleHttpRequest[] = [];
  return {
    log,
    transport: {
      request: (req) => {
        log.push(req);
        return Promise.resolve(handler(req)).then((res) => res);
      },
    },
  };
}

function connectorFor(handler: (req: GoogleHttpRequest) => GoogleHttpResponse | Promise<GoogleHttpResponse>, opts: { tokens?: () => Promise<string> } = {}) {
  const { transport, log } = scripted(handler);
  const connector = new GoogleCalendarConnector({
    transport,
    tokens: opts.tokens ?? (() => Promise.resolve("approved-test-token")),
    calendarId: CAL,
  });
  return { connector, log };
}

test("availability clips server busy windows and merges overlaps", async () => {
  const { connector } = connectorFor((req) => {
    assert.match(req.url, /\/freeBusy$/);
    assert.equal(req.method, "POST");
    assert.equal(req.headers.Authorization, "Bearer approved-test-token");
    const body = JSON.parse(req.body ?? "{}") as { items?: Array<{ id?: string }> };
    assert.deepEqual(body.items, [{ id: CAL }]);
    return json(200, {
      kind: "calendar#freeBusy",
      timeMin: START,
      timeMax: END,
      calendars: {
        [CAL]: {
          busy: [
            { start: "2030-06-12T19:00:00.000Z", end: "2030-06-12T21:00:00.000Z" },
            { start: "2030-06-12T20:30:00.000Z", end: "2030-06-12T22:00:00.000Z" },
          ],
        },
      },
    });
  });
  const result = await connector.checkAvailability({ operationKey: "op-avail-1", calendarId: CAL, startAt: START, endAt: END });
  assert.equal(result.status, "succeeded");
  if (result.status !== "succeeded") return;
  assert.equal(result.metadata.mode.mode, "live");
  assert.equal(result.metadata.simulated, false);
  const busy = result.data.slots.filter((slot) => !slot.available);
  const free = result.data.slots.filter((slot) => slot.available);
  assert.equal(busy.length, 1);
  assert.equal(busy[0]?.startAt, "2030-06-12T19:00:00.000Z");
  assert.equal(busy[0]?.endAt, "2030-06-12T22:00:00.000Z");
  assert.equal(busy[0]?.calendarId, CAL);
  assert.equal(free.length, 2);
  assert.ok(result.data.provenance.every((ref) => ref.fictional === false));
});

test("availability fails closed on malformed busy windows", async () => {
  const { connector } = connectorFor(() => json(200, {
    kind: "calendar#freeBusy",
    calendars: { [CAL]: { busy: [{ start: "not-a-time", end: END }] } },
  }));
  const result = await connector.checkAvailability({ operationKey: "op-avail-bad", calendarId: CAL, startAt: START, endAt: END });
  assert.equal(result.status, "failed");
});

test("availability surfaces per-calendar errors without coating them as free", async () => {
  const missing = connectorFor(() => json(200, {
    kind: "calendar#freeBusy",
    calendars: { [CAL]: { errors: [{ domain: "global", reason: "notFound" }] } },
  }));
  const gone = await missing.connector.checkAvailability({ operationKey: "op-x", calendarId: CAL, startAt: START, endAt: END });
  assert.equal(gone.status, "failed");
  if (gone.status !== "failed") return;
  assert.equal(gone.error.kind, "invalid_request");

  const broken = connectorFor(() => json(200, {
    kind: "calendar#freeBusy",
    calendars: { [CAL]: { errors: [{ domain: "global", reason: "internalError" }] } },
  }));
  const failed = await broken.connector.checkAvailability({ operationKey: "op-y", calendarId: CAL, startAt: START, endAt: END });
  assert.equal(failed.status, "failed");
  if (failed.status !== "failed") return;
  assert.equal(failed.error.kind, "transport_error");
  assert.equal(failed.error.retryable, true);
});

test("bound adapter rejects requests naming another calendar", async () => {
  const { connector, log } = connectorFor(() => json(200, { kind: "calendar#freeBusy", calendars: {} }));
  const avail = await connector.checkAvailability({ operationKey: "op-b", calendarId: "other-calendar", startAt: START, endAt: END });
  assert.equal(avail.status, "failed");
  if (avail.status !== "failed") return;
  assert.equal(avail.error.kind, "invalid_request");
  assert.equal(log.length, 0);
  const held = await connector.createProvisionalHold({
    operationKey: "op-b2", bookingId: "booking-001", calendarId: "other-calendar", startAt: START, endAt: END, expiresAt: "2030-06-13T23:00:00.000Z",
  });
  assert.equal(held.status, "failed");
  if (held.status !== "failed") return;
  assert.equal(held.error.kind, "invalid_request");
  assert.equal(log.length, 0);
});

test("availability maps revoked, rate-limited, and server errors honestly", async () => {
  const cases: Array<{ status: number; reason: string; kind: string; retryable: boolean }> = [
    { status: 401, reason: "authError", kind: "access_revoked", retryable: false },
    { status: 403, reason: "rateLimitExceeded", kind: "rate_limited", retryable: true },
    { status: 429, reason: "rateLimitExceeded", kind: "rate_limited", retryable: true },
    { status: 500, reason: "backendError", kind: "transport_error", retryable: true },
  ];
  for (const item of cases) {
    const { connector } = connectorFor(() => googleError(item.status, item.reason, "simulated"));
    const result = await connector.checkAvailability({ operationKey: "op-avail-x", calendarId: CAL, startAt: START, endAt: END });
    assert.equal(result.status, "failed");
    if (result.status !== "failed") continue;
    assert.equal(result.error.kind, item.kind);
    assert.equal(result.error.retryable, item.retryable);
  }
});

test("deterministic event ids are valid Calendar ids", () => {
  const id = googleEventIdFor("gather:calendar:create-provisional-hold:abc123");
  assert.match(id, /^g[0-9a-f]{31}$/);
  assert.equal(googleEventIdFor("gather:calendar:create-provisional-hold:abc123"), id);
});

function holdBody(operationKey: string) {
  return {
    operationKey,
    bookingId: "booking-001",
    calendarId: CAL,
    startAt: START,
    endAt: END,
    expiresAt: "2030-06-13T23:00:00.000Z",
  };
}

function createdEvent(operationKey: string) {
  return {
    id: googleEventIdFor(operationKey),
    status: "confirmed",
    summary: "Gather provisional hold — booking-001",
    start: { dateTime: START },
    end: { dateTime: END },
    created: "2030-01-02T00:00:00.000Z",
    extendedProperties: { private: { gatherOperationKey: operationKey, gatherBookingId: "booking-001", gatherExpiresAt: "2030-06-13T23:00:00.000Z" } },
  };
}

test("hold success carries a live, non-simulated receipt", async () => {
  const { connector, log } = connectorFor((req) => {
    if (req.method === "POST") {
      assert.match(req.url, /sendUpdates=none/);
      const body = JSON.parse(req.body ?? "{}") as Record<string, unknown>;
      assert.ok(typeof body.id === "string");
      assert.ok(!("Authorization" in (body as object)) || true);
      return json(201, createdEvent("op-hold-1"));
    }
    return json(404, {});
  });
  const result = await connector.createProvisionalHold(holdBody("op-hold-1"));
  assert.equal(result.status, "succeeded");
  if (result.status !== "succeeded") return;
  assert.equal(result.data.hold.holdId, googleEventIdFor("op-hold-1"));
  assert.equal(result.data.hold.bookingId, "booking-001");
  assert.equal(result.data.hold.status, "provisional_hold");
  assert.equal(result.metadata.mode.label, "LIVE");
  assert.equal(result.metadata.simulated, false);
  assert.equal(result.metadata.mode.fictional, false);
  // No token material in request bodies.
  assert.ok(log.every((entry) => !JSON.stringify(entry.body ?? "").includes("approved-test-token")));
});

test("hold 409 replays the exact event; mismatched linkage is conflict", async () => {
  const matching = connectorFor(() => json(200, createdEvent("op-hold-2")));
  void matching;
  const replay = connectorFor((req) => {
    if (req.method === "POST") return googleError(409, "duplicate", "The requested identifier already exists.");
    return json(200, createdEvent("op-hold-2"));
  });
  const first = await replay.connector.createProvisionalHold(holdBody("op-hold-2"));
  assert.equal(first.status, "succeeded");
  if (first.status !== "succeeded") return;
  assert.equal(first.data.hold.holdId, googleEventIdFor("op-hold-2"));

  const mismatched = connectorFor((req) => {
    if (req.method === "POST") return googleError(409, "duplicate", "The requested identifier already exists.");
    return json(200, {
      ...createdEvent("op-hold-3"),
      extendedProperties: { private: { gatherOperationKey: "someone-else", gatherBookingId: "booking-999", gatherExpiresAt: "2030-06-13T23:00:00.000Z" } },
    });
  });
  const second = await mismatched.connector.createProvisionalHold(holdBody("op-hold-3"));
  assert.equal(second.status, "failed");
  if (second.status !== "failed") return;
  assert.equal(second.error.kind, "conflict");
});

test("timeout after acceptance is uncertain and reconciles by id", async () => {
  const serverEvents = new Map<string, unknown>();
  const { transport } = scripted((req) => {
    if (req.method === "POST") {
      serverEvents.set("held", createdEvent("op-hold-4"));
      throw new TransportTimeoutError();
    }
    const held = serverEvents.get("held");
    assert.ok(held !== undefined);
    return json(200, held);
  });
  const connector = new GoogleCalendarConnector({ transport, tokens: () => Promise.resolve("t"), calendarId: CAL });
  const created = await connector.createProvisionalHold(holdBody("op-hold-4"));
  assert.equal(created.status, "uncertain");
  if (created.status !== "uncertain") return;
  assert.equal(created.reconciliationRequired, true);
  const reconciled = await connector.reconcileProvisionalHold({ operationKey: "op-hold-4" });
  assert.equal(reconciled.status, "succeeded");
  if (reconciled.status !== "succeeded") return;
  assert.equal(reconciled.data.hold.holdId, googleEventIdFor("op-hold-4"));
  assert.equal(serverEvents.size, 1);
});

test("write 5xx is uncertain, never a retryable failure", async () => {
  const { connector } = connectorFor(() => googleError(500, "backendError", "simulated backend failure"));
  const result = await connector.createProvisionalHold(holdBody("op-hold-5"));
  assert.equal(result.status, "uncertain");
});

test("reconcile reports cancelled, missing, and unscoped lookups honestly", async () => {
  const { connector } = connectorFor(() => json(200, { ...createdEvent("op-hold-6"), status: "cancelled" }));
  const cancelled = await connector.reconcileProvisionalHold({ operationKey: "op-hold-6" });
  assert.equal(cancelled.status, "failed");
  if (cancelled.status !== "failed") return;
  assert.equal(cancelled.error.kind, "not_found");

  const missing = connectorFor(() => googleError(404, "notFound", "Not Found"));
  const gone = await missing.connector.reconcileProvisionalHold({ operationKey: "op-hold-7" });
  assert.equal(gone.status, "failed");
  if (gone.status !== "failed") return;
  assert.equal(gone.error.kind, "not_found");

  const bare = scripted(() => json(200, {}));
  const unscoped = new GoogleCalendarConnector({ transport: bare.transport, tokens: () => Promise.resolve("t") });
  const scoped = await unscoped.reconcileProvisionalHold({ operationKey: "op-hold-8" });
  assert.equal(scoped.status, "failed");
  if (scoped.status !== "failed") return;
  assert.equal(scoped.error.kind, "invalid_request");
  assert.equal(bare.log.length, 0);
});

test("malformed provider JSON is never coerced into success", async () => {
  const { connector } = connectorFor(() => ({ status: 200, headers: {}, text: "{not-json" }));
  const avail = await connector.checkAvailability({ operationKey: "op-x", calendarId: CAL, startAt: START, endAt: END });
  assert.equal(avail.status, "failed");
  const { connector: holdConnector } = connectorFor(() => ({ status: 201, headers: {}, text: "[1,2" }));
  const held = await holdConnector.createProvisionalHold(holdBody("op-y"));
  // Ambiguous success body after a write: uncertain, never blind-retryable failure.
  assert.equal(held.status, "uncertain");
});

test("reconcile rejects unrelated ids, missing linkage, and payload mismatches", async () => {
  const variants: Array<{ name: string; event: unknown; kind: string }> = [
    { name: "unrelated id", event: { ...createdEvent("op-v"), id: "unrelated" }, kind: "conflict" },
    {
      name: "missing linkage",
      event: { id: googleEventIdFor("op-v"), status: "confirmed", start: { dateTime: START }, end: { dateTime: END }, created: "2030-01-02T00:00:00.000Z" },
      kind: "conflict",
    },
    {
      name: "wrong booking",
      event: { ...createdEvent("op-v"), extendedProperties: { private: { gatherOperationKey: "op-v", gatherBookingId: "booking-999", gatherExpiresAt: "2030-06-13T23:00:00.000Z" } } },
      kind: "conflict",
    },
    {
      name: "wrong window",
      event: { ...createdEvent("op-v"), start: { dateTime: "2030-06-13T17:00:00.000Z" }, end: { dateTime: "2030-06-13T23:00:00.000Z" } },
      kind: "conflict",
    },
    {
      name: "wrong expiry",
      event: { ...createdEvent("op-v"), extendedProperties: { private: { gatherOperationKey: "op-v", gatherBookingId: "booking-001", gatherExpiresAt: "2030-07-01T00:00:00.000Z" } } },
      kind: "conflict",
    },
    {
      name: "missing times",
      event: { id: googleEventIdFor("op-v"), status: "confirmed", created: "2030-01-02T00:00:00.000Z", extendedProperties: { private: { gatherOperationKey: "op-v", gatherBookingId: "booking-001", gatherExpiresAt: "2030-06-13T23:00:00.000Z" } } },
      kind: "conflict",
    },
  ];
  for (const variant of variants) {
    const { transport } = scripted(() => json(200, variant.event));
    const connector = new GoogleCalendarConnector({
      transport,
      tokens: () => Promise.resolve("t"),
      resolveHoldScope: () => Promise.resolve({
        calendarId: CAL,
        bookingId: "booking-001",
        startAt: START,
        endAt: END,
        expiresAt: "2030-06-13T23:00:00.000Z",
      }),
    });
    const result = await connector.reconcileProvisionalHold({ operationKey: "op-v" });
    assert.equal(result.status, "failed", variant.name);
    if (result.status !== "failed") continue;
    assert.equal(result.error.kind, variant.kind, variant.name);
  }
});

test("reconcile verifies full identity through the durable resolver", async () => {
  const { transport, log } = scripted(() => json(200, createdEvent("op-full")));
  const connector = new GoogleCalendarConnector({
    transport,
    tokens: () => Promise.resolve("t"),
    resolveHoldScope: (key) => Promise.resolve(
      key === "op-full"
        ? { calendarId: CAL, bookingId: "booking-001", startAt: START, endAt: END, expiresAt: "2030-06-13T23:00:00.000Z" }
        : undefined,
    ),
  });
  const result = await connector.reconcileProvisionalHold({ operationKey: "op-full" });
  assert.equal(result.status, "succeeded");
  if (result.status !== "succeeded") return;
  assert.equal(result.data.hold.bookingId, "booking-001");
  assert.equal(result.data.hold.startAt, START);
  assert.equal(result.data.hold.expiresAt, "2030-06-13T23:00:00.000Z");
  assert.ok(log[0]?.url.includes(`/calendars/${CAL}/events/`));

  // Resolver silence means the scope cannot be established: no coercion.
  const connector2 = new GoogleCalendarConnector({
    transport,
    tokens: () => Promise.resolve("t"),
    resolveHoldScope: () => Promise.resolve(undefined),
  });
  const missing = await connector2.reconcileProvisionalHold({ operationKey: "op-unknown" });
  assert.equal(missing.status, "failed");
  if (missing.status !== "failed") return;
  assert.equal(missing.error.kind, "invalid_request");
});

test("missing token maps to revoked access, never to a live call", async () => {
  const { connector, log } = connectorFor(
    () => json(200, { items: [] }),
    { tokens: () => Promise.reject(new Error("no approved assets")) },
  );
  const result = await connector.checkAvailability({ operationKey: "op-t", calendarId: CAL, startAt: START, endAt: END });
  assert.equal(result.status, "failed");
  if (result.status !== "failed") return;
  assert.equal(result.error.kind, "access_revoked");
  assert.equal(log.length, 0);
});
