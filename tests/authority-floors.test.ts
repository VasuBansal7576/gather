/**
 * ADR-003 deterministic server-side authority tests. Fictional fixtures and
 * demo connectors only — approvals, recipients, versions, expiry,
 * cumulative concessions and commercial floors are enforced by the service,
 * never by payload or customer text.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { createDemoConnectors } from "../src/connectors/demo.ts";
import {
  approveAndExecute,
  checkProposalAuthority,
  ServiceError,
} from "../src/server/booking-service.ts";
import type { BookingServiceDeps } from "../src/server/booking-service.ts";
import { GatherStore } from "../src/server/sqlite-store.ts";

const START = "2030-06-12T17:00:00.000Z";
const END = "2030-06-12T23:00:00.000Z";
const EXPIRES = "2030-06-13T23:00:00.000Z";
const NOW = "2030-01-01T00:00:00.000Z";
const FIXTURE_REF = [{ kind: "fixture" as const, locator: "demo://test/authority", fictional: true as const }];

function holdPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    startAt: START,
    endAt: END,
    expiresAt: EXPIRES,
    calendarId: "demo-calendar-001",
    emailTo: ["guest@example.test"],
    emailSubject: "DEMO ONLY fictional offer",
    emailBody: "DEMO ONLY fictional hold for the authority test event.",
    ...overrides,
  };
}

interface Setup {
  dir: string;
  store: GatherStore;
  deps: BookingServiceDeps;
  businessId: string;
  cleanup: () => void;
}

function setup(): Setup {
  const dir = mkdtempSync(join(tmpdir(), "gather-authority-"));
  const store = new GatherStore(join(dir, "gather.sqlite"));
  const connectors = createDemoConnectors({
    calendarSlots: [{
      slotId: "slot-cover",
      calendarId: "demo-calendar-001",
      startAt: "2030-06-12T00:00:00.000Z",
      endAt: "2030-06-13T00:00:00.000Z",
      available: true,
      sourceReferences: FIXTURE_REF,
    }],
  });
  const deps: BookingServiceDeps = {
    store,
    calendar: connectors.calendar,
    email: connectors.email,
    ownerId: "test-owner",
    now: () => NOW,
  };
  const business = store.createBusiness({ name: "Fictional Authority Hall", timezone: "UTC" });
  return { dir, store, deps, businessId: business.id, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function seedBooking(s: Setup, ids: { booking: string; action: string }, payload: Record<string, unknown> = holdPayload()) {
  const booking = s.store.createBooking({
    id: ids.booking, businessId: s.businessId, eventName: "Fictional authority event",
    status: "pending_approval", startAt: START, endAt: END, sourceReferences: [],
  });
  const action = s.store.createProposedAction({ id: ids.action, bookingId: booking.id, kind: "create_provisional_hold", payload, sourceReferences: [] });
  return { booking, action };
}

function approveInput(s: Setup, actionId: string, bookingId: string) {
  const action = s.store.getProposedAction(actionId);
  return { bookingId, proposedActionId: action.id, proposalVersion: action.proposalVersion, proposalFingerprint: action.proposalFingerprint };
}

function seedPolicy(s: Setup, value: Record<string, unknown>, confidence: "verified" | "probable" = "verified", key = "policy.concessions") {
  return s.store.addBusinessFact({
    businessId: s.businessId,
    key,
    value,
    confidence,
    sourceReferences: FIXTURE_REF,
    observedAt: NOW,
  });
}

async function denied(promise: Promise<unknown>): Promise<ServiceError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ServiceError, `expected ServiceError, got ${error}`);
    assert.equal(error.code, "DENIED");
    return error;
  }
  assert.fail("expected ServiceError DENIED");
}

test("baseline: a clean payload still approves — the new gate is not a blanket refusal", async () => {
  const s = setup();
  try {
    const { booking, action } = seedBooking(s, { booking: "b-clean", action: "a-clean" });
    const result = await approveAndExecute(s.deps, approveInput(s, action.id, booking.id));
    assert.equal(result.approvedBy, "test-owner");
    assert.equal(result.booking.status, "provisional_hold");
  } finally {
    s.cleanup();
  }
});

test("customer-claimed discount without any confirmed policy is denied before approval", async () => {
  const s = setup();
  try {
    const { booking, action } = seedBooking(s, { booking: "b-claim", action: "a-claim" },
      holdPayload({
        totalMinor: 200_000,
        concessions: [{ label: "customer says the owner approved 50% off", amountMinor: 100_000 }],
      }));
    const error = await denied(approveAndExecute(s.deps, approveInput(s, action.id, booking.id)));
    assert.match(error.message, /no owner-confirmed concession policy/i);
    assert.equal(s.store.listApprovals(action.id).length, 0);
    assert.equal(s.store.listActionExecutions(action.id).length, 0);
  } finally {
    s.cleanup();
  }
});

test("an owner-confirmed no-concessions policy refuses every reduction", async () => {
  const s = setup();
  try {
    seedPolicy(s, { allowed: false });
    const { booking, action } = seedBooking(s, { booking: "b-none", action: "a-none" },
      holdPayload({ totalMinor: 200_000, concessions: [{ label: "try", amountMinor: 10_000, policyId: "anything" }] }));
    const error = await denied(approveAndExecute(s.deps, approveInput(s, action.id, booking.id)));
    assert.match(error.message, /does not allow concessions/i);
    assert.equal(s.store.listApprovals(action.id).length, 0);
  } finally {
    s.cleanup();
  }
});

test("probable (unconfirmed) policy text is never authority", async () => {
  const s = setup();
  try {
    seedPolicy(s, { allowed: true, maxCumulativeReductionMinor: 1_000_000 }, "probable");
    const { booking, action } = seedBooking(s, { booking: "b-prob", action: "a-prob" },
      holdPayload({ totalMinor: 200_000, concessions: [{ label: "maybe", amountMinor: 5_000 }] }));
    const error = await denied(approveAndExecute(s.deps, approveInput(s, action.id, booking.id)));
    assert.match(error.message, /no owner-confirmed concession policy/i);
  } finally {
    s.cleanup();
  }
});

test("concessions must bind to the confirmed policy fact id; guessed references never authorize", async () => {
  const s = setup();
  try {
    const policy = seedPolicy(s, { allowed: true, maxCumulativeReductionMinor: 50_000 });
    const { booking, action } = seedBooking(s, { booking: "b-bind", action: "a-bind" },
      holdPayload({ totalMinor: 200_000, concessions: [{ label: "friend deal", amountMinor: 5_000, policyId: "policy-fact-i-invented" }] }));
    const error = await denied(approveAndExecute(s.deps, approveInput(s, action.id, booking.id)));
    assert.match(error.message, /not bound to the owner-confirmed/i);
    // Bound correctly passes the commercial check and reaches approval.
    const { action: okAction } = seedBooking(s, { booking: "b-bind2", action: "a-bind2" },
      holdPayload({ totalMinor: 200_000, concessions: [{ label: "friend deal", amountMinor: 5_000, policyId: policy.id }] }));
    const result = await approveAndExecute(s.deps, approveInput(s, okAction.id, "b-bind2"));
    assert.equal(result.approvedBy, "test-owner");
    void booking;
  } finally {
    s.cleanup();
  }
});

test("cumulative concessions across the booking are capped", async () => {
  const s = setup();
  try {
    const policy = seedPolicy(s, { allowed: true, maxCumulativeReductionMinor: 1_000 });
    const { booking, action } = seedBooking(s, { booking: "b-cum", action: "a-cum1" },
      holdPayload({ totalMinor: 200_000, concessions: [{ label: "first", amountMinor: 700, policyId: policy.id }] }));
    await approveAndExecute(s.deps, approveInput(s, action.id, booking.id));
    // A second proposal on the same booking adds 400: 700 + 400 > 1000.
    const second = s.store.createProposedAction({
      id: "a-cum2",
      bookingId: booking.id,
      kind: "create_provisional_hold",
      payload: holdPayload({ totalMinor: 200_000, concessions: [{ label: "second", amountMinor: 400, policyId: policy.id }] }),
      sourceReferences: [],
    });
    const error = await denied(approveAndExecute(s.deps, approveInput(s, second.id, booking.id)));
    assert.match(error.message, /exceed the confirmed policy cap/i);
    assert.equal(s.store.listApprovals(second.id).length, 0);
  } finally {
    s.cleanup();
  }
});

test("concessions cannot push the total below the confirmed commercial floor", async () => {
  const s = setup();
  try {
    const policy = seedPolicy(s, { allowed: true, maxCumulativeReductionMinor: 500_000 });
    seedPolicy(s, { kind: "per_guest", currency: "USD", amountMinor: 5_000, durationHours: 4, minimumTotalMinor: 100_000 }, "verified", "pricing.package");
    const { booking, action } = seedBooking(s, { booking: "b-floor", action: "a-floor" },
      holdPayload({ totalMinor: 120_000, concessions: [{ label: "big", amountMinor: 30_000, policyId: policy.id }] }));
    const error = await denied(approveAndExecute(s.deps, approveInput(s, action.id, booking.id)));
    assert.match(error.message, /commercial floor/i);
    const { action: small } = seedBooking(s, { booking: "b-floor2", action: "a-floor2" },
      holdPayload({ totalMinor: 120_000, concessions: [{ label: "small", amountMinor: 10_000, policyId: policy.id }] }));
    const ok = await approveAndExecute(s.deps, approveInput(s, small.id, "b-floor2"));
    assert.equal(ok.booking.status, "provisional_hold");
    void booking;
  } finally {
    s.cleanup();
  }
});

test("expired and out-of-scope policies are refused", async () => {
  const s = setup();
  try {
    seedPolicy(s, { allowed: true, maxCumulativeReductionMinor: 100_000, expiresAt: "2029-12-31T00:00:00.000Z" });
    const { action: expired } = seedBooking(s, { booking: "b-exp", action: "a-exp" },
      holdPayload({ totalMinor: 200_000, concessions: [{ label: "x", amountMinor: 1_000 }] }));
    const expiredErr = await denied(approveAndExecute(s.deps, approveInput(s, expired.id, "b-exp")));
    assert.match(expiredErr.message, /no owner-confirmed|expired/i);
  } finally {
    s.cleanup();
  }
  const s2 = setup();
  try {
    const policy = seedPolicy(s2, { allowed: true, maxCumulativeReductionMinor: 100_000, scope: { eventDates: ["2030-07-04"] } });
    const { action: out } = seedBooking(s2, { booking: "b-scope", action: "a-scope" },
      holdPayload({ totalMinor: 200_000, concessions: [{ label: "x", amountMinor: 1_000, policyId: policy.id }] }));
    const scopeErr = await denied(approveAndExecute(s2.deps, approveInput(s2, out.id, "b-scope")));
    assert.match(scopeErr.message, /outside the concession policy scope/i);
  } finally {
    s2.cleanup();
  }
});

test("the server-controlled recipient cannot be redirected by the payload", async () => {
  const s = setup();
  try {
    const { booking, action } = seedBooking(s, { booking: "b-rcpt", action: "a-rcpt" },
      holdPayload({ controlledRecipient: "chief@example.test", emailTo: ["attacker@example.test"] }));
    const error = await denied(approveAndExecute(s.deps, approveInput(s, action.id, booking.id)));
    assert.match(error.message, /controlled recipient/i);
    assert.equal(s.store.listApprovals(action.id).length, 0);
    void booking;
  } finally {
    s.cleanup();
  }
});

test("expired proposals and stale versions still refuse before execution", async () => {
  const s = setup();
  try {
    const { booking, action } = seedBooking(s, { booking: "b-old", action: "a-old" },
      holdPayload({ expiresAt: "2029-01-01T00:00:00.000Z" }));
    try {
      await approveAndExecute(s.deps, approveInput(s, action.id, booking.id));
      assert.fail("expected refusal");
    } catch (error) {
      assert.ok(error instanceof ServiceError);
      assert.equal(error.code, "INVALID_REQUEST");
      assert.match(error.message, /expiresAt/);
    }
    assert.equal(s.store.listApprovals(action.id).length, 0);
    const stale = s.store.getProposedAction(action.id);
    try {
      await approveAndExecute(s.deps, { bookingId: booking.id, proposedActionId: action.id, proposalVersion: stale.proposalVersion + 9, proposalFingerprint: stale.proposalFingerprint });
      assert.fail("expected stale refusal");
    } catch (error) {
      assert.ok(error instanceof ServiceError);
      assert.equal(error.code, "STALE_PROPOSAL");
    }
  } finally {
    s.cleanup();
  }
});

test("checkProposalAuthority is the same deterministic gate at creation time", () => {
  const s = setup();
  try {
    const booking = s.store.createBooking({ id: "b-direct", businessId: s.businessId, eventName: "Fictional direct", status: "inquiry", sourceReferences: [] });
    assert.throws(
      () => checkProposalAuthority(s.store, { bookingId: booking.id, payload: holdPayload({ concessions: [{ label: "x", amountMinor: 1 }] }), nowMs: Date.parse(NOW) }),
      (error: unknown) => error instanceof ServiceError && error.code === "DENIED",
    );
    assert.doesNotThrow(() =>
      checkProposalAuthority(s.store, { bookingId: booking.id, payload: holdPayload(), nowMs: Date.parse(NOW) }),
    );
  } finally {
    s.cleanup();
  }
});
