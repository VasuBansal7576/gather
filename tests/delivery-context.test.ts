import assert from "node:assert/strict";
import test from "node:test";
import { createDeliveryApi, type DeliveryFetch } from "../src/delivery-owner/api.ts";

// getBookingContext must follow the durable current-proposal pointer
// (K 4402f67 `currentProposedActionId`) — never proposals.at(-1), never max
// version. All fixtures use clearly fictional identifiers.

const FP_NEW = "n".repeat(64);
const FP_OLD = "o".repeat(64);

function action(id: string, version: number, fingerprint: string): Record<string, unknown> {
  return {
    action: { id, proposalVersion: version, proposalFingerprint: fingerprint, kind: "create_provisional_hold" },
  };
}

/** Fake transport serving one workspace payload for GET /api/workspace. */
function fixtureFetch(workspace: unknown): DeliveryFetch {
  return async (input: string) => {
    assert.equal(input, "/api/workspace");
    return new Response(JSON.stringify(workspace), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

function workspaceWith(record: Record<string, unknown>): Record<string, unknown> {
  return { demo: false, bookings: [record] };
}

function bookingRecord(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    booking: { id: "booking-fixture-1", eventName: "Fictional dinner", status: "provisional_hold" },
    executions: [],
    ...extra,
  };
}

test("pointer selects the current v1 over a stale higher-version v2 listed last (adverse order)", async () => {
  const api = createDeliveryApi(fixtureFetch(workspaceWith(bookingRecord({
    currentProposedActionId: "action-new",
    // Stale old action carries the HIGHER version and sits last, so both
    // at(-1) and max-version would pick it. The pointer names the new v1.
    proposals: [action("action-new", 1, FP_NEW), action("action-old", 2, FP_OLD)],
  }))));
  const context = await api.getBookingContext("booking-fixture-1");
  assert.equal(context.identity?.proposedActionId, "action-new");
  assert.equal(context.identity?.proposalVersion, 1);
  assert.equal(context.identity?.proposalFingerprint, FP_NEW);
});

test("pointer selects the current action regardless of array position", async () => {
  const api = createDeliveryApi(fixtureFetch(workspaceWith(bookingRecord({
    currentProposedActionId: "action-new",
    proposals: [action("action-old", 9, FP_OLD), action("action-new", 1, FP_NEW)],
  }))));
  const context = await api.getBookingContext("booking-fixture-1");
  assert.equal(context.identity?.proposedActionId, "action-new");
  assert.equal(context.identity?.proposalVersion, 1);
});

test("dangling pointer fails closed: no identity, never a wrong proposal", async () => {
  const api = createDeliveryApi(fixtureFetch(workspaceWith(bookingRecord({
    currentProposedActionId: "action-missing",
    proposals: [action("action-new", 1, FP_NEW), action("action-old", 2, FP_OLD)],
  }))));
  const context = await api.getBookingContext("booking-fixture-1");
  assert.equal(context.identity, undefined);
});

test("malformed pointer fails closed instead of guessing", async () => {
  for (const bad of [123, "", null]) {
    const api = createDeliveryApi(fixtureFetch(workspaceWith(bookingRecord({
      currentProposedActionId: bad,
      proposals: [action("action-new", 1, FP_NEW)],
    }))));
    const context = await api.getBookingContext("booking-fixture-1");
    assert.equal(context.identity, undefined);
  }
});

test("absent pointer keeps the pre-pointer legacy fallback (integration backcompat)", async () => {
  const api = createDeliveryApi(fixtureFetch(workspaceWith(bookingRecord({
    proposals: [action("action-first", 1, FP_NEW), action("action-last", 1, FP_OLD)],
  }))));
  const context = await api.getBookingContext("booking-fixture-1");
  assert.equal(context.identity?.proposedActionId, "action-last");
});
