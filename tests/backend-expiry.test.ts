import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { createDemoConnectors } from "../src/connectors/demo.ts";
import {
  approveAndExecute,
  holdOperationKey,
  ServiceError,
} from "../src/server/booking-service.ts";
import type { BookingServiceDeps } from "../src/server/booking-service.ts";
import { DurableDemoCalendar, DurableDemoEmail } from "../src/server/durable-demo-connectors.ts";
import { GatherStore } from "../src/server/sqlite-store.ts";

// All fixtures below are fictional and stay DEMO ONLY. The injected clock is
// fixed so expiry boundaries are deterministic.
const START = "2030-06-12T17:00:00.000Z";
const END = "2030-06-12T23:00:00.000Z";
const EXPIRES = "2030-06-13T23:00:00.000Z";
const CAL1 = "demo-calendar-001";
const CAL2 = "demo-calendar-002";
const NOW = "2030-01-01T00:00:00.000Z";
const NOW_MS = Date.parse(NOW);

function holdPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    startAt: START,
    endAt: END,
    expiresAt: EXPIRES,
    calendarId: CAL1,
    emailTo: ["guest@example.test"],
    emailSubject: "DEMO ONLY fictional offer",
    emailBody: "DEMO ONLY fictional hold for the expiry test event.",
    ...overrides,
  };
}

function slot(slotId: string, calendarId: string, startAt = "2030-06-12T00:00:00.000Z", endAt = "2030-06-13T00:00:00.000Z") {
  return {
    slotId, calendarId, startAt, endAt, available: true as const,
    sourceReferences: [{ kind: "fixture" as const, locator: "demo://test/expiry-slot", fictional: true as const }],
  };
}

interface Setup {
  dir: string;
  path: string;
  store: GatherStore;
  deps: BookingServiceDeps;
  businessId: string;
  cleanup: () => void;
}

function setup(slots = [slot("slot-cover", CAL1)]): Setup {
  const dir = mkdtempSync(join(tmpdir(), "gather-expiry-"));
  const path = join(dir, "gather.sqlite");
  const store = new GatherStore(path);
  const connectors = createDemoConnectors({ calendarSlots: slots });
  const deps: BookingServiceDeps = {
    store,
    calendar: new DurableDemoCalendar(store, connectors.calendar, () => NOW_MS),
    email: new DurableDemoEmail(store, connectors.email),
    ownerId: "test-owner",
    now: () => NOW,
  };
  const business = store.createBusiness({ name: "Fictional Expiry Hall", timezone: "UTC" });
  return { dir, path, store, deps, businessId: business.id, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function seedBooking(s: Setup, ids: { booking: string; action: string }, payload: Record<string, unknown> = holdPayload()) {
  const booking = s.store.createBooking({
    id: ids.booking, businessId: s.businessId, eventName: "Fictional expiry event",
    status: "pending_approval", startAt: START, endAt: END, sourceReferences: [],
  });
  const action = s.store.createProposedAction({ id: ids.action, bookingId: booking.id, kind: "create_provisional_hold", payload, sourceReferences: [] });
  return { booking, action };
}

function approveInput(s: Setup, actionId: string, bookingId: string) {
  const action = s.store.getProposedAction(actionId);
  return { bookingId, proposedActionId: action.id, proposalVersion: action.proposalVersion, proposalFingerprint: action.proposalFingerprint };
}

async function assertServiceError(promise: Promise<unknown>, code: string): Promise<ServiceError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ServiceError, `expected ServiceError, got ${error}`);
    assert.equal(error.code, code);
    return error;
  }
  assert.fail(`expected ServiceError ${code}`);
}

function expiredReceipt(): Record<string, unknown> {
  return {
    hold: {
      holdId: "demo-hold-expired0001",
      operationKey: "expired-op-key",
      bookingId: "b-old",
      calendarId: CAL1,
      startAt: START,
      endAt: END,
      expiresAt: "2029-06-01T00:00:00.000Z",
      status: "provisional_hold",
      createdAt: "2030-01-01T00:00:00.000Z",
      sourceReferences: [],
    },
    provenance: [],
  };
}

test("an expired durable receipt no longer denies a future window", async () => {
  const s = setup();
  try {
    // A known-expired receipt is preserved as history but must not block.
    s.store.saveProviderReceipt("hold", "expired-op-key", expiredReceipt());
    const { action, booking } = seedBooking(s, { booking: "b-after-expiry", action: "a-after-expiry" });
    const response = await approveAndExecute(s.deps, approveInput(s, action.id, booking.id));
    assert.equal(response.hold.execution.status, "succeeded");
    // The expired row is still present as history.
    assert.ok(s.store.getProviderReceipt("expired-op-key") !== undefined);
    assert.equal(s.store.findHoldConflict(CAL1, START, END, { excludeOperationKey: holdOperationKey(action.id, 1), nowMs: NOW_MS }), undefined);
  } finally {
    s.cleanup();
  }
});

test("an unknown pending intent stays fail-closed even past its lease", async () => {
  const s = setup();
  try {
    // Crashed before any provider call: intent claimed with a short lease and
    // never followed by evidence. The lease expiring must NOT free the window.
    const claimed = s.store.claimHoldSlot("crashed-op-key", CAL1, START, END, { nowMs: NOW_MS, intentLeaseMs: 1 });
    assert.equal(claimed.ok, true);
    const late = s.store.findHoldConflict(CAL1, START, END, { excludeOperationKey: "other-op-key", nowMs: NOW_MS + 86_400_000 });
    assert.equal(late, "crashed-op-key");
    const { action, booking } = seedBooking(s, { booking: "b-blocked", action: "a-blocked" });
    const error = await assertServiceError(approveAndExecute(s.deps, approveInput(s, action.id, booking.id)), "SLOT_UNAVAILABLE");
    assert.match(error.message, /already held \(durable record crashed-op-key\)/);
    assert.equal(s.store.getBooking(booking.id).status, "failed");
  } finally {
    s.cleanup();
  }
});

test("a future unexpired overlap is refused on the same DB and after reopen", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gather-expiry-reopen-"));
  const path = join(dir, "gather.sqlite");
  const first = new GatherStore(path);
  try {
    const connectors = createDemoConnectors({ calendarSlots: [slot("slot-cover", CAL1)] });
    const deps: BookingServiceDeps = {
      store: first,
      calendar: new DurableDemoCalendar(first, connectors.calendar, () => NOW_MS),
      email: new DurableDemoEmail(first, connectors.email),
      ownerId: "test-owner",
      now: () => NOW,
    };
    const business = first.createBusiness({ name: "Fictional Hall", timezone: "UTC" });
    const bookingA = first.createBooking({ id: "b-x-a", businessId: business.id, eventName: "A", status: "pending_approval", sourceReferences: [] });
    const actionA = first.createProposedAction({ id: "a-x-a", bookingId: bookingA.id, kind: "create_provisional_hold", payload: holdPayload(), sourceReferences: [] });
    const done = await approveAndExecute(deps, { bookingId: bookingA.id, proposedActionId: actionA.id, proposalVersion: 1, proposalFingerprint: actionA.proposalFingerprint });
    assert.equal(done.hold.execution.status, "succeeded");
    // Same DB, same process: a second booking for the same window is refused.
    const bookingB = first.createBooking({ id: "b-x-b", businessId: business.id, eventName: "B", status: "pending_approval", sourceReferences: [] });
    const actionB = first.createProposedAction({ id: "a-x-b", bookingId: bookingB.id, kind: "create_provisional_hold", payload: holdPayload(), sourceReferences: [] });
    await assertServiceError(
      approveAndExecute(deps, { bookingId: bookingB.id, proposedActionId: actionB.id, proposalVersion: 1, proposalFingerprint: actionB.proposalFingerprint }),
      "SLOT_UNAVAILABLE",
    );
  } finally {
    first.close();
  }
  // Reopened DB with rebuilt adapters: the durable window still refuses.
  const second = new GatherStore(path);
  try {
    const connectors = createDemoConnectors({ calendarSlots: [slot("slot-cover", CAL1)] });
    const deps: BookingServiceDeps = {
      store: second,
      calendar: new DurableDemoCalendar(second, connectors.calendar, () => NOW_MS),
      email: new DurableDemoEmail(second, connectors.email),
      ownerId: "test-owner",
      now: () => NOW,
    };
    const bookingC = second.createBooking({ id: "b-x-c", businessId: second.listBusinesses()[0]!.id, eventName: "C", status: "pending_approval", sourceReferences: [] });
    const actionC = second.createProposedAction({ id: "a-x-c", bookingId: bookingC.id, kind: "create_provisional_hold", payload: holdPayload(), sourceReferences: [] });
    const error = await assertServiceError(
      approveAndExecute(deps, { bookingId: bookingC.id, proposedActionId: actionC.id, proposalVersion: 1, proposalFingerprint: actionC.proposalFingerprint }),
      "SLOT_UNAVAILABLE",
    );
    assert.match(error.message, /already held \(durable record/);
  } finally {
    second.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the same window on a different calendar is allowed", async () => {
  const s = setup([slot("slot-a", CAL1), slot("slot-b", CAL2)]);
  try {
    const first = seedBooking(s, { booking: "b-cal-a", action: "a-cal-a" }, holdPayload({ calendarId: CAL1 }));
    const done = await approveAndExecute(s.deps, approveInput(s, first.action.id, first.booking.id));
    assert.equal(done.hold.execution.status, "succeeded");
    const second = seedBooking(s, { booking: "b-cal-b", action: "a-cal-b" }, holdPayload({ calendarId: CAL2 }));
    const other = await approveAndExecute(s.deps, approveInput(s, second.action.id, second.booking.id));
    assert.equal(other.hold.execution.status, "succeeded");
  } finally {
    s.cleanup();
  }
});

test("mixed malformed emailTo elements are rejected before any approval", async () => {
  const s = setup();
  try {
    for (const [index, emailTo] of [
      ["guest@example.test", "", 42],
      ["guest@example.test", "   "],
      ["guest@example.test", null],
    ].entries()) {
      const { action, booking } = seedBooking(s, { booking: `b-mixed-${index}`, action: `a-mixed-${index}` }, holdPayload({ emailTo }));
      const error = await assertServiceError(approveAndExecute(s.deps, approveInput(s, action.id, booking.id)), "INVALID_REQUEST");
      assert.match(error.message, /emailTo/);
      assert.equal(s.store.listApprovals(action.id).length, 0);
      assert.equal(s.store.listActionExecutions(action.id).length, 0);
    }
  } finally {
    s.cleanup();
  }
});

test("an event that already started is rejected even when its end is future", async () => {
  const s = setup();
  try {
    const started = new Date(NOW_MS - 3_600_000).toISOString();
    const ends = new Date(NOW_MS + 3_600_000).toISOString();
    const { action, booking } = seedBooking(
      s,
      { booking: "b-started", action: "a-started" },
      holdPayload({ startAt: started, endAt: ends, expiresAt: new Date(NOW_MS + 7_200_000).toISOString() }),
    );
    const error = await assertServiceError(approveAndExecute(s.deps, approveInput(s, action.id, booking.id)), "INVALID_REQUEST");
    assert.match(error.message, /already started/);
    assert.equal(s.store.listApprovals(action.id).length, 0);
  } finally {
    s.cleanup();
  }
});

test("a create-time race on a durably held window maps to SLOT_UNAVAILABLE", async () => {
  const s = setup();
  try {
    const { action, booking } = seedBooking(s, { booking: "b-race", action: "a-race" });
    // Availability reads pass, then a peer claims the window before the hold
    // write: the create-time conflict must surface as SLOT_UNAVAILABLE, not
    // a generic execution failure.
    const realHold = s.deps.calendar.createProvisionalHold.bind(s.deps.calendar);
    const peer = new GatherStore(s.path);
    try {
      s.deps.calendar.createProvisionalHold = (async (req: Parameters<typeof realHold>[0]) => {
        peer.claimHoldSlot("peer-op-key", CAL1, START, END, { nowMs: NOW_MS });
        return realHold(req);
      }) as typeof realHold;
      const error = await assertServiceError(approveAndExecute(s.deps, approveInput(s, action.id, booking.id)), "SLOT_UNAVAILABLE");
      assert.match(error.message, /already held \(durable record peer-op-key\)/);
      assert.equal(s.store.getBooking(booking.id).status, "failed");
    } finally {
      peer.close();
    }
  } finally {
    s.cleanup();
  }
});
