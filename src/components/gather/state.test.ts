import assert from "node:assert/strict";
import test from "node:test";
import {
  isApprovalInFlight,
  receiptRecoveryKind,
  resolveSelectedBookingId,
} from "./state.ts";
import { DEMO_BOOKINGS } from "./demo-data.ts";
import type { ProposalIdentity } from "./types.ts";

test("selected booking recovers when the list changes or empties", () => {
  const bookings = [{ id: "a" }, { id: "b" }];
  // No prior selection falls back to the first booking.
  assert.equal(resolveSelectedBookingId(bookings, undefined), "a");
  // An existing selection is preserved across refreshes.
  assert.equal(resolveSelectedBookingId(bookings, "b"), "b");
  // A vanished selection falls back to the first booking.
  assert.equal(resolveSelectedBookingId(bookings, "gone"), "a");
  // An empty list yields no selection — never a stale booking.
  assert.equal(resolveSelectedBookingId([], "a"), undefined);
});

test("approval is in flight via fingerprint prop or pending receipt", () => {
  const proposal = { fingerprint: "fp-1" };
  assert.equal(isApprovalInFlight(proposal, undefined, undefined), false);
  assert.equal(isApprovalInFlight(proposal, ["fp-1"], []), true);
  assert.equal(isApprovalInFlight(proposal, ["other"], []), false);
  assert.equal(isApprovalInFlight(proposal, undefined, [
    { id: "r1", actionId: "a1", label: "x", status: "pending" },
  ]), true);
  assert.equal(isApprovalInFlight(proposal, undefined, [
    { id: "r1", actionId: "a1", label: "x", status: "succeeded" },
  ]), false);
});

test("receipt recovery routes retry vs reconcile honestly", () => {
  assert.equal(receiptRecoveryKind({ status: "failed", recoveryLabel: "Retry" }), "retry");
  assert.equal(receiptRecoveryKind({ status: "partial", recoveryLabel: "Retry" }), "retry");
  assert.equal(
    receiptRecoveryKind({ status: "uncertain", recoveryLabel: "Reconcile", executionId: "e1" }),
    "reconcile",
  );
  // An uncertain receipt without an execution id cannot be reconciled.
  assert.equal(receiptRecoveryKind({ status: "uncertain", recoveryLabel: "Reconcile" }), undefined);
  // Succeeded and pending receipts never offer recovery.
  assert.equal(receiptRecoveryKind({ status: "succeeded", recoveryLabel: "Retry" }), undefined);
  assert.equal(receiptRecoveryKind({ status: "pending" }), undefined);
  assert.equal(receiptRecoveryKind({ status: "failed" }), undefined);
});

test("demo fixtures carry exact proposal identity for the approval contract", () => {
  for (const booking of DEMO_BOOKINGS) {
    const proposal = booking.detail.proposal;
    assert.equal(typeof proposal.version, "number");
    assert.ok(proposal.version >= 1);
    assert.ok(proposal.fingerprint.startsWith("demo-fp-"));
    assert.ok(proposal.consequences.length > 0);
    const identity: ProposalIdentity = {
      bookingId: booking.id,
      proposedActionId: proposal.id,
      proposalVersion: proposal.version,
      proposalFingerprint: proposal.fingerprint,
    };
    assert.equal(identity.bookingId, booking.id);
  }
});

test("demo receipts never claim a hold or sent request is confirmed", () => {
  const priya = DEMO_BOOKINGS.find((booking) => booking.id === "booking-priya-04");
  assert.ok(priya);
  assert.equal(priya.status, "provisional-hold");
  const statuses = priya.detail.receipts?.map((receipt) => receipt.status) ?? [];
  assert.ok(statuses.includes("succeeded"));
  assert.ok(statuses.includes("uncertain"));
  assert.ok(statuses.includes("partial"));
});
