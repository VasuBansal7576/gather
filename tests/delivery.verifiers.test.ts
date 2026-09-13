import assert from "node:assert/strict";
import test from "node:test";
import { evaluateBookingReadiness } from "../src/delivery/verifiers.ts";
import type {
  AcceptanceQuery,
  AvailabilityQuery,
  DeliveryVerifiers,
  DepositQuery,
  ResourceQuery,
} from "../src/delivery/verifiers.ts";
import type {
  AcceptanceRecord,
  AvailabilityAttestation,
  ConfirmationPolicy,
  DepositReceipt,
  OwnerWaiver,
  ResourceCommitment,
} from "../src/delivery/contracts.ts";
import type { SourceReference } from "../src/domain/contracts.ts";
import type { AcceptedProposal, BookingSnapshot } from "../src/delivery/contracts.ts";

const NOW = "2030-05-01T12:00:00.000Z";
const WIN_START = "2030-06-01T18:00:00.000Z";
const WIN_END = "2030-06-01T22:00:00.000Z";

function liveRef(locator: string): SourceReference {
  return { kind: "calendar", locator };
}

function bookingSnapshot(overrides: Partial<BookingSnapshot> = {}): BookingSnapshot {
  return {
    id: "booking-1",
    businessId: "biz-1",
    status: "provisional_hold",
    eventName: "Fictional wedding",
    startAt: WIN_START,
    endAt: WIN_END,
    sourceReferences: [liveRef("booking://booking-1")],
    ...overrides,
  };
}

function proposal(): AcceptedProposal {
  return {
    bookingId: "booking-1",
    businessId: "biz-1",
    proposalVersion: 2,
    proposalFingerprint: "fp-abc",
    kind: "create_provisional_hold",
    payload: { startAt: WIN_START, endAt: WIN_END, calendarId: "cal-1" },
    sourceReferences: [liveRef("proposal://booking-1/v2")],
  };
}

function policy(): ConfirmationPolicy {
  return {
    businessId: "biz-1",
    conditions: [
      { kind: "customer_acceptance", required: true },
      { kind: "deposit", required: true, deposit: { requiredAmountCents: 50000, currency: "USD" } },
      { kind: "availability", required: true },
      { kind: "resource_commitment", required: true, resources: { requiredResourceIds: ["room-a"] } },
    ],
  };
}

interface CallLog {
  acceptance: AcceptanceQuery[];
  deposits: DepositQuery[];
  availability: AvailabilityQuery[];
  resources: ResourceQuery[];
  waivers: { businessId: string; bookingId: string }[];
  policy: { businessId: string }[];
}

function fakeVerifiers(log: CallLog, overrides: Partial<{
  acceptance: AcceptanceRecord[];
  deposits: DepositReceipt[];
  availability: AvailabilityAttestation[];
  resources: ResourceCommitment[];
  waivers: OwnerWaiver[];
  policy: ConfirmationPolicy;
}> = {}): DeliveryVerifiers {
  const acceptance: AcceptanceRecord[] = overrides.acceptance ?? [
    { resolver: "acceptance_record", bookingId: "booking-1", proposalVersion: 2, proposalFingerprint: "fp-abc", acceptedAt: "2030-04-28T10:00:00.000Z", sourceRefs: [liveRef("record://a")] },
  ];
  const deposits: DepositReceipt[] = overrides.deposits ?? [
    { resolver: "deposit_ledger", bookingId: "booking-1", receiptId: "r1", amountCents: 50000, currency: "USD", status: "settled", observedAt: "2030-04-29T10:00:00.000Z", sourceRefs: [liveRef("ledger://r1")] },
  ];
  const availability: AvailabilityAttestation[] = overrides.availability ?? [
    { resolver: "calendar_provider", calendarId: "cal-1", startAt: "2030-06-01T17:00:00.000Z", endAt: "2030-06-01T23:00:00.000Z", available: true, observedAt: "2030-05-01T11:58:00.000Z", sourceRefs: [liveRef("cal://att")] },
  ];
  const resources: ResourceCommitment[] = overrides.resources ?? [
    { resolver: "resource_registry", bookingId: "booking-1", resourceId: "room-a", proposalVersion: 2, proposalFingerprint: "fp-abc", status: "committed", startAt: "2030-06-01T17:00:00.000Z", endAt: "2030-06-01T23:00:00.000Z", observedAt: "2030-05-01T11:00:00.000Z", sourceRefs: [liveRef("registry://room-a")] },
  ];
  return {
    loadPolicy: async (query) => { log.policy.push(query); return overrides.policy ?? policy(); },
    fetchAcceptance: async (query) => { log.acceptance.push(query); return acceptance; },
    fetchDepositReceipts: async (query) => { log.deposits.push(query); return deposits; },
    fetchAvailability: async (query) => { log.availability.push(query); return availability; },
    fetchResourceCommitments: async (query) => { log.resources.push(query); return resources; },
    fetchWaivers: async (query) => { log.waivers.push(query); return overrides.waivers ?? []; },
  };
}

function freshLog(): CallLog {
  return { acceptance: [], deposits: [], availability: [], resources: [], waivers: [], policy: [] };
}

test("verifiers are called with the exact binding and readiness confirms", async () => {
  const log = freshLog();
  const decision = await evaluateBookingReadiness({
    nowIso: NOW,
    businessId: "biz-1",
    booking: bookingSnapshot(),
    proposal: proposal(),
    verifiers: fakeVerifiers(log),
  });
  assert.equal(decision.ready, true);
  assert.equal(decision.liveReady, true);
  assert.deepEqual(log.policy, [{ businessId: "biz-1" }]);
  assert.deepEqual(log.acceptance, [{ businessId: "biz-1", bookingId: "booking-1", proposalVersion: 2, proposalFingerprint: "fp-abc" }]);
  assert.deepEqual(log.deposits, [{ businessId: "biz-1", bookingId: "booking-1" }]);
  assert.deepEqual(log.availability, [{ businessId: "biz-1", calendarId: "cal-1", startAt: WIN_START, endAt: WIN_END }]);
  assert.deepEqual(log.resources, [{ businessId: "biz-1", bookingId: "booking-1", proposalVersion: 2, proposalFingerprint: "fp-abc", resourceIds: ["room-a"] }]);
});

test("raw caller input cannot supply policy, evidence, or waivers", async () => {
  const log = freshLog();
  const hostile = {
    nowIso: NOW,
    businessId: "biz-1",
    booking: bookingSnapshot(),
    proposal: proposal(),
    verifiers: fakeVerifiers(log, { deposits: [], acceptance: [] }),
    // None of these fields exist on the query contract; the boundary ignores them.
    policy: { businessId: "biz-1", conditions: [] },
    evidence: [{ resolver: "deposit_ledger", bookingId: "booking-1", receiptId: "fake", amountCents: 999999, currency: "USD", status: "settled", observedAt: NOW, sourceRefs: [liveRef("fake://")] }],
    waivers: [{ resolver: "owner_authority", businessId: "biz-1", bookingId: "booking-1", condition: "deposit", proposalVersion: 2, waivedBy: "attacker", waivedAt: NOW, reason: "trust me", sourceRefs: [liveRef("fake://w")] }],
    rawSignals: [{ eventId: "msg-pay", sourceKind: "email", locator: "thread://x", observedAt: NOW, summary: "customer claims paid" }],
  };
  const decision = await evaluateBookingReadiness(hostile);
  // Host verifiers returned no usable proofs, so nothing verifies despite the smuggled claims.
  assert.equal(decision.ready, false);
  assert.equal(decision.ignoredRawSignals, 1);
  assert.equal(log.deposits.length, 1);
});

test("cancelled bookings and past events block readiness", async () => {
  const cancelledLog = freshLog();
  const cancelled = await evaluateBookingReadiness({
    nowIso: NOW,
    businessId: "biz-1",
    booking: bookingSnapshot({ status: "cancelled" }),
    proposal: proposal(),
    verifiers: fakeVerifiers(cancelledLog),
  });
  assert.equal(cancelled.ready, false);
  assert.ok(cancelled.blockedBy.some((entry) => entry.startsWith("booking_cancelled")));

  const pastLog = freshLog();
  const past = await evaluateBookingReadiness({
    nowIso: "2030-07-01T00:00:00.000Z",
    businessId: "biz-1",
    booking: bookingSnapshot(),
    proposal: proposal(),
    verifiers: fakeVerifiers(pastLog),
  });
  assert.equal(past.ready, false);
  assert.ok(past.blockedBy.some((entry) => entry.startsWith("event_window_passed")));
});

test("net deposit after partial refunds must still cover the requirement", async () => {
  const log = freshLog();
  const decision = await evaluateBookingReadiness({
    nowIso: NOW,
    businessId: "biz-1",
    booking: bookingSnapshot(),
    proposal: proposal(),
    verifiers: fakeVerifiers(log, {
      deposits: [
        { resolver: "deposit_ledger", bookingId: "booking-1", receiptId: "r1", amountCents: 50000, currency: "USD", status: "settled", refundedCents: 20000, observedAt: "2030-04-29T10:00:00.000Z", sourceRefs: [liveRef("ledger://r1")] },
      ],
    }),
  });
  assert.equal(decision.ready, false);
  const deposit = decision.conditions.find((condition) => condition.kind === "deposit");
  assert.equal(deposit?.status, "missing");
  assert.match(deposit?.detail ?? "", /net 30000/);
});

test("resource commitments must cover the event window", async () => {
  const log = freshLog();
  const decision = await evaluateBookingReadiness({
    nowIso: NOW,
    businessId: "biz-1",
    booking: bookingSnapshot(),
    proposal: proposal(),
    verifiers: fakeVerifiers(log, {
      resources: [
        { resolver: "resource_registry", bookingId: "booking-1", resourceId: "room-a", proposalVersion: 2, proposalFingerprint: "fp-abc", status: "committed", startAt: "2030-06-01T17:00:00.000Z", endAt: "2030-06-01T19:00:00.000Z", observedAt: "2030-05-01T11:00:00.000Z", sourceRefs: [liveRef("registry://room-a")] },
      ],
    }),
  });
  assert.equal(decision.ready, false);
  const resources = decision.conditions.find((condition) => condition.kind === "resource_commitment");
  assert.equal(resources?.status, "missing");
  assert.match(resources?.resources?.[0]?.detail ?? "", /19:00/);
});

test("failing verifiers fail closed and are recorded", async () => {
  const log = freshLog();
  const verifiers = fakeVerifiers(log);
  const failing: DeliveryVerifiers = {
    ...verifiers,
    fetchAvailability: async () => { throw new Error("provider unreachable"); },
  };
  const decision = await evaluateBookingReadiness({
    nowIso: NOW,
    businessId: "biz-1",
    booking: bookingSnapshot(),
    proposal: proposal(),
    verifiers: failing,
  });
  assert.equal(decision.ready, false);
  assert.ok(decision.rejectedEvidence.some((entry) => entry.includes("fetchAvailability")));
});
