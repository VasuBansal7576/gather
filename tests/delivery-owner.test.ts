import assert from "node:assert/strict";
import test from "node:test";
import {
  parseConfirmResponse,
  parseHandoffResponse,
  parseReadinessResponse,
} from "../src/delivery-owner/contracts.ts";
import {
  bookingPhase,
  canAttemptConfirm,
  conditionLabel,
  deliveryRouteForBooking,
  formatCents,
  handoffStateLabel,
  RequestEpoch,
} from "../src/delivery-owner/state.ts";

const DECISION = {
  binding: { businessId: "biz", bookingId: "bk", proposalVersion: 1, proposalFingerprint: "ab".repeat(32) },
  evaluatedAt: "2030-05-20T12:00:00.000Z",
  conditions: [{
    kind: "deposit", required: true, status: "missing", detail: "Need $500",
    evidence: [], waived: false,
  }],
  ready: false,
  liveReady: false,
  provenance: "demo",
  blockedBy: ["deposit missing"],
  ignoredRawSignals: 1,
  rejectedEvidence: ["payment-link"],
};

const BOOKING = { id: "bk", businessId: "biz", status: "provisional_hold", eventName: "Fictional Dinner" };

test("readiness parses; unknown shapes rejected", () => {
  const parsed = parseReadinessResponse({ demo: true, booking: BOOKING, binding: DECISION.binding, decision: DECISION });
  assert.equal(parsed?.decision.ready, false);
  assert.equal(parseReadinessResponse({}), undefined);
  assert.equal(parseReadinessResponse({ demo: true, booking: BOOKING, binding: DECISION.binding, decision: { ...DECISION, provenance: "live!" } }), undefined);
  assert.equal(parseReadinessResponse({ demo: true, booking: BOOKING, binding: DECISION.binding, decision: { ...DECISION, conditions: [{ kind: "x" }] } }), undefined);
});

test("handoff parses null revision preview and recorded revision", () => {
  const base = { demo: true, booking: BOOKING, state: "preliminary", handoff: null };
  assert.deepEqual(parseHandoffResponse({ ...base, revision: null })?.revision, null);
  assert.equal(parseHandoffResponse({ ...base, revision: "1" }), undefined);
  assert.equal(parseHandoffResponse({ ...base, revision: 2, state: "ready" })?.state, "ready");
  assert.equal(parseHandoffResponse({ ...base, revision: null, state: "shipped" }), undefined);
});

test("confirm parses all command outcomes", () => {
  const base = { demo: false, booking: BOOKING, confirmedBooking: true, note: "ok", decision: null };
  assert.equal(parseConfirmResponse({ ...base, command: { confirmKey: "k", status: "confirmed" } })?.command.status, "confirmed");
  assert.equal(parseConfirmResponse({ ...base, command: { confirmKey: "k", status: "bogus" } }), undefined);
  assert.equal(parseConfirmResponse({ ...base, command: { confirmKey: "k", status: "blocked" }, decision: DECISION })?.decision?.ready, false);
});

test("state helpers stay owner-readable and the nav hook is explicit", () => {
  assert.equal(deliveryRouteForBooking("bk-1"), "/bookings/bk-1/delivery");
  assert.equal(deliveryRouteForBooking("a/b"), "/bookings/a%2Fb/delivery");
  assert.equal(bookingPhase("provisional_hold"), "provisional");
  assert.equal(bookingPhase("confirmed"), "confirmed");
  assert.equal(canAttemptConfirm(true, true), true);
  assert.equal(canAttemptConfirm(true, false), false);
  assert.equal(conditionLabel("deposit"), "Deposit");
  assert.ok(handoffStateLabel("blocked").startsWith("Blocked"));
  assert.equal(formatCents(50000, "USD"), "$500.00");
  const epoch = new RequestEpoch();
  const first = epoch.next();
  epoch.next();
  assert.equal(epoch.isCurrent(first), false);
});
