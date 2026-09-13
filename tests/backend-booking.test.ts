import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { createDemoConnectors } from "../src/connectors/demo.ts";
import type {
  CheckAvailabilityRequest,
  ConnectorResult,
  CreateProvisionalHoldRequest,
  CreateProvisionalHoldResponse,
  CheckAvailabilityResponse,
  SendEmailRequest,
  SendEmailResponse,
} from "../src/connectors/contracts.ts";
import {
  approveAndExecute,
  emailOperationKey,
  getWorkspace,
  holdOperationKey,
  reconcileExecution,
  retryFailedSteps,
  ServiceError,
} from "../src/server/booking-service.ts";
import type { BookingServiceDeps } from "../src/server/booking-service.ts";
import { seedDemoFixtures } from "../src/server/demo-fixtures.ts";
import { GatherStore } from "../src/server/sqlite-store.ts";
import { assertSameOrigin, parseApproveBody } from "../src/server/validation.ts";

// All fixtures are fictional and must stay visibly labeled as DEMO ONLY.
const START = "2030-06-12T17:00:00.000Z";
const END = "2030-06-12T23:00:00.000Z";
const EXPIRES = "2030-06-13T23:00:00.000Z";

function holdPayload(to: string[] = ["guest@example.test"]): Record<string, unknown> {
  return {
    startAt: START,
    endAt: END,
    expiresAt: EXPIRES,
    emailTo: to,
    emailSubject: "DEMO ONLY fictional offer",
    emailBody: "DEMO ONLY fictional hold for the test event.",
  };
}

function coveringSlot() {
  return {
    slotId: "slot-cover",
    startAt: "2030-06-12T00:00:00.000Z",
    endAt: "2030-06-13T00:00:00.000Z",
    available: true as const,
    sourceReferences: [{ kind: "fixture" as const, locator: "demo://test/slot", fictional: true as const }],
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

function setup(extraSeed: Parameters<typeof createDemoConnectors>[0] = {}): Setup {
  const dir = mkdtempSync(join(tmpdir(), "gather-be-"));
  const path = join(dir, "gather.sqlite");
  const store = new GatherStore(path);
  const connectors = createDemoConnectors({ calendarSlots: [coveringSlot()], ...extraSeed });
  const deps: BookingServiceDeps = {
    store,
    calendar: connectors.calendar,
    email: connectors.email,
    calendarId: "demo-calendar-001",
    ownerId: "test-owner",
  };
  const business = store.createBusiness({ name: "Fictional Test Hall", timezone: "UTC" });
  return {
    dir, path, store, deps, connectors, businessId: business.id,
    cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

function seedBooking(s: Setup, ids: { booking: string; action: string }, payload: Record<string, unknown> = holdPayload()) {
  const booking = s.store.createBooking({
    id: ids.booking,
    businessId: s.businessId,
    eventName: "Fictional test event",
    status: "pending_approval",
    startAt: START,
    endAt: END,
    sourceReferences: [{ kind: "fixture", locator: "demo://test/booking", fictional: true }],
  });
  const action = s.store.createProposedAction({
    id: ids.action,
    bookingId: booking.id,
    kind: "create_provisional_hold",
    payload,
    sourceReferences: [{ kind: "fixture", locator: "demo://test/proposal", fictional: true }],
  });
  return { booking, action };
}

function approveInput(s: Setup, actionId: string, bookingId: string) {
  const action = s.store.getProposedAction(actionId);
  return {
    bookingId,
    proposedActionId: action.id,
    proposalVersion: action.proposalVersion,
    proposalFingerprint: action.proposalFingerprint,
  };
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

test("repeated approval reuses one approval and one provider write per step", async () => {
  const s = setup();
  try {
    const { action, booking } = seedBooking(s, { booking: "b-repeat", action: "a-repeat" });
    const first = await approveAndExecute(s.deps, approveInput(s, action.id, booking.id));
    const second = await approveAndExecute(s.deps, approveInput(s, action.id, booking.id));
    assert.equal(second.approval.id, first.approval.id);
    assert.equal(second.hold.execution.id, first.hold.execution.id);
    assert.equal(second.email?.execution.id, first.email?.execution.id);
    assert.equal(s.connectors.store.listProvisionalHolds().length, 1);
    assert.equal(first.hold.execution.idempotencyKey, holdOperationKey(action.id, 1));
    assert.equal(first.email?.execution.idempotencyKey, emailOperationKey(action.id, 1));
  } finally {
    s.cleanup();
  }
});

test("changed proposal rejects stale approval; cross-booking approval is denied", async () => {
  const s = setup();
  try {
    const { action, booking } = seedBooking(s, { booking: "b-stale", action: "a-stale" });
    const other = seedBooking(s, { booking: "b-other", action: "a-other" });
    const staleInput = approveInput(s, action.id, booking.id);
    await approveAndExecute(s.deps, staleInput);
    s.store.replaceProposedAction(action.id, { kind: "create_provisional_hold", payload: { ...holdPayload(), emailSubject: "DEMO ONLY changed" }, sourceReferences: [] });
    await assertServiceError(approveAndExecute(s.deps, staleInput), "STALE_PROPOSAL");
    // Cross-booking: valid fingerprint of action A presented for booking B.
    const cross = { ...approveInput(s, other.action.id, other.booking.id), bookingId: booking.id };
    await assertServiceError(approveAndExecute(s.deps, cross), "CROSS_BOOKING");
  } finally {
    s.cleanup();
  }
});

test("unavailable date blocks the hold and writes nothing provider-side", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gather-be-unavail-"));
  const path = join(dir, "gather.sqlite");
  const store = new GatherStore(path);
  const connectors = createDemoConnectors({
    calendarSlots: [{
      slotId: "slot-blocked",
      startAt: "2030-06-12T00:00:00.000Z",
      endAt: "2030-06-13T00:00:00.000Z",
      available: false,
      reason: "Demo fixture marks this date as unavailable.",
      sourceReferences: [{ kind: "fixture", locator: "demo://test/blocked", fictional: true }],
    }],
  });
  const deps: BookingServiceDeps = { store, calendar: connectors.calendar, email: connectors.email, ownerId: "test-owner" };
  try {
    const business = store.createBusiness({ name: "Fictional Hall", timezone: "UTC" });
    const booking = store.createBooking({ id: "b-blocked", businessId: business.id, eventName: "Fictional blocked event", status: "pending_approval", sourceReferences: [] });
    const action = store.createProposedAction({ id: "a-blocked", bookingId: booking.id, kind: "create_provisional_hold", payload: holdPayload(), sourceReferences: [] });
    await assertServiceError(
      approveAndExecute(deps, { bookingId: booking.id, proposedActionId: action.id, proposalVersion: 1, proposalFingerprint: action.proposalFingerprint }),
      "SLOT_UNAVAILABLE",
    );
    assert.equal(connectors.store.listProvisionalHolds().length, 0);
    assert.equal(store.listAllActionExecutions().length, 0);
    assert.equal(store.getBooking(booking.id).status, "failed");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hold success with email failure never resends the hold on retry", async () => {
  const s = setup();
  try {
    const { action, booking } = seedBooking(s, { booking: "b-emailfail", action: "a-emailfail" });
    let sends = 0;
    const realSend = s.deps.email.sendEmail.bind(s.deps.email);
    s.deps.email.sendEmail = async (req: SendEmailRequest): Promise<ConnectorResult<SendEmailResponse>> => {
      sends += 1;
      if (sends === 1) {
        return { status: "failed", metadata: { operationKey: req.operationKey, mode: { mode: "demo", label: "DEMO ONLY", fictional: true }, simulated: true, sourceReferences: [] }, error: { kind: "transport_error", message: "fixture email transport failure", retryable: true } };
      }
      return realSend(req);
    };
    const first = await approveAndExecute(s.deps, approveInput(s, action.id, booking.id));
    assert.equal(first.hold.execution.status, "succeeded");
    assert.equal(first.email?.execution.status, "failed");
    assert.equal(s.connectors.store.listProvisionalHolds().length, 1);
    const retried = await retryFailedSteps(s.deps, action.id);
    assert.equal(retried.hold.execution.id, first.hold.execution.id);
    assert.equal(retried.email?.execution.status, "succeeded");
    assert.equal(retried.resentSucceededStep, false);
    assert.equal(s.connectors.store.listProvisionalHolds().length, 1);
    assert.equal(s.store.getBooking(booking.id).status, "provisional_hold");
    assert.notEqual(s.store.getBooking(booking.id).status, "confirmed");
  } finally {
    s.cleanup();
  }
});

test("timeout-after-success reconciles without duplicating provider writes", async () => {
  const actionId = "a-timeout";
  const holdKey = holdOperationKey(actionId, 1);
  const s = setup({ timeoutAfterSuccessOperationKeys: [holdKey] });
  try {
    const { action, booking } = seedBooking(s, { booking: "b-timeout", action: actionId });
    const first = await approveAndExecute(s.deps, approveInput(s, action.id, booking.id));
    // Service auto-reconciles the uncertain hold against the completed demo write.
    assert.equal(first.hold.execution.status, "succeeded");
    assert.equal(first.hold.execution.reconciledAt !== undefined || first.hold.execution.completedAt !== undefined, true);
    const retry = await approveAndExecute(s.deps, approveInput(s, action.id, booking.id));
    assert.equal(retry.hold.execution.id, first.hold.execution.id);
    assert.equal(s.connectors.store.listProvisionalHolds().length, 1);
    const receipt = first.hold.execution.result as { hold: { holdId: string } };
    const retryReceipt = retry.hold.execution.result as { hold: { holdId: string } };
    assert.equal(retryReceipt.hold.holdId, receipt.hold.holdId);
  } finally {
    s.cleanup();
  }
});

test("persisted uncertainty refuses retry until reconciliation", async () => {
  const s = setup();
  try {
    const { action, booking } = seedBooking(s, { booking: "b-uncertain", action: "a-uncertain" });
    let reconcileCalls = 0;
    const realCreate = s.deps.calendar.createProvisionalHold.bind(s.deps.calendar);
    const realReconcile = s.deps.calendar.reconcileProvisionalHold.bind(s.deps.calendar);
    s.deps.calendar.createProvisionalHold = async (req: CreateProvisionalHoldRequest): Promise<ConnectorResult<CreateProvisionalHoldResponse>> => {
      await realCreate(req); // provider-side write completes…
      // …but the response is lost, so the caller only sees uncertainty.
      return {
        status: "uncertain",
        metadata: { operationKey: req.operationKey, mode: { mode: "demo", label: "DEMO ONLY", fictional: true }, simulated: true, sourceReferences: [] },
        error: { kind: "timeout_after_success", message: "fixture response lost after success", retryable: false },
        reconciliationRequired: true,
      };
    };
    s.deps.calendar.reconcileProvisionalHold = async (req: { operationKey: string }): Promise<ConnectorResult<CreateProvisionalHoldResponse>> => {
      reconcileCalls += 1;
      if (reconcileCalls === 1) {
        return { status: "failed", metadata: { operationKey: req.operationKey, mode: { mode: "demo", label: "DEMO ONLY", fictional: true }, simulated: true, sourceReferences: [] }, error: { kind: "not_found", message: "fixture reconcile not yet visible", retryable: true } };
      }
      return realReconcile(req);
    };
    const first = await approveAndExecute(s.deps, approveInput(s, action.id, booking.id));
    assert.equal(first.hold.execution.status, "uncertain");
    assert.equal(first.email, null);
    assert.equal(s.store.getBooking(booking.id).status, "uncertain");
    await assertServiceError(retryFailedSteps(s.deps, action.id), "RECONCILE_REQUIRED");
    const reconciled = await reconcileExecution(s.deps, first.hold.execution.id);
    assert.equal(reconciled.execution.status, "succeeded");
    assert.equal(s.store.getBooking(booking.id).status, "provisional_hold");
    const retried = await retryFailedSteps(s.deps, action.id);
    assert.equal(retried.hold.execution.id, first.hold.execution.id);
    assert.equal(s.connectors.store.listProvisionalHolds().length, 1);
  } finally {
    s.cleanup();
  }
});

test("revoked access surfaces a reconnectable error and parks the booking", async () => {
  const s = setup();
  try {
    const { action, booking } = seedBooking(s, { booking: "b-revoked", action: "a-revoked" });
    s.deps.calendar.checkAvailability = async (_req: CheckAvailabilityRequest): Promise<ConnectorResult<CheckAvailabilityResponse>> => ({
      status: "failed",
      metadata: { operationKey: "revoked", mode: { mode: "demo", label: "DEMO ONLY", fictional: true }, simulated: true, sourceReferences: [] },
      error: { kind: "access_revoked", message: "Demo calendar access was revoked", retryable: false },
    });
    const error = await assertServiceError(approveAndExecute(s.deps, approveInput(s, action.id, booking.id)), "ACCESS_REVOKED");
    assert.equal(error.retryable, false);
    assert.equal(s.store.getBooking(booking.id).status, "uncertain");
    assert.equal(s.connectors.store.listProvisionalHolds().length, 0);
  } finally {
    s.cleanup();
  }
});

test("restart reuses durable approvals and receipts with fresh adapters and no new writes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gather-be-restart-"));
  const path = join(dir, "gather.sqlite");
  const slot = coveringSlot();
  const firstStore = new GatherStore(path);
  const firstConnectors = createDemoConnectors({ calendarSlots: [slot] });
  const firstDeps: BookingServiceDeps = { store: firstStore, calendar: firstConnectors.calendar, email: firstConnectors.email, ownerId: "test-owner" };
  let holdId = "";
  let messageId = "";
  let approvalId = "";
  try {
    const business = firstStore.createBusiness({ name: "Fictional Hall", timezone: "UTC" });
    const booking = firstStore.createBooking({ id: "b-restart", businessId: business.id, eventName: "Fictional restart event", status: "pending_approval", sourceReferences: [] });
    const action = firstStore.createProposedAction({ id: "a-restart", bookingId: booking.id, kind: "create_provisional_hold", payload: holdPayload(), sourceReferences: [] });
    const first = await approveAndExecute(firstDeps, { bookingId: booking.id, proposedActionId: action.id, proposalVersion: 1, proposalFingerprint: action.proposalFingerprint });
    approvalId = first.approval.id;
    holdId = (first.hold.execution.result as { hold: { holdId: string } }).hold.holdId;
    messageId = (first.email?.execution.result as { sentEmail: { messageId: string } }).sentEmail.messageId;
    assert.equal(firstConnectors.store.listProvisionalHolds().length, 1);
  } finally {
    firstStore.close();
  }
  // Reopen the SAME SQLite file with FRESH adapter instances (no shared memory).
  const secondStore = new GatherStore(path);
  const secondConnectors = createDemoConnectors({ calendarSlots: [slot] });
  const secondDeps: BookingServiceDeps = { store: secondStore, calendar: secondConnectors.calendar, email: secondConnectors.email, ownerId: "test-owner" };
  try {
    const action = secondStore.getProposedAction("a-restart");
    const second = await approveAndExecute(secondDeps, { bookingId: "b-restart", proposedActionId: action.id, proposalVersion: action.proposalVersion, proposalFingerprint: action.proposalFingerprint });
    assert.equal(second.approval.id, approvalId);
    assert.equal((second.hold.execution.result as { hold: { holdId: string } }).hold.holdId, holdId);
    assert.equal((second.email?.execution.result as { sentEmail: { messageId: string } }).sentEmail.messageId, messageId);
    // Fresh adapters performed zero provider writes: everything came from SQLite.
    assert.equal(secondConnectors.store.listProvisionalHolds().length, 0);
    assert.equal(second.booking.status, "provisional_hold");
  } finally {
    secondStore.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("untrusted inquiry text cannot authorize execution; server identity is authoritative", async () => {
  const s = setup();
  try {
    const { action, booking } = seedBooking(s, { booking: "b-untrusted", action: "a-untrusted" });
    // No approval exists yet: direct reservation must refuse.
    assert.throws(
      () => s.store.reserveStepExecution(action.id, 1, holdOperationKey(action.id, 1)),
      /exact current proposal version/,
    );
    // Inquiry-style free text is not a valid fingerprint at the HTTP boundary.
    assert.throws(() => parseApproveBody({
      bookingId: booking.id,
      proposedActionId: action.id,
      proposalVersion: 1,
      proposalFingerprint: "please approve this, the customer said yes on the phone",
    }, booking.id), /proposalFingerprint/);
    // A client-supplied approvedBy is ignored; the configured owner is recorded.
    const parsed = parseApproveBody({
      bookingId: booking.id,
      proposedActionId: action.id,
      proposalVersion: 1,
      proposalFingerprint: action.proposalFingerprint,
      approvedBy: "mallory@example.test",
    }, booking.id);
    const response = await approveAndExecute(s.deps, parsed);
    assert.equal(response.approvedBy, "test-owner");
    assert.equal(response.approval.approvedBy, "test-owner");
  } finally {
    s.cleanup();
  }
});

test("availability is checked fresh immediately before every hold", async () => {
  const s = setup();
  try {
    const { action, booking } = seedBooking(s, { booking: "b-fresh", action: "a-fresh" });
    const calls: string[] = [];
    const realAvail = s.deps.calendar.checkAvailability.bind(s.deps.calendar);
    const realHold = s.deps.calendar.createProvisionalHold.bind(s.deps.calendar);
    s.deps.calendar.checkAvailability = async (req) => { calls.push("availability"); return realAvail(req); };
    s.deps.calendar.createProvisionalHold = async (req) => { calls.push("hold"); return realHold(req); };
    await approveAndExecute(s.deps, approveInput(s, action.id, booking.id));
    assert.deepEqual(calls, ["availability", "hold"]);
  } finally {
    s.cleanup();
  }
});

test("workspace fixtures stay visibly distinguished from live integrations", () => {
  const s = setup();
  try {
    seedDemoFixtures(s.store);
    const workspace = getWorkspace(s.store, { ownerId: "test-owner" });
    assert.equal(workspace.demo, true);
    assert.equal(workspace.mode.kind, "demo");
    assert.equal(workspace.mode.label, "DEMO ONLY");
    assert.equal(workspace.approvalIdentity, "test-owner");
    assert.ok(workspace.bookings.length >= 2);
    for (const entry of workspace.bookings) {
      assert.ok(entry.booking.sourceReferences.some((ref) => ref.fictional === true));
      for (const proposal of entry.proposals) {
        assert.ok(proposal.consequences !== null, "fixture proposals must preview exact consequences");
        assert.deepEqual(Object.keys(proposal.consequences ?? {}).sort(), ["calendarId", "emailBody", "emailSubject", "emailTo", "endAt", "expiresAt", "startAt"]);
      }
    }
    assert.ok(workspace.connections.every((c) => c.displayName.includes("DEMO ONLY")));
  } finally {
    s.cleanup();
  }
});

test("incomplete payloads are rejected so the fingerprint always covers execution", async () => {
  const s = setup();
  try {
    const { action, booking } = seedBooking(s, { booking: "b-incomplete", action: "a-incomplete" }, { startAt: START, endAt: END });
    const error = await assertServiceError(approveAndExecute(s.deps, approveInput(s, action.id, booking.id)), "INVALID_REQUEST");
    assert.match(error.message, /explicit/);
    const workspace = getWorkspace(s.store, { ownerId: "test-owner" });
    const entry = workspace.bookings.find((item) => item.booking.id === booking.id);
    assert.equal(entry?.proposals[0]?.consequences, null);
    assert.ok((entry?.proposals[0]?.consequencesError ?? "").length > 0);
  } finally {
    s.cleanup();
  }
});

test("cross-origin mutations are denied while same-origin and non-browser calls pass", () => {
  assert.doesNotThrow(() => assertSameOrigin({ host: "localhost:3000" }));
  assert.doesNotThrow(() => assertSameOrigin({ host: "localhost:3000", origin: "http://localhost:3000" }));
  assert.throws(() => assertSameOrigin({ host: "localhost:3000", origin: "https://evil.example" }), /Cross-origin/);
});
