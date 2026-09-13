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

// Fictional fixtures only; every receipt below stays DEMO ONLY. One mutable
// clock is shared by the demo world, the durable wrappers, and the service.
const CAL1 = "demo-calendar-001";
const CAL2 = "demo-calendar-002";
const T0 = Date.parse("2030-01-01T00:00:00.000Z");
const START = "2030-06-12T17:00:00.000Z";
const END = "2030-06-12T23:00:00.000Z";

function mutableClock() {
  let t = T0;
  return { get: () => t, set: (v: number) => { t = v; }, iso: () => new Date(t).toISOString() };
}

function payload(expiresAt: string, calendarId = CAL1): Record<string, unknown> {
  return {
    startAt: START, endAt: END, expiresAt, calendarId,
    emailTo: ["guest@example.test"],
    emailSubject: "DEMO ONLY fictional offer",
    emailBody: "DEMO ONLY fictional hold for the lifecycle test event.",
  };
}

function slot(slotId: string, calendarId: string, available: boolean = true, reason?: string): {
  slotId: string;
  calendarId: string;
  startAt: string;
  endAt: string;
  available: boolean;
  reason?: string;
  sourceReferences: { kind: "fixture"; locator: string; fictional: true }[];
} {
  return {
    slotId, calendarId, startAt: "2030-06-12T00:00:00.000Z", endAt: "2030-06-13T00:00:00.000Z", available,
    ...(reason ? { reason } : {}),
    sourceReferences: [{ kind: "fixture" as const, locator: "demo://test/lifecycle-slot", fictional: true as const }],
  };
}

interface World {
  dir: string;
  path: string;
  store: GatherStore;
  deps: BookingServiceDeps;
  clock: ReturnType<typeof mutableClock>;
  businessId: string;
  cleanup: () => void;
}

function openWorld(path: string, slots: ReturnType<typeof slot>[], clock: ReturnType<typeof mutableClock>, timeoutKeys: string[] = []): Pick<World, "store" | "deps"> {
  const store = new GatherStore(path);
  const connectors = createDemoConnectors({ calendarSlots: slots, nowMs: clock.get, timeoutAfterSuccessOperationKeys: timeoutKeys });
  const deps: BookingServiceDeps = {
    store,
    calendar: new DurableDemoCalendar(store, connectors.calendar, clock.get),
    email: new DurableDemoEmail(store, connectors.email),
    ownerId: "test-owner",
    now: clock.iso,
  };
  return { store, deps };
}

function seedBooking(w: Pick<World, "store" | "businessId">, ids: { booking: string; action: string }, p: Record<string, unknown>) {
  const booking = w.store.createBooking({
    id: ids.booking, businessId: w.businessId, eventName: "Fictional lifecycle event",
    status: "pending_approval", startAt: START, endAt: END, sourceReferences: [],
  });
  const action = w.store.createProposedAction({ id: ids.action, bookingId: booking.id, kind: "create_provisional_hold", payload: p, sourceReferences: [] });
  return { booking, action };
}

function approveInput(w: Pick<World, "store">, actionId: string, bookingId: string) {
  const action = w.store.getProposedAction(actionId);
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

test("end-to-end expiry: hold, advance clock past expiry, rebook same window with same adapters", async () => {
  const clock = mutableClock();
  const dir = mkdtempSync(join(tmpdir(), "gather-life-"));
  const path = join(dir, "gather.sqlite");
  const { store, deps } = openWorld(path, [slot("slot-cover", CAL1)], clock);
  const businessId = store.createBusiness({ name: "Fictional Hall", timezone: "UTC" }).id;
  const w = { store, businessId };
  try {
    // Hold expires one hour after the fixed start clock, long before the event.
    const first = seedBooking(w, { booking: "b-life-1", action: "a-life-1" }, payload(new Date(T0 + 3_600_000).toISOString()));
    const done = await approveAndExecute(deps, approveInput({ store }, first.action.id, first.booking.id));
    assert.equal(done.hold.execution.status, "succeeded");
    // Advance the shared clock past expiry but before the event starts.
    clock.set(T0 + 7_200_000);
    const second = seedBooking(w, { booking: "b-life-2", action: "a-life-2" }, payload(new Date(T0 + 7_200_000 + 3_600_000).toISOString()));
    const rebooked = await approveAndExecute(deps, approveInput({ store }, second.action.id, second.booking.id));
    assert.equal(rebooked.hold.execution.status, "succeeded");
    assert.equal(store.getBooking(second.booking.id).status, "provisional_hold");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("expiry agreement after restart with rebuilt adapters on the same clock", async () => {
  const clock = mutableClock();
  const dir = mkdtempSync(join(tmpdir(), "gather-life-restart-"));
  const path = join(dir, "gather.sqlite");
  const first = openWorld(path, [slot("slot-cover", CAL1)], clock);
  const businessId = first.store.createBusiness({ name: "Fictional Hall", timezone: "UTC" }).id;
  try {
    const seeded = seedBooking({ store: first.store, businessId }, { booking: "b-r-1", action: "a-r-1" }, payload(new Date(T0 + 3_600_000).toISOString()));
    const done = await approveAndExecute(first.deps, approveInput(first, seeded.action.id, seeded.booking.id));
    assert.equal(done.hold.execution.status, "succeeded");
  } finally {
    first.store.close();
  }
  clock.set(T0 + 7_200_000);
  const second = openWorld(path, [slot("slot-cover", CAL1)], clock);
  try {
    const business = second.store.listBusinesses()[0]!.id;
    const next = seedBooking({ store: second.store, businessId: business }, { booking: "b-r-2", action: "a-r-2" }, payload(new Date(T0 + 7_200_000 + 3_600_000).toISOString()));
    const rebooked = await approveAndExecute(second.deps, approveInput(second, next.action.id, next.booking.id));
    assert.equal(rebooked.hold.execution.status, "succeeded");
  } finally {
    second.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("timeout-after-success with an expired reconciled receipt frees the window", async () => {
  const clock = mutableClock();
  const dir = mkdtempSync(join(tmpdir(), "gather-life-timeout-"));
  const path = join(dir, "gather.sqlite");
  const holdKey = holdOperationKey("a-t-1", 1);
  const { store, deps } = openWorld(path, [slot("slot-cover", CAL1)], clock, [holdKey]);
  const businessId = store.createBusiness({ name: "Fictional Hall", timezone: "UTC" }).id;
  const w = { store, businessId };
  try {
    const first = seedBooking(w, { booking: "b-t-1", action: "a-t-1" }, payload(new Date(T0 + 3_600_000).toISOString()));
    const healed = await approveAndExecute(deps, approveInput({ store }, first.action.id, first.booking.id));
    assert.equal(healed.hold.execution.status, "succeeded");
    // The uncertain branch kept the intent and saved the receipt; expiry must
    // now govern both, so the window frees.
    clock.set(T0 + 7_200_000);
    assert.equal(store.findHoldConflict(CAL1, START, END, { excludeOperationKey: "unrelated", nowMs: clock.get() }), undefined);
    const second = seedBooking(w, { booking: "b-t-2", action: "a-t-2" }, payload(new Date(T0 + 7_200_000 + 3_600_000).toISOString()));
    const rebooked = await approveAndExecute(deps, approveInput({ store }, second.action.id, second.booking.id));
    assert.equal(rebooked.hold.execution.status, "succeeded");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a genuinely unknown intent still blocks past its lease", async () => {
  const clock = mutableClock();
  const dir = mkdtempSync(join(tmpdir(), "gather-life-unknown-"));
  const path = join(dir, "gather.sqlite");
  const { store, deps } = openWorld(path, [slot("slot-cover", CAL1)], clock);
  const businessId = store.createBusiness({ name: "Fictional Hall", timezone: "UTC" }).id;
  try {
    // No receipt exists for this key: the effect is unproven, so even a
    // long-expired lease must not free the window.
    assert.equal(store.claimHoldSlot("crashed-unknown", CAL1, START, END, { nowMs: clock.get(), intentLeaseMs: 1 }).ok, true);
    clock.set(T0 + 86_400_000 * 30);
    assert.equal(store.findHoldConflict(CAL1, START, END, { excludeOperationKey: "other", nowMs: clock.get() }), "crashed-unknown");
    const seeded = seedBooking({ store, businessId }, { booking: "b-u-1", action: "a-u-1" }, payload(new Date(T0 + 86_400_000 * 30 + 3_600_000).toISOString()));
    await assertServiceError(approveAndExecute(deps, approveInput({ store }, seeded.action.id, seeded.booking.id)), "SLOT_UNAVAILABLE");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unavailable slot on calendar B cannot block calendar A at create time", async () => {
  const clock = mutableClock();
  const dir = mkdtempSync(join(tmpdir(), "gather-life-cross-"));
  const path = join(dir, "gather.sqlite");
  const { store, deps } = openWorld(path, [
    slot("slot-a-open", CAL1),
    { ...slot("slot-b-busy", CAL2, false), reason: "Busy on B" },
  ], clock);
  const businessId = store.createBusiness({ name: "Fictional Hall", timezone: "UTC" }).id;
  try {
    const seeded = seedBooking({ store, businessId }, { booking: "b-x-1", action: "a-x-1" }, payload(new Date(T0 + 3_600_000).toISOString(), CAL1));
    const done = await approveAndExecute(deps, approveInput({ store }, seeded.action.id, seeded.booking.id));
    assert.equal(done.hold.execution.status, "succeeded");
    assert.equal(store.getBooking(seeded.booking.id).status, "provisional_hold");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
