/**
 * SIMULATED durable-intent tests (ADR-002 / C02 / C06). Scripted demo
 * connectors and temporary SQLite files only — nothing live is touched.
 * Covers the observable acceptance slices: stable dedupe + fenced claims
 * (002-A01), restart/reconciliation honesty (002-A02), and
 * cancellation/replay state preservation (002-A03).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { createDemoConnectors, type DemoConnectorSet } from "../src/connectors/demo.ts";
import {
  DEMO_MODE,
  type ConnectorUncertain,
  type CreateProvisionalHoldRequest,
  type CreateProvisionalHoldResponse,
  type ConnectorResult,
  type SendEmailRequest,
  type SendEmailResponse,
  type OperationRequest,
} from "../src/connectors/contracts.ts";
import { CoordinationLedger } from "../src/coordination/ledger.ts";
import { IntentService } from "../src/intents/index.ts";
import {
  emailOperationKey,
  holdOperationKey,
  ServiceError,
  type BookingServiceDeps,
} from "../src/server/booking-service.ts";
import { DurableDemoCalendar, DurableDemoEmail } from "../src/server/durable-demo-connectors.ts";
import { GatherStore } from "../src/server/sqlite-store.ts";

const NOW = "2030-06-01T00:00:00.000Z";
const START = "2030-06-12T17:00:00.000Z";
const END = "2030-06-12T23:00:00.000Z";
const EXPIRES = "2030-06-13T23:00:00.000Z";
const CALENDAR = "demo-calendar-001";

function holdPayload(to: string[] = ["guest@example.test"]): Record<string, unknown> {
  return {
    startAt: START,
    endAt: END,
    expiresAt: EXPIRES,
    calendarId: CALENDAR,
    emailTo: to,
    emailSubject: "DEMO ONLY fictional offer",
    emailBody: "DEMO ONLY fictional hold for the test event.",
  };
}

function coveringSlot() {
  return {
    slotId: "slot-cover",
    calendarId: CALENDAR,
    startAt: "2030-06-12T00:00:00.000Z",
    endAt: "2030-06-13T00:00:00.000Z",
    available: true as const,
    sourceReferences: [{ kind: "fixture" as const, locator: "demo://test/slot", fictional: true as const }],
  };
}

interface World {
  dir: string;
  path: string;
  store: GatherStore;
  demo: DemoConnectorSet;
  deps: BookingServiceDeps;
  intents: IntentService;
  businessId: string;
  cleanup: () => void;
}

function world(opts: { dir?: string; seed?: Parameters<typeof createDemoConnectors>[0]; now?: () => string } = {}): World {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), "gather-intents-"));
  const path = join(dir, "gather.sqlite");
  const store = new GatherStore(path);
  const demo = createDemoConnectors({ calendarSlots: [coveringSlot()], nowMs: () => Date.parse(NOW), ...opts.seed });
  const deps: BookingServiceDeps = {
    store,
    calendar: new DurableDemoCalendar(store, demo.calendar, () => Date.parse(NOW)),
    email: new DurableDemoEmail(store, demo.email),
    ownerId: "test-owner",
    now: opts.now ?? (() => NOW),
  };
  const intents = new IntentService({ booking: deps, mode: "prepared", now: opts.now ?? (() => NOW) });
  const business = store.createBusiness({ name: "Fictional Test Hall", timezone: "UTC" });
  return {
    dir, path, store, demo, deps, intents, businessId: business.id,
    cleanup: () => { try { store.close(); } catch { /* already closed */ } rmSync(dir, { recursive: true, force: true }); },
  };
}

/**
 * Reopen the same SQLite file with fresh volatile demo state — a restart.
 * `wrapCalendar`/`wrapEmail` decorate the DURABLE adapters, so provider
 * receipts keep persisting through wrapped calls.
 */
function reopen(
  w: World,
  opts: {
    wrapCalendar?: (inner: DurableDemoCalendar) => BookingServiceDeps["calendar"];
    wrapEmail?: (inner: DurableDemoEmail) => BookingServiceDeps["email"];
    now?: () => string;
    seed?: Parameters<typeof createDemoConnectors>[0];
  } = {},
): World {
  const store = new GatherStore(w.path);
  const demo = createDemoConnectors({ calendarSlots: [coveringSlot()], nowMs: () => Date.parse(NOW), ...opts.seed });
  const calendar = new DurableDemoCalendar(store, demo.calendar, () => Date.parse(NOW));
  const email = new DurableDemoEmail(store, demo.email);
  const deps: BookingServiceDeps = {
    store,
    calendar: opts.wrapCalendar === undefined ? calendar : opts.wrapCalendar(calendar),
    email: opts.wrapEmail === undefined ? email : opts.wrapEmail(email),
    ownerId: "test-owner",
    now: opts.now ?? (() => NOW),
  };
  return { dir: w.dir, path: w.path, store, demo, deps, intents: new IntentService({ booking: deps, mode: "prepared", now: opts.now ?? (() => NOW) }), businessId: w.businessId, cleanup: w.cleanup };
}

function seedProposal(w: World, ids: { booking: string; action: string }, payload: Record<string, unknown> = holdPayload()) {
  const booking = w.store.createBooking({
    id: ids.booking,
    businessId: w.businessId,
    eventName: "Fictional test event",
    status: "pending_approval",
    startAt: START,
    endAt: END,
    sourceReferences: [{ kind: "fixture", locator: "demo://test/booking", fictional: true }],
  });
  const action = w.store.createProposedAction({
    id: ids.action,
    bookingId: booking.id,
    kind: "create_provisional_hold",
    payload,
    sourceReferences: [{ kind: "fixture", locator: "demo://test/proposal", fictional: true }],
  });
  return { booking, action };
}

function approveCommand(w: World, actionId: string, bookingId: string) {
  const action = w.store.getProposedAction(actionId);
  return {
    kind: "approve_booking_proposal" as const,
    bookingId,
    proposedActionId: action.id,
    proposalVersion: action.proposalVersion,
    proposalFingerprint: action.proposalFingerprint,
  };
}

function uncertainOutcome(operationKey: string): ConnectorUncertain {
  return {
    status: "uncertain",
    metadata: { operationKey, mode: DEMO_MODE, simulated: true, sourceReferences: [] },
    error: { kind: "timeout_after_success", message: "Simulated lost response after a provider write", retryable: false },
    reconciliationRequired: true,
  };
}

// --------------------------------------------------------------- 002-A01

test("002-A01: duplicate submit returns the same intent; a changed payload under the same key conflicts", async () => {
  const w = world();
  try {
    const { booking, action } = seedProposal(w, { booking: "b-a01", action: "a-a01" });
    const command = approveCommand(w, action.id, booking.id);
    const first = w.intents.enqueue({ command, commandKey: "cmd-approve-1" });
    const second = w.intents.enqueue({ command, commandKey: "cmd-approve-1" });
    assert.equal(second.intent.id, first.intent.id);
    assert.equal(second.duplicate, true);
    // Same key, different payload → conflict, never a second intent.
    assert.throws(
      () => w.intents.enqueue({ command: { ...command, proposalFingerprint: command.proposalFingerprint.replace(/.$/, "0") }, commandKey: "cmd-approve-1" }),
      (error) => error instanceof ServiceError && error.code === "CONFLICT",
    );
    assert.equal(w.intents.list({ bookingId: booking.id }).length, 1);
    await w.intents.drive(first.intent.id, "test");
    assert.equal(w.intents.get(first.intent.id).state, "completed");
  } finally {
    w.cleanup();
  }
});

test("002-A01: concurrent claims have exactly one fenced owner; a stale claim cannot advance", async () => {
  const w = world();
  try {
    const { booking, action } = seedProposal(w, { booking: "b-a01b", action: "a-a01b" });
    const command = approveCommand(w, action.id, booking.id);
    const { intent } = w.intents.enqueue({ command });

    // A second store connection = a second progression participant.
    const store2 = new GatherStore(w.path);
    const demo2 = createDemoConnectors({ calendarSlots: [coveringSlot()], nowMs: () => Date.parse(NOW) });
    const deps2: BookingServiceDeps = { store: store2, calendar: demo2.calendar, email: demo2.email, ownerId: "test-owner", now: () => NOW };
    const intents2 = new IntentService({ booking: deps2, mode: "prepared", now: () => NOW });

    const claimsA = w.intents.claimDue({ owner: "owner-A" });
    const claimsB = intents2.claimDue({ owner: "owner-B" });
    assert.equal(claimsA.length + claimsB.length, 1, "exactly one participant may claim the intent");
    const winner = claimsA.length === 1 ? { service: w.intents, claim: claimsA[0]! } : { service: intents2, claim: claimsB[0]! };
    const loser = claimsA.length === 1 ? intents2 : w.intents;
    assert.equal(winner.claim.intent.id, intent.id);

    // A second claim attempt while the winner's lease is live claims nothing.
    assert.equal(loser.claimDue({ owner: "loser" }).length, 0);

    // The winner advances to completion — exactly once.
    const settled = await winner.service.advance(intent.id, winner.claim.lease);
    assert.equal(settled.state, "completed");
    assert.equal(w.store.listApprovals(action.id).length, 1);
    store2.close();
  } finally {
    w.cleanup();
  }
});

test("002-A01: a claim fenced by reclaim/cancel can no longer write progress", async () => {
  const w = world();
  try {
    const { booking, action } = seedProposal(w, { booking: "b-a01c", action: "a-a01c" });
    const { intent } = w.intents.enqueue({ command: approveCommand(w, action.id, booking.id) });

    // Owner A claims; owner B reclaims behind an expired lease (future clock).
    const claimA = w.intents.claimDue({ owner: "owner-A" })[0]!;
    const later = new IntentService({ booking: w.deps, mode: "prepared", now: () => "2030-06-01T00:10:00.000Z" });
    const claimB = later.claimDue({ owner: "owner-B" })[0]!;
    assert.ok(claimB.lease.fencingToken > claimA.lease.fencingToken, "reclaim must bump the fencing token");

    // A's advance is fenced out: nothing dispatches under a dead claim.
    const seen = await w.intents.advance(intent.id, claimA.lease);
    assert.equal(seen.runId, claimB.lease.runId);
    assert.equal(w.store.listApprovals(action.id).length, 0, "fenced claim wrote an approval");
    assert.equal(w.demo.store.listProvisionalHolds().length, 0);

    // Cancelling fences B too — B's late advance records nothing further.
    const cancelled = w.intents.cancel(intent.id, "test-owner");
    assert.equal(cancelled.intent.state, "cancelled");
    const afterCancel = await later.advance(intent.id, claimB.lease);
    assert.equal(afterCancel.state, "cancelled");
    assert.equal(w.demo.store.listProvisionalHolds().length, 0);
  } finally {
    w.cleanup();
  }
});

// --------------------------------------------------------------- 002-A02

test("002-A02: restart after a retryable email failure preserves the hold and resumes only the email", async () => {
  const w = world();
  const { booking, action } = seedProposal(w, { booking: "b-a02", action: "a-a02" });
  const holdKey = holdOperationKey(action.id, action.proposalVersion);
  const emailKey = emailOperationKey(action.id, action.proposalVersion);
  try {
    // First drive: hold lands durably, the send drops with a retryable
    // transport failure — the intent parks as retryable mid-pipeline.
    let firstSends = 0;
    const failingEmail = {
      sendEmail: async (req: SendEmailRequest): Promise<ConnectorResult<SendEmailResponse>> => {
        firstSends += 1;
        return {
          status: "failed" as const,
          metadata: { operationKey: req.operationKey, mode: DEMO_MODE, simulated: true as const, sourceReferences: [] },
          error: { kind: "transport_error" as const, message: "simulated transport drop before send", retryable: true },
        };
      },
      reconcileSentEmail: (req: OperationRequest) => w.demo.email.reconcileSentEmail(req),
    };
    const first = new IntentService({ booking: { ...w.deps, email: failingEmail }, mode: "prepared", now: () => NOW });
    const { intent } = first.enqueue({ command: approveCommand(w, action.id, booking.id) });
    const parked = await first.drive(intent.id, "owner-A");
    assert.equal(parked.state, "retryable");
    assert.equal(firstSends, 1);
    assert.equal(w.store.getExecutionByIdempotencyKey(holdKey)?.status, "succeeded");
    assert.equal(w.store.getExecutionByIdempotencyKey(emailKey)?.status, "failed");
    assert.equal(w.store.getBooking(booking.id).status, "provisional_hold");

    // Restart: fresh store + fresh demo world on the same file. The hold is
    // preserved by receipt, never re-dispatched; only the email re-runs.
    let holdCalls = 0;
    let secondSends = 0;
    const w2 = reopen(w, {
      wrapCalendar: (inner) => ({
        checkAvailability: (req) => inner.checkAvailability(req),
        createProvisionalHold: async (req: CreateProvisionalHoldRequest): Promise<ConnectorResult<CreateProvisionalHoldResponse>> => {
          holdCalls += 1;
          throw new Error("hold must never re-dispatch");
        },
        reconcileProvisionalHold: (req) => inner.reconcileProvisionalHold(req),
      }),
      wrapEmail: (inner) => ({
        sendEmail: async (req: SendEmailRequest) => {
          secondSends += 1;
          return inner.sendEmail(req);
        },
        reconcileSentEmail: (req: OperationRequest) => inner.reconcileSentEmail(req),
      }),
    });
    const recovery = await w2.intents.recoverInterrupted();
    assert.deepEqual(recovery.recovered, [], "a retryable (not running) intent needs no crash recovery");
    const settled = await w2.intents.drive(intent.id, "owner-B");
    assert.equal(settled.state, "completed");
    assert.equal(holdCalls, 0, "the succeeded hold was never re-dispatched");
    assert.equal(secondSends, 1, "only the eligible email step resumed");
    assert.equal(w2.store.getExecutionByIdempotencyKey(emailKey)?.status, "succeeded");
    assert.equal(w2.store.getBooking(booking.id).status, "provisional_hold");
    assert.equal(w2.demo.store.getSentEmail(emailKey)?.subject, holdPayload().emailSubject);
    assert.ok(w2.store.getProviderReceipt(holdKey));
    assert.ok(w2.store.getProviderReceipt(emailKey));
    w2.store.close();
  } finally {
    w.cleanup();
  }
});

test("002-A02: a process crash mid-dispatch leaves the intent running; recovery holds it honest", async () => {
  const w = world();
  const { booking, action } = seedProposal(w, { booking: "b-a02x", action: "a-a02x" });
  const holdKey = holdOperationKey(action.id, action.proposalVersion);
  const emailKey = emailOperationKey(action.id, action.proposalVersion);
  try {
    // Crash while the email dispatch is in flight: the response — and any
    // receipt — never lands. The intent row stays 'running' under a dead
    // claim; restart recovery checks effects before reclaiming anything.
    let sends = 0;
    const crashEmail = {
      sendEmail: async (_req: SendEmailRequest): Promise<ConnectorResult<SendEmailResponse>> => {
        sends += 1;
        w.store.close(); // the process dies here: nothing durable records the outcome
        throw new Error("simulated process crash mid-dispatch");
      },
      reconcileSentEmail: (req: OperationRequest) => w.demo.email.reconcileSentEmail(req),
    };
    const crashed = new IntentService({ booking: { ...w.deps, email: crashEmail }, mode: "prepared", now: () => NOW });
    const { intent } = crashed.enqueue({ command: approveCommand(w, action.id, booking.id) });
    await assert.rejects(() => crashed.drive(intent.id, "owner-A"));
    assert.equal(sends, 1);

    const dead = new GatherStore(w.path);
    const row = dead.db.prepare("SELECT state, steps_json FROM intents WHERE id = $id").get({ $id: intent.id }) as { state: string; steps_json: string };
    assert.equal(row.state, "running", "the intent was mid-run when the process died");
    const steps = JSON.parse(row.steps_json) as Array<{ name: string; status: string }>;
    assert.deepEqual(steps.map((s) => [s.name, s.status]), [["approve", "done"], ["hold", "done"], ["email", "pending"]]);
    dead.close();

    // Restart with the clock past the dead claim's lease so the pending
    // execution row can be reclaimed; a fresh demo world holds no evidence.
    const w2 = reopen(w, { now: () => "2030-06-01T00:05:00.000Z" });
    const recovery = await w2.intents.recoverInterrupted();
    assert.deepEqual(recovery.recovered, [intent.id]);
    assert.equal(w2.intents.get(intent.id).state, "retryable", "incomplete evidence re-parks for a fresh claim");

    const resumed = await w2.intents.drive(intent.id, "owner-B");
    // The reclaimed email row reconciles by stable key first: the fresh
    // provider world shows no write, so the step stays honestly uncertain —
    // a missing provider record never licenses a blind retry.
    assert.equal(resumed.state, "uncertain");
    assert.equal(w2.store.getExecutionByIdempotencyKey(emailKey)?.status, "uncertain");
    assert.equal(w2.store.getExecutionByIdempotencyKey(holdKey)?.status, "succeeded", "the landed hold survives the crash");
    assert.ok(w2.store.getProviderReceipt(holdKey));
    w2.store.close();
  } finally {
    w.cleanup();
  }
});

test("002-A02: crash after a remote success before the receipt stays uncertain until reconciled", async () => {
  const w = world();
  const { booking, action } = seedProposal(w, { booking: "b-a02b", action: "a-a02b" });
  const emailKey = emailOperationKey(action.id, action.proposalVersion);
  try {
    // The provider write lands but its response is lost, and the first
    // reconciliation read reports nothing (the write is not yet visible) —
    // the intent must stay honestly uncertain.
    let reconcileReads = 0;
    const timeoutWorld = createDemoConnectors({ calendarSlots: [coveringSlot()], nowMs: () => Date.parse(NOW), timeoutAfterSuccessOperationKeys: [emailKey] });
    const timedEmail = {
      sendEmail: (req: SendEmailRequest) => timeoutWorld.email.sendEmail(req),
      reconcileSentEmail: async (req: OperationRequest) => {
        reconcileReads += 1;
        if (reconcileReads === 1) {
          // The provider write is not yet visible to reconciliation.
          return { status: "failed" as const, metadata: { operationKey: req.operationKey, mode: DEMO_MODE, simulated: true as const, sourceReferences: [] }, error: { kind: "not_found" as const, message: "no completed email found", retryable: false } };
        }
        return timeoutWorld.email.reconcileSentEmail(req);
      },
    };
    const timed = new IntentService({ booking: { ...w.deps, email: timedEmail }, mode: "prepared", now: () => NOW });
    const { intent } = timed.enqueue({ command: approveCommand(w, action.id, booking.id) });
    const first = await timed.drive(intent.id, "owner-A");
    assert.equal(first.state, "uncertain");
    assert.equal(w.store.getExecutionByIdempotencyKey(emailKey)?.status, "uncertain");
    assert.equal(w.store.getBooking(booking.id).status, "uncertain");

    // Restart + explicit reconcile by operation key: the provider record is
    // now visible, so the step heals and the intent completes.
    const w2 = reopen(w, {
      wrapEmail: () => ({
        sendEmail: (req: SendEmailRequest) => timeoutWorld.email.sendEmail(req),
        reconcileSentEmail: (req: OperationRequest) => timeoutWorld.email.reconcileSentEmail(req),
      }),
    });
    const report = await w2.intents.reconcile(emailKey);
    assert.equal(report.outcome, "healed");
    const healed = w2.intents.get(intent.id);
    assert.equal(healed.state, "completed");
    assert.equal(w2.store.getExecutionByIdempotencyKey(emailKey)?.status, "succeeded");
    w2.store.close();
  } finally {
    w.cleanup();
  }
});

test("002-A02: a missing provider search result never licenses a blind retry", async () => {
  const w = world();
  const { booking, action } = seedProposal(w, { booking: "b-a02c", action: "a-a02c" });
  const holdKey = holdOperationKey(action.id, action.proposalVersion);
  try {
    // Provider call reports a lost response and the world genuinely holds no
    // write: reconcile finds nothing, so the step must remain uncertain and
    // no second dispatch may occur.
    let createCalls = 0;
    const emptyCalendar = {
      checkAvailability: (req: Parameters<BookingServiceDeps["calendar"]["checkAvailability"]>[0]) => w.demo.calendar.checkAvailability(req),
      createProvisionalHold: async (req: CreateProvisionalHoldRequest): Promise<ConnectorResult<CreateProvisionalHoldResponse>> => {
        createCalls += 1;
        return uncertainOutcome(req.operationKey);
      },
      reconcileProvisionalHold: async (req: OperationRequest) => ({
        status: "failed" as const,
        metadata: { operationKey: req.operationKey, mode: DEMO_MODE, simulated: true as const, sourceReferences: [] },
        error: { kind: "not_found" as const, message: "no provider record", retryable: false },
      }),
    };
    const service = new IntentService({ booking: { ...w.deps, calendar: emptyCalendar }, mode: "prepared", now: () => NOW });
    const { intent } = service.enqueue({ command: approveCommand(w, action.id, booking.id) });
    const first = await service.drive(intent.id, "owner-A");
    assert.equal(first.state, "uncertain");
    assert.equal(createCalls, 1);

    // Restart + re-drive: reconcile-first finds nothing → still uncertain,
    // still exactly one provider dispatch ever.
    const w2 = reopen(w, { wrapCalendar: () => emptyCalendar });
    const second = await w2.intents.drive(intent.id, "owner-B");
    assert.equal(second.state, "uncertain");
    assert.equal(createCalls, 1, "a missing provider record must never trigger a blind retry");
    assert.equal(w2.store.getExecutionByIdempotencyKey(holdKey)?.status, "uncertain");
    w2.store.close();
  } finally {
    w.cleanup();
  }
});

// --------------------------------------------------------------- 002-A03

test("002-A03: cancelled and completed intents retain state on retries", async () => {
  const w = world();
  try {
    const { booking, action } = seedProposal(w, { booking: "b-a03", action: "a-a03" });
    const command = approveCommand(w, action.id, booking.id);

    // Cancel before any drive: replaying the same command returns the same
    // cancelled intent and nothing is dispatched.
    const { intent } = w.intents.enqueue({ command });
    const cancelled = w.intents.cancel(intent.id, "test-owner");
    assert.equal(cancelled.applied, true);
    const replay = w.intents.enqueue({ command });
    assert.equal(replay.intent.id, intent.id);
    assert.equal(replay.intent.state, "cancelled");
    const driven = await w.intents.drive(intent.id, "owner-A");
    assert.equal(driven.state, "cancelled");
    assert.equal(w.store.listApprovals(action.id).length, 0);
    assert.equal(w.demo.store.listProvisionalHolds().length, 0);

    // A completed intent: retries and cancels cannot reopen it.
    const { booking: b2, action: a2 } = seedProposal(w, { booking: "b-a03b", action: "a-a03b" });
    const done = await w.intents.drive(w.intents.enqueue({ command: approveCommand(w, a2.id, b2.id) }).intent.id, "owner-A");
    assert.equal(done.state, "completed");
    w.store.updateBookingStatus(b2.id, "confirmed");
    const lateCancel = w.intents.cancel(done.id, "test-owner");
    assert.equal(lateCancel.applied, false, "a completed intent cannot be cancelled");
    assert.equal(lateCancel.intent.state, "completed");
    assert.equal(w.store.getBooking(b2.id).status, "confirmed", "confirmed bookings never downgrade");
    const redriven = await w.intents.drive(done.id, "owner-A");
    assert.equal(redriven.state, "completed");
    assert.equal(w.demo.store.listProvisionalHolds().length, 1, "no duplicate hold was written");
  } finally {
    w.cleanup();
  }
});

test("002-A03: cancellation between awaits blocks the next effect; landed effects keep their receipts", async () => {
  const w = world();
  const { booking, action } = seedProposal(w, { booking: "b-a03c", action: "a-a03c" });
  const holdKey = holdOperationKey(action.id, action.proposalVersion);
  const emailKey = emailOperationKey(action.id, action.proposalVersion);
  try {
    let intentId = "";
    const cancellingCalendar = {
      checkAvailability: (req: Parameters<BookingServiceDeps["calendar"]["checkAvailability"]>[0]) => w.demo.calendar.checkAvailability(req),
      createProvisionalHold: async (req: CreateProvisionalHoldRequest): Promise<ConnectorResult<CreateProvisionalHoldResponse>> => {
        const result = await w.demo.calendar.createProvisionalHold(req);
        // The owner cancels while the hold call is in flight: the hold keeps
        // its durable receipt, and the email step must never dispatch.
        w.intents.cancel(intentId, "test-owner");
        return result;
      },
      reconcileProvisionalHold: (req: OperationRequest) => w.demo.calendar.reconcileProvisionalHold(req),
    };
    const service = new IntentService({ booking: { ...w.deps, calendar: cancellingCalendar }, mode: "prepared", now: () => NOW });
    const { intent } = service.enqueue({ command: approveCommand(w, action.id, booking.id) });
    intentId = intent.id;
    const settled = await service.drive(intent.id, "owner-A");
    assert.equal(settled.state, "cancelled");
    assert.equal(w.store.getExecutionByIdempotencyKey(holdKey)?.status, "succeeded", "the landed hold keeps its receipt");
    assert.equal(w.store.getExecutionByIdempotencyKey(emailKey), undefined, "the unsent email was blocked");
    assert.equal(w.demo.store.getSentEmail(emailKey), undefined);
    assert.equal(w.demo.store.listProvisionalHolds().length, 1);
    assert.equal(w.store.getBooking(booking.id).status, "provisional_hold");
  } finally {
    w.cleanup();
  }
});

test("002-A03: owner pause via a control intent blocks pending provider effects", async () => {
  const w = world();
  try {
    const { booking, action } = seedProposal(w, { booking: "b-a03d", action: "a-a03d" });
    const pause = w.intents.enqueue({ command: { kind: "owner_control", bookingId: booking.id, control: "pause", dedupeKey: "ctrl-pause-1" } });
    const paused = await w.intents.drive(pause.intent.id, "owner-A");
    assert.equal(paused.state, "completed");
    const ledger = new CoordinationLedger(w.store.db);
    assert.equal(ledger.controlStateForBooking(booking.id), "paused");

    // An approve intent submitted under pause must not dispatch provider writes.
    const approve = w.intents.enqueue({ command: approveCommand(w, action.id, booking.id) });
    const blocked = await w.intents.drive(approve.intent.id, "owner-A");
    assert.equal(blocked.state, "blocked");
    assert.equal(w.demo.store.listProvisionalHolds().length, 0);
    assert.equal(w.demo.store.getSentEmail(emailOperationKey(action.id, action.proposalVersion)), undefined);
  } finally {
    w.cleanup();
  }
});

// --------------------------------------------------------------- misc ports

test("intents: deadline expiry blocks queued work instead of claiming it", async () => {
  const w = world();
  try {
    const { booking, action } = seedProposal(w, { booking: "b-dl", action: "a-dl" });
    const { intent } = w.intents.enqueue({ command: approveCommand(w, action.id, booking.id), deadlineMs: 1000 });
    const later = new IntentService({ booking: w.deps, mode: "prepared", now: () => "2030-06-01T01:00:00.000Z" });
    const claims = later.claimDue({ owner: "late-owner" });
    assert.equal(claims.length, 0);
    assert.equal(later.get(intent.id).state, "blocked");
    assert.equal(w.demo.store.listProvisionalHolds().length, 0);
  } finally {
    w.cleanup();
  }
});

test("intents: enqueue rejects unknown actions, stale versions, and bad shapes", () => {
  const w = world();
  try {
    const { booking, action } = seedProposal(w, { booking: "b-v", action: "a-v" });
    const command = approveCommand(w, action.id, booking.id);
    assert.throws(() => w.intents.enqueue({ command: { ...command, proposedActionId: "nope" } }), ServiceError);
    assert.throws(() => w.intents.enqueue({ command: { ...command, proposalVersion: 99 } }), ServiceError);
    assert.throws(() => w.intents.enqueue({ command, expectedVersion: 2 }), ServiceError);
    // Superseded proposal: enqueueing the old version fails loudly.
    w.store.createProposedAction({
      id: "a-v2", bookingId: booking.id, kind: "create_provisional_hold", payload: holdPayload(),
      sourceReferences: [{ kind: "fixture", locator: "demo://test/proposal2", fictional: true }],
    });
    assert.throws(() => w.intents.enqueue({ command }), (error) => error instanceof ServiceError && error.code === "STALE_PROPOSAL");
  } finally {
    w.cleanup();
  }
});
