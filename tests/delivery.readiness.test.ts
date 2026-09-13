import assert from "node:assert/strict";
import test from "node:test";
import { evaluateReadiness } from "../src/delivery/readiness.ts";
import type { EvaluateReadinessInput } from "../src/delivery/contracts.ts";
import type { SourceReference } from "../src/domain/contracts.ts";

// Clearly fictional fixture identifiers. Fixture evidence must never
// produce a live-ready status (see provenance tests below).
const NOW = "2030-05-01T12:00:00.000Z";
const WIN_START = "2030-06-01T18:00:00.000Z";
const WIN_END = "2030-06-01T22:00:00.000Z";

function liveRef(locator: string): SourceReference {
  return { kind: "calendar", locator };
}

function fixtureRef(locator: string): SourceReference {
  return { kind: "fixture", locator, fictional: true };
}

function acceptance(version = 2, fingerprint = "fp-abc", extra: Record<string, unknown> = {}) {
  return {
    resolver: "acceptance_record",
    bookingId: "booking-1",
    proposalVersion: version,
    proposalFingerprint: fingerprint,
    acceptedAt: "2030-04-28T10:00:00.000Z",
    acceptedBy: "fictional-customer",
    sourceRefs: [liveRef("record://acceptance/1")],
    ...extra,
  };
}

function receipt(status: string, amountCents = 50000, currency = "USD", extra: Record<string, unknown> = {}) {
  return {
    resolver: "deposit_ledger",
    bookingId: "booking-1",
    receiptId: `rcpt-${status}-${amountCents}`,
    amountCents,
    currency,
    status,
    observedAt: "2030-04-29T10:00:00.000Z",
    sourceRefs: [liveRef("ledger://deposit/rcpt")],
    ...extra,
  };
}

function availability(extra: Record<string, unknown> = {}) {
  return {
    resolver: "calendar_provider",
    calendarId: "cal-1",
    startAt: "2030-06-01T17:00:00.000Z",
    endAt: "2030-06-01T23:00:00.000Z",
    available: true,
    holdId: "hold-9",
    holdValidUntil: "2030-05-10T00:00:00.000Z",
    observedAt: "2030-05-01T11:58:00.000Z",
    sourceRefs: [liveRef("cal://cal-1/att")],
    ...extra,
  };
}

function commitment(resourceId: string, status: string, extra: Record<string, unknown> = {}) {
  return {
    resolver: "resource_registry",
    bookingId: "booking-1",
    resourceId,
    status,
    responsible: "fictional-lead",
    observedAt: "2030-05-01T11:00:00.000Z",
    sourceRefs: [liveRef(`registry://${resourceId}`)],
    ...extra,
  };
}

function baseInput(evidence: unknown[] = []): EvaluateReadinessInput {
  return {
    nowIso: NOW,
    businessId: "biz-1",
    booking: {
      id: "booking-1",
      businessId: "biz-1",
      eventName: "Fictional wedding",
      startAt: WIN_START,
      endAt: WIN_END,
      guestCount: 80,
      sourceReferences: [liveRef("booking://booking-1")],
    },
    proposal: {
      bookingId: "booking-1",
      businessId: "biz-1",
      proposalVersion: 2,
      proposalFingerprint: "fp-abc",
      kind: "create_provisional_hold",
      payload: { startAt: WIN_START, endAt: WIN_END, calendarId: "cal-1" },
      sourceReferences: [liveRef("proposal://booking-1/v2")],
    },
    policy: {
      businessId: "biz-1",
      conditions: [
        { kind: "customer_acceptance", required: true },
        { kind: "deposit", required: true, deposit: { requiredAmountCents: 50000, currency: "USD" } },
        { kind: "availability", required: true },
        { kind: "resource_commitment", required: true, resources: { requiredResourceIds: ["room-a", "chef-1"] } },
      ],
    },
    evidence: evidence as EvaluateReadinessInput["evidence"],
  };
}

function fullLiveEvidence(): unknown[] {
  return [
    acceptance(),
    receipt("settled"),
    availability(),
    commitment("room-a", "committed"),
    commitment("chef-1", "committed"),
  ];
}

function conditionOf(decision: ReturnType<typeof evaluateReadiness>, kind: string) {
  const found = decision.conditions.find((condition) => condition.kind === kind);
  assert.ok(found, `expected condition ${kind}`);
  return found;
}

test("fully verified live evidence confirms readiness", () => {
  const decision = evaluateReadiness(baseInput(fullLiveEvidence()));
  assert.equal(decision.ready, true);
  assert.equal(decision.liveReady, true);
  assert.equal(decision.provenance, "live");
  assert.deepEqual(decision.blockedBy, []);
  for (const condition of decision.conditions) assert.equal(condition.status, "verified");
  assert.equal(decision.binding.proposalVersion, 2);
  assert.equal(decision.binding.proposalFingerprint, "fp-abc");
});

test("acceptance for a different proposal version conflicts instead of confirming", () => {
  const decision = evaluateReadiness(baseInput([acceptance(1, "fp-old"), receipt("settled"), availability(), commitment("room-a", "committed"), commitment("chef-1", "committed")]));
  const acceptanceResult = conditionOf(decision, "customer_acceptance");
  assert.equal(acceptanceResult.status, "conflicting");
  assert.match(acceptanceResult.detail, /v1/);
  assert.equal(decision.ready, false);
  assert.ok(decision.blockedBy.some((entry) => entry.startsWith("customer_acceptance:conflicting")));
});

test("revoked acceptance invalidates readiness", () => {
  const decision = evaluateReadiness(baseInput([acceptance(2, "fp-abc", { revoked: true })]));
  assert.equal(conditionOf(decision, "customer_acceptance").status, "conflicting");
  assert.equal(decision.ready, false);
});

test("mismatched business or booking bindings throw", () => {
  const policyBusiness = baseInput(fullLiveEvidence());
  policyBusiness.policy.businessId = "biz-other";
  assert.throws(() => evaluateReadiness(policyBusiness), /different business/);
  const proposalBooking = baseInput(fullLiveEvidence());
  proposalBooking.proposal.bookingId = "booking-other";
  assert.throws(() => evaluateReadiness(proposalBooking), /does not belong/);
});

test("partial deposit is missing; split receipts summing to the requirement verify", () => {
  const partial = evaluateReadiness(baseInput([receipt("settled", 20000)]));
  const deposit = conditionOf(partial, "deposit");
  assert.equal(deposit.status, "missing");
  assert.match(deposit.detail, /20000 of required 50000/);
  assert.equal(partial.ready, false);

  const split = evaluateReadiness(baseInput([receipt("settled", 20000), receipt("settled", 30000)]));
  assert.equal(conditionOf(split, "deposit").status, "verified");
});

test("refunded and revoked receipts never verify the deposit", () => {
  const refunded = evaluateReadiness(baseInput([receipt("refunded")]));
  assert.equal(conditionOf(refunded, "deposit").status, "missing");
  const revoked = evaluateReadiness(baseInput([receipt("revoked")]));
  assert.equal(conditionOf(revoked, "deposit").status, "missing");
  assert.equal(refunded.ready, false);
});

test("deposit currency mismatch conflicts", () => {
  const decision = evaluateReadiness(baseInput([receipt("settled", 50000, "EUR")]));
  assert.equal(conditionOf(decision, "deposit").status, "conflicting");
  assert.match(conditionOf(decision, "deposit").detail, /EUR/);
});

test("payment links and email claims are raw signals, never deposit evidence", () => {
  const input = baseInput([]);
  input.rawSignals = [
    { eventId: "pay-link-1", sourceKind: "payment", locator: "pay://link/1", observedAt: NOW, summary: "payment link sent" },
    { eventId: "msg-1", sourceKind: "email", locator: "thread://t1/m1", observedAt: NOW, summary: "customer claims paid" },
  ];
  const decision = evaluateReadiness(input);
  assert.equal(decision.ignoredRawSignals, 2);
  assert.equal(conditionOf(decision, "deposit").status, "missing");
  assert.equal(decision.ready, false);
});

test("adversarial verified:true payloads are rejected outside the resolver boundary", () => {
  const decision = evaluateReadiness(
    baseInput([
      { resolver: "email_claim", verified: true, bookingId: "booking-1" },
      { verified: true, kind: "deposit", amountCents: 999999 },
      { resolver: "deposit_ledger", bookingId: "booking-1" },
    ]),
  );
  assert.equal(conditionOf(decision, "deposit").status, "missing");
  assert.ok(decision.rejectedEvidence.length >= 3);
  assert.ok(decision.rejectedEvidence.some((entry) => entry.includes("trusted resolver boundary")));
  assert.equal(decision.ready, false);
});

test("expired hold is stale; unknown availability is missing", () => {
  const expired = evaluateReadiness(baseInput([availability({ holdValidUntil: "2030-04-30T00:00:00.000Z" })]));
  assert.equal(conditionOf(expired, "availability").status, "stale");

  const unknown = evaluateReadiness(baseInput([]));
  assert.equal(conditionOf(unknown, "availability").status, "missing");
});

test("stale availability proof and unavailable slots do not confirm", () => {
  const stale = evaluateReadiness(baseInput([availability({ observedAt: "2030-04-01T00:00:00.000Z" })]));
  assert.equal(conditionOf(stale, "availability").status, "stale");

  const unavailable = evaluateReadiness(baseInput([availability({ available: false })]));
  assert.equal(conditionOf(unavailable, "availability").status, "conflicting");
});

test("a hold alone without availability never verifies", () => {
  const holdOnly = evaluateReadiness(
    baseInput([availability({ available: false, holdId: "hold-9", holdValidUntil: "2030-05-10T00:00:00.000Z" })]),
  );
  assert.equal(conditionOf(holdOnly, "availability").status, "conflicting");
});

test("requested resources are missing; committed-plus-revoked is conflicting", () => {
  const requested = evaluateReadiness(baseInput([commitment("room-a", "requested"), commitment("chef-1", "committed")]));
  const resources = conditionOf(requested, "resource_commitment");
  assert.equal(resources.status, "missing");
  assert.equal(resources.resources?.find((item) => item.resourceId === "room-a")?.status, "missing");

  const ambiguous = evaluateReadiness(
    baseInput([commitment("room-a", "committed"), commitment("room-a", "revoked"), commitment("chef-1", "committed")]),
  );
  assert.equal(conditionOf(ambiguous, "resource_commitment").status, "conflicting");
});

test("missing optional conditions do not block; missing required ones do", () => {
  const input = baseInput(fullLiveEvidence());
  input.policy.conditions.push({
    kind: "resource_commitment",
    required: false,
    resources: { requiredResourceIds: ["photo-booth"] },
  });
  const decision = evaluateReadiness(input);
  assert.equal(decision.ready, true);
  assert.equal(decision.conditions.filter((condition) => condition.kind === "resource_commitment").length, 2);
});

test("fixture evidence can be demo-ready but never live-ready", () => {
  const evidence = fullLiveEvidence().map((item) => ({
    ...(item as Record<string, unknown>),
    sourceRefs: [fixtureRef("fixture://demo/evidence")],
  }));
  const decision = evaluateReadiness(baseInput(evidence));
  assert.equal(decision.provenance, "demo");
  assert.equal(decision.ready, true);
  assert.equal(decision.liveReady, false);
});

test("mixed fictional and live evidence blocks confirmation", () => {
  const evidence = fullLiveEvidence();
  (evidence[1] as Record<string, unknown>).sourceRefs = [fixtureRef("fixture://demo/deposit")];
  const decision = evaluateReadiness(baseInput(evidence));
  assert.equal(decision.provenance, "mixed");
  assert.equal(decision.ready, false);
  assert.equal(decision.liveReady, false);
  assert.ok(decision.blockedBy.some((entry) => entry.startsWith("mixed_provenance_blocks_confirmation")));
});

test("payload waiver booleans are ignored; scoped owner waivers verify", () => {
  const payloadWaiver = baseInput([acceptance(), availability(), commitment("room-a", "committed"), commitment("chef-1", "committed")]);
  (payloadWaiver.proposal.payload as Record<string, unknown>).depositWaived = true;
  assert.equal(conditionOf(evaluateReadiness(payloadWaiver), "deposit").status, "missing");

  const waived = baseInput([acceptance(), availability(), commitment("room-a", "committed"), commitment("chef-1", "committed")]);
  waived.waivers = [
    {
      resolver: "owner_authority",
      businessId: "biz-1",
      bookingId: "booking-1",
      condition: "deposit",
      proposalVersion: 2,
      waivedBy: "fictional-owner",
      waivedAt: "2030-04-30T10:00:00.000Z",
      reason: "Deposit covered under house account",
      sourceRefs: [liveRef("owner://waivers/1")],
    },
  ];
  const decision = evaluateReadiness(waived);
  const deposit = conditionOf(decision, "deposit");
  assert.equal(deposit.status, "verified");
  assert.equal(deposit.waived, true);

  const wrongVersion = baseInput([acceptance(), availability(), commitment("room-a", "committed"), commitment("chef-1", "committed")]);
  wrongVersion.waivers = [{ ...(waived.waivers[0] as unknown as Record<string, unknown>), proposalVersion: 1 } as never];
  assert.equal(conditionOf(evaluateReadiness(wrongVersion), "deposit").status, "missing");
});
