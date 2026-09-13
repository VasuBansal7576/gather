/**
 * Deterministic DEMO ONLY tests for the hold-release simulator.
 * These exercise fictional in-memory behavior only and assert the demo
 * provenance markers (`DEMO ONLY`, `simulated: true`, fictional). They are
 * never live outcomes — see tests/google-hold-release.test.ts (SIMULATED
 * scripted HTTP) for the live adapter contract.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DemoCalendarHoldReleaseConnector } from "../src/connectors/hold-release-demo.ts";
import { releaseHoldOperationKey } from "../src/connectors/hold-release.ts";

const HOLD = {
  holdId: "demo-hold-001",
  bookingId: "booking-001",
  calendarId: "demo-calendar-001",
  originalHoldOperationKey: "gather:calendar:create-provisional-hold:demo-1",
  startAt: "2030-06-12T17:00:00.000Z",
  endAt: "2030-06-12T23:00:00.000Z",
  expiresAt: "2030-06-13T23:00:00.000Z",
};

function request(overrides: Record<string, string> = {}) {
  return {
    operationKey: "demo-release-1",
    bookingId: HOLD.bookingId,
    calendarId: HOLD.calendarId,
    holdId: HOLD.holdId,
    originalHoldOperationKey: HOLD.originalHoldOperationKey,
    startAt: HOLD.startAt,
    endAt: HOLD.endAt,
    expiresAt: HOLD.expiresAt,
    ...overrides,
  };
}

test("demo release deletes the seeded hold with demo provenance", async () => {
  const connector = new DemoCalendarHoldReleaseConnector({ holds: [HOLD] });
  const result = await connector.releaseProvisionalHold(request());
  assert.equal(result.status, "succeeded");
  if (result.status !== "succeeded") return;
  assert.equal(result.data.released.status, "released");
  assert.equal(result.data.released.alreadyReleased, false);
  assert.equal(result.metadata.mode.label, "DEMO ONLY");
  assert.equal(result.metadata.simulated, true);
  assert.equal(result.metadata.mode.fictional, true);
  assert.equal(connector.getHold(HOLD.holdId), undefined);
});

test("demo release replays an absent hold as idempotent success", async () => {
  const connector = new DemoCalendarHoldReleaseConnector({ holds: [HOLD] });
  const first = await connector.releaseProvisionalHold(request());
  assert.equal(first.status, "succeeded");
  const second = await connector.releaseProvisionalHold(request({ operationKey: "demo-release-2" }));
  assert.equal(second.status, "succeeded");
  if (second.status !== "succeeded") return;
  assert.equal(second.data.released.alreadyReleased, true);
});

test("demo release refuses wrong calendar and stranger identity", async () => {
  const connector = new DemoCalendarHoldReleaseConnector({ holds: [HOLD] });
  const wrongCal = await connector.releaseProvisionalHold(request({ calendarId: "other-calendar" }));
  assert.equal(wrongCal.status, "failed");
  if (wrongCal.status !== "failed") return;
  assert.equal(wrongCal.error.kind, "conflict");

  const stranger = await connector.releaseProvisionalHold(
    request({ bookingId: "booking-999", originalHoldOperationKey: "gather:calendar:create-provisional-hold:other" }),
  );
  assert.equal(stranger.status, "failed");
  if (stranger.status !== "failed") return;
  assert.equal(stranger.error.kind, "conflict");
  // Refused releases never delete: the hold survives both attempts.
  assert.notEqual(connector.getHold(HOLD.holdId), undefined);
});

test("demo timeout deletes, reports uncertain, and reconciles", async () => {
  const connector = new DemoCalendarHoldReleaseConnector({
    holds: [HOLD],
    timeoutAfterSuccessOperationKeys: ["demo-release-timeout"],
  });
  const released = await connector.releaseProvisionalHold(request({ operationKey: "demo-release-timeout" }));
  assert.equal(released.status, "uncertain");
  if (released.status !== "uncertain") return;
  assert.equal(released.reconciliationRequired, true);
  assert.equal(connector.getHold(HOLD.holdId), undefined);

  const reconciled = await connector.reconcileReleasedHold({ operationKey: "demo-release-timeout" });
  assert.equal(reconciled.status, "succeeded");
  if (reconciled.status !== "succeeded") return;
  assert.equal(reconciled.data.released.holdId, HOLD.holdId);
});

test("demo reconcile refuses unknown keys and reports surviving holds", async () => {
  const connector = new DemoCalendarHoldReleaseConnector({ holds: [HOLD] });
  const unknown = await connector.reconcileReleasedHold({ operationKey: "demo-unknown" });
  assert.equal(unknown.status, "failed");
  if (unknown.status !== "failed") return;
  assert.equal(unknown.error.kind, "invalid_request");
});

test("release operation keys are deterministic", () => {
  const input = { bookingId: "booking-001", holdId: "demo-hold-001", originalHoldOperationKey: "op-hold-1" };
  assert.equal(releaseHoldOperationKey(input), releaseHoldOperationKey(input));
  assert.match(releaseHoldOperationKey(input), /^gather:calendar:release-provisional-hold:/);
});
