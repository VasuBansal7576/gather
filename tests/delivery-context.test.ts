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

function exec(
  id: string,
  actionId: string,
  version: number,
  key: string,
  status: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    proposedActionId: actionId,
    proposalVersion: version,
    idempotencyKey: key,
    attempt: 1,
    status,
    startedAt: "2030-05-01T10:00:00.000Z",
    completedAt: "2030-05-01T10:01:00.000Z",
    ...extra,
  };
}

function liveProof(locator: string): Record<string, unknown> {
  return { proof: { mode: "live", simulated: false, provenance: [{ kind: "calendar", locator }] } };
}

function fixtureProof(locator: string): Record<string, unknown> {
  return { proof: { mode: "demo", simulated: true, provenance: [{ kind: "fixture", locator, fictional: true }] } };
}

test("historical successes never read as current proof; unknown keys never read as hold", async () => {
  const api = createDeliveryApi(fixtureFetch(workspaceWith(bookingRecord({
    currentProposedActionId: "action-new",
    // Stale action sorts last with the higher version so at(-1) and
    // max-version would both pick it; the pointer names the new v1.
    proposals: [action("action-new", 1, FP_NEW), action("action-old", 2, FP_OLD)],
    executions: [
      exec("ex-old-hold", "action-old", 2, "gather:calendar:create-provisional-hold:aaaa1111", "succeeded", { result: liveProof("cal://old") }),
      exec("ex-old-email", "action-old", 2, "gather:email:send:bbbb2222", "succeeded", { result: liveProof("gmail://old") }),
      exec("ex-weird", "action-new", 1, "gather:calendar:availability:cccc3333", "succeeded"),
      exec("ex-new-hold", "action-new", 1, "gather:calendar:create-provisional-hold:dddd4444", "pending"),
    ],
  }))));
  const context = await api.getBookingContext("booking-fixture-1");
  assert.equal(context.identity?.proposedActionId, "action-new");
  const proof = context.receipts.filter((receipt) => receipt.current && receipt.step !== "unknown");
  assert.deepEqual(proof.map((receipt) => receipt.id), ["ex-new-hold"]);
  const byId = new Map(context.receipts.map((receipt) => [receipt.id, receipt]));
  // Historical rows keep their step but are never current.
  assert.equal(byId.get("ex-old-hold")?.step, "hold");
  assert.equal(byId.get("ex-old-hold")?.current, false);
  assert.equal(byId.get("ex-old-email")?.step, "email");
  assert.equal(byId.get("ex-old-email")?.current, false);
  // The unknown operation key is not guessed as a hold.
  assert.equal(byId.get("ex-weird")?.step, "unknown");
  // Provenance survives the boundary: live stays live, missing stays unknown.
  assert.equal(byId.get("ex-old-hold")?.provenance, "live");
  assert.equal(byId.get("ex-weird")?.provenance, "unknown");
  assert.equal(byId.get("ex-new-hold")?.provenance, "unknown");
});

test("provenance distinguishes live, simulated, and unknown without upgrading", async () => {
  const api = createDeliveryApi(fixtureFetch(workspaceWith(bookingRecord({
    currentProposedActionId: "action-new",
    proposals: [action("action-new", 1, FP_NEW)],
    executions: [
      exec("ex-live", "action-new", 1, "gather:calendar:create-provisional-hold:1111aaaa", "succeeded", { result: liveProof("cal://live") }),
      exec("ex-sim", "action-new", 1, "gather:email:send:2222bbbb", "succeeded", { result: fixtureProof("fixture://demo") }),
      exec("ex-fictional-live", "action-new", 1, "gather:calendar:create-provisional-hold:3333cccc", "succeeded", {
        result: { proof: { mode: "live", simulated: false, provenance: [{ kind: "fixture", locator: "fixture://x", fictional: true }] } },
      }),
      exec("ex-noproof", "action-new", 1, "gather:calendar:create-provisional-hold:4444dddd", "succeeded"),
      exec("ex-malformed", "action-new", 1, "gather:calendar:create-provisional-hold:5555eeee", "succeeded", { result: { proof: "nonsense" } }),
    ],
  }))));
  const context = await api.getBookingContext("booking-fixture-1");
  const byId = new Map(context.receipts.map((receipt) => [receipt.id, receipt]));
  assert.equal(byId.get("ex-live")?.provenance, "live");
  assert.equal(byId.get("ex-sim")?.provenance, "simulated");
  // Live-claimed proof citing fictional refs fails closed to simulated.
  assert.equal(byId.get("ex-fictional-live")?.provenance, "simulated");
  assert.equal(byId.get("ex-noproof")?.provenance, "unknown");
  assert.equal(byId.get("ex-malformed")?.provenance, "unknown");
  // All rows are scoped to the current proposal, so all are current.
  assert.ok(context.receipts.every((receipt) => receipt.current === true));
});

test("evidence envelope markers decide on positive evidence; proof-absent successes stay unknown", async () => {
  const api = createDeliveryApi(fixtureFetch(workspaceWith(bookingRecord({
    currentProposedActionId: "action-new",
    proposals: [action("action-new", 1, FP_NEW)],
    executions: [
      exec("ex-mode-live", "action-new", 1, "gather:calendar:create-provisional-hold:1111aaaa", "succeeded", {
        mode: { kind: "live", label: "LIVE", fictional: false },
      }),
      exec("ex-mode-demo", "action-new", 1, "gather:calendar:create-provisional-hold:2222bbbb", "succeeded", {
        mode: { kind: "demo", label: "DEMO ONLY", fictional: true },
      }),
      exec("ex-mode-unknown", "action-new", 1, "gather:calendar:create-provisional-hold:3333cccc", "succeeded", {
        mode: { kind: "unknown", label: "UNVERIFIED", fictional: false },
      }),
      exec("ex-demo-true", "action-new", 1, "gather:email:send:4444dddd", "succeeded", { demo: true }),
      // Bare demo:false with no mode and no proof is NOT positive evidence.
      exec("ex-bare", "action-new", 1, "gather:calendar:create-provisional-hold:5555eeee", "succeeded", { demo: false }),
    ],
  }))));
  const context = await api.getBookingContext("booking-fixture-1");
  const byId = new Map(context.receipts.map((receipt) => [receipt.id, receipt]));
  assert.equal(byId.get("ex-mode-live")?.provenance, "live");
  assert.equal(byId.get("ex-mode-demo")?.provenance, "simulated");
  assert.equal(byId.get("ex-mode-unknown")?.provenance, "unknown");
  assert.equal(byId.get("ex-demo-true")?.provenance, "simulated");
  assert.equal(byId.get("ex-bare")?.provenance, "unknown");
});

test("version drift within the same action is history, not proof", async () => {
  const api = createDeliveryApi(fixtureFetch(workspaceWith(bookingRecord({
    currentProposedActionId: "action-new",
    proposals: [action("action-new", 2, FP_NEW)],
    executions: [
      exec("ex-v1", "action-new", 1, "gather:calendar:create-provisional-hold:aaaa1111", "succeeded", { result: liveProof("cal://v1") }),
      exec("ex-v2", "action-new", 2, "gather:calendar:create-provisional-hold:bbbb2222", "succeeded", { result: liveProof("cal://v2") }),
    ],
  }))));
  const context = await api.getBookingContext("booking-fixture-1");
  assert.equal(context.identity?.proposalVersion, 2);
  const byId = new Map(context.receipts.map((receipt) => [receipt.id, receipt]));
  assert.equal(byId.get("ex-v1")?.current, false);
  assert.equal(byId.get("ex-v2")?.current, true);
});

test("absent pointer is honestly no authority: no identity, every receipt non-current", async () => {
  const api = createDeliveryApi(fixtureFetch(workspaceWith(bookingRecord({
    proposals: [action("action-first", 1, FP_NEW), action("action-last", 1, FP_OLD)],
    executions: [{
      id: "ex-1",
      proposedActionId: "action-last",
      proposalVersion: 1,
      idempotencyKey: "gather:calendar:create-provisional-hold:abc123",
      attempt: 1,
      status: "succeeded",
      startedAt: "2030-05-01T10:00:00.000Z",
    }],
  }))));
  const context = await api.getBookingContext("booking-fixture-1");
  assert.equal(context.identity, undefined);
  assert.ok(context.receipts.length > 0);
  assert.ok(context.receipts.every((receipt) => receipt.current === false));
});
