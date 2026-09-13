import assert from "node:assert/strict";
import test from "node:test";
import { buildHandoff } from "../src/delivery/handoff.ts";
import { evaluateReadiness } from "../src/delivery/readiness.ts";
import type { EvaluateReadinessInput } from "../src/delivery/contracts.ts";
import type { SourceReference } from "../src/domain/contracts.ts";

const NOW = "2030-05-01T12:00:00.000Z";
const WIN_START = "2030-06-01T18:00:00.000Z";
const WIN_END = "2030-06-01T22:00:00.000Z";

function liveRef(locator: string): SourceReference {
  return { kind: "calendar", locator };
}

function readyInput(): EvaluateReadinessInput {
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
      payload: {
        startAt: WIN_START,
        endAt: WIN_END,
        calendarId: "cal-1",
        services: [
          { name: "Plated dinner", detail: "Three courses" },
          { name: "Room setup" },
        ],
        responsibilities: [{ party: "House captain", task: "Run of show" }],
      },
      sourceReferences: [liveRef("proposal://booking-1/v2")],
    },
    policy: {
      businessId: "biz-1",
      conditions: [
        { kind: "customer_acceptance", required: true },
        { kind: "deposit", required: true, deposit: { requiredAmountCents: 50000, currency: "USD" } },
        { kind: "availability", required: true },
        { kind: "resource_commitment", required: true, resources: { requiredResourceIds: ["room-a"] } },
      ],
    },
    evidence: [
      {
        resolver: "acceptance_record",
        bookingId: "booking-1",
        proposalVersion: 2,
        proposalFingerprint: "fp-abc",
        acceptedAt: "2030-04-28T10:00:00.000Z",
        sourceRefs: [liveRef("record://acceptance/1")],
      },
      {
        resolver: "deposit_ledger",
        bookingId: "booking-1",
        receiptId: "rcpt-1",
        amountCents: 50000,
        currency: "USD",
        status: "settled",
        observedAt: "2030-04-29T10:00:00.000Z",
        sourceRefs: [liveRef("ledger://deposit/rcpt-1")],
      },
      {
        resolver: "calendar_provider",
        calendarId: "cal-1",
        startAt: "2030-06-01T17:00:00.000Z",
        endAt: "2030-06-01T23:00:00.000Z",
        available: true,
        observedAt: "2030-05-01T11:58:00.000Z",
        sourceRefs: [liveRef("cal://cal-1/att")],
      },
      {
        resolver: "resource_registry",
        bookingId: "booking-1",
        resourceId: "room-a",
        status: "committed",
        responsible: "House captain",
        observedAt: "2030-05-01T11:00:00.000Z",
        sourceRefs: [liveRef("registry://room-a")],
      },
    ],
  };
}

test("complete handoff is tied to the accepted version with evidence-backed entries", () => {
  const input = readyInput();
  const decision = evaluateReadiness(input);
  assert.equal(decision.ready, true);
  const handoff = buildHandoff({ decision, booking: input.booking, proposal: input.proposal });
  assert.equal(handoff.ready, true);
  assert.equal(handoff.binding.proposalVersion, 2);
  assert.equal(handoff.binding.proposalFingerprint, "fp-abc");
  assert.equal(handoff.event.name, "Fictional wedding");
  assert.equal(handoff.event.guestCount, 80);
  assert.equal(handoff.services.length, 2);
  assert.equal(handoff.services[0]?.name, "Plated dinner");
  assert.equal(handoff.responsibilities.length, 1);
  assert.equal(handoff.resources.length, 1);
  assert.equal(handoff.resources[0]?.responsible, "House captain");
  assert.deepEqual(handoff.outstanding, []);
});

test("blocked decisions produce incomplete handoffs with explicit outstanding work", () => {
  const input = readyInput();
  input.evidence = [];
  const decision = evaluateReadiness(input);
  assert.equal(decision.ready, false);
  const handoff = buildHandoff({ decision, booking: input.booking, proposal: input.proposal });
  assert.equal(handoff.ready, false);
  assert.ok(handoff.outstanding.some((entry) => entry.includes("customer_acceptance")));
  assert.ok(handoff.outstanding.some((entry) => entry.includes("deposit")));
});

test("missing services and responsibilities are outstanding, never invented", () => {
  const input = readyInput();
  const payload = input.proposal.payload as Record<string, unknown>;
  delete payload.services;
  delete payload.responsibilities;
  const decision = evaluateReadiness(input);
  assert.equal(decision.ready, true);
  const handoff = buildHandoff({ decision, booking: input.booking, proposal: input.proposal });
  assert.equal(handoff.ready, false);
  assert.deepEqual(handoff.services, []);
  assert.deepEqual(handoff.responsibilities, []);
  assert.ok(handoff.outstanding.some((entry) => entry.includes("Services are not itemized")));
  assert.ok(handoff.outstanding.some((entry) => entry.includes("Responsibilities are not assigned")));
});

test("handoff rejects binding mismatches across revisions", () => {
  const input = readyInput();
  const decision = evaluateReadiness(input);
  const moved = { ...input.proposal, proposalVersion: 3, proposalFingerprint: "fp-new" };
  assert.throws(() => buildHandoff({ decision, booking: input.booking, proposal: moved }), /binding mismatch/);
});

test("handoff retains demo provenance instead of claiming live readiness", () => {
  const input = readyInput();
  input.evidence = (input.evidence as unknown as Record<string, unknown>[]).map((item) => ({
    ...item,
    sourceRefs: [{ kind: "fixture", locator: "fixture://demo/all", fictional: true }],
  })) as EvaluateReadinessInput["evidence"];
  const decision = evaluateReadiness(input);
  assert.equal(decision.provenance, "demo");
  const handoff = buildHandoff({ decision, booking: input.booking, proposal: input.proposal });
  assert.equal(handoff.provenance, "demo");
});
