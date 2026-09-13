import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import type {
  CalendarAvailabilityReader,
  CheckAvailabilityRequest,
  CheckAvailabilityResponse,
  ConnectorMetadata,
  ConnectorResult,
  CreateProvisionalHoldRequest,
  CreateProvisionalHoldResponse,
  EmailSender,
  OperationRequest,
  SendEmailRequest,
  SendEmailResponse,
  SourceReference,
} from "../src/connectors/contracts.ts";
import {
  approveAndExecute,
  emailOperationKey,
  getWorkspace,
  holdOperationKey,
  isLiveStepProof,
  reconcileExecution,
  retryFailedSteps,
  stepReceiptDetail,
  ServiceError,
} from "../src/server/booking-service.ts";
import type { BookingServiceDeps } from "../src/server/booking-service.ts";
import { confirmBooking } from "../src/server/booking-delivery/service.ts";
import { DeliveryStore } from "../src/server/booking-delivery/store.ts";
import { GatherStore } from "../src/server/sqlite-store.ts";
import { KnowledgeService } from "../src/knowledge/index.ts";
import {
  buildBookingOffer,
  decideOperator,
  persistPreparedProposal,
} from "../src/server/business-operator/index.ts";
import type { OperatorDeps } from "../src/server/business-operator/index.ts";
import { DurableDemoCalendar, DurableDemoEmail } from "../src/server/durable-demo-connectors.ts";
import { createDemoConnectors } from "../src/connectors/demo.ts";
import { adaptWorkspace } from "../src/host/adapter.ts";
import type { BookingServiceDeps as OperatorBookingDeps } from "../src/server/booking-service.ts";

// All fixtures are fictional and stay labeled by their sources.
const START = "2030-06-12T17:00:00.000Z";
const END = "2030-06-12T23:00:00.000Z";
const EXPIRES = "2030-06-13T23:00:00.000Z";
const CAL = "demo-calendar-001";
const NOW = "2030-01-01T00:00:00.000Z";
const OWNER = "test-owner";

const SRC = (locator: string) => [{ kind: "document" as const, locator, label: locator, fictional: true as const }];
const LIVE_SRC: SourceReference[] = [{ kind: "calendar", locator: "live-cal://slot-1" }];

function holdPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    startAt: START,
    endAt: END,
    expiresAt: EXPIRES,
    calendarId: CAL,
    emailTo: ["guest@example.test"],
    emailSubject: "DEMO ONLY fictional offer",
    emailBody: "DEMO ONLY fictional hold for the test event.",
    ...overrides,
  };
}

function demoDeps(store: GatherStore, clock = NOW): BookingServiceDeps {
  const connectors = createDemoConnectors({
    calendarSlots: [{
      slotId: "demo-cover", calendarId: CAL,
      startAt: "2030-06-12T00:00:00.000Z", endAt: "2030-06-13T00:00:00.000Z", available: true,
      sourceReferences: [{ kind: "fixture", locator: "demo://cal/cover", fictional: true }],
    }],
  });
  return {
    store,
    calendar: new DurableDemoCalendar(store, connectors.calendar, () => Date.parse(clock)),
    email: new DurableDemoEmail(store, connectors.email),
    ownerId: OWNER,
    now: () => clock,
  };
}

function liveMeta(operationKey: string): ConnectorMetadata {
  return {
    operationKey,
    mode: { mode: "live", label: "LIVE", fictional: false },
    simulated: false,
    sourceReferences: LIVE_SRC,
  };
}

/** Scripted live-shaped connectors (tests only): live metadata, non-fictional provenance. */
function liveConnectors(): { calendar: CalendarAvailabilityReader & { createProvisionalHold: unknown; reconcileProvisionalHold: unknown }; email: EmailSender } {
  const slots = [{
    slotId: "live-cover", calendarId: CAL,
    startAt: "2030-06-12T00:00:00.000Z", endAt: "2030-06-13T00:00:00.000Z", available: true,
    sourceReferences: LIVE_SRC,
  }];
  const calendar = {
    checkAvailability: async (request: CheckAvailabilityRequest): Promise<ConnectorResult<CheckAvailabilityResponse>> => ({
      status: "succeeded", metadata: liveMeta(request.operationKey), data: { slots, provenance: LIVE_SRC },
    }),
    createProvisionalHold: async (request: CreateProvisionalHoldRequest): Promise<ConnectorResult<CreateProvisionalHoldResponse>> => ({
      status: "succeeded",
      metadata: liveMeta(request.operationKey),
      data: {
        hold: {
          holdId: `live-hold-${request.operationKey}`, operationKey: request.operationKey, bookingId: request.bookingId,
          calendarId: request.calendarId, startAt: request.startAt, endAt: request.endAt, expiresAt: request.expiresAt,
          status: "provisional_hold", createdAt: NOW, sourceReferences: LIVE_SRC,
        },
        provenance: LIVE_SRC,
      },
    }),
    reconcileProvisionalHold: async (request: OperationRequest): Promise<ConnectorResult<CreateProvisionalHoldResponse>> => ({
      status: "failed",
      metadata: liveMeta(request.operationKey),
      error: { kind: "not_found", message: "no live record", retryable: false },
    }),
  };
  const email: EmailSender = {
    sendEmail: async (request: SendEmailRequest): Promise<ConnectorResult<SendEmailResponse>> => ({
      status: "succeeded",
      metadata: liveMeta(request.operationKey),
      data: {
        sentEmail: {
          messageId: `live-msg-${request.operationKey}`, operationKey: request.operationKey,
          to: request.to, cc: [], subject: request.subject, body: request.body, sentAt: NOW, sourceReferences: LIVE_SRC,
        },
        provenance: LIVE_SRC,
      },
    }),
    reconcileSentEmail: async (request: OperationRequest): Promise<ConnectorResult<SendEmailResponse>> => ({
      status: "failed",
      metadata: liveMeta(request.operationKey),
      error: { kind: "not_found", message: "no live record", retryable: false },
    }),
  };
  return { calendar: calendar as never, email };
}

function world() {
  const dir = mkdtempSync(join(tmpdir(), "gather-pauth-"));
  const store = new GatherStore(join(dir, "gather.sqlite"));
  const businessId = store.createBusiness({ name: "Fictional Hall", timezone: "UTC" }).id;
  return { dir, store, businessId, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function seedBooking(store: GatherStore, businessId: string, bookingId: string, actionId: string, payload: Record<string, unknown> = holdPayload()) {
  const booking = store.createBooking({
    id: bookingId, businessId, eventName: "Fictional test event", status: "pending_approval",
    startAt: START, endAt: END, sourceReferences: SRC("demo://test/booking"),
  });
  const action = store.createProposedAction({
    id: actionId, bookingId: booking.id, kind: "create_provisional_hold", payload, sourceReferences: SRC("demo://test/proposal"),
  });
  return { booking, action };
}

function approveIdentity(store: GatherStore, actionId: string, bookingId: string) {
  const action = store.getProposedAction(actionId);
  return {
    bookingId, proposedActionId: action.id,
    proposalVersion: action.proposalVersion, proposalFingerprint: action.proposalFingerprint,
  };
}

async function assertServiceError(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ServiceError, `expected ServiceError, got ${error}`);
    assert.equal(error.code, code);
    return;
  }
  assert.fail(`expected ServiceError ${code}`);
}

function adaptedProposal(store: GatherStore, bookingId: string) {
  const workspace = getWorkspace(store, { ownerId: OWNER });
  const adapted = adaptWorkspace(workspace as unknown as Parameters<typeof adaptWorkspace>[0]);
  const booking = adapted.bookings.find((item) => item.id === bookingId);
  assert.ok(booking, "booking must be adapted");
  return booking.detail.proposal;
}

// ---------- Authoritative current proposal: server, backend, and adapter agree ----------

test("actual server output through the adapter shows the durable current proposal", async () => {
  const w = world();
  try {
    const deps = demoDeps(w.store);
    const { booking, action } = seedBooking(w.store, w.businessId, "b-current-1", "a-current-1");
    assert.equal(w.store.getCurrentProposalAction(booking.id)?.id, action.id);
    const proposal = adaptedProposal(w.store, booking.id);
    assert.equal(proposal.id, action.id);
    const response = await approveAndExecute(deps, approveIdentity(w.store, action.id, booking.id));
    assert.equal(response.hold.execution.status, "succeeded");
    assert.equal(response.email?.execution.status, "succeeded");
  } finally {
    w.cleanup();
  }
});

test("old v2 versus new v1: the newer action is current everywhere, old approval is stale", async () => {
  const w = world();
  try {
    const deps = demoDeps(w.store);
    const { booking, action: oldAction } = seedBooking(w.store, w.businessId, "b-oldv2", "a-oldv2");
    w.store.replaceProposedAction(oldAction.id, {
      kind: "create_provisional_hold", payload: holdPayload({ emailSubject: "v2 subject" }), sourceReferences: SRC("demo://test/v2"),
    });
    assert.equal(w.store.getProposedAction(oldAction.id).proposalVersion, 2);
    const fresh = w.store.createProposedAction({
      id: "a-newv1", bookingId: booking.id, kind: "create_provisional_hold",
      payload: holdPayload({ emailSubject: "new terms" }), sourceReferences: SRC("demo://test/new"),
    });
    // The old action is superseded even though its in-row version is higher.
    assert.equal(w.store.getProposedAction(oldAction.id).status, "superseded");
    assert.equal(w.store.getCurrentProposalAction(booking.id)?.id, fresh.id);
    // The adapter shows the newer v1, never the old v2.
    const proposal = adaptedProposal(w.store, booking.id);
    assert.equal(proposal.id, fresh.id);
    assert.equal(proposal.version, 1);
    // Approving the old v2 identity is stale; the current v1 approves.
    await assertServiceError(approveAndExecute(deps, approveIdentity(w.store, oldAction.id, booking.id)), "STALE_PROPOSAL");
    const response = await approveAndExecute(deps, approveIdentity(w.store, fresh.id, booking.id));
    assert.equal(response.hold.execution.status, "succeeded");
  } finally {
    w.cleanup();
  }
});

test("equal timestamps never decide currency: the explicit pointer wins over UUID order", async () => {
  const w = world();
  try {
    const deps = demoDeps(w.store);
    const booking = w.store.createBooking({
      id: "b-tie", businessId: w.businessId, eventName: "E", status: "pending_approval", sourceReferences: SRC("demo://t"),
    });
    // Lexicographically larger id first, so any UUID-order tiebreak would
    // prefer it; the durable pointer must still select the newer action.
    w.store.createProposedAction({
      id: "zz-old", bookingId: booking.id, kind: "create_provisional_hold",
      payload: holdPayload(), sourceReferences: SRC("demo://t/old"),
    });
    w.store.createProposedAction({
      id: "aa-new", bookingId: booking.id, kind: "create_provisional_hold",
      payload: holdPayload({ emailSubject: "newer" }), sourceReferences: SRC("demo://t/new"),
    });
    const stamp = "2030-02-02T02:02:02.000Z";
    w.store.db.prepare("UPDATE proposed_actions SET created_at = $stamp WHERE booking_id = $bookingId").run({ $stamp: stamp, $bookingId: booking.id });
    assert.equal(w.store.getCurrentProposalAction(booking.id)?.id, "aa-new");
    assert.equal(adaptedProposal(w.store, booking.id).id, "aa-new");
    await assertServiceError(approveAndExecute(deps, approveIdentity(w.store, "zz-old", booking.id)), "STALE_PROPOSAL");
  } finally {
    w.cleanup();
  }
});

// ---------- Operator persist: replay reuse without resurrection ----------

function operatorWorld(w: { store: GatherStore; businessId: string }): { deps: OperatorDeps; bookingDeps: OperatorBookingDeps } {
  const bookingDeps: OperatorBookingDeps = demoDeps(w.store);
  const readerCalls: string[] = [];
  const availability = {
    checkAvailability: async (request: { operationKey: string; calendarId: string; startAt: string; endAt: string }) => {
      readerCalls.push(request.operationKey);
      const provenance = [{ kind: "calendar" as const, locator: `fake-calendar://${request.calendarId}`, fictional: true as const }];
      return {
        status: "succeeded",
        metadata: { operationKey: request.operationKey, mode: { mode: "demo" as const, label: "DEMO ONLY", fictional: true as const }, simulated: true, sourceReferences: provenance },
        data: {
          slots: [{
            slotId: "slot-cover", calendarId: request.calendarId,
            startAt: "2030-06-12T00:00:00.000Z", endAt: "2030-06-13T00:00:00.000Z",
            available: true, sourceReferences: provenance,
          }],
          provenance,
        },
      };
    },
  } as unknown as CalendarAvailabilityReader;
  void readerCalls;
  return { deps: { store: w.store, booking: bookingDeps, ownerId: OWNER, availability }, bookingDeps };
}

function confirmOperatorFacts(w: { store: GatherStore; businessId: string }): void {
  const svc = new KnowledgeService(w.store);
  const facts: { key: string; subjectId?: string; value: Record<string, unknown> }[] = [
    { key: "space", subjectId: "hall", value: { spaceId: "hall", name: "Hall", capacityMin: 10, capacityMax: 100 } },
    { key: "price_line", subjectId: "dinner", value: { lineId: "dinner", label: "Dinner", pricingBasis: "per_guest", unitCents: 10000 } },
    { key: "pricing_bounds", value: { currency: "USD", floorCents: 100000, costsComplete: true, depositBps: 2000 } },
    { key: "service", subjectId: "dinner", value: { serviceId: "dinner", label: "Dinner", available: true } },
  ];
  for (const fact of facts) {
    const candidate = svc.intakeCandidate({
      businessId: w.businessId, ...fact, confidence: "probable", sourceReferences: SRC("fixture://contract/" + fact.key),
    });
    svc.confirmCandidate({ businessId: w.businessId, actor: { kind: "owner", id: OWNER }, candidateId: candidate.id });
  }
}

function operatorInquiry(w: { businessId: string }): Record<string, unknown> {
  return {
    inquiryId: "inq-pauth", businessId: w.businessId, eventType: "dinner",
    startAt: START, endAt: END, guestCount: 40, serviceRequirements: ["dinner"],
    sourceReferences: SRC("fixture://contract/inq"),
  };
}

test("operator replay reuses the current row; replay of a superseded fingerprint never resurrects it", async () => {
  const w = world();
  try {
    const { deps } = operatorWorld(w);
    confirmOperatorFacts(w);
    const booking = w.store.createBooking({
      businessId: w.businessId, eventName: "E", status: "pending_approval", sourceReferences: SRC("demo://op/b"),
    });
    const email = { to: ["guest@example.test"], subject: "Offer", body: "Hold." };
    const firstBuilt = await buildBookingOffer(deps, { bookingId: booking.id, inquiry: operatorInquiry(w), calendarId: CAL } as never);
    const first = persistPreparedProposal(deps, firstBuilt, { email, expiresAt: EXPIRES });
    assert.ok(!("missing" in first));
    if ("missing" in first) throw new Error("unreachable");
    const replayed = persistPreparedProposal(deps, firstBuilt, { email, expiresAt: EXPIRES });
    assert.ok(!("missing" in replayed));
    if ("missing" in replayed) throw new Error("unreachable");
    assert.equal(replayed.action.id, first.action.id);
    assert.equal(replayed.reused, true);
    assert.equal(w.store.getCurrentProposalAction(booking.id)?.id, first.action.id);

    // A genuine price change publishes a new current proposal.
    decideOperator(deps, "correct", {
      businessId: w.businessId, key: "price_line", subjectId: "dinner", expectedRevision: 1,
      value: { lineId: "dinner", label: "Dinner", pricingBasis: "per_guest", unitCents: 12000 },
    });
    const secondBuilt = await buildBookingOffer(deps, { bookingId: booking.id, inquiry: operatorInquiry(w), calendarId: CAL } as never);
    const second = persistPreparedProposal(deps, secondBuilt, { email, expiresAt: EXPIRES });
    assert.ok(!("missing" in second));
    if ("missing" in second) throw new Error("unreachable");
    assert.notEqual(second.action.id, first.action.id);
    assert.equal(second.reused, false);
    assert.equal(w.store.getCurrentProposalAction(booking.id)?.id, second.action.id);

    // Re-persisting the ORIGINAL built offer after the correction is stale
    // at the snapshot layer: its knowledge backing moved, so a rebuild is
    // required instead of silently reusing displaced terms.
    await assertServiceError(
      (async () => persistPreparedProposal(deps, firstBuilt, { email, expiresAt: EXPIRES }))(),
      "STALE_PROPOSAL",
    );
    assert.equal(w.store.getCurrentProposalAction(booking.id)?.id, second.action.id);
    assert.equal(adaptedProposal(w.store, booking.id).id, second.action.id);
  } finally {
    w.cleanup();
  }
});

test("store republish of a superseded fingerprint publishes afresh without reviving the old row", () => {
  const w = world();
  try {
    const booking = w.store.createBooking({
      businessId: w.businessId, eventName: "E", status: "pending_approval", sourceReferences: SRC("demo://s/b"),
    });
    const refs = SRC("demo://s/p");
    const first = w.store.publishProposalAction({
      bookingId: booking.id, kind: "create_provisional_hold", payload: holdPayload(), sourceReferences: refs, fingerprint: "fp-first",
    });
    assert.equal(first.reused, false);
    const second = w.store.publishProposalAction({
      bookingId: booking.id, kind: "create_provisional_hold",
      payload: holdPayload({ emailSubject: "new" }), sourceReferences: refs, fingerprint: "fp-second",
    });
    assert.equal(second.reused, false);
    assert.notEqual(second.action.id, first.action.id);
    assert.equal(w.store.getCurrentProposalAction(booking.id)?.id, second.action.id);
    // Same-fingerprint replay against the superseded row never revives that
    // row: it publishes afresh as a new current row (knowledge changed away
    // and back — a pure replay would have matched the current row). The old
    // row stays superseded with its approvals dead.
    const replayed = w.store.publishProposalAction({
      bookingId: booking.id, kind: "create_provisional_hold", payload: holdPayload(), sourceReferences: refs, fingerprint: "fp-first",
    });
    assert.equal(replayed.reused, false);
    assert.notEqual(replayed.action.id, first.action.id);
    assert.equal(w.store.getProposedAction(first.action.id).status, "superseded");
    assert.equal(w.store.getCurrentProposalAction(booking.id)?.id, replayed.action.id);
    // A further identical replay now matches the current row and reuses it.
    const rereplayed = w.store.publishProposalAction({
      bookingId: booking.id, kind: "create_provisional_hold", payload: holdPayload(), sourceReferences: refs, fingerprint: "fp-first",
    });
    assert.equal(rereplayed.action.id, replayed.action.id);
    assert.equal(rereplayed.reused, true);
    assert.equal(w.store.listProposedActionsForBooking(booking.id).length, 3);
  } finally {
    w.cleanup();
  }
});

// ---------- Stale gates after supersession ----------

test("a live approval dies with supersession: approve, retry, and reconcile all refuse the old action", async () => {
  const w = world();
  try {
    const deps = demoDeps(w.store);
    const { booking, action } = seedBooking(w.store, w.businessId, "b-supersede", "a-supersede");
    w.store.approveProposedAction(action.id, OWNER);
    // Make the hold uncertain while the approval is still live.
    const key = holdOperationKey(action.id, 1);
    const reservation = w.store.reserveStepExecution(action.id, 1, key, { claimToken: "test-claim", leaseMs: 120_000, nowMs: Date.now() });
    w.store.markExecutionUncertain(reservation.execution.id, "lost response", { claimToken: "test-claim" });
    // A genuinely new proposal supersedes the old action and kills its approval.
    const fresh = w.store.createProposedAction({
      id: "a-supersede-2", bookingId: booking.id, kind: "create_provisional_hold",
      payload: holdPayload({ emailSubject: "new terms" }), sourceReferences: SRC("demo://test/new"),
    });
    assert.equal(w.store.getCurrentProposalAction(booking.id)?.id, fresh.id);
    const liveApprovals = w.store.listApprovals(action.id).filter((item) => item.status === "approved");
    assert.equal(liveApprovals.length, 0);
    await assertServiceError(approveAndExecute(deps, approveIdentity(w.store, action.id, booking.id)), "STALE_PROPOSAL");
    await assertServiceError(retryFailedSteps(deps, action.id), "STALE_PROPOSAL");
    await assertServiceError(reconcileExecution(deps, reservation.execution.id), "STALE_PROPOSAL");
  } finally {
    w.cleanup();
  }
});

test("a proposal published mid-approval halts after the await, preserving observed evidence and parking the booking", async () => {
  const w = world();
  try {
    const inner = createDemoConnectors({
      calendarSlots: [{
        slotId: "demo-cover", calendarId: CAL,
        startAt: "2030-06-12T00:00:00.000Z", endAt: "2030-06-13T00:00:00.000Z", available: true,
        sourceReferences: [{ kind: "fixture", locator: "demo://cal/cover", fictional: true }],
      }],
    });
    const { booking, action } = seedBooking(w.store, w.businessId, "b-midflight", "a-midflight");
    // The provider call publishes a newer proposal before succeeding: the
    // approval that was live at reserve time is dead by completion time.
    // Prototype delegation keeps the demo connector's methods intact.
    const racingCalendar = Object.assign(Object.create(Object.getPrototypeOf(inner.calendar)), inner.calendar, {
      createProvisionalHold: async (request: CreateProvisionalHoldRequest) => {
        w.store.createProposedAction({
          id: "a-midflight-2", bookingId: booking.id, kind: "create_provisional_hold",
          payload: holdPayload({ emailSubject: "superseding terms" }), sourceReferences: SRC("demo://test/race"),
        });
        return inner.calendar.createProvisionalHold(request);
      },
    });
    const deps: BookingServiceDeps = {
      store: w.store,
      calendar: new DurableDemoCalendar(w.store, racingCalendar as never, () => Date.parse(NOW)),
      email: new DurableDemoEmail(w.store, inner.email),
      ownerId: OWNER,
      now: () => NOW,
    };
    await assertServiceError(approveAndExecute(deps, approveIdentity(w.store, action.id, booking.id)), "STALE_PROPOSAL");
    // The observed provider write is preserved as versioned history on the
    // old action (never rewritten, never leaked to the new proposal), while
    // the pipeline halts before the email step and parks the booking.
    const execution = w.store.getExecutionByIdempotencyKey(holdOperationKey(action.id, 1));
    assert.equal(execution?.status, "succeeded");
    assert.equal(w.store.getExecutionByIdempotencyKey(emailOperationKey(action.id, 1)), undefined);
    assert.equal(w.store.getBooking(booking.id).status, "uncertain");
    assert.equal(w.store.getCurrentProposalAction(booking.id)?.id, "a-midflight-2");
  } finally {
    w.cleanup();
  }
});

test("confirmation binds only the durable current proposal, never a superseded action", async () => {
  const w = world();
  try {
    const { booking, action } = seedBooking(w.store, w.businessId, "b-confirm", "a-confirm");
    w.store.approveProposedAction(action.id, OWNER);
    w.store.createProposedAction({
      id: "a-confirm-2", bookingId: booking.id, kind: "create_provisional_hold",
      payload: holdPayload({ emailSubject: "newer" }), sourceReferences: SRC("demo://test/new"),
    });
    const delivery = new DeliveryStore(w.store.db);
    await assertServiceError(
      confirmBooking(
        { store: w.store, delivery, ownerId: OWNER, now: () => NOW },
        {
          bookingId: booking.id, proposedActionId: action.id,
          proposalVersion: action.proposalVersion, proposalFingerprint: action.proposalFingerprint,
          confirmKey: "confirm-superseded",
        },
      ),
      "STALE_PROPOSAL",
    );
  } finally {
    w.cleanup();
  }
});

// ---------- Receipt provenance honesty ----------

test("live-shaped connector results keep live proof; demo and unknown proofs fail closed to demo", async () => {
  const w = world();
  try {
    const { calendar, email } = liveConnectors();
    const deps: BookingServiceDeps = { store: w.store, calendar: calendar as never, email, ownerId: OWNER, now: () => NOW };
    const { booking, action } = seedBooking(w.store, w.businessId, "b-liveproof", "a-liveproof");
    const response = await approveAndExecute(deps, approveIdentity(w.store, action.id, booking.id));
    assert.equal(response.hold.execution.status, "succeeded");
    // Live proof is preserved on the stored result and the receipt reads live.
    assert.equal(response.hold.demo, false);
    assert.equal(response.email?.demo, false);
    assert.ok(!response.note.includes("simulated"), `live note must not claim simulated: ${response.note}`);
    const receipts = w.store.listActionExecutions(action.id);
    assert.equal(receipts.length, 2);
    for (const execution of receipts) {
      assert.equal(isLiveStepProof(execution.result), true);
    }
    const liveWorkspace = getWorkspace(w.store, { ownerId: OWNER });
    const liveAdapted = adaptWorkspace(liveWorkspace as unknown as Parameters<typeof adaptWorkspace>[0]);
    const liveDetail = liveAdapted.bookings.find((item) => item.id === booking.id)?.detail;
    const liveHold = liveDetail?.receipts?.find((receipt) => receipt.step === "hold");
    assert.ok(liveHold?.detail?.includes("provider receipt recorded"), `live receipt must say provider receipt, got: ${liveHold?.detail}`);
  } finally {
    w.cleanup();
  }
});

test("demo connector receipts stay demo through the adapter with simulated wording", async () => {
  const w = world();
  try {
    const deps = demoDeps(w.store);
    const { booking, action } = seedBooking(w.store, w.businessId, "b-demoproof", "a-demoproof");
    const response = await approveAndExecute(deps, approveIdentity(w.store, action.id, booking.id));
    assert.equal(response.hold.demo, true);
    assert.equal(response.email?.demo, true);
    for (const execution of w.store.listActionExecutions(action.id)) {
      assert.equal(isLiveStepProof(execution.result), false);
    }
    const workspace = getWorkspace(w.store, { ownerId: OWNER });
    const adapted = adaptWorkspace(workspace as unknown as Parameters<typeof adaptWorkspace>[0]);
    const detail = adapted.bookings.find((item) => item.id === booking.id)?.detail;
    const holdReceipt = detail?.receipts?.find((receipt) => receipt.step === "hold");
    assert.equal(holdReceipt?.status, "succeeded");
    assert.ok(holdReceipt?.detail?.includes("simulated"), `demo receipt must say simulated, got: ${holdReceipt?.detail}`);
  } finally {
    w.cleanup();
  }
});

test("proof validation fails closed: unknown, fixture, and malformed proofs never read live", () => {
  assert.equal(isLiveStepProof(undefined), false);
  assert.equal(isLiveStepProof(null), false);
  assert.equal(isLiveStepProof({}), false);
  assert.equal(isLiveStepProof({ proof: null }), false);
  assert.equal(isLiveStepProof({ proof: { mode: "live", simulated: false, provenance: [] } }), false);
  assert.equal(isLiveStepProof({ proof: { mode: "live", simulated: true, provenance: LIVE_SRC } }), false);
  assert.equal(
    isLiveStepProof({ proof: { mode: "live", simulated: false, provenance: [{ kind: "fixture", locator: "x", fictional: true }] } }),
    false,
    "a fictional fixture ref can never upgrade a receipt to live",
  );
  assert.equal(isLiveStepProof({ proof: { mode: "demo", simulated: true, provenance: LIVE_SRC } }), false);
  assert.equal(isLiveStepProof({ proof: { mode: "live", simulated: false, provenance: LIVE_SRC } }), true);
});

test("a legacy execution result without proof adapts as unverified, never live or simulated", async () => {
  const w = world();
  try {
    const deps = demoDeps(w.store);
    const { booking, action } = seedBooking(w.store, w.businessId, "b-legacyproof", "a-legacyproof");
    await approveAndExecute(deps, approveIdentity(w.store, action.id, booking.id));
    // Strip proofs to simulate pre-proof rows: every receipt must fail closed.
    for (const execution of w.store.listActionExecutions(action.id)) {
      const result = { ...(execution.result as Record<string, unknown>) };
      delete result.proof;
      w.store.db.prepare("UPDATE action_executions SET result_json = $json WHERE id = $id").run({ $json: JSON.stringify(result), $id: execution.id });
    }
    const workspace = getWorkspace(w.store, { ownerId: OWNER });
    const adapted = adaptWorkspace(workspace as unknown as Parameters<typeof adaptWorkspace>[0]);
    const detail = adapted.bookings.find((item) => item.id === booking.id)?.detail;
    for (const receipt of detail?.receipts ?? []) {
      if (receipt.status === "succeeded") {
        assert.ok(receipt.detail?.includes("unverified"), `unproven receipt must say unverified, got: ${receipt.detail}`);
      }
    }
  } finally {
    w.cleanup();
  }
});

// ---------- Regression: mid-await supersession, proof validation, honest envelopes ----------

/** A booking/action pair with non-fictional sources — real, never fixture. */
function seedRealBooking(store: GatherStore, businessId: string, bookingId: string, actionId: string, payload: Record<string, unknown> = holdPayload()) {
  const booking = store.createBooking({
    id: bookingId, businessId, eventName: "Real guest event", status: "pending_approval",
    startAt: START, endAt: END, sourceReferences: [{ kind: "document", locator: "doc://real/booking" }],
  });
  const action = store.createProposedAction({
    id: actionId, bookingId: booking.id, kind: "create_provisional_hold", payload,
    sourceReferences: [{ kind: "document", locator: "doc://real/proposal" }],
  });
  return { booking, action };
}

test("reconcile revalidates current authority after the provider await — supersession mid-await refuses the heal", async () => {
  const w = world();
  try {
    const live = liveConnectors();
    // Hold lands uncertain and stays that way while reconcile finds nothing.
    const uncertainCalendar = {
      ...live.calendar,
      createProvisionalHold: async (request: CreateProvisionalHoldRequest): Promise<ConnectorResult<CreateProvisionalHoldResponse>> => ({
        status: "uncertain", metadata: liveMeta(request.operationKey),
        error: { kind: "timeout_after_success", message: "scripted timeout", retryable: false },
        reconciliationRequired: true,
      }),
    };
    const deps: BookingServiceDeps = { store: w.store, calendar: uncertainCalendar as never, email: live.email, ownerId: OWNER, now: () => NOW };
    const { booking, action } = seedBooking(w.store, w.businessId, "b-race", "a-race");
    const approved = await approveAndExecute(deps, approveIdentity(w.store, action.id, booking.id));
    assert.equal(approved.hold.execution.status, "uncertain");
    const uncertainExec = approved.hold.execution;

    // The scripted provider call supersedes the proposal mid-await, then
    // reports success — the stale execution must NOT heal or move status.
    const supersedingCalendar = {
      ...uncertainCalendar,
      reconcileProvisionalHold: async (request: OperationRequest): Promise<ConnectorResult<CreateProvisionalHoldResponse>> => {
        w.store.createProposedAction({
          bookingId: booking.id, kind: "create_provisional_hold",
          payload: holdPayload({ startAt: "2030-06-20T17:00:00.000Z", endAt: "2030-06-20T23:00:00.000Z" }),
          sourceReferences: SRC("demo://test/newer"),
        });
        return {
          status: "succeeded", metadata: liveMeta(request.operationKey),
          data: {
            hold: { holdId: "h-late", operationKey: request.operationKey, bookingId: booking.id, calendarId: CAL,
              startAt: START, endAt: END, expiresAt: EXPIRES, status: "provisional_hold", createdAt: NOW, sourceReferences: LIVE_SRC },
            provenance: LIVE_SRC,
          },
        };
      },
    };
    await assertServiceError(
      reconcileExecution({ ...deps, calendar: supersedingCalendar as never }, uncertainExec.id),
      "STALE_PROPOSAL",
    );
    const after = w.store.getActionExecution(uncertainExec.id);
    assert.equal(after.status, "uncertain", "a superseded action's execution is never healed");
    assert.notEqual(w.store.getBooking(booking.id).status, "provisional_hold",
      "booking status must not claim a hold that belongs to a superseded proposal");
  } finally {
    w.cleanup();
  }
});

test("live proof requires structurally valid provenance — malformed entries never qualify", async () => {
  const malformed = [null, {}, "not a source", { fictional: false }, { kind: "fixture", locator: "demo://x" },
    { kind: "bogus", locator: "x" }, { kind: "calendar", locator: "" }, { kind: "calendar", locator: "x", fictional: true }];
  for (const ref of malformed) {
    assert.equal(
      isLiveStepProof({ proof: { mode: "live", simulated: false, provenance: [ref] } }),
      false, `malformed provenance ${JSON.stringify(ref)} must not read as live`,
    );
  }
  assert.equal(isLiveStepProof({ proof: { mode: "live", simulated: false, provenance: [{ kind: "calendar", locator: "live://x" }] } }), true);
  assert.equal(isLiveStepProof({ proof: { mode: "demo", simulated: true, provenance: [{ kind: "calendar", locator: "live://x" }] } }), false);
  assert.equal(isLiveStepProof({ hold: {} }), false, "proof-absent results are not live");
});

test("response envelopes reflect actual evidence — live proof, unverified, and fixture markers", async () => {
  const w = world();
  try {
    const live = liveConnectors();
    const deps: BookingServiceDeps = { store: w.store, calendar: live.calendar as never, email: live.email, ownerId: OWNER, now: () => NOW };

    // Real booking, both steps live-proven: the envelope is LIVE, never demo.
    const { booking, action } = seedRealBooking(w.store, w.businessId, "b-live", "a-live");
    const res = await approveAndExecute(deps, approveIdentity(w.store, action.id, booking.id));
    assert.equal(res.demo, false);
    assert.equal(res.mode.kind, "live");
    assert.match(res.note, /Provider receipts recorded/);

    // Fixture booking: demo marker preserved.
    const { booking: fb, action: fa } = seedBooking(w.store, w.businessId, "b-fx", "a-fx");
    const fx = await approveAndExecute(demoDeps(w.store), approveIdentity(w.store, fa.id, fb.id));
    assert.equal(fx.demo, true);
    assert.equal(fx.mode.kind, "demo");

    // Workspace marker: real bookings present -> never claims fictional demo.
    const workspace = getWorkspace(w.store, { ownerId: OWNER });
    assert.equal(workspace.demo, false);
  } finally {
    w.cleanup();
  }
});

test("a proof-absent succeeded receipt reads unverified — never claims simulated or live", async () => {
  const w = world();
  try {
    const live = liveConnectors();
    const deps: BookingServiceDeps = { store: w.store, calendar: live.calendar as never, email: live.email, ownerId: OWNER, now: () => NOW };
    const { booking, action } = seedRealBooking(w.store, w.businessId, "b-legacy", "a-legacy");
    await approveAndExecute(deps, approveIdentity(w.store, action.id, booking.id));
    // Strip the proof objects to simulate a pre-proof legacy row.
    for (const execution of w.store.listActionExecutions(action.id)) {
      const result = { ...(execution.result as Record<string, unknown>) };
      delete result.proof;
      w.store.db.prepare("UPDATE action_executions SET result_json = $json WHERE id = $id").run({ $json: JSON.stringify(result), $id: execution.id });
    }
    const detail = stepReceiptDetail(w.store.listActionExecutions(action.id)[0]!);
    assert.match(detail, /unverified/);
    const workspace = getWorkspace(w.store, { ownerId: OWNER });
    assert.equal(workspace.mode.kind, "unknown", "real booking with unproven receipts is unverified, not demo or live");
    const item = workspace.bookings.find((entry) => entry.booking.id === booking.id);
    assert.equal(item?.executions[0]?.status, "succeeded");
    // And the adapter shows unverified, never live or simulated.
    const adapted = adaptWorkspace(workspace as unknown as Parameters<typeof adaptWorkspace>[0]);
    const receipts = adapted.bookings.find((entry) => entry.id === booking.id)?.detail.receipts ?? [];
    for (const receipt of receipts.filter((r) => r.status === "succeeded")) {
      assert.match(receipt.detail ?? "", /unverified/);
    }
  } finally {
    w.cleanup();
  }
});
