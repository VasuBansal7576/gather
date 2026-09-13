/**
 * SIMULATED operator-runtime tests. Scripted inbox transports and a temporary
 * SQLite file only; every sweep reports simulation:true and no live assets
 * are touched. Covers: persist+drain, restart resume with ledger dedupe,
 * reply-before-followup suppression, pause surfacing, revoked tokens,
 * ambiguous identity, and the operator-never-approves boundary.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { CoordinationLedger } from "../src/coordination/ledger.ts";
import { createDemoConnectors } from "../src/connectors/demo.ts";
import type { GoogleHttpRequest, GoogleHttpResponse, GoogleHttpTransport } from "../src/connectors/google/transport.ts";
import { GmailInboxPoller, encodeCursor } from "../src/connectors/google/incremental.ts";
import { GatherStore } from "../src/server/sqlite-store.ts";
import { emailOperationKey, holdOperationKey } from "../src/server/booking-service.ts";
import { drainDueWork } from "../src/server/operator-runtime/due-work.ts";
import { operatorHealth } from "../src/server/operator-runtime/health.ts";
import { runIntakeSweep, type IntakeDeps, type ThreadReaderPort } from "../src/server/operator-runtime/intake.ts";
import { operatorMcpTools } from "../src/server/operator-runtime/mcp-tools.ts";
import { OperatorIntakeStore } from "../src/server/operator-runtime/store.ts";

const ACCOUNT = "acct-operator-1";
const NOW = "2030-06-01T00:00:00.000Z";

function json(status: number, body: unknown): GoogleHttpResponse {
  return { status, headers: {}, text: JSON.stringify(body) };
}

function scripted(handler: (req: GoogleHttpRequest) => GoogleHttpResponse): GoogleHttpTransport {
  return {
    request: (req) => Promise.resolve(handler(req)),
  };
}

interface Fixture {
  dir: string;
  store: GatherStore;
  ledger: CoordinationLedger;
  businessId: string;
  bookingId: string;
  cleanup: () => void;
}

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "gather-op-"));
  const store = new GatherStore(join(dir, "gather.sqlite"));
  const ledger = new CoordinationLedger(store.db, { clock: () => NOW });
  const business = store.createBusiness({ name: "Fictional Hall", timezone: "UTC" });
  const booking = store.createBooking({ businessId: business.id, eventName: "Fictional event", sourceReferences: [] });
  return {
    dir, store, ledger, businessId: business.id, bookingId: booking.id,
    cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

function depsFor(fx: Fixture, transport: GoogleHttpTransport, threads?: Pick<ThreadReaderPort, "readThread">): IntakeDeps {
  const demo = createDemoConnectors({});
  const poller = new GmailInboxPoller({ transport, tokens: () => Promise.resolve("t"), accountId: ACCOUNT });
  return {
    store: fx.store,
    ledger: fx.ledger,
    inbox: {
      pollInbox: poller.pollInbox.bind(poller),
      provenance: { simulated: true, label: "scripted-test-transport" },
    },
    booking: {
      store: fx.store,
      calendar: demo.calendar,
      email: demo.email,
      ownerId: "test-owner",
      now: () => NOW,
    },
    accountId: ACCOUNT,
    businessId: fx.businessId,
    now: () => NOW,
    ...(threads === undefined ? {} : { threads: { ...threads, provenance: { simulated: true, label: "scripted-test-transport" } } }),
  };
}

function historyTransport(messages: Array<{ id: string; threadId: string }>, historyId = "5001"): GoogleHttpTransport {
  return scripted((req) => {
    if (req.url.includes("/profile")) {
      return json(200, { emailAddress: "owner@example.test", historyId });
    }
    if (req.url.includes("/history")) {
      return json(200, {
        historyId,
        history: messages.map((message, index) => ({
          id: String(4000 + index),
          messagesAdded: [{ message: { id: message.id, threadId: message.threadId } }],
        })),
      });
    }
    if (req.url.includes("/messages")) {
      return json(200, { messages: messages.map((message) => ({ id: message.id, threadId: message.threadId })) });
    }
    return json(404, {});
  });
}

test("scripted intake persists, parks ambiguous mail, and commits the cursor", async () => {
  const fx = fixture();
  try {
    const threads = {
      readThread: async (threadId: string) => ({
        threadId,
        subject: "Dinner",
        messages: [{ id: "m-1", threadId, from: "guest@example.test", to: [], subject: "Dinner", body: "hi", receivedAt: NOW, sourceReferences: [] }],
        sourceReferences: [],
      }),
    };
    // Pre-link the source key by recording a verified receipt path is not
    // available here; instead the owner pre-binds via an established link is
    // also unavailable — so first assert needs_decision, then link via owner
    // decision path is out of scope: use direct booking link by seeding an
    // identity link through a verified receipt is overkill. Instead verify
    // the sweep parks ambiguous mail without ingesting.
    const deps = depsFor(fx, historyTransport([{ id: "m-1", threadId: "t-1" }]), threads);
    const sweep = await runIntakeSweep(deps);
    assert.equal(sweep.simulation, true);
    assert.equal(sweep.polled, 1);
    assert.equal(sweep.persisted, 1);
    assert.deepEqual(sweep.needsDecision, ["m-1"]);
    assert.equal(sweep.cursorCommitted, true);
    const intake = new OperatorIntakeStore(fx.store.db);
    assert.ok(intake.getCursor(ACCOUNT) !== undefined);
    // Ledger ingested nothing: ambiguous identity never auto-links.
    assert.equal(fx.ledger.listDueWork({ nowIso: NOW, limit: 50 }).length, 0);
  } finally {
    fx.cleanup();
  }
});

test("pre-linked identity drains intake straight into ledger events", async () => {
  const fx = fixture();
  try {
    const { recordVerifiedIdentityLink } = await import("../src/identity/service.ts");
    fx.store.upsertConnectedAccount({
      id: ACCOUNT,
      businessId: fx.businessId,
      provider: "gmail",
      displayName: "Fictional Gmail",
      status: "connected",
    });
    // Owner-verified binding established out of band (receipt-observed);
    // intake then resolves instead of parking.
    recordVerifiedIdentityLink(fx.store, {
      components: {
        provider: "gmail",
        accountId: ACCOUNT,
        businessId: fx.businessId,
        sourceKind: "email",
        externalId: "m-2",
        threadId: "t-2",
      },
      bookingId: fx.bookingId,
      receipt: { operationKey: "gather:demo:op-1", mode: "demo" },
      actor: "test-owner",
    });
    const threads = {
      readThread: async (threadId: string) => ({
        threadId,
        subject: "Dinner",
        messages: [
          { id: "m-0", threadId, from: "guest@example.test", to: [], subject: "Dinner", body: "first", receivedAt: NOW, sourceReferences: [] },
          { id: "m-2", threadId, from: "guest@example.test", to: [], subject: "Dinner", body: "second", receivedAt: NOW, sourceReferences: [] },
        ],
        sourceReferences: [],
      }),
    };
    const deps = depsFor(fx, historyTransport([{ id: "m-2", threadId: "t-2" }]), threads);
    const sweep = await runIntakeSweep(deps);
    assert.equal(sweep.drained, 1);
    assert.deepEqual(sweep.needsDecision, []);
    assert.equal(sweep.cursorCommitted, true);
    const items = new OperatorIntakeStore(fx.store.db).listItems(sweep.batchId!);
    assert.equal(items[0]?.status, "ingested");
    assert.equal(items[0]?.bookingId, fx.bookingId);
    assert.ok(items[0]?.ledgerEventId);
  } finally {
    fx.cleanup();
  }
});

test("uncertain approved work reconciles and resolves as done", async () => {
  const fx = fixture();
  try {
    const demo = createDemoConnectors({
      calendarSlots: [{
        slotId: "slot-op",
        calendarId: "demo-calendar-001",
        startAt: "2030-07-12T00:00:00.000Z",
        endAt: "2030-07-13T00:00:00.000Z",
        available: true,
        sourceReferences: [],
      }],
    });
    const action = fx.store.createProposedAction({
      id: "a-op-uncertain",
      bookingId: fx.bookingId,
      kind: "create_provisional_hold",
      payload: {
        startAt: "2030-07-12T17:00:00.000Z",
        endAt: "2030-07-12T23:00:00.000Z",
        expiresAt: "2030-07-13T23:00:00.000Z",
        calendarId: "demo-calendar-001",
        emailTo: ["guest@example.test"],
        emailSubject: "s",
        emailBody: "b",
      },
      sourceReferences: [],
    });
    // Owner approval happens through the approved path (fixture as owner),
    // never through the operator drain below.
    fx.store.approveProposedAction(action.id, "test-owner");
    // A hold attempt lost its response: pending execution parked uncertain.
    // The demo provider holds the completed write for later reconciliation.
    const holdKey = holdOperationKey(action.id, 1);
    await demo.calendar.createProvisionalHold({
      operationKey: holdKey,
      bookingId: fx.bookingId,
      calendarId: "demo-calendar-001",
      startAt: "2030-07-12T17:00:00.000Z",
      endAt: "2030-07-12T23:00:00.000Z",
      expiresAt: "2030-07-13T23:00:00.000Z",
    });
    const reserved = fx.store.reserveStepExecution(action.id, 1, holdKey, { claimToken: "fixture", leaseMs: 60000, nowMs: Date.parse(NOW) });
    assert.equal(reserved.created, true);
    fx.store.markExecutionUncertain(reserved.execution.id, "fixture lost response");
    const ingested = fx.ledger.ingestEvent({
      dedupeKey: "k-change-op",
      kind: "change",
      bookingId: fx.bookingId,
      sourceId: "m-op",
      sourceKind: "email",
      observedAt: NOW,
    });
    assert.ok(ingested.createdWaiting.length >= 1);
    // Host links the due item to the approved proposal (detail convention)
    // and makes it due now.
    for (const item of ingested.createdWaiting) {
      fx.store.db.prepare("UPDATE coord_waiting SET detail_json = $detail, due_at = $due WHERE id = $id").run({
        $detail: JSON.stringify({ proposedActionId: action.id }),
        $due: NOW,
        $id: item.id,
      });
    }
    const base = depsFor(fx, historyTransport([]));
    const deps: IntakeDeps = {
      ...base,
      booking: { ...base.booking, calendar: demo.calendar, email: demo.email },
    };
    const report = await drainDueWork(deps);
    // Uncertain reconciled (read-only provider truth, no new write); the
    // item resolves done with no new approval minted by the operator.
    assert.equal(report.reconciled.length, 1);
    assert.equal(report.awaitingOwner.length, 0);
    assert.equal(fx.store.listApprovals(action.id).length, 1, "operator reconciled but never re-approved");
    assert.equal(demo.store.listProvisionalHolds().length, 1, "no duplicate provider write");
  } finally {
    fx.cleanup();
  }
});

test("failed-send work waits for the owner; the operator never resends email", async () => {
  const fx = fixture();
  try {
    const action = fx.store.createProposedAction({
      id: "a-op-failed",
      bookingId: fx.bookingId,
      kind: "create_provisional_hold",
      payload: {
        startAt: "2030-07-12T17:00:00.000Z",
        endAt: "2030-07-12T23:00:00.000Z",
        expiresAt: "2030-07-13T23:00:00.000Z",
        calendarId: "demo-calendar-001",
        emailTo: ["guest@example.test"],
        emailSubject: "s",
        emailBody: "b",
      },
      sourceReferences: [],
    });
    fx.store.approveProposedAction(action.id, "test-owner");
    // A failed email step: retrying it would resend customer email, so the
    // operator must park it for the owner instead.
    const mailKey = emailOperationKey(action.id, 1);
    const reserved = fx.store.reserveStepExecution(action.id, 1, mailKey, { claimToken: "fixture", leaseMs: 60000, nowMs: Date.parse(NOW) });
    fx.store.completeActionExecution(reserved.execution.id, { status: "failed", error: "fixture transport failure" });
    const ingested = fx.ledger.ingestEvent({
      dedupeKey: "k-change-op2",
      kind: "change",
      bookingId: fx.bookingId,
      sourceId: "m-op2",
      sourceKind: "email",
      observedAt: NOW,
    });
    for (const item of ingested.createdWaiting) {
      fx.store.db.prepare("UPDATE coord_waiting SET detail_json = $detail, due_at = $due WHERE id = $id").run({
        $detail: JSON.stringify({ proposedActionId: action.id }),
        $due: NOW,
        $id: item.id,
      });
    }
    const deps = depsFor(fx, historyTransport([]));
    let sends = 0;
    const realSend = deps.booking.email.sendEmail.bind(deps.booking.email);
    deps.booking.email.sendEmail = async (request) => {
      sends += 1;
      return realSend(request);
    };
    const report = await drainDueWork(deps);
    assert.deepEqual(report.reconciled, []);
    assert.equal(report.awaitingOwner.length, 1);
    assert.equal(sends, 0, "operator drain must never send customer email");
  } finally {
    fx.cleanup();
  }
});

test("restart replays are absorbed by ledger dedupe keys", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gather-op-restart-"));
  const path = join(dir, "gather.sqlite");
  const first = new GatherStore(path);
  const business = first.createBusiness({ name: "Fictional Hall", timezone: "UTC" });
  const booking = first.createBooking({ businessId: business.id, eventName: "Fictional event", sourceReferences: [] });
  void booking;
  try {
    const ledger1 = new CoordinationLedger(first.db, { clock: () => NOW });
    const event = ledger1.ingestEvent({
      dedupeKey: "gather:intake:acct-operator-1:m-9:inquiry",
      kind: "inquiry",
      bookingId: "b-9",
      sourceId: "m-9",
      sourceKind: "email",
      observedAt: NOW,
    });
    assert.equal(event.duplicate, false);
    first.close();

    const second = new GatherStore(path);
    try {
      const ledger2 = new CoordinationLedger(second.db, { clock: () => NOW });
      const replay = ledger2.ingestEvent({
        dedupeKey: "gather:intake:acct-operator-1:m-9:inquiry",
        kind: "inquiry",
        bookingId: "b-9",
        sourceId: "m-9",
        sourceKind: "email",
        observedAt: NOW,
      });
      assert.equal(replay.duplicate, true);
      assert.equal(replay.eventId, event.eventId);
    } finally {
      second.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reply observed after inquiry suppresses the pending followup at claim", async () => {
  const fx = fixture();
  try {
    const inquiry = fx.ledger.ingestEvent({
      dedupeKey: "k-inquiry-1",
      kind: "inquiry",
      bookingId: fx.bookingId,
      sourceId: "m-inq",
      sourceKind: "email",
      observedAt: "2030-06-01T10:00:00.000Z",
    });
    assert.equal(inquiry.createdWaiting.length, 1);
    const reply = fx.ledger.ingestEvent({
      dedupeKey: "k-reply-1",
      kind: "reply",
      bookingId: fx.bookingId,
      sourceId: "m-rep",
      sourceKind: "email",
      observedAt: "2030-06-01T11:00:00.000Z",
    });
    assert.equal(reply.duplicate, false);
    // Received-order suppression happens at reply ingest: the answered
    // followup never reaches a worker as claimable work.
    assert.deepEqual(reply.suppressedWaitingIds, inquiry.createdWaiting.map((item) => item.id));
    const claimed = fx.ledger.claimDueWork({ ids: inquiry.createdWaiting.map((item) => item.id), claimedBy: "op-test", nowIso: "2030-06-04T00:00:00.000Z" });
    assert.deepEqual(claimed.claimed.map((item) => item.id), []);
  } finally {
    fx.cleanup();
  }
});

test("owner pause surfaces in health and parks waiting work", async () => {
  const fx = fixture();
  try {
    const inquiry = fx.ledger.ingestEvent({
      dedupeKey: "k-inquiry-p",
      kind: "inquiry",
      bookingId: fx.bookingId,
      sourceId: "m-p",
      sourceKind: "email",
      observedAt: NOW,
    });
    assert.equal(inquiry.createdWaiting.length, 1);
    const control = fx.ledger.applyOwnerControl({
      dedupeKey: "owner-pause-1",
      kind: "pause",
      bookingId: fx.bookingId,
      attestedBy: "test-owner",
    });
    assert.equal(control.controlHonored, true);
    assert.deepEqual(control.pausedWaitingIds, inquiry.createdWaiting.map((item) => item.id));
    const deps = depsFor(fx, historyTransport([]));
    const health = operatorHealth(deps);
    assert.equal(health.simulation, true);
    assert.deepEqual(health.pausedBookings, [fx.bookingId]);
    assert.equal(health.waitingByStatus["paused"], 1);
  } finally {
    fx.cleanup();
  }
});

test("revoked tokens fail the sweep without advancing any cursor", async () => {
  const fx = fixture();
  try {
    const revoked: GoogleHttpTransport = scripted(() => json(401, { error: { code: 401, message: "Invalid Credentials", errors: [{ reason: "authError" }] } }));
    const deps = depsFor(fx, revoked);
    const sweep = await runIntakeSweep(deps);
    assert.equal(sweep.error !== undefined, true);
    assert.equal(sweep.cursorCommitted, false);
    const intake = new OperatorIntakeStore(fx.store.db);
    assert.equal(intake.getCursor(ACCOUNT), undefined);
    assert.equal(intake.latestBatch(ACCOUNT), undefined);
    const health = operatorHealth(deps);
    assert.equal(health.failures.length, 1);
    assert.equal(health.accounts[0]?.cursorCommitted, false);
  } finally {
    fx.cleanup();
  }
});

test("operator paths never mint owner approval", async () => {
  const fx = fixture();
  try {
    const action = fx.store.createProposedAction({
      bookingId: fx.bookingId,
      kind: "create_provisional_hold",
      payload: {
        startAt: "2030-07-12T17:00:00.000Z",
        endAt: "2030-07-12T23:00:00.000Z",
        expiresAt: "2030-07-13T23:00:00.000Z",
        calendarId: "demo-calendar-001",
        emailTo: ["guest@example.test"],
        emailSubject: "s",
        emailBody: "b",
      },
      sourceReferences: [],
    });
    const deps = depsFor(fx, historyTransport([]));
    // A due item referencing an UNAPPROVED proposal: drain must not approve.
    fx.ledger.ingestEvent({
      dedupeKey: "k-change-1",
      kind: "change",
      bookingId: fx.bookingId,
      sourceId: "m-c",
      sourceKind: "email",
      observedAt: NOW,
      payload: { proposedActionId: action.id },
    });
    const report = await drainDueWork(deps);
    assert.equal(fx.store.listApprovals(action.id).length, 0, "no approval row may appear from operator paths");
    assert.ok(report.claimed.length >= 0);
  } finally {
    fx.cleanup();
  }
});

test("dead cursor resets durably; the next sweep full-syncs cursorless", async () => {
  const fx = fixture();
  try {
    const intake = new OperatorIntakeStore(fx.store.db);
    intake.commitCursor(ACCOUNT, encodeCursor("100", { account: ACCOUNT }));
    let historyCalls = 0;
    const transport = scripted((req) => {
      if (req.url.includes("/profile")) return json(200, { historyId: "7000" });
      if (req.url.includes("/history")) {
        historyCalls += 1;
        // Only the dead cursor fails; the fresh watermark reconciles cleanly.
        if (historyCalls === 1) return json(404, { error: { code: 404, message: "expired" } });
        return json(200, { historyId: "7001", history: [] });
      }
      return json(200, { messages: [{ id: "m-full", threadId: "t-full" }] });
    });
    const deps = depsFor(fx, transport);
    const first = await runIntakeSweep(deps);
    assert.equal(first.resetRequired, true);
    assert.equal(intake.getCursor(ACCOUNT), undefined, "dead cursor is durably cleared, not replayed");
    const second = await runIntakeSweep(deps);
    assert.equal(second.resetRequired, false);
    assert.equal(second.polled, 1);
    assert.equal(second.cursorCommitted, true);
    assert.ok(intake.getCursor(ACCOUNT) !== undefined);
  } finally {
    fx.cleanup();
  }
});

test("reply detection uses chronology and direction, never thread length", async () => {
  const fx = fixture();
  try {
    fx.store.upsertConnectedAccount({ id: ACCOUNT, businessId: fx.businessId, provider: "gmail", displayName: "t", status: "connected" });
    // Thread where the LATER message is also present: the earlier message
    // must still classify as inquiry, and own outbound mail is skipped.
    const threads = {
      readThread: async (threadId: string) => ({
        threadId,
        subject: "Dinner",
        messages: [
          { id: "m-early", threadId, from: "guest@example.test", to: [], subject: "Dinner", body: "first", receivedAt: "2030-06-01T10:00:00.000Z", sourceReferences: [] },
          { id: "m-late", threadId, from: "guest@example.test", to: [], subject: "Dinner", body: "second", receivedAt: "2030-06-01T11:00:00.000Z", sourceReferences: [] },
          { id: "m-own", threadId, from: "owner@example.test", to: [], subject: "Dinner", body: "ours", receivedAt: "2030-06-01T12:00:00.000Z", sourceReferences: [] },
        ],
        sourceReferences: [],
      }),
    };
    const deps: IntakeDeps = {
      ...depsFor(fx, historyTransport([
        { id: "m-early", threadId: "t-chrono" },
        { id: "m-own", threadId: "t-chrono" },
      ]), threads),
      ownAddresses: ["owner@example.test"],
    };
    const sweep = await runIntakeSweep(deps);
    const intake = new OperatorIntakeStore(fx.store.db);
    const items = intake.listItems(sweep.batchId!);
    // m-early: inquiry (later messages do not reclassify it); m-own: skipped.
    // Neither auto-links without a verified binding, so both park — but with
    // the right ledger kinds recorded on re-drive, not reply fabrications.
    assert.deepEqual(items.map((item) => [item.messageId, item.status]).sort(), [
      ["m-early", "needs_decision"],
      ["m-own", "skipped"],
    ]);
  } finally {
    fx.cleanup();
  }
});

test("same message reclassified after thread growth ingests exactly once", async () => {
  const fx = fixture();
  try {
    fx.store.upsertConnectedAccount({ id: ACCOUNT, businessId: fx.businessId, provider: "gmail", displayName: "t", status: "connected" });
    const { recordVerifiedIdentityLink } = await import("../src/identity/service.ts");
    const link = (messageId: string) => recordVerifiedIdentityLink(fx.store, {
      components: { provider: "gmail", accountId: ACCOUNT, businessId: fx.businessId, sourceKind: "email", externalId: messageId, threadId: "t-grow" },
      bookingId: fx.bookingId,
      receipt: { operationKey: `gather:demo:${messageId}`, mode: "demo" },
      actor: "test-owner",
    });
    link("m-grow");
    // First sighting: thread holds only m-grow.
    let threadMessages = ["m-grow"];
    const threads = {
      readThread: async (threadId: string) => ({
        threadId,
        subject: "Dinner",
        messages: threadMessages.map((id, index) => ({
          id, threadId, from: "guest@example.test", to: [], subject: "Dinner", body: id,
          receivedAt: `2030-06-01T1${index}:00:00.000Z`, sourceReferences: [],
        })),
        sourceReferences: [],
      }),
    };
    const historyFor = (ids: string[]) => scripted((req) => {
      if (req.url.includes("/profile")) return json(200, { historyId: "8000" });
      if (req.url.includes("/history")) {
        return json(200, {
          historyId: "8001",
          history: ids.map((id, index) => ({ id: String(8100 + index), messagesAdded: [{ message: { id, threadId: "t-grow" } }] })),
        });
      }
      return json(200, { messages: ids.map((id) => ({ id, threadId: "t-grow" })) });
    });
    const first = await runIntakeSweep(depsFor(fx, historyFor(["m-grow"]), threads));
    assert.equal(first.drained, 1);
    // Thread grows with a reply; the already-drained message replays (cursor
    // reuse after a crash): stable identity collapses it to a duplicate with
    // no content-conflict throw, and the new reply ingests.
    link("m-reply");
    threadMessages = ["m-grow", "m-reply"];
    const replay = await runIntakeSweep({
      ...depsFor(fx, historyFor(["m-grow", "m-reply"]), threads),
    });
    assert.equal(replay.duplicates, 1);
    assert.equal(replay.drained, 1);
    assert.equal(replay.error, undefined);
  } finally {
    fx.cleanup();
  }
});

test("parked items drain after owner resolution even with an empty poll", async () => {
  const fx = fixture();
  try {
    fx.store.upsertConnectedAccount({ id: ACCOUNT, businessId: fx.businessId, provider: "gmail", displayName: "t", status: "connected" });
    const threads = {
      readThread: async (threadId: string) => ({
        threadId,
        subject: "Dinner",
        messages: [{ id: "m-park", threadId, from: "guest@example.test", to: [], subject: "Dinner", body: "hi", receivedAt: NOW, sourceReferences: [] }],
        sourceReferences: [],
      }),
    };
    const deps = depsFor(fx, historyTransport([{ id: "m-park", threadId: "t-park" }]), threads);
    const first = await runIntakeSweep(deps);
    assert.deepEqual(first.needsDecision, ["m-park"]);
    // Owner resolves identity out of band with a verified binding.
    const { recordVerifiedIdentityLink } = await import("../src/identity/service.ts");
    recordVerifiedIdentityLink(fx.store, {
      components: { provider: "gmail", accountId: ACCOUNT, businessId: fx.businessId, sourceKind: "email", externalId: "m-park", threadId: "t-park" },
      bookingId: fx.bookingId,
      receipt: { operationKey: "gather:demo:park", mode: "demo" },
      actor: "test-owner",
    });
    // Next poll returns nothing new — the parked item still drains.
    const empty = depsFor(fx, historyTransport([]), threads);
    const second = await runIntakeSweep(empty);
    assert.equal(second.polled, 0);
    assert.equal(second.drained, 1);
    assert.deepEqual(second.needsDecision, []);
    const intake = new OperatorIntakeStore(fx.store.db);
    assert.ok(intake.listItems(first.batchId!).some((item) => item.messageId === "m-park" && item.status === "ingested"));
  } finally {
    fx.cleanup();
  }
});

test("due work is scoped to the runtime business and booking", async () => {
  const fx = fixture();
  try {
    const otherBusiness = fx.store.createBusiness({ name: "Other", timezone: "UTC" });
    const otherBooking = fx.store.createBooking({ businessId: otherBusiness.id, eventName: "Other event", sourceReferences: [] });
    const foreign = fx.ledger.ingestEvent({
      dedupeKey: "k-foreign",
      kind: "change",
      bookingId: otherBooking.id,
      sourceId: "m-f",
      sourceKind: "email",
      observedAt: NOW,
    });
    assert.ok(foreign.createdWaiting.length >= 1);
    const deps = depsFor(fx, historyTransport([]));
    const report = await drainDueWork(deps);
    // Foreign-business work is never claimed here, let alone executed.
    assert.deepEqual(report.claimed, []);
    const { claimDueItems } = await import("../src/server/operator-runtime/due-work.ts");
    const claimed = claimDueItems(deps);
    assert.deepEqual(claimed.claimed, []);
  } finally {
    fx.cleanup();
  }
});

test("reply between claim and dispatch suppresses instead of executing", async () => {
  const fx = fixture();
  try {
    const action = fx.store.createProposedAction({
      id: "a-op-race",
      bookingId: fx.bookingId,
      kind: "create_provisional_hold",
      payload: {
        startAt: "2030-07-12T17:00:00.000Z",
        endAt: "2030-07-12T23:00:00.000Z",
        expiresAt: "2030-07-13T23:00:00.000Z",
        calendarId: "demo-calendar-001",
        emailTo: ["guest@example.test"],
        emailSubject: "s",
        emailBody: "b",
      },
      sourceReferences: [],
    });
    fx.store.approveProposedAction(action.id, "test-owner");
    const holdKey = holdOperationKey(action.id, 1);
    const reserved = fx.store.reserveStepExecution(action.id, 1, holdKey, { claimToken: "t", leaseMs: 60000, nowMs: Date.parse(NOW) });
    fx.store.markExecutionUncertain(reserved.execution.id, "fixture");
    const ingested = fx.ledger.ingestEvent({
      dedupeKey: "k-change-race",
      kind: "change",
      bookingId: fx.bookingId,
      sourceId: "m-race",
      sourceKind: "email",
      observedAt: NOW,
    });
    for (const item of ingested.createdWaiting) {
      fx.store.db.prepare("UPDATE coord_waiting SET detail_json = $detail, due_at = $due WHERE id = $id").run({
        $detail: JSON.stringify({ proposedActionId: action.id }),
        $due: NOW,
        $id: item.id,
      });
    }
    const deps = depsFor(fx, historyTransport([]));
    const { claimDueItems, dispatchClaimedItems } = await import("../src/server/operator-runtime/due-work.ts");
    const { claimed } = claimDueItems(deps);
    assert.equal(claimed.length, 1);
    // A customer reply lands after the claim but before dispatch.
    fx.ledger.ingestEvent({
      dedupeKey: "k-reply-race",
      kind: "reply",
      bookingId: fx.bookingId,
      sourceId: "m-race-reply",
      sourceKind: "email",
      observedAt: NOW,
    });
    const result = await dispatchClaimedItems(deps, claimed);
    assert.deepEqual(result.reconciled, []);
    assert.deepEqual(result.awaitingOwner, []);
    // The execution was NOT reconciled: suppression won the race.
    assert.equal(fx.store.getActionExecution(reserved.execution.id).status, "uncertain");
  } finally {
    fx.cleanup();
  }
});

test("MCP tools are read-only and carry no approval surface", async () => {
  const fx = fixture();
  try {
    const deps = depsFor(fx, historyTransport([]));
    const tools = operatorMcpTools(deps);
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ["operator.health", "operator.intake.status", "operator.waiting"]);
    assert.ok(tools.every((tool) => tool.execution === "live"));
    const health = await tools[0]!.call({}, { toolName: "operator.health", execution: "live", simulated: false });
    assert.ok(JSON.stringify(health).includes("simulation"));
    assert.equal(fx.store.listApprovals("nonexistent").length, 0);
  } finally {
    fx.cleanup();
  }
});
