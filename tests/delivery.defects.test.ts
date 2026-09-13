import assert from "node:assert/strict";
import test from "node:test";
import { buildHandoff } from "../src/delivery/handoff.ts";
import { evaluateReadiness } from "../src/delivery/readiness.ts";
import type { EvaluateReadinessInput } from "../src/delivery/contracts.ts";
import type { SourceReference } from "../src/domain/contracts.ts";

// Regression tests for the five concrete defects: duplicate receiptId
// double-counting, conflicting ledger snapshots, resource revision/window
// binding, waiver fingerprint scope, and booking/proposal window mismatch.
// Clearly fictional fixture identifiers throughout.
const NOW = "2030-05-01T12:00:00.000Z";
const WIN_START = "2030-06-01T18:00:00.000Z";
const WIN_END = "2030-06-01T22:00:00.000Z";

function liveRef(locator: string): SourceReference {
  return { kind: "calendar", locator };
}

function receipt(receiptId: string, status: string, amountCents: number, extra: Record<string, unknown> = {}) {
  return {
    resolver: "deposit_ledger",
    bookingId: "booking-1",
    receiptId,
    amountCents,
    currency: "USD",
    status,
    observedAt: "2030-04-29T10:00:00.000Z",
    sourceRefs: [liveRef(`ledger://${receiptId}`)],
    ...extra,
  };
}

function commitment(resourceId: string, extra: Record<string, unknown> = {}) {
  return {
    resolver: "resource_registry",
    bookingId: "booking-1",
    resourceId,
    proposalVersion: 2,
    proposalFingerprint: "fp-abc",
    status: "committed",
    startAt: "2030-06-01T17:00:00.000Z",
    endAt: "2030-06-01T23:00:00.000Z",
    observedAt: "2030-05-01T11:00:00.000Z",
    sourceRefs: [liveRef(`registry://${resourceId}`)],
    ...extra,
  };
}

function baseInput(evidence: unknown[]): EvaluateReadinessInput {
  return {
    nowIso: NOW,
    businessId: "biz-1",
    booking: {
      id: "booking-1",
      businessId: "biz-1",
      status: "provisional_hold",
      eventName: "Fictional wedding",
      startAt: WIN_START,
      endAt: WIN_END,
      sourceReferences: [liveRef("booking://booking-1")],
    },
    proposal: {
      bookingId: "booking-1",
      businessId: "biz-1",
      proposalVersion: 2,
      proposalFingerprint: "fp-abc",
      kind: "create_provisional_hold",
      payload: {
        startAt: WIN_START,
        endAt: WIN_END,
        calendarId: "cal-1",
        services: [{ name: "Plated dinner" }],
        responsibilities: [{ party: "House captain", task: "Run of show" }],
      },
      sourceReferences: [liveRef("proposal://booking-1/v2")],
    },
    policy: {
      businessId: "biz-1",
      conditions: [
        { kind: "deposit", required: true, deposit: { requiredAmountCents: 50000, currency: "USD" } },
        { kind: "resource_commitment", required: true, resources: { requiredResourceIds: ["room-a"] } },
      ],
    },
    evidence: evidence as EvaluateReadinessInput["evidence"],
  };
}

function depositOnly(evidence: unknown[]): EvaluateReadinessInput {
  const input = baseInput(evidence);
  input.policy.conditions = [
    { kind: "deposit", required: true, deposit: { requiredAmountCents: 50000, currency: "USD" } },
  ];
  return input;
}

function resourcesOnly(evidence: unknown[]): EvaluateReadinessInput {
  const input = baseInput(evidence);
  input.policy.conditions = [
    { kind: "resource_commitment", required: true, resources: { requiredResourceIds: ["room-a"] } },
  ];
  return input;
}

// Defect 1: duplicate receiptId rows summed twice, so a repeated
// half-payment satisfied the full deposit.
test("duplicate receiptId rows collapse: a redelivered half-payment stays missing", () => {
  const decision = evaluateReadiness(
    depositOnly([receipt("rcpt-half", "settled", 25000), receipt("rcpt-half", "settled", 25000)]),
  );
  const deposit = decision.conditions[0];
  assert.equal(deposit?.status, "missing");
  assert.match(deposit?.detail ?? "", /net 25000 of required 50000/);
  assert.equal(decision.ready, false);
});

// Defect 2: conflicting status/refund snapshots for one receipt must fail
// closed instead of picking the favorable row.
test("conflicting ledger snapshots for one receiptId fail closed", () => {
  const statusConflict = evaluateReadiness(
    depositOnly([receipt("rcpt-x", "settled", 50000), receipt("rcpt-x", "refunded", 50000)]),
  );
  assert.equal(statusConflict.conditions[0]?.status, "conflicting");
  assert.match(statusConflict.conditions[0]?.detail ?? "", /rcpt-x/);

  const refundConflict = evaluateReadiness(
    depositOnly([receipt("rcpt-y", "settled", 50000), receipt("rcpt-y", "settled", 50000, { refundedCents: 50000 })]),
  );
  assert.equal(refundConflict.conditions[0]?.status, "conflicting");
  assert.equal(refundConflict.ready, false);
});

// Defect 3: commitments must bind the exact accepted version/fingerprint
// and cover the event window; stale revisions and short windows are out.
test("stale-revision and short-window commitments are rejected, exact covering verifies", () => {
  const stale = evaluateReadiness(resourcesOnly([commitment("room-a", { proposalVersion: 1, proposalFingerprint: "fp-old" })]));
  assert.equal(stale.conditions[0]?.status, "missing");
  assert.ok(stale.rejectedEvidence.some((entry) => entry.includes("v1") && entry.includes("room-a")));

  const wrongFingerprint = evaluateReadiness(resourcesOnly([commitment("room-a", { proposalFingerprint: "fp-other" })]));
  assert.equal(wrongFingerprint.conditions[0]?.status, "missing");

  const short = evaluateReadiness(resourcesOnly([commitment("room-a", { endAt: "2030-06-01T19:00:00.000Z" })]));
  assert.equal(short.conditions[0]?.status, "missing");
  assert.match(short.conditions[0]?.resources?.[0]?.detail ?? "", /does not cover/);

  const exact = evaluateReadiness(resourcesOnly([commitment("room-a")]));
  assert.equal(exact.conditions[0]?.status, "verified");
});

// Defect 4: waivers bind version AND fingerprint; version alone never scopes.
test("waiver with the right version but wrong fingerprint is ignored", () => {
  const input = depositOnly([]);
  input.waivers = [
    {
      resolver: "owner_authority",
      businessId: "biz-1",
      bookingId: "booking-1",
      condition: "deposit",
      proposalVersion: 2,
      proposalFingerprint: "fp-other",
      waivedBy: "fictional-owner",
      waivedAt: "2030-04-30T10:00:00.000Z",
      reason: "Wrong fingerprint must not waive",
      sourceRefs: [liveRef("owner://waivers/9")],
    },
  ];
  const decision = evaluateReadiness(input);
  assert.equal(decision.conditions[0]?.status, "missing");
  assert.equal(decision.conditions[0]?.waived, false);
});

// Defect 5: booking snapshot and accepted proposal windows must agree;
// availability reads the proposal while handoff reads the booking.
test("booking/proposal window mismatch blocks evaluation and handoff", () => {
  const input = baseInput([]);
  input.booking.endAt = "2030-06-02T22:00:00.000Z";
  assert.throws(() => evaluateReadiness(input), /window differs/);

  const consistent = baseInput([]);
  const decision = evaluateReadiness(consistent);
  const moved = { ...consistent.booking, endAt: "2030-06-02T22:00:00.000Z" };
  assert.throws(() => buildHandoff({ decision, booking: moved, proposal: consistent.proposal }), /window differs/);
});
