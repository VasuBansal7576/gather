import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import type {
  CalendarAvailabilityReader,
  ConnectorResult,
  CreateProvisionalHoldResponse,
  OperationRequest,
  SourceReference,
} from "../src/connectors/contracts.ts";
import type {
  CalendarHoldReleaseConnector,
  ReleaseProvisionalHoldRequest,
  ReleaseProvisionalHoldResponse,
} from "../src/connectors/hold-release.ts";
import { CoordinationLedger } from "../src/coordination/ledger.ts";
import { KnowledgeService } from "../src/knowledge/index.ts";
import {
  approveAndExecute,
  holdOperationKey,
  ServiceError,
} from "../src/server/booking-service.ts";
import type { BookingServiceDeps } from "../src/server/booking-service.ts";
import {
  pauseBooking,
  requestCancellation,
  requestRevision,
  resumeBooking,
  verifyCancellation,
  type RevisionsDeps,
} from "../src/server/booking-revisions/index.ts";
import type { RevisionBinding } from "../src/server/booking-revisions/index.ts";
import { decideOperator } from "../src/server/business-operator/index.ts";
import type { OperatorDeps } from "../src/server/business-operator/index.ts";
import { createDemoConnectors } from "../src/connectors/demo.ts";
import { DurableDemoCalendar, DurableDemoEmail } from "../src/server/durable-demo-connectors.ts";
import { GatherStore } from "../src/server/sqlite-store.ts";

// All fixtures are fictional and stay labeled by their sources.
const START = "2030-06-12T17:00:00.000Z";
const END = "2030-06-12T23:00:00.000Z";
const EXPIRES = "2030-06-13T23:00:00.000Z";
const CAL = "demo-calendar-001";
const NOW = "2030-01-01T00:00:00.000Z";
const OWNER = "test-owner";

const SRC = (locator: string) => [{ kind: "document" as const, locator, label: locator, fictional: true as const }];

function holdPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    startAt: START,
    endAt: END,
    expiresAt: EXPIRES,
    calendarId: CAL,
    emailTo: ["guest@example.test"],
    emailSubject: "DEMO ONLY fictional offer",
    emailBody: "DEMO ONLY fictional hold.",
    ...overrides,
  };
}

interface World {
  dir: string;
  path: string;
  store: GatherStore;
  deps: RevisionsDeps;
  operatorDeps: OperatorDeps;
  businessId: string;
  cleanup: () => void;
}

function fakeAvailability(): CalendarAvailabilityReader {
  return {
    checkAvailability: async (request: { operationKey: string; calendarId: string; startAt: string; endAt: string }) => {
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
}

function world(holdRelease?: CalendarHoldReleaseConnector): World {
  const dir = mkdtempSync(join(tmpdir(), "gather-rev-"));
  const path = join(dir, "gather.sqlite");
  const store = new GatherStore(path);
  const connectors = createDemoConnectors({
    calendarSlots: [{
      slotId: "demo-cover", calendarId: CAL,
      startAt: "2030-06-12T00:00:00.000Z", endAt: "2030-06-13T00:00:00.000Z", available: true,
      sourceReferences: [{ kind: "fixture", locator: "demo://cal/cover", fictional: true }],
    }],
  });
  const booking: BookingServiceDeps = {
    store,
    calendar: new DurableDemoCalendar(store, connectors.calendar, () => Date.parse(NOW)),
    email: new DurableDemoEmail(store, connectors.email),
    ownerId: OWNER,
    now: () => NOW,
  };
  const operatorDeps: OperatorDeps = { store, booking, ownerId: OWNER, availability: fakeAvailability() };
  const businessId = store.createBusiness({ name: "Fictional Hall", timezone: "UTC" }).id;
  const deps: RevisionsDeps = {
    store, booking, ownerId: OWNER, availability: fakeAvailability(),
    ledger: new CoordinationLedger(store.db),
    ...(holdRelease === undefined ? {} : { holdRelease }),
    now: () => NOW,
  };
  return { dir, path, store, deps, operatorDeps, businessId, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function confirmFacts(w: World): void {
  const svc = new KnowledgeService(w.store);
  const facts: { key: string; subjectId?: string; value: Record<string, unknown> }[] = [
    { key: "space", subjectId: "hall", value: { spaceId: "hall", name: "Hall", capacityMin: 10, capacityMax: 100 } },
    { key: "price_line", subjectId: "dinner", value: { lineId: "dinner", label: "Dinner", pricingBasis: "per_guest", unitCents: 10000 } },
    { key: "pricing_bounds", value: { currency: "USD", floorCents: 100000, costsComplete: true, depositBps: 2000 } },
    { key: "service", subjectId: "dinner", value: { serviceId: "dinner", label: "Dinner", available: true } },
  ];
  for (const fact of facts) {
    const candidate = svc.intakeCandidate({
      businessId: w.businessId, ...fact, confidence: "probable", sourceReferences: SRC("fixture://kb/" + fact.key),
    });
    svc.confirmCandidate({ businessId: w.businessId, actor: { kind: "owner", id: OWNER }, candidateId: candidate.id });
  }
}

function inquiry(w: World, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    inquiryId: "inq-rev", businessId: w.businessId, eventType: "dinner",
    startAt: START, endAt: END, guestCount: 40, serviceRequirements: ["dinner"],
    sourceReferences: SRC("fixture://rev/inq"),
    ...overrides,
  };
}

function email() {
  return { to: ["guest@example.test"], subject: "Revised offer", body: "Revised hold." };
}

function bindingOf(w: World, bookingId: string, commandId: string): RevisionBinding {
  const current = w.store.getCurrentProposalAction(bookingId);
  assert.ok(current, "booking must have a current proposal");
  return {
    businessId: w.businessId, bookingId,
    proposedActionId: current.id, proposalVersion: current.proposalVersion,
    proposalFingerprint: current.proposalFingerprint, commandId,
  };
}

function seedSimpleBooking(w: World, bookingId: string, actionId: string, payload: Record<string, unknown> = holdPayload()) {
  const booking = w.store.createBooking({
    id: bookingId, businessId: w.businessId, eventName: "Fictional test event", status: "pending_approval",
    startAt: START, endAt: END, sourceReferences: SRC("demo://test/booking"),
  });
  const action = w.store.createProposedAction({
    id: actionId, bookingId: booking.id, kind: "create_provisional_hold", payload,
    sourceReferences: SRC("demo://test/proposal"),
  });
  return { booking, action };
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

function scriptedRelease(outcome: "succeeded" | "uncertain" | "failed", calls: string[] = []): CalendarHoldReleaseConnector {
  const refs: SourceReference[] = [{ kind: "calendar", locator: "live-cal://release" }];
  const data = (request: ReleaseProvisionalHoldRequest | OperationRequest, holdId: string, originalKey: string) => ({
    released: {
      holdId, operationKey: request.operationKey, originalHoldOperationKey: originalKey,
      bookingId: "ignored", calendarId: CAL, status: "released" as const,
      alreadyReleased: false, releasedAt: NOW, sourceReferences: refs,
    },
    provenance: refs,
  });
  return {
    releaseProvisionalHold: async (request: ReleaseProvisionalHoldRequest): Promise<ConnectorResult<ReleaseProvisionalHoldResponse>> => {
      calls.push(`release:${request.operationKey}`);
      if (outcome === "succeeded") {
        return {
          status: "succeeded",
          metadata: { operationKey: request.operationKey, mode: { mode: "live", label: "LIVE", fictional: false }, simulated: false, sourceReferences: refs },
          data: data(request, request.holdId, request.originalHoldOperationKey),
        };
      }
      if (outcome === "uncertain") {
        return {
          status: "uncertain",
          metadata: { operationKey: request.operationKey, mode: { mode: "live", label: "LIVE", fictional: false }, simulated: false, sourceReferences: refs },
          error: { kind: "timeout_after_success", message: "delete may have applied", retryable: true },
          reconciliationRequired: true,
        };
      }
      return {
        status: "failed",
        metadata: { operationKey: request.operationKey, mode: { mode: "live", label: "LIVE", fictional: false }, simulated: false, sourceReferences: refs },
        error: { kind: "authorization_denied", message: "release refused", retryable: false },
      };
    },
    reconcileReleasedHold: async (request: OperationRequest): Promise<ConnectorResult<ReleaseProvisionalHoldResponse>> => {
      calls.push(`reconcile:${request.operationKey}`);
      if (outcome === "uncertain") {
        return {
          status: "failed",
          metadata: { operationKey: request.operationKey, mode: { mode: "live", label: "LIVE", fictional: false }, simulated: false, sourceReferences: refs },
          error: { kind: "not_found", message: "no release record yet", retryable: true },
        };
      }
      return {
        status: "failed",
        metadata: { operationKey: request.operationKey, mode: { mode: "live", label: "LIVE", fictional: false }, simulated: false, sourceReferences: refs },
        error: { kind: "not_found", message: "no release record", retryable: false },
      };
    },
  };
}

// ---------- Revision ----------

test("revision publishes new terms through the prepare path, invalidates the old approval, preserves receipts", async () => {
  const w = world();
  try {
    confirmFacts(w);
    const booking = w.store.createBooking({
      businessId: w.businessId, eventName: "E", status: "pending_approval", sourceReferences: SRC("demo://rev/b"),
    });
    const { buildBookingOffer, persistPreparedProposal } = await import("../src/server/business-operator/index.ts");
    const firstBuilt = await buildBookingOffer(w.operatorDeps, { bookingId: booking.id, inquiry: inquiry(w), calendarId: CAL } as never);
    const first = persistPreparedProposal(w.operatorDeps, firstBuilt, { email: email(), expiresAt: EXPIRES });
    assert.ok(!("missing" in first));
    if ("missing" in first) throw new Error("unreachable");
    w.store.approveProposedAction(first.action.id, OWNER);
    const oldExecutions = w.store.listActionExecutions(first.action.id);

    const revised = await requestRevision(w.deps, {
      binding: bindingOf(w, booking.id, "cmd-rev-1"),
      inquiry: inquiry(w, { guestCount: 60 }),
      calendarId: CAL, email: email(), expiresAt: EXPIRES,
    });
    assert.equal(revised.status, "revised");
    assert.ok(revised.action);
    assert.notEqual(revised.action.id, first.action.id);
    assert.equal(revised.supersedesActionId, first.action.id);
    assert.equal(w.store.getCurrentProposalAction(booking.id)?.id, revised.action.id);
    // Old approval died with supersession; old receipts are preserved untouched.
    assert.deepEqual(w.store.listApprovals(first.action.id).filter((item) => item.status === "approved"), []);
    assert.deepEqual(
      w.store.listActionExecutions(first.action.id).map((item) => item.id),
      oldExecutions.map((item) => item.id),
    );
    // New terms require a new approval: the old identity is stale.
    const staleIdentity = {
      bookingId: booking.id, proposedActionId: first.action.id,
      proposalVersion: first.action.proposalVersion, proposalFingerprint: first.action.proposalFingerprint,
    };
    await assertServiceError(approveAndExecute(w.deps.booking, staleIdentity), "STALE_PROPOSAL");
  } finally {
    w.cleanup();
  }
});

test("revision refuses while an obsolete unreleased hold conflicts, persisting nothing", async () => {
  const w = world();
  try {
    const { booking, action } = seedSimpleBooking(w, "b-rev-block", "a-rev-block");
    const identity = {
      bookingId: booking.id, proposedActionId: action.id,
      proposalVersion: action.proposalVersion, proposalFingerprint: action.proposalFingerprint,
    };
    const executed = await approveAndExecute(w.deps.booking, identity);
    assert.equal(executed.hold.execution.status, "succeeded");
    const blocked = await requestRevision(w.deps, {
      binding: bindingOf(w, booking.id, "cmd-rev-block"),
      inquiry: inquiry(w), calendarId: CAL, email: email(), expiresAt: EXPIRES,
    });
    assert.equal(blocked.status, "blocked");
    assert.ok(blocked.blocked?.some((item) => item.code === "obsolete_hold_unreleased"));
    assert.equal(w.store.listProposedActionsForBooking(booking.id).length, 1);
  } finally {
    w.cleanup();
  }
});

test("revision with a stale binding is refused and duplicate commands replay", async () => {
  const w = world();
  try {
    confirmFacts(w);
    const booking = w.store.createBooking({
      businessId: w.businessId, eventName: "E", status: "pending_approval", sourceReferences: SRC("demo://rev/b2"),
    });
    const { buildBookingOffer, persistPreparedProposal } = await import("../src/server/business-operator/index.ts");
    const built = await buildBookingOffer(w.operatorDeps, { bookingId: booking.id, inquiry: inquiry(w), calendarId: CAL } as never);
    const first = persistPreparedProposal(w.operatorDeps, built, { email: email(), expiresAt: EXPIRES });
    assert.ok(!("missing" in first));
    if ("missing" in first) throw new Error("unreachable");
    const staleBinding = {
      businessId: w.businessId, bookingId: booking.id,
      proposedActionId: first.action.id, proposalVersion: first.action.proposalVersion,
      proposalFingerprint: first.action.proposalFingerprint, commandId: "cmd-rev-stale",
    };
    // A newer proposal displaces the binding before the command runs.
    w.store.createProposedAction({
      id: "a-rev-newer", bookingId: booking.id, kind: "create_provisional_hold",
      payload: holdPayload({ emailSubject: "newer" }), sourceReferences: SRC("demo://rev/new"),
    });
    await assertServiceError(
      requestRevision(w.deps, { binding: staleBinding, inquiry: inquiry(w), calendarId: CAL, email: email(), expiresAt: EXPIRES }),
      "STALE_PROPOSAL",
    );
    const dupBinding = bindingOf(w, booking.id, "cmd-rev-dup");
    const firstRevision = await requestRevision(w.deps, {
      binding: dupBinding,
      inquiry: inquiry(w, { guestCount: 55 }),
      calendarId: CAL, email: email(), expiresAt: EXPIRES,
    });
    assert.equal(firstRevision.status, "revised");
    const replayed = await requestRevision(w.deps, {
      binding: dupBinding,
      inquiry: inquiry(w, { guestCount: 55 }),
      calendarId: CAL, email: email(), expiresAt: EXPIRES,
    });
    assert.equal((replayed as { duplicate?: boolean }).duplicate, true);
    assert.equal(replayed.action?.id, firstRevision.action?.id);
  } finally {
    w.cleanup();
  }
});

// ---------- Cancellation: request (local) vs verify (external) ----------

test("cancellation request invalidates authority and stops due work without setting cancelled", () => {
  const w = world();
  try {
    const { booking, action } = seedSimpleBooking(w, "b-cancel-req", "a-cancel-req");
    w.store.approveProposedAction(action.id, OWNER);
    // Due work exists before the request.
    const ledger = new CoordinationLedger(w.store.db);
    ledger.ingestEvent({
      dedupeKey: "evt-inq-1", kind: "inquiry", bookingId: booking.id,
      sourceId: "inbox://msg-1", sourceKind: "email", observedAt: NOW, payload: {},
    });
    const response = requestCancellation(w.deps, bindingOf(w, booking.id, "cmd-cancel-1"));
    assert.equal(response.status, "request_received");
    assert.equal(response.cancelState, "requested");
    assert.equal(response.invalidatedApprovals, 1);
    assert.notEqual(w.store.getBooking(booking.id).status, "cancelled");
    // Due work is stopped: waiting rows are invalidated.
    const waiting = w.store.db.prepare("SELECT status FROM coord_waiting").all() as Array<{ status: string }>;
    assert.ok(waiting.length > 0);
    assert.ok(waiting.every((row) => row.status === "invalidated"), `due work must be invalidated, got ${JSON.stringify(waiting)}`);
    // A second command id is a read-only acknowledgement, not a duplicate.
    const again = requestCancellation(w.deps, bindingOf(w, booking.id, "cmd-cancel-2"));
    assert.equal(again.status, "already_requested");
  } finally {
    w.cleanup();
  }
});

test("cancel verify without a wired port stays requested with explicit blocked conditions", async () => {
  const w = world();
  try {
    const { booking, action } = seedSimpleBooking(w, "b-cancel-np", "a-cancel-np");
    const identity = {
      bookingId: booking.id, proposedActionId: action.id,
      proposalVersion: action.proposalVersion, proposalFingerprint: action.proposalFingerprint,
    };
    await approveAndExecute(w.deps.booking, identity);
    requestCancellation(w.deps, bindingOf(w, booking.id, "cmd-cancel-np"));
    const blocked = await verifyCancellation(w.deps, { binding: bindingOf(w, booking.id, "cmd-verify-np") });
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.cancellationScope, "local_request");
    assert.ok(blocked.blocked?.some((item) => item.code === "release_unverified"));
    assert.notEqual(w.store.getBooking(booking.id).status, "cancelled");
  } finally {
    w.cleanup();
  }
});

test("cancel verify with release proof and waiver completes externally verified cancellation", async () => {
  const calls: string[] = [];
  const w = world(scriptedRelease("succeeded", calls));
  try {
    confirmFacts(w);
    const booking = w.store.createBooking({
      businessId: w.businessId, eventName: "E", status: "pending_approval", sourceReferences: SRC("demo://cancel/b"),
    });
    const { buildBookingOffer, persistPreparedProposal } = await import("../src/server/business-operator/index.ts");
    const built = await buildBookingOffer(w.operatorDeps, { bookingId: booking.id, inquiry: inquiry(w), calendarId: CAL } as never);
    const persisted = persistPreparedProposal(w.operatorDeps, built, { email: email(), expiresAt: EXPIRES });
    assert.ok(!("missing" in persisted));
    if ("missing" in persisted) throw new Error("unreachable");
    const identity = {
      bookingId: booking.id, proposedActionId: persisted.action.id,
      proposalVersion: persisted.action.proposalVersion, proposalFingerprint: persisted.action.proposalFingerprint,
    };
    const executed = await approveAndExecute(w.deps.booking, identity);
    assert.equal(executed.hold.execution.status, "succeeded");
    requestCancellation(w.deps, bindingOf(w, booking.id, "cmd-cancel-full"));
    // Deposit is implicated (configured deposit + executed steps): without a
    // waiver the refund obligation stays explicitly blocked.
    const noWaiver = await verifyCancellation(w.deps, { binding: bindingOf(w, booking.id, "cmd-verify-now") });
    assert.equal(noWaiver.status, "blocked");
    assert.ok(noWaiver.blocked?.some((item) => item.code === "refund_unverified"));
    assert.ok(calls.some((call) => call.startsWith("release:")), "the port must have been called for the hold");
    // A booking-scoped approved allow-exception naming the refund policy waives it.
    decideOperator(w.operatorDeps, "exception", {
      businessId: w.businessId, scope: "booking", scopeId: booking.id,
      policyId: "refund-policy-1", effect: "allow",
      value: { note: "Owner waives the deposit refund for this fictional cancellation." },
    });
    const verified = await verifyCancellation(w.deps, {
      binding: bindingOf(w, booking.id, "cmd-verify-waived"),
      waiver: { policyId: "refund-policy-1" },
    });
    assert.equal(verified.status, "verified");
    assert.equal(verified.cancellationScope, "external_verified");
    assert.equal(w.store.getBooking(booking.id).status, "cancelled");
  } finally {
    w.cleanup();
  }
});

test("cancel verify releases holds across superseded proposals before verifying", async () => {
  const calls: string[] = [];
  const w = world(scriptedRelease("succeeded", calls));
  try {
    confirmFacts(w);
    const booking = w.store.createBooking({
      businessId: w.businessId, eventName: "E", status: "pending_approval", sourceReferences: SRC("demo://cancel/x"),
    });
    const { buildBookingOffer, persistPreparedProposal } = await import("../src/server/business-operator/index.ts");
    const firstBuilt = await buildBookingOffer(w.operatorDeps, { bookingId: booking.id, inquiry: inquiry(w), calendarId: CAL } as never);
    const first = persistPreparedProposal(w.operatorDeps, firstBuilt, { email: email(), expiresAt: EXPIRES });
    assert.ok(!("missing" in first));
    if ("missing" in first) throw new Error("unreachable");
    const identity = {
      bookingId: booking.id, proposedActionId: first.action.id,
      proposalVersion: first.action.proposalVersion, proposalFingerprint: first.action.proposalFingerprint,
    };
    const executed = await approveAndExecute(w.deps.booking, identity);
    assert.equal(executed.hold.execution.status, "succeeded");
    const v1Hold = executed.hold.execution.result as { hold?: { holdId?: unknown } };
    const v1HoldId = v1Hold.hold?.holdId;
    assert.ok(typeof v1HoldId === "string", "v1 must carry a durable hold receipt");
    // Revise onto a different calendar: the v1 hold no longer overlap-gates,
    // so v2 becomes current while the v1 provider hold is still outstanding.
    const revised = await requestRevision(w.deps, {
      binding: bindingOf(w, booking.id, "cmd-rev-x"),
      inquiry: inquiry(w), calendarId: "demo-calendar-002", email: email(), expiresAt: EXPIRES,
    });
    assert.equal(revised.status, "revised");
    requestCancellation(w.deps, bindingOf(w, booking.id, "cmd-cancel-x"));
    const verified = await verifyCancellation(w.deps, { binding: bindingOf(w, booking.id, "cmd-verify-x") });
    assert.equal(verified.status, "verified");
    assert.equal(verified.cancellationScope, "external_verified");
    // Regression pin: the superseded v1 hold must have been released through
    // the port — verifying with zero port calls would leak the live hold.
    assert.ok(calls.length > 0, "the port must have been called for the superseded hold");
    const v1Key = w.store.listActionExecutions(first.action.id).find((item) => item.idempotencyKey.includes(":create-provisional-hold:"))?.idempotencyKey;
    assert.ok(v1Key, "v1 must have a durable hold execution key");
    const record = w.store.db.prepare("SELECT status, receipt_json FROM hold_release_records WHERE hold_operation_key = $key").get({ $key: v1Key }) as { status: string; receipt_json: string } | null;
    assert.ok(record, "a durable release record must exist for the superseded hold");
    assert.equal(record.status, "released");
    assert.ok(String(record.receipt_json).includes(v1HoldId as string), "the release receipt must name the v1 hold");
    assert.equal(w.store.getBooking(booking.id).status, "cancelled");
  } finally {
    w.cleanup();
  }
});

test("cancel verify is refused before any request and on stale bindings", async () => {
  const w = world();
  try {
    const { booking } = seedSimpleBooking(w, "b-cancel-early", "a-cancel-early");
    await assertServiceError(
      verifyCancellation(w.deps, { binding: bindingOf(w, booking.id, "cmd-verify-early") }),
      "INVALID_REQUEST",
    );
    requestCancellation(w.deps, bindingOf(w, booking.id, "cmd-cancel-early"));
    const staleBinding = bindingOf(w, booking.id, "cmd-verify-stale");
    w.store.createProposedAction({
      id: "a-cancel-newer", bookingId: booking.id, kind: "create_provisional_hold",
      payload: holdPayload({ emailSubject: "newer" }), sourceReferences: SRC("demo://cancel/new"),
    });
    const current = w.store.getCurrentProposalAction(booking.id);
    assert.notEqual(staleBinding.proposedActionId, current?.id);
    await assertServiceError(verifyCancellation(w.deps, { binding: staleBinding }), "STALE_PROPOSAL");
    assert.notEqual(w.store.getBooking(booking.id).status, "cancelled");
  } finally {
    w.cleanup();
  }
});

test("cancel request and verify survive restart with the same command ids replaying", () => {
  const w = world();
  try {
    const { booking } = seedSimpleBooking(w, "b-cancel-restart", "a-cancel-restart");
    const first = requestCancellation(w.deps, bindingOf(w, booking.id, "cmd-cancel-restart"));
    assert.equal(first.status, "request_received");
    w.store.close();
    const reopened = new GatherStore(w.path);
    try {
      const deps: RevisionsDeps = {
        ...w.deps, store: reopened,
        booking: { ...w.deps.booking, store: reopened },
        ledger: new CoordinationLedger(reopened.db),
      };
      const replayBinding = (() => {
        const current = reopened.getCurrentProposalAction(booking.id);
        assert.ok(current);
        return {
          businessId: w.businessId, bookingId: booking.id,
          proposedActionId: current.id, proposalVersion: current.proposalVersion,
          proposalFingerprint: current.proposalFingerprint, commandId: "cmd-cancel-restart",
        };
      })();
      const replayed = requestCancellation(deps, replayBinding);
      assert.equal((replayed as { duplicate?: boolean }).duplicate, true);
      assert.equal(replayed.status, "request_received");
      assert.notEqual(reopened.getBooking(booking.id).status, "cancelled");
    } finally {
      reopened.close();
    }
  } finally {
    // w.store was closed mid-test to prove restart durability; tolerate the
    // double close and still remove the temp dir.
    try {
      w.cleanup();
    } catch {
      rmSync(w.dir, { recursive: true, force: true });
    }
  }
});

test("uncertain and failed releases stay explicitly blocked, never faked", async () => {
  for (const outcome of ["uncertain", "failed"] as const) {
    const w = world(scriptedRelease(outcome));
    try {
      const { booking, action } = seedSimpleBooking(w, `b-rel-${outcome}`, `a-rel-${outcome}`);
      const identity = {
        bookingId: booking.id, proposedActionId: action.id,
        proposalVersion: action.proposalVersion, proposalFingerprint: action.proposalFingerprint,
      };
      await approveAndExecute(w.deps.booking, identity);
      requestCancellation(w.deps, bindingOf(w, booking.id, `cmd-cancel-${outcome}`));
      const blocked = await verifyCancellation(w.deps, { binding: bindingOf(w, booking.id, `cmd-verify-${outcome}`) });
      assert.equal(blocked.status, "blocked");
      const codes = (blocked.blocked ?? []).map((item) => item.code);
      assert.ok(
        codes.includes(outcome === "uncertain" ? "release_uncertain" : "release_unverified"),
        `expected an explicit release condition, got ${JSON.stringify(codes)}`,
      );
      assert.notEqual(w.store.getBooking(booking.id).status, "cancelled");
    } finally {
      w.cleanup();
    }
  }
});

test("a proposal published mid-verify aborts before the booking can cancel", async () => {
  const w = world();
  try {
    const { booking } = seedSimpleBooking(w, "b-cancel-race", "a-cancel-race");
    // Approve first (a succeeded hold gives the release path an await to
    // race across), then request cancellation against the same current.
    const identity = {
      bookingId: booking.id, proposedActionId: "a-cancel-race",
      proposalVersion: 1, proposalFingerprint: w.store.getProposedAction("a-cancel-race").proposalFingerprint,
    };
    const executed = await approveAndExecute(w.deps.booking, identity);
    assert.equal(executed.hold.execution.status, "succeeded");
    requestCancellation(w.deps, bindingOf(w, booking.id, "cmd-cancel-race"));
    const racing: CalendarHoldReleaseConnector = scriptedRelease("succeeded");
    const racingDeps: RevisionsDeps = {
      ...w.deps,
      holdRelease: {
        releaseProvisionalHold: async (request) => {
          w.store.createProposedAction({
            id: "a-cancel-race-2", bookingId: booking.id, kind: "create_provisional_hold",
            payload: holdPayload({ emailSubject: "superseding" }), sourceReferences: SRC("demo://cancel/race"),
          });
          return racing.releaseProvisionalHold(request);
        },
        reconcileReleasedHold: (request) => racing.reconcileReleasedHold(request),
      },
    };
    await assertServiceError(
      verifyCancellation(racingDeps, { binding: bindingOf(w, booking.id, "cmd-verify-race") }),
      "STALE_PROPOSAL",
    );
    assert.notEqual(w.store.getBooking(booking.id).status, "cancelled");
  } finally {
    w.cleanup();
  }
});

// ---------- Pause / resume ----------

test("pause refuses new writes without rewriting executed receipts; resume restores", async () => {
  const w = world();
  try {
    const { booking, action } = seedSimpleBooking(w, "b-pause", "a-pause");
    const identity = {
      bookingId: booking.id, proposedActionId: action.id,
      proposalVersion: action.proposalVersion, proposalFingerprint: action.proposalFingerprint,
    };
    const executed = await approveAndExecute(w.deps.booking, identity);
    const executionsBefore = w.store.listActionExecutions(action.id).map((item) => [item.id, item.status]);
    const paused = pauseBooking(w.deps, bindingOf(w, booking.id, "cmd-pause-1"));
    assert.equal(paused.status, "paused");
    assert.equal(paused.paused, true);
    await assertServiceError(approveAndExecute(w.deps.booking, identity), "BOOKING_PAUSED");
    // Already-executed receipts are exactly as observed — pausing lies about nothing.
    assert.deepEqual(
      w.store.listActionExecutions(action.id).map((item) => [item.id, item.status]),
      executionsBefore,
    );
    assert.equal(executed.hold.execution.status, "succeeded");
    const resumed = resumeBooking(w.deps, bindingOf(w, booking.id, "cmd-resume-1"));
    assert.equal(resumed.status, "resumed");
    assert.equal(resumed.paused, false);
    const again = await approveAndExecute(w.deps.booking, identity);
    assert.equal(again.hold.execution.id, executed.hold.execution.id);
  } finally {
    w.cleanup();
  }
});

test("pause is stale-gated, duplicate-safe, and terminal against cancellation", () => {
  const w = world();
  try {
    const { booking, action } = seedSimpleBooking(w, "b-pause-edge", "a-pause-edge");
    void action;
    w.store.createProposedAction({
      id: "a-pause-newer", bookingId: booking.id, kind: "create_provisional_hold",
      payload: holdPayload({ emailSubject: "newer" }), sourceReferences: SRC("demo://pause/new"),
    });
    const stale = {
      businessId: w.businessId, bookingId: booking.id,
      proposedActionId: "a-pause-edge", proposalVersion: 1,
      proposalFingerprint: w.store.getProposedAction("a-pause-edge").proposalFingerprint,
      commandId: "cmd-pause-stale",
    };
    try {
      pauseBooking(w.deps, stale);
      assert.fail("expected STALE_PROPOSAL");
    } catch (error) {
      assert.ok(error instanceof ServiceError && error.code === "STALE_PROPOSAL");
    }
    const first = pauseBooking(w.deps, bindingOf(w, booking.id, "cmd-pause-dup"));
    assert.equal(first.duplicate, undefined);
    const replayed = pauseBooking(w.deps, bindingOf(w, booking.id, "cmd-pause-dup"));
    assert.equal(replayed.duplicate, true);
    // A paused booking cannot be cancellation-requested (verification would
    // refuse the paused booking while resume would refuse the requested
    // one): the owner resumes first, keeping due work suppressed throughout.
    try {
      requestCancellation(w.deps, bindingOf(w, booking.id, "cmd-pause-cancel"));
      assert.fail("expected BOOKING_PAUSED");
    } catch (error) {
      assert.ok(error instanceof ServiceError && error.code === "BOOKING_PAUSED");
      assert.equal(error.retryable, true);
    }
    const resumed = resumeBooking(w.deps, bindingOf(w, booking.id, "cmd-pause-resume"));
    assert.equal(resumed.status, "resumed");
    const requested = requestCancellation(w.deps, bindingOf(w, booking.id, "cmd-pause-cancel"));
    assert.equal(requested.status, "request_received");
    // A requested booking refuses pause: due work already stopped and
    // authority already invalidated, so pausing could only strand it.
    try {
      pauseBooking(w.deps, bindingOf(w, booking.id, "cmd-pause-late"));
      assert.fail("expected INVALID_REQUEST");
    } catch (error) {
      assert.ok(error instanceof ServiceError && error.code === "INVALID_REQUEST");
    }
    try {
      resumeBooking(w.deps, bindingOf(w, booking.id, "cmd-resume-dead"));
      assert.fail("expected INVALID_REQUEST");
    } catch (error) {
      assert.ok(error instanceof ServiceError && error.code === "INVALID_REQUEST");
    }
  } finally {
    w.cleanup();
  }
});

test("cross-booking bindings are refused and unknown commands conflict honestly", () => {
  const w = world();
  try {
    const first = seedSimpleBooking(w, "b-x-1", "a-x-1");
    const second = seedSimpleBooking(w, "b-x-2", "a-x-2");
    const cross = {
      ...bindingOf(w, first.booking.id, "cmd-cross"),
      businessId: second.booking.businessId,
      proposedActionId: second.action.id,
    };
    try {
      pauseBooking(w.deps, cross);
      assert.fail("expected CROSS_BOOKING");
    } catch (error) {
      assert.ok(error instanceof ServiceError && error.code === "CROSS_BOOKING");
    }
    pauseBooking(w.deps, bindingOf(w, first.booking.id, "cmd-conflict"));
    try {
      resumeBooking(w.deps, bindingOf(w, first.booking.id, "cmd-conflict"));
      assert.fail("expected conflict");
    } catch (error) {
      assert.ok(error instanceof Error && /different .* request|different request/.test(error.message));
    }
  } finally {
    w.cleanup();
  }
});

// ---------- HTTP body validation (route handlers are thin parse → service → json) ----------

test("revision/cancellation/pause bodies validate exact bindings at the boundary", async () => {
  const { parseCancellationBody, parsePauseBody, parseRevisionBody } = await import(
    "../src/server/booking-revisions/validation.ts"
  );
  const w = world();
  try {
    const { booking } = seedSimpleBooking(w, "b-val", "a-val");
    const current = w.store.getCurrentProposalAction(booking.id);
    assert.ok(current);
    const base = {
      businessId: w.businessId,
      bookingId: booking.id,
      proposedActionId: current.id,
      proposalVersion: current.proposalVersion,
      proposalFingerprint: current.proposalFingerprint,
      commandId: "cmd-val",
    };
    const revision = parseRevisionBody(
      { ...base, inquiry: inquiry(w), calendarId: CAL, email: email(), expiresAt: EXPIRES }, booking.id,
    );
    assert.equal(revision.binding.commandId, "cmd-val");
    const cancellation = parseCancellationBody({ ...base, action: "verify", waiver: { policyId: "p1" } }, booking.id);
    assert.equal(cancellation.action, "verify");
    assert.equal(parsePauseBody({ ...base, action: "resume" }, booking.id).action, "resume");
    const rejects: Array<() => unknown> = [
      () => parseRevisionBody({ ...base, bookingId: "other" }, booking.id),
      () => parseRevisionBody({ ...base, proposalFingerprint: "not-hex!!" }, booking.id),
      () => parseRevisionBody({ ...base, inquiry: inquiry(w), calendarId: CAL, email: email() }, booking.id),
      () => parseCancellationBody({ ...base, action: "explode" }, booking.id),
      () => parsePauseBody({ ...base }, booking.id),
      () => parsePauseBody({ ...base, action: "pause", commandId: "" }, booking.id),
    ];
    for (const fn of rejects) {
      assert.throws(fn, /must be|must match/, "malformed bodies must fail at the boundary");
    }
  } finally {
    w.cleanup();
  }
});
