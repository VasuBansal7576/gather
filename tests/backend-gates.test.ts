import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { createDemoConnectors } from "../src/connectors/demo.ts";
import type {
  CheckAvailabilityRequest,
  CheckAvailabilityResponse,
  ConnectorResult,
  CreateProvisionalHoldRequest,
  CreateProvisionalHoldResponse,
  OperationRequest,
} from "../src/connectors/contracts.ts";
import {
  approveAndExecute,
  holdOperationKey,
  reconcileExecution,
  retryFailedSteps,
  ServiceError,
} from "../src/server/booking-service.ts";
import type { BookingServiceDeps } from "../src/server/booking-service.ts";
import { DurableDemoCalendar, DurableDemoEmail } from "../src/server/durable-demo-connectors.ts";
import { GatherStore } from "../src/server/sqlite-store.ts";

// Fictional fixtures only; every assertion below stays in the DEMO ONLY world.
const START = "2030-06-12T17:00:00.000Z";
const END = "2030-06-12T23:00:00.000Z";
const EXPIRES = "2030-06-13T23:00:00.000Z";
const NOW = "2030-01-01T00:00:00.000Z";
const NOW_MS = Date.parse(NOW);

function holdPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    startAt: START,
    endAt: END,
    expiresAt: EXPIRES,
    calendarId: "demo-calendar-001",
    emailTo: ["guest@example.test"],
    emailSubject: "DEMO ONLY fictional offer",
    emailBody: "DEMO ONLY fictional hold for the gate test event.",
    ...overrides,
  };
}

function slot(slotId: string, startAt: string, endAt: string, available: boolean, reason?: string) {
  return {
    slotId, startAt, endAt, available,
    ...(reason ? { reason } : {}),
    sourceReferences: [{ kind: "fixture" as const, locator: "demo://test/gate-slot", fictional: true as const }],
  };
}

interface Setup {
  dir: string;
  path: string;
  store: GatherStore;
  deps: BookingServiceDeps;
  connectors: ReturnType<typeof createDemoConnectors>;
  businessId: string;
  cleanup: () => void;
}

function setup(slots: ReturnType<typeof slot>[] = [slot("slot-cover", "2030-06-12T00:00:00.000Z", "2030-06-13T00:00:00.000Z", true)]): Setup {
  const dir = mkdtempSync(join(tmpdir(), "gather-gate-"));
  const path = join(dir, "gather.sqlite");
  const store = new GatherStore(path);
  const connectors = createDemoConnectors({ calendarSlots: slots });
  const deps: BookingServiceDeps = {
    store,
    calendar: connectors.calendar,
    email: connectors.email,
    ownerId: "test-owner",
    now: () => NOW,
  };
  const business = store.createBusiness({ name: "Fictional Gate Hall", timezone: "UTC" });
  return { dir, path, store, deps, connectors, businessId: business.id, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function seedBooking(s: Setup, ids: { booking: string; action: string }, payload: Record<string, unknown> = holdPayload()) {
  const booking = s.store.createBooking({
    id: ids.booking, businessId: s.businessId, eventName: "Fictional gate event",
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

test("separate store connections cannot both own one pending step", () => {
  const s = setup();
  const peer = new GatherStore(s.path);
  try {
    const { action } = seedBooking(s, { booking: "b-conn", action: "a-conn" });
    s.store.approveProposedAction(action.id, "test-owner");
    const key = holdOperationKey(action.id, 1);
    const first = s.store.reserveStepExecution(action.id, 1, key, { claimToken: "owner-a", leaseMs: 120_000, nowMs: NOW_MS });
    assert.equal(first.created, true);
    // A second connection racing the same stable key is refused while the claim lives.
    assert.throws(() => peer.reserveStepExecution(action.id, 1, key, { claimToken: "owner-b", leaseMs: 120_000, nowMs: NOW_MS }), /already in progress/);
    // The first owner completes under its claim; the peer then sees success, never executes.
    s.store.completeActionExecution(first.execution.id, { status: "succeeded", result: { demo: true } }, { claimToken: "owner-a" });
    const peerView = peer.reserveStepExecution(action.id, 1, key, { claimToken: "owner-b", leaseMs: 120_000, nowMs: NOW_MS });
    assert.equal(peerView.created, false);
    assert.equal(peerView.execution.status, "succeeded");
  } finally {
    peer.close();
    s.cleanup();
  }
});

test("service never replays a pending step owned by another attempt", async () => {
  const s = setup();
  try {
    const { action, booking } = seedBooking(s, { booking: "b-inflight", action: "a-inflight" });
    s.store.approveProposedAction(action.id, "test-owner");
    // Simulate a crashed worker that reserved but never finished (live lease).
    s.store.reserveStepExecution(action.id, 1, holdOperationKey(action.id, 1), { claimToken: "crashed-worker", leaseMs: 120_000, nowMs: NOW_MS });
    const error = await assertServiceError(approveAndExecute(s.deps, approveInput(s, action.id, booking.id)), "CONFLICT");
    assert.equal(error.retryable, true);
    assert.equal(s.connectors.store.listProvisionalHolds().length, 0);
  } finally {
    s.cleanup();
  }
});

test("completion writes are conditional on the claim token", () => {
  const s = setup();
  try {
    const { action } = seedBooking(s, { booking: "b-claim", action: "a-claim" });
    s.store.approveProposedAction(action.id, "test-owner");
    const key = holdOperationKey(action.id, 1);
    const first = s.store.reserveStepExecution(action.id, 1, key, { claimToken: "owner-a", leaseMs: 1000, nowMs: NOW_MS });
    // A reclaimer takes over after the lease expires; the old owner can no longer commit.
    const second = s.store.reserveStepExecution(action.id, 1, key, { claimToken: "owner-b", leaseMs: 120_000, nowMs: NOW_MS + 60_000 });
    assert.equal(second.reclaimed, true);
    assert.throws(
      () => s.store.completeActionExecution(first.execution.id, { status: "succeeded" }, { claimToken: "owner-a" }),
      /no longer held/,
    );
    assert.throws(
      () => s.store.markExecutionUncertain(first.execution.id, "stale owner", { claimToken: "owner-a" }),
      /no longer held/,
    );
    const done = s.store.completeActionExecution(first.execution.id, { status: "succeeded", result: { demo: true } }, { claimToken: "owner-b" });
    assert.equal(done.status, "succeeded");
  } finally {
    s.cleanup();
  }
});

test("crash before any provider call reconciles to uncertain with zero writes", async () => {
  const s = setup();
  try {
    const { action, booking } = seedBooking(s, { booking: "b-crashclean", action: "a-crashclean" });
    s.store.approveProposedAction(action.id, "test-owner");
    // Crashed worker reserved (short lease) but never reached the provider.
    s.store.reserveStepExecution(action.id, 1, holdOperationKey(action.id, 1), { claimToken: "crashed", leaseMs: 1000, nowMs: NOW_MS });
    // The service clock runs after the lease: the row is reclaimable, not in flight.
    s.deps.now = () => new Date(NOW_MS + 60_000).toISOString();
    const response = await approveAndExecute(s.deps, approveInput(s, action.id, booking.id));
    // Reclaim reconciled by stable key, found nothing, and refused to replay.
    assert.equal(response.hold.execution.status, "uncertain");
    assert.equal(response.email, null);
    assert.equal(s.connectors.store.listProvisionalHolds().length, 0);
    assert.equal(s.store.getBooking(booking.id).status, "uncertain");
    await assertServiceError(reconcileExecution(s.deps, response.hold.execution.id), "NOT_FOUND");
  } finally {
    s.cleanup();
  }
});

test("crash after a provider write heals via reconcile without a duplicate", async () => {
  const s = setup();
  try {
    const { action, booking } = seedBooking(s, { booking: "b-crashwrite", action: "a-crashwrite" });
    s.store.approveProposedAction(action.id, "test-owner");
    const key = holdOperationKey(action.id, 1);
    // The crashed attempt completed the provider write, then died before recording it.
    const direct = await s.connectors.calendar.createProvisionalHold({
      operationKey: key, bookingId: booking.id, calendarId: "demo-calendar-001",
      startAt: START, endAt: END, expiresAt: EXPIRES,
    });
    assert.equal(direct.status, "succeeded");
    s.store.reserveStepExecution(action.id, 1, key, { claimToken: "crashed", leaseMs: 1000, nowMs: NOW_MS });
    s.deps.now = () => new Date(NOW_MS + 60_000).toISOString();
    const response = await approveAndExecute(s.deps, approveInput(s, action.id, booking.id));
    assert.equal(response.hold.execution.status, "succeeded");
    assert.equal(s.connectors.store.listProvisionalHolds().length, 1);
    if (direct.status !== "succeeded") return;
    const healed = response.hold.execution.result as { hold: { holdId: string } };
    assert.equal(healed.hold.holdId, direct.data.hold.holdId);
  } finally {
    s.cleanup();
  }
});

test("retry re-checks availability and never attempts email when revoked", async () => {
  const s = setup();
  try {
    const { action, booking } = seedBooking(s, { booking: "b-retryrev", action: "a-retryrev" });
    let holds = 0;
    let availabilityCalls = 0;
    const realAvail = s.deps.calendar.checkAvailability.bind(s.deps.calendar);
    const realHold = s.deps.calendar.createProvisionalHold.bind(s.deps.calendar);
    s.deps.calendar.checkAvailability = async (req: CheckAvailabilityRequest): Promise<ConnectorResult<CheckAvailabilityResponse>> => {
      availabilityCalls += 1;
      return realAvail(req);
    };
    s.deps.calendar.createProvisionalHold = async (req: CreateProvisionalHoldRequest): Promise<ConnectorResult<CreateProvisionalHoldResponse>> => {
      holds += 1;
      if (holds === 1) {
        return { status: "failed", metadata: { operationKey: req.operationKey, mode: { mode: "demo", label: "DEMO ONLY", fictional: true }, simulated: true, sourceReferences: [] }, error: { kind: "conflict", message: "fixture transient conflict", retryable: true } };
      }
      return realHold(req);
    };
    await assertServiceError(approveAndExecute(s.deps, approveInput(s, action.id, booking.id)), "EXECUTION_FAILED");
    assert.equal(availabilityCalls, 1);
    // Access is revoked before the retry: the retry must re-check availability
    // and stop before any new hold or email attempt.
    s.deps.calendar.checkAvailability = async (_req: CheckAvailabilityRequest): Promise<ConnectorResult<CheckAvailabilityResponse>> => ({
      status: "failed",
      metadata: { operationKey: "revoked", mode: { mode: "demo", label: "DEMO ONLY", fictional: true }, simulated: true, sourceReferences: [] },
      error: { kind: "access_revoked", message: "Demo calendar access was revoked", retryable: false },
    });
    await assertServiceError(retryFailedSteps(s.deps, action.id), "ACCESS_REVOKED");
    assert.equal(holds, 1);
    assert.equal(s.store.getExecutionByIdempotencyKey(holdOperationKey(action.id, 1))?.status, "failed");
    assert.equal(s.store.listActionExecutions(action.id).filter((e) => e.idempotencyKey.includes(":send:")).length, 0);
    assert.equal(s.store.getBooking(booking.id).status, "uncertain");
  } finally {
    s.cleanup();
  }
});

test("retry after the proposal changes refuses stale receipts", async () => {
  const s = setup();
  try {
    const { action, booking } = seedBooking(s, { booking: "b-retrystale", action: "a-retrystale" });
    const first = await approveAndExecute(s.deps, approveInput(s, action.id, booking.id));
    assert.equal(first.hold.execution.status, "succeeded");
    const holdsBefore = s.connectors.store.listProvisionalHolds().length;
    s.store.replaceProposedAction(action.id, {
      kind: "create_provisional_hold",
      payload: holdPayload({ emailSubject: "DEMO ONLY revised offer" }),
      sourceReferences: [],
    });
    await assertServiceError(retryFailedSteps(s.deps, action.id), "STALE_PROPOSAL");
    assert.equal(s.connectors.store.listProvisionalHolds().length, holdsBefore);
  } finally {
    s.cleanup();
  }
});

test("changed calendar target invalidates approval and executes the new target", async () => {
  const s = setup();
  try {
    const { action, booking } = seedBooking(s, { booking: "b-calchange", action: "a-calchange" });
    const firstInput = approveInput(s, action.id, booking.id);
    const first = await approveAndExecute(s.deps, firstInput);
    assert.equal((first.hold.execution.result as { hold: { calendarId: string } }).hold.calendarId, "demo-calendar-001");
    s.store.replaceProposedAction(action.id, {
      kind: "create_provisional_hold",
      payload: holdPayload({ calendarId: "demo-calendar-002" }),
      sourceReferences: [],
    });
    await assertServiceError(approveAndExecute(s.deps, firstInput), "STALE_PROPOSAL");
    const second = await approveAndExecute(s.deps, approveInput(s, action.id, booking.id));
    assert.equal(second.approval.proposalVersion, 2);
    assert.equal((second.hold.execution.result as { hold: { calendarId: string } }).hold.calendarId, "demo-calendar-002");
  } finally {
    s.cleanup();
  }
});

test("partial slot overlap without full coverage blocks the hold", async () => {
  const s = setup([slot("slot-half", "2030-06-12T12:00:00.000Z", "2030-06-12T18:00:00.000Z", true)]);
  try {
    const { action, booking } = seedBooking(s, { booking: "b-partial", action: "a-partial" });
    const error = await assertServiceError(approveAndExecute(s.deps, approveInput(s, action.id, booking.id)), "SLOT_UNAVAILABLE");
    assert.match(error.message, /fully covers/);
    assert.equal(s.connectors.store.listProvisionalHolds().length, 0);
    assert.equal(s.store.getBooking(booking.id).status, "failed");
  } finally {
    s.cleanup();
  }
});

test("a hold expiring before the event is legitimate; an expired hold is rejected", async () => {
  const s = setup();
  try {
    // Expiry after now (2030-01-01) but before the event: previously wrongly rejected.
    const { action, booking } = seedBooking(s, { booking: "b-earlyexp", action: "a-earlyexp" },
      holdPayload({ expiresAt: "2030-06-05T00:00:00.000Z" }));
    const ok = await approveAndExecute(s.deps, approveInput(s, action.id, booking.id));
    assert.equal(ok.hold.execution.status, "succeeded");
    // Expiry in the past relative to the injected clock is refused before any side effect.
    const expired = seedBooking(s, { booking: "b-expired", action: "a-expired" },
      holdPayload({ expiresAt: "2029-12-01T00:00:00.000Z" }));
    await assertServiceError(approveAndExecute(s.deps, approveInput(s, expired.action.id, expired.booking.id)), "INVALID_REQUEST");
    assert.equal(s.store.listActionExecutions(expired.action.id).length, 0);
  } finally {
    s.cleanup();
  }
});

test("restart while uncertain reconciles from durable receipts with rebuilt adapters", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gather-gate-restart-"));
  const path = join(dir, "gather.sqlite");
  const slots = [slot("slot-cover", "2030-06-12T00:00:00.000Z", "2030-06-13T00:00:00.000Z", true)];
  const holdKey = holdOperationKey("a-restart-uncertain", 1);
  let executionId = "";
  let durableHoldId = "";
  const firstStore = new GatherStore(path);
  try {
    const demo = createDemoConnectors({ calendarSlots: slots, timeoutAfterSuccessOperationKeys: [holdKey] });
    const calendar = new DurableDemoCalendar(firstStore, demo.calendar);
    const email = new DurableDemoEmail(firstStore, demo.email);
    // Reconciliation is unavailable during the first attempt: uncertainty persists,
    // but the completed write is already durably logged.
    let blockReconcile = true;
    const realReconcile = calendar.reconcileProvisionalHold.bind(calendar);
    calendar.reconcileProvisionalHold = async (req: OperationRequest) => {
      if (blockReconcile) {
        return {
          status: "failed" as const,
          metadata: { operationKey: req.operationKey, mode: { mode: "demo" as const, label: "DEMO ONLY" as const, fictional: true as const }, simulated: true as const, sourceReferences: [] },
          error: { kind: "not_found" as const, message: "fixture reconcile unavailable", retryable: true as const },
        };
      }
      return realReconcile(req);
    };
    const deps: BookingServiceDeps = { store: firstStore, calendar, email, ownerId: "test-owner", now: () => NOW };
    const business = firstStore.createBusiness({ name: "Fictional Hall", timezone: "UTC" });
    const booking = firstStore.createBooking({ id: "b-restart-uncertain", businessId: business.id, eventName: "Fictional restart event", status: "pending_approval", sourceReferences: [] });
    const action = firstStore.createProposedAction({ id: "a-restart-uncertain", bookingId: booking.id, kind: "create_provisional_hold", payload: holdPayload(), sourceReferences: [] });
    const first = await approveAndExecute(deps, { bookingId: booking.id, proposedActionId: action.id, proposalVersion: 1, proposalFingerprint: action.proposalFingerprint });
    assert.equal(first.hold.execution.status, "uncertain");
    executionId = first.hold.execution.id;
    const receipt = firstStore.getProviderReceipt(holdKey);
    assert.ok(receipt, "completed write must be durably logged even though its response was lost");
    durableHoldId = (receipt?.receipt.hold as { holdId: string }).holdId;
  } finally {
    firstStore.close();
  }
  // Rebuild everything from the same SQLite file with fresh adapter memory.
  const secondStore = new GatherStore(path);
  try {
    const demo2 = createDemoConnectors({ calendarSlots: slots });
    const deps2: BookingServiceDeps = {
      store: secondStore,
      calendar: new DurableDemoCalendar(secondStore, demo2.calendar),
      email: new DurableDemoEmail(secondStore, demo2.email),
      ownerId: "test-owner",
      now: () => NOW,
    };
    const reconciled = await reconcileExecution(deps2, executionId);
    assert.equal(reconciled.execution.status, "succeeded");
    assert.equal((reconciled.execution.result as { hold: { holdId: string } }).hold.holdId, durableHoldId);
    // Fresh volatile adapters performed zero provider writes: recovery came from SQLite.
    assert.equal(demo2.store.listProvisionalHolds().length, 0);
  } finally {
    secondStore.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
