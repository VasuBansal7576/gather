/**
 * SIMULATED contract tests for the live Google hold-release adapter.
 * Every HTTP exchange below is scripted through an injected fake transport;
 * no live account verification has been performed and the live gate is BLOCKED.
 *
 * Covers: loopback release (GET → conditional DELETE → absence confirm),
 * idempotent replay of an absent hold, wrong calendar/event refusal without
 * any HTTP call, changed-identity refusal, ETag 412 conflict, timeout after
 * DELETE (uncertain + restart reconcile), revoked permission mapping, and
 * restart-stable reconcile via the durable scope resolver.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { googleEventIdFor } from "../src/connectors/google/calendar.ts";
import { GoogleCalendarHoldReleaseConnector } from "../src/connectors/google/hold-release.ts";
import { TransportTimeoutError, type GoogleHttpRequest, type GoogleHttpResponse, type GoogleHttpTransport } from "../src/connectors/google/transport.ts";
import type { ReleaseProvisionalHoldRequest } from "../src/connectors/hold-release.ts";

const CAL = "owner-calendar-001";
const BOOKING = "booking-001";
const HOLD_OP = "gather:calendar:create-provisional-hold:release-test-1";
const HOLD_ID = googleEventIdFor(HOLD_OP);
const START = "2030-06-12T17:00:00.000Z";
const END = "2030-06-12T23:00:00.000Z";
const EXPIRES = "2030-06-13T23:00:00.000Z";
const ETAG = '"hold-rev-7"';

function json(status: number, body: unknown, headers: Record<string, string> = {}): GoogleHttpResponse {
  return { status, headers: { "Content-Type": "application/json", ...headers }, text: JSON.stringify(body) };
}

function empty(status: number): GoogleHttpResponse {
  return { status, headers: {}, text: "" };
}

function googleError(status: number, reason: string, message: string): GoogleHttpResponse {
  return json(status, { error: { code: status, message, errors: [{ domain: "global", reason, message }] } });
}

function holdEvent(opKey: string = HOLD_OP, booking: string = BOOKING): Record<string, unknown> {
  return {
    id: HOLD_ID,
    status: "confirmed",
    etag: ETAG,
    summary: `Gather provisional hold — ${booking}`,
    start: { dateTime: START },
    end: { dateTime: END },
    created: "2030-01-02T00:00:00.000Z",
    extendedProperties: { private: { gatherOperationKey: opKey, gatherBookingId: booking, gatherExpiresAt: EXPIRES } },
  };
}

function releaseRequest(overrides: Partial<ReleaseProvisionalHoldRequest> = {}): ReleaseProvisionalHoldRequest {
  return {
    operationKey: "release-op-1",
    bookingId: BOOKING,
    calendarId: CAL,
    holdId: HOLD_ID,
    originalHoldOperationKey: HOLD_OP,
    startAt: START,
    endAt: END,
    expiresAt: EXPIRES,
    ...overrides,
  };
}

function scripted(handler: (req: GoogleHttpRequest) => GoogleHttpResponse | Promise<GoogleHttpResponse>): {
  transport: GoogleHttpTransport;
  log: GoogleHttpRequest[];
} {
  const log: GoogleHttpRequest[] = [];
  return {
    log,
    transport: { request: (req) => { log.push(req); return Promise.resolve(handler(req)); } },
  };
}

test("loopback release verifies, deletes conditionally, and confirms absence", async () => {
  const calls: string[] = [];
  const { transport, log } = scripted((req) => {
    calls.push(`${req.method} ${req.url}`);
    if (req.method === "GET") {
      if (calls.length === 1) return json(200, holdEvent(), { ETag: ETAG });
      return googleError(404, "notFound", "Not Found");
    }
    assert.equal(req.method, "DELETE");
    assert.match(req.url, /sendUpdates=none/);
    assert.equal(req.headers["If-Match"], ETAG);
    return empty(204);
  });
  const connector = new GoogleCalendarHoldReleaseConnector({
    transport,
    tokens: () => Promise.resolve("approved-test-token"),
    calendarId: CAL,
  });
  const result = await connector.releaseProvisionalHold(releaseRequest());
  assert.equal(result.status, "succeeded");
  if (result.status !== "succeeded") return;
  assert.equal(result.data.released.holdId, HOLD_ID);
  assert.equal(result.data.released.status, "released");
  assert.equal(result.data.released.alreadyReleased, false);
  assert.equal(result.metadata.mode.mode, "live");
  assert.equal(result.metadata.simulated, false);
  assert.equal(result.metadata.mode.fictional, false);
  assert.equal(calls.length, 3);
  assert.ok(log.every((entry) => !JSON.stringify(entry.body ?? "").includes("approved-test-token")));
});

test("absent hold replays as idempotent success without a delete", async () => {
  const { transport, log } = scripted((req) => {
    assert.equal(req.method, "GET");
    return googleError(404, "notFound", "Not Found");
  });
  const connector = new GoogleCalendarHoldReleaseConnector({
    transport,
    tokens: () => Promise.resolve("t"),
    calendarId: CAL,
  });
  const result = await connector.releaseProvisionalHold(releaseRequest());
  assert.equal(result.status, "succeeded");
  if (result.status !== "succeeded") return;
  assert.equal(result.data.released.alreadyReleased, true);
  assert.equal(log.length, 1);
});

test("wrong calendar is refused without any HTTP call", async () => {
  const { transport, log } = scripted(() => json(200, holdEvent()));
  const connector = new GoogleCalendarHoldReleaseConnector({
    transport,
    tokens: () => Promise.resolve("t"),
    calendarId: CAL,
  });
  const result = await connector.releaseProvisionalHold(releaseRequest({ calendarId: "other-calendar" }));
  assert.equal(result.status, "failed");
  if (result.status !== "failed") return;
  assert.equal(result.error.kind, "invalid_request");
  assert.equal(log.length, 0);
});

test("wrong event id is refused without any HTTP call", async () => {
  const { transport, log } = scripted(() => json(200, holdEvent()));
  const connector = new GoogleCalendarHoldReleaseConnector({
    transport,
    tokens: () => Promise.resolve("t"),
    calendarId: CAL,
  });
  const result = await connector.releaseProvisionalHold(releaseRequest({ holdId: "stranger-event-id" }));
  assert.equal(result.status, "failed");
  if (result.status !== "failed") return;
  assert.equal(result.error.kind, "conflict");
  assert.equal(log.length, 0);
});

test("changed identity refuses the delete", async () => {
  const { transport, log } = scripted(() => json(200, holdEvent("someone-else", "booking-999"), { ETag: ETAG }));
  const connector = new GoogleCalendarHoldReleaseConnector({
    transport,
    tokens: () => Promise.resolve("t"),
    calendarId: CAL,
  });
  const result = await connector.releaseProvisionalHold(releaseRequest());
  assert.equal(result.status, "failed");
  if (result.status !== "failed") return;
  assert.equal(result.error.kind, "conflict");
  assert.ok(log.every((entry) => entry.method === "GET"));
});

test("changed window refuses the delete", async () => {
  const moved = { ...holdEvent(), start: { dateTime: "2030-06-13T17:00:00.000Z" }, end: { dateTime: "2030-06-13T23:00:00.000Z" } };
  const { transport, log } = scripted(() => json(200, moved, { ETag: ETAG }));
  const connector = new GoogleCalendarHoldReleaseConnector({
    transport,
    tokens: () => Promise.resolve("t"),
    calendarId: CAL,
  });
  const result = await connector.releaseProvisionalHold(releaseRequest());
  assert.equal(result.status, "failed");
  if (result.status !== "failed") return;
  assert.equal(result.error.kind, "conflict");
  assert.ok(log.every((entry) => entry.method === "GET"));
});

test("ETag precondition failure is conflict, not success", async () => {
  const { transport } = scripted((req) => {
    if (req.method === "GET") return json(200, holdEvent(), { ETag: ETAG });
    return googleError(412, "conditionNotMet", "Precondition failed");
  });
  const connector = new GoogleCalendarHoldReleaseConnector({
    transport,
    tokens: () => Promise.resolve("t"),
    calendarId: CAL,
  });
  const result = await connector.releaseProvisionalHold(releaseRequest());
  assert.equal(result.status, "failed");
  if (result.status !== "failed") return;
  assert.equal(result.error.kind, "conflict");
});

test("concurrent delete between read and delete is idempotent success", async () => {
  const { transport } = scripted((req) => {
    if (req.method === "GET") return json(200, holdEvent(), { ETag: ETAG });
    return googleError(404, "notFound", "Not Found");
  });
  const connector = new GoogleCalendarHoldReleaseConnector({
    transport,
    tokens: () => Promise.resolve("t"),
    calendarId: CAL,
  });
  const result = await connector.releaseProvisionalHold(releaseRequest());
  assert.equal(result.status, "succeeded");
  if (result.status !== "succeeded") return;
  assert.equal(result.data.released.alreadyReleased, true);
});

test("surviving event after delete is a retryable failure, never success", async () => {
  const { transport } = scripted((req) => {
    if (req.method === "DELETE") return empty(204);
    return json(200, holdEvent(), { ETag: ETAG });
  });
  const connector = new GoogleCalendarHoldReleaseConnector({
    transport,
    tokens: () => Promise.resolve("t"),
    calendarId: CAL,
  });
  const result = await connector.releaseProvisionalHold(releaseRequest());
  assert.equal(result.status, "failed");
  if (result.status !== "failed") return;
  assert.equal(result.error.kind, "transport_error");
  assert.equal(result.error.retryable, true);
});

test("timeout after delete is uncertain and restart-reconciles to success", async () => {
  let deleted = false;
  const { transport } = scripted((req) => {
    if (req.method === "DELETE") {
      deleted = true;
      throw new TransportTimeoutError();
    }
    // Post-restart world: the delete landed, so the event is gone.
    if (deleted) return googleError(410, "deleted", "Resource has been deleted");
    return json(200, holdEvent(), { ETag: ETAG });
  });
  const tokens = () => Promise.resolve("t");
  const first = new GoogleCalendarHoldReleaseConnector({ transport, tokens, calendarId: CAL });
  const released = await first.releaseProvisionalHold(releaseRequest({ operationKey: "release-timeout-1" }));
  assert.equal(released.status, "uncertain");
  if (released.status !== "uncertain") return;
  assert.equal(released.reconciliationRequired, true);

  // Restart: a fresh adapter with no binding, scope from durable storage.
  const restarted = new GoogleCalendarHoldReleaseConnector({
    transport,
    tokens,
    resolveReleaseScope: (key) => Promise.resolve(
      key === "release-timeout-1"
        ? { calendarId: CAL, holdId: HOLD_ID, bookingId: BOOKING, originalHoldOperationKey: HOLD_OP, startAt: START, endAt: END, expiresAt: EXPIRES }
        : undefined,
    ),
  });
  const reconciled = await restarted.reconcileReleasedHold({ operationKey: "release-timeout-1" });
  assert.equal(reconciled.status, "succeeded");
  if (reconciled.status !== "succeeded") return;
  assert.equal(reconciled.data.released.holdId, HOLD_ID);
  assert.equal(reconciled.metadata.simulated, false);
});

test("delete 5xx is uncertain, never a blind-retryable failure", async () => {
  const { transport } = scripted((req) => {
    if (req.method === "DELETE") return googleError(500, "backendError", "simulated backend failure");
    return json(200, holdEvent(), { ETag: ETAG });
  });
  const connector = new GoogleCalendarHoldReleaseConnector({
    transport,
    tokens: () => Promise.resolve("t"),
    calendarId: CAL,
  });
  const result = await connector.releaseProvisionalHold(releaseRequest());
  assert.equal(result.status, "uncertain");
});

test("revoked permission maps honestly on read and delete", async () => {
  const deniedTransport = scripted(() => googleError(401, "authError", "Invalid Credentials"));
  const readDenied = new GoogleCalendarHoldReleaseConnector({
    transport: deniedTransport.transport,
    tokens: () => Promise.resolve("t"),
    calendarId: CAL,
  });
  const readResult = await readDenied.releaseProvisionalHold(releaseRequest());
  assert.equal(readResult.status, "failed");
  if (readResult.status !== "failed") return;
  assert.equal(readResult.error.kind, "access_revoked");

  const { transport } = scripted((req) => {
    if (req.method === "DELETE") return googleError(403, "forbidden", "The caller does not have permission");
    return json(200, holdEvent(), { ETag: ETAG });
  });
  const deleteDenied = new GoogleCalendarHoldReleaseConnector({ transport, tokens: () => Promise.resolve("t"), calendarId: CAL });
  const deleteResult = await deleteDenied.releaseProvisionalHold(releaseRequest());
  assert.equal(deleteResult.status, "failed");
  if (deleteResult.status !== "failed") return;
  assert.equal(deleteResult.error.kind, "authorization_denied");
});

test("missing token performs no HTTP call", async () => {
  const { transport, log } = scripted(() => json(200, holdEvent()));
  const connector = new GoogleCalendarHoldReleaseConnector({
    transport,
    tokens: () => Promise.reject(new Error("no approved assets")),
    calendarId: CAL,
  });
  const result = await connector.releaseProvisionalHold(releaseRequest());
  assert.equal(result.status, "failed");
  if (result.status !== "failed") return;
  assert.equal(result.error.kind, "access_revoked");
  assert.equal(log.length, 0);
});

test("reconcile reports a surviving hold honestly and refuses unscoped keys", async () => {
  const { transport, log } = scripted(() => json(200, holdEvent(), { ETag: ETAG }));
  const tokens = () => Promise.resolve("t");
  const scopeFor = (key: string) => Promise.resolve(
    key === "release-still-there"
      ? { calendarId: CAL, holdId: HOLD_ID, bookingId: BOOKING, originalHoldOperationKey: HOLD_OP, startAt: START, endAt: END, expiresAt: EXPIRES }
      : undefined,
  );
  const connector = new GoogleCalendarHoldReleaseConnector({ transport, tokens, resolveReleaseScope: scopeFor });
  const present = await connector.reconcileReleasedHold({ operationKey: "release-still-there" });
  assert.equal(present.status, "failed");
  if (present.status !== "failed") return;
  assert.equal(present.error.kind, "conflict");
  // Reconcile never deletes: every call was a GET.
  assert.ok(log.every((entry) => entry.method === "GET"));

  const unknown = await connector.reconcileReleasedHold({ operationKey: "release-unknown" });
  assert.equal(unknown.status, "failed");
  if (unknown.status !== "failed") return;
  assert.equal(unknown.error.kind, "invalid_request");

  const bare = scripted(() => json(404, {}));
  const unscoped = new GoogleCalendarHoldReleaseConnector({ transport: bare.transport, tokens });
  const noscope = await unscoped.reconcileReleasedHold({ operationKey: "release-x" });
  assert.equal(noscope.status, "failed");
  if (noscope.status !== "failed") return;
  assert.equal(noscope.error.kind, "invalid_request");
  assert.equal(bare.log.length, 0);
});
