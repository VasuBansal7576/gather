import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { createDemoConnectors } from "../src/connectors/demo.ts";
import { availabilityOperationKey } from "../src/connectors/contracts.ts";
import type {
  CheckAvailabilityRequest,
  CheckAvailabilityResponse,
  ConnectorResult,
  CreateProvisionalHoldRequest,
  CreateProvisionalHoldResponse,
  SendEmailRequest,
  SendEmailResponse,
} from "../src/connectors/contracts.ts";
import {
  approveAndExecute,
  emailOperationKey,
  holdOperationKey,
  reconcileExecution,
  ServiceError,
} from "../src/server/booking-service.ts";
import type { BookingServiceDeps } from "../src/server/booking-service.ts";
import { DurableDemoCalendar, DurableDemoEmail } from "../src/server/durable-demo-connectors.ts";
import { GatherStore } from "../src/server/sqlite-store.ts";

// Fictional fixtures only; every receipt below stays DEMO ONLY.
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
    emailBody: "DEMO ONLY fictional hold for the corrections test event.",
    ...overrides,
  };
}

function slot(slotId: string, calendarId: string, startAt = "2030-06-12T00:00:00.000Z", endAt = "2030-06-13T00:00:00.000Z", available = true) {
  return {
    slotId, calendarId, startAt, endAt, available,
    sourceReferences: [{ kind: "fixture" as const, locator: "demo://test/corrections-slot", fictional: true as const }],
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

function setup(slots = [slot("slot-cover", "demo-calendar-001")]): Setup {
  const dir = mkdtempSync(join(tmpdir(), "gather-corr-"));
  const path = join(dir, "gather.sqlite");
  const store = new GatherStore(path);
  const connectors = createDemoConnectors({ calendarSlots: slots });
  const deps: BookingServiceDeps = { store, calendar: connectors.calendar, email: connectors.email, ownerId: "test-owner", now: () => NOW };
  const business = store.createBusiness({ name: "Fictional Corrections Hall", timezone: "UTC" });
  return { dir, path, store, deps, connectors, businessId: business.id, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function seedBooking(s: Setup, ids: { booking: string; action: string }, payload: Record<string, unknown> = holdPayload(), kind: "create_provisional_hold" | "send_offer" | "update_booking" | "custom" = "create_provisional_hold") {
  const booking = s.store.createBooking({
    id: ids.booking, businessId: s.businessId, eventName: "Fictional corrections event",
    status: "pending_approval", startAt: START, endAt: END, sourceReferences: [],
  });
  const action = s.store.createProposedAction({ id: ids.action, bookingId: booking.id, kind, payload, sourceReferences: [] });
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

test("invalid and past proposals gain no approval row", async () => {
  const s = setup();
  try {
    const bad = seedBooking(s, { booking: "b-bad", action: "a-bad" }, { startAt: START, endAt: END });
    await assertServiceError(approveAndExecute(s.deps, approveInput(s, bad.action.id, bad.booking.id)), "INVALID_REQUEST");
    assert.equal(s.store.listApprovals(bad.action.id).length, 0);
    assert.equal(s.store.listActionExecutions(bad.action.id).length, 0);

    const past = seedBooking(s, { booking: "b-past", action: "a-past" }, holdPayload({
      startAt: "2020-06-12T17:00:00.000Z",
      endAt: "2020-06-12T23:00:00.000Z",
      expiresAt: EXPIRES,
    }));
    const error = await assertServiceError(approveAndExecute(s.deps, approveInput(s, past.action.id, past.booking.id)), "INVALID_REQUEST");
    assert.match(error.message, /already ended/);
    assert.equal(s.store.listApprovals(past.action.id).length, 0);
    assert.equal(s.store.listActionExecutions(past.action.id).length, 0);
  } finally {
    s.cleanup();
  }
});

test("uncertain email aggregates booking uncertainty until reconciled", async () => {
  const actionId = "a-emailunc";
  // Seed the email key for timeout-after-success, then block the first
  // auto-reconcile so uncertainty persists instead of healing inline.
  const connectors = createDemoConnectors({
    calendarSlots: [slot("slot-cover", "demo-calendar-001")],
    timeoutAfterSuccessOperationKeys: [emailOperationKey(actionId, 1)],
  });
  const dir = mkdtempSync(join(tmpdir(), "gather-corr-eu-"));
  const path = join(dir, "gather.sqlite");
  const store2 = new GatherStore(path);
  const deps2: BookingServiceDeps = { store: store2, calendar: connectors.calendar, email: connectors.email, ownerId: "test-owner", now: () => NOW };
  try {
    const business = store2.createBusiness({ name: "Fictional Hall", timezone: "UTC" });
    const booking = store2.createBooking({ id: "b-emailunc", businessId: business.id, eventName: "Fictional event", status: "pending_approval", sourceReferences: [] });
    const action = store2.createProposedAction({ id: actionId, bookingId: booking.id, kind: "create_provisional_hold", payload: holdPayload(), sourceReferences: [] });
    let blockReconcile = true;
    const realReconcile = connectors.email.reconcileSentEmail.bind(connectors.email);
    connectors.email.reconcileSentEmail = async (req) => {
      if (blockReconcile) {
        return {
          status: "failed" as const,
          metadata: { operationKey: req.operationKey, mode: { mode: "demo" as const, label: "DEMO ONLY" as const, fictional: true as const }, simulated: true as const, sourceReferences: [] },
          error: { kind: "not_found" as const, message: "fixture reconcile unavailable", retryable: true as const },
        };
      }
      return realReconcile(req);
    };
    const first = await approveAndExecute(deps2, { bookingId: booking.id, proposedActionId: action.id, proposalVersion: 1, proposalFingerprint: action.proposalFingerprint });
    assert.equal(first.hold.execution.status, "succeeded");
    assert.equal(first.email?.execution.status, "uncertain");
    assert.equal(store2.getBooking(booking.id).status, "uncertain");
    blockReconcile = false;
    const healed = await reconcileExecution(deps2, first.email!.execution.id);
    assert.equal(healed.execution.status, "succeeded");
    assert.equal(store2.getBooking(booking.id).status, "provisional_hold");
  } finally {
    store2.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("markExecutionUncertain refuses terminal rows", () => {
  const s = setup();
  try {
    const { action } = seedBooking(s, { booking: "b-term", action: "a-term" });
    s.store.approveProposedAction(action.id, "test-owner");
    const pending = s.store.reserveStepExecution(action.id, 1, holdOperationKey(action.id, 1), { claimToken: "t", leaseMs: 60_000, nowMs: NOW_MS });
    assert.equal(s.store.markExecutionUncertain(pending.execution.id, "wobble").status, "uncertain");
    assert.equal(s.store.markExecutionUncertain(pending.execution.id, "still wobble").status, "uncertain");

    const failed = s.store.reserveStepExecution(action.id, 1, "other-key-failed", { claimToken: "t", leaseMs: 60_000, nowMs: NOW_MS });
    s.store.completeActionExecution(failed.execution.id, { status: "failed", error: "nope" });
    assert.throws(() => s.store.markExecutionUncertain(failed.execution.id, "rewrite attempt"), /Only pending or uncertain/);

    const partial = s.store.reserveStepExecution(action.id, 1, "other-key-partial", { claimToken: "t", leaseMs: 60_000, nowMs: NOW_MS });
    s.store.completeActionExecution(partial.execution.id, { status: "partial", result: {} });
    assert.throws(() => s.store.markExecutionUncertain(partial.execution.id, "rewrite attempt"), /Only pending or uncertain/);

    const ok = s.store.reserveStepExecution(action.id, 1, "other-key-ok", { claimToken: "t", leaseMs: 60_000, nowMs: NOW_MS });
    s.store.completeActionExecution(ok.execution.id, { status: "succeeded", result: {} });
    assert.throws(() => s.store.markExecutionUncertain(ok.execution.id, "rewrite attempt"), /Only pending or uncertain/);
  } finally {
    s.cleanup();
  }
});

test("reconcile without evidence stays retryably pending; revoked is distinct", async () => {
  const s = setup();
  try {
    const { action, booking } = seedBooking(s, { booking: "b-recerr", action: "a-recerr" });
    s.store.approveProposedAction(action.id, "test-owner");
    const reserved = s.store.reserveStepExecution(action.id, 1, holdOperationKey(action.id, 1), { claimToken: "t", leaseMs: 60_000, nowMs: NOW_MS });
    s.store.markExecutionUncertain(reserved.execution.id, "lost response");
    // Nothing was ever written provider-side: absence of evidence is not
    // evidence of absence — the row stays uncertain and retry stays allowed.
    const pending = await assertServiceError(reconcileExecution(s.deps, reserved.execution.id), "RECONCILE_PENDING");
    assert.equal(pending.retryable, true);
    assert.equal(s.store.getActionExecution(reserved.execution.id).status, "uncertain");
    void booking;
    // Revocation surfaces distinctly and is not retryable blindly.
    const realReconcile = s.deps.calendar.reconcileProvisionalHold.bind(s.deps.calendar);
    s.deps.calendar.reconcileProvisionalHold = async (req) => ({
      status: "failed" as const,
      metadata: { operationKey: req.operationKey, mode: { mode: "demo" as const, label: "DEMO ONLY" as const, fictional: true as const }, simulated: true as const, sourceReferences: [] },
      error: { kind: "access_revoked" as const, message: "Demo calendar access was revoked", retryable: false as const },
    });
    try {
      await assertServiceError(reconcileExecution(s.deps, reserved.execution.id), "ACCESS_REVOKED");
    } finally {
      s.deps.calendar.reconcileProvisionalHold = realReconcile;
    }
    assert.equal(s.store.getActionExecution(reserved.execution.id).status, "uncertain");
  } finally {
    s.cleanup();
  }
});

test("repeat approval after success skips availability and reuses receipts", async () => {
  const s = setup();
  try {
    const { action, booking } = seedBooking(s, { booking: "b-repeat2", action: "a-repeat2" });
    let availabilityCalls = 0;
    const realAvail = s.deps.calendar.checkAvailability.bind(s.deps.calendar);
    s.deps.calendar.checkAvailability = async (req: CheckAvailabilityRequest): Promise<ConnectorResult<CheckAvailabilityResponse>> => {
      availabilityCalls += 1;
      return realAvail(req);
    };
    const first = await approveAndExecute(s.deps, approveInput(s, action.id, booking.id));
    assert.equal(availabilityCalls, 1);
    // Access is lost afterwards: a repeat approval must still reuse the own
    // succeeded receipts instead of failing a new availability read.
    s.deps.calendar.checkAvailability = async (_req: CheckAvailabilityRequest): Promise<ConnectorResult<CheckAvailabilityResponse>> => {
      availabilityCalls += 1;
      return {
        status: "failed" as const,
        metadata: { operationKey: "revoked", mode: { mode: "demo" as const, label: "DEMO ONLY" as const, fictional: true as const }, simulated: true as const, sourceReferences: [] },
        error: { kind: "access_revoked" as const, message: "Demo calendar access was revoked", retryable: false as const },
      };
    };
    const second = await approveAndExecute(s.deps, approveInput(s, action.id, booking.id));
    assert.equal(availabilityCalls, 1);
    assert.equal(second.hold.execution.id, first.hold.execution.id);
    assert.equal(second.email?.execution.id, first.email?.execution.id);
    assert.equal(s.connectors.store.listProvisionalHolds().length, 1);
  } finally {
    s.cleanup();
  }
});

test("stale proposal across an async wait halts before email", async () => {
  const s = setup();
  try {
    const { action, booking } = seedBooking(s, { booking: "b-stalewait", action: "a-stalewait" });
    let holdCalls = 0;
    let emailCalls = 0;
    let release!: (value: ConnectorResult<CreateProvisionalHoldResponse>) => void;
    const key = holdOperationKey(action.id, 1);
    s.deps.calendar.createProvisionalHold = (req: CreateProvisionalHoldRequest): Promise<ConnectorResult<CreateProvisionalHoldResponse>> => {
      holdCalls += 1;
      return new Promise((resolve) => { release = resolve; });
    };
    s.deps.email.sendEmail = async (_req: SendEmailRequest): Promise<ConnectorResult<SendEmailResponse>> => {
      emailCalls += 1;
      throw new Error("must not be called after staleness");
    };
    const attempt = approveAndExecute(s.deps, approveInput(s, action.id, booking.id));
    while (holdCalls === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    // The displayed proposal is superseded while the hold call is in flight.
    s.store.replaceProposedAction(action.id, {
      kind: "create_provisional_hold",
      payload: holdPayload({ emailSubject: "DEMO ONLY revised mid-flight" }),
      sourceReferences: [],
    });
    release({
      status: "succeeded",
      metadata: { operationKey: key, mode: { mode: "demo", label: "DEMO ONLY", fictional: true }, simulated: true, sourceReferences: [] },
      data: {
        hold: {
          holdId: "demo-hold-stale", operationKey: key, bookingId: booking.id, calendarId: "demo-calendar-001",
          startAt: START, endAt: END, expiresAt: EXPIRES, status: "provisional_hold", createdAt: NOW, sourceReferences: [],
        },
        provenance: [],
      },
    });
    await assertServiceError(attempt, "STALE_PROPOSAL");
    assert.equal(emailCalls, 0);
    // Observed provider evidence is kept as versioned history; the aggregate
    // is parked uncertain and the pipeline never continued as if approved.
    assert.equal(s.store.getActionExecution(s.store.getExecutionByIdempotencyKey(key)!.id).status, "succeeded");
    assert.equal(s.store.getBooking(booking.id).status, "uncertain");
  } finally {
    s.cleanup();
  }
});

test("C4: restart cannot double-book the same calendar window", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gather-corr-c4-"));
  const path = join(dir, "gather.sqlite");
  const slots = [slot("slot-cover", "demo-calendar-001")];
  const firstStore = new GatherStore(path);
  try {
    const demo1 = createDemoConnectors({ calendarSlots: slots });
    const deps1: BookingServiceDeps = {
      store: firstStore,
      calendar: new DurableDemoCalendar(firstStore, demo1.calendar),
      email: new DurableDemoEmail(firstStore, demo1.email),
      ownerId: "test-owner",
      now: () => NOW,
    };
    const business = firstStore.createBusiness({ name: "Fictional Hall", timezone: "UTC" });
    const bookingA = firstStore.createBooking({ id: "b-c4-a", businessId: business.id, eventName: "Fictional A", status: "pending_approval", sourceReferences: [] });
    const actionA = firstStore.createProposedAction({ id: "a-c4-a", bookingId: bookingA.id, kind: "create_provisional_hold", payload: holdPayload(), sourceReferences: [] });
    const first = await approveAndExecute(deps1, { bookingId: bookingA.id, proposedActionId: actionA.id, proposalVersion: 1, proposalFingerprint: actionA.proposalFingerprint });
    assert.equal(first.hold.execution.status, "succeeded");
  } finally {
    firstStore.close();
  }
  // Fresh volatile adapters after restart still see the durable window claim.
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
    const bookingB = secondStore.createBooking({ id: "b-c4-b", businessId: secondStore.listBusinesses()[0]!.id, eventName: "Fictional B", status: "pending_approval", sourceReferences: [] });
    const actionB = secondStore.createProposedAction({ id: "a-c4-b", bookingId: bookingB.id, kind: "create_provisional_hold", payload: holdPayload(), sourceReferences: [] });
    const error = await assertServiceError(
      approveAndExecute(deps2, { bookingId: bookingB.id, proposedActionId: actionB.id, proposalVersion: 1, proposalFingerprint: actionB.proposalFingerprint }),
      "EXECUTION_FAILED",
    );
    assert.match(error.message, /already held/);
    assert.equal(demo2.store.listProvisionalHolds().length, 0);
    assert.equal(secondStore.getBooking(bookingB.id).status, "failed");
  } finally {
    secondStore.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("C4: overlapping hold claims serialize across separate connections", () => {
  const s = setup();
  const peer = new GatherStore(s.path);
  try {
    const first = s.store.claimHoldSlot("op-key-a", "demo-calendar-001", START, END, { nowMs: NOW_MS });
    assert.equal(first.ok, true);
    const second = peer.claimHoldSlot("op-key-b", "demo-calendar-001", START, END, { nowMs: NOW_MS });
    assert.equal(second.ok, false);
    if (!second.ok) assert.equal(second.conflictingKey, "op-key-a");
    // Own retries always pass; other calendars are unaffected.
    assert.equal(s.store.claimHoldSlot("op-key-a", "demo-calendar-001", START, END, { nowMs: NOW_MS }).ok, true);
    assert.equal(peer.claimHoldSlot("op-key-c", "demo-calendar-002", START, END, { nowMs: NOW_MS }).ok, true);
    // Definitive failure releases the window for others.
    peer.releaseHoldSlot("op-key-a");
    s.store.releaseHoldSlot("op-key-a");
    assert.equal(peer.claimHoldSlot("op-key-b", "demo-calendar-001", START, END, { nowMs: NOW_MS }).ok, true);
  } finally {
    peer.close();
    s.cleanup();
  }
});

test("C5: availability is scoped to the requested calendar", async () => {
  const s = setup([slot("slot-only-a", "demo-calendar-001")]);
  try {
    // Same dates on another calendar have no coverage: no cross-calendar hold.
    const { action, booking } = seedBooking(s, { booking: "b-c5", action: "a-c5" }, holdPayload({ calendarId: "demo-calendar-002" }));
    await assertServiceError(approveAndExecute(s.deps, approveInput(s, action.id, booking.id)), "SLOT_UNAVAILABLE");
    assert.equal(s.connectors.store.listProvisionalHolds().length, 0);
    // Availability keys differ per calendar so receipts cannot be confused.
    assert.notEqual(
      availabilityOperationKey({ calendarId: "demo-calendar-001", startAt: START, endAt: END }),
      availabilityOperationKey({ calendarId: "demo-calendar-002", startAt: START, endAt: END }),
    );
  } finally {
    s.cleanup();
  }
});

test("C6: unsupported proposal kinds are rejected before approval", async () => {
  const s = setup();
  try {
    for (const [index, kind] of (["custom", "send_offer", "update_booking"] as const).entries()) {
      const { action, booking } = seedBooking(s, { booking: `b-c6-${index}`, action: `a-c6-${index}` }, holdPayload(), kind);
      const error = await assertServiceError(approveAndExecute(s.deps, approveInput(s, action.id, booking.id)), "INVALID_REQUEST");
      assert.match(error.message, /Unsupported proposal kind/);
      assert.equal(s.store.listApprovals(action.id).length, 0);
      assert.equal(s.store.listActionExecutions(action.id).length, 0);
      void booking;
    }
  } finally {
    s.cleanup();
  }
});
