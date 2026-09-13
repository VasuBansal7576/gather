import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { CoordinationLedger } from "../src/coordination/ledger.ts";

const INQUIRY_OBSERVED = "2030-04-01T10:00:00.000Z";
const AFTER_FOLLOWUP_DUE = "2030-04-04T10:00:00.000Z";

function tempDb(): { path: string; db: DatabaseSync; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), "gather-coord-"));
  const path = join(directory, "gather.sqlite");
  const db = new DatabaseSync(path);
  return {
    path,
    db,
    cleanup: () => {
      try {
        db.close();
      } catch {
        // Best-effort close before removing the temp directory.
      }
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function inquiryEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dedupeKey: "evt-inquiry-001",
    kind: "inquiry",
    bookingId: "booking-001",
    sourceId: "thread-abc",
    sourceKind: "email",
    observedAt: INQUIRY_OBSERVED,
    payload: { followupDueAt: "2030-04-03T10:00:00.000Z" },
    ...overrides,
  };
}

test("inquiry intake creates durable followup work that survives close/reopen (restart)", () => {
  const { path, db, cleanup } = tempDb();
  try {
    const first = new CoordinationLedger(db);
    const result = first.ingestEvent(inquiryEvent());
    assert.equal(result.duplicate, false);
    assert.equal(result.stale, false);
    assert.equal(result.createdWaiting.length, 1);
    assert.equal(result.createdWaiting[0]?.kind, "followup");
    assert.equal(result.createdWaiting[0]?.requiresApproval, true);
    assert.equal(result.createdWaiting[0]?.requiresFreshCheck, true);
    db.close();

    const reopened = new DatabaseSync(path);
    try {
      const second = new CoordinationLedger(reopened);
      const due = second.listDueWork({ nowIso: AFTER_FOLLOWUP_DUE });
      assert.equal(due.length, 1);
      assert.equal(due[0]?.bookingId, "booking-001");
      assert.equal(due[0]?.recommendedAction, "draft_followup_for_approval");
      // Restart must not duplicate: re-ingesting the same evidence is a no-op.
      const repeat = second.ingestEvent(inquiryEvent());
      assert.equal(repeat.duplicate, true);
      assert.equal(second.listWaitingForBooking("booking-001").length, 1);
    } finally {
      reopened.close();
    }
  } finally {
    cleanup();
  }
});

test("duplicate events are idempotent and leave a single waiting item", () => {
  const { db, cleanup } = tempDb();
  try {
    const ledger = new CoordinationLedger(db);
    const first = ledger.ingestEvent(inquiryEvent());
    const second = ledger.ingestEvent(inquiryEvent());
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(second.eventId, first.eventId);
    assert.equal(ledger.listWaitingForBooking("booking-001").length, 1);
  } finally {
    cleanup();
  }
});

test("a reply observed before the followup due date suppresses the reminder", () => {
  const { db, cleanup } = tempDb();
  try {
    const ledger = new CoordinationLedger(db);
    ledger.ingestEvent(inquiryEvent());
    const suppressed = ledger.ingestEvent({
      dedupeKey: "evt-reply-001",
      kind: "reply",
      bookingId: "booking-001",
      sourceId: "msg-reply-9",
      sourceKind: "email",
      observedAt: "2030-04-02T09:00:00.000Z",
    });
    assert.deepEqual(suppressed.suppressedWaitingIds.length, 1);
    assert.equal(ledger.listDueWork({ nowIso: AFTER_FOLLOWUP_DUE }).length, 0);
    const [waiting] = ledger.listWaitingForBooking("booking-001");
    assert.equal(waiting?.status, "suppressed");
  } finally {
    cleanup();
  }
});

test("late change with an older revision is stale; a newer revision invalidates prior review", () => {
  const { db, cleanup } = tempDb();
  try {
    const ledger = new CoordinationLedger(db);
    ledger.ingestEvent({
      dedupeKey: "evt-change-002",
      kind: "change",
      bookingId: "booking-002",
      sourceId: "rev-2",
      sourceKind: "email",
      observedAt: "2030-04-02T10:00:00.000Z",
      revision: 2,
    });
    const late = ledger.ingestEvent({
      dedupeKey: "evt-change-001-late",
      kind: "change",
      bookingId: "booking-002",
      sourceId: "rev-1",
      sourceKind: "email",
      observedAt: "2030-04-01T10:00:00.000Z",
      revision: 1,
    });
    assert.equal(late.stale, true);
    assert.equal(late.createdWaiting.length, 0);

    const newer = ledger.ingestEvent({
      dedupeKey: "evt-change-003",
      kind: "change",
      bookingId: "booking-002",
      sourceId: "rev-3",
      sourceKind: "email",
      observedAt: "2030-04-03T10:00:00.000Z",
      revision: 3,
    });
    assert.equal(newer.invalidatedWaitingIds.length, 1);
    const items = ledger.listWaitingForBooking("booking-002");
    const invalidated = items.filter((item) => item.status === "invalidated");
    const pending = items.filter((item) => item.status === "pending");
    assert.equal(invalidated.length, 1);
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.revision, 3);
  } finally {
    cleanup();
  }
});

test("owner control pauses, resumes, and cancels through host attestation", () => {
  const { db, cleanup } = tempDb();
  try {
    const ledger = new CoordinationLedger(db);
    ledger.ingestEvent(inquiryEvent());
    const paused = ledger.applyOwnerControl({
      dedupeKey: "ctrl-pause-001",
      kind: "pause",
      bookingId: "booking-001",
      attestedBy: "fictional-owner",
    });
    assert.equal(paused.controlHonored, true);
    assert.equal(paused.duplicate, false);
    assert.equal(paused.pausedWaitingIds.length, 1);
    assert.equal(ledger.controlStateForBooking("booking-001"), "paused");
    assert.equal(ledger.listDueWork({ nowIso: AFTER_FOLLOWUP_DUE }).length, 0);

    const resumed = ledger.applyOwnerControl({
      dedupeKey: "ctrl-resume-001",
      kind: "resume",
      bookingId: "booking-001",
      attestedBy: "fictional-owner",
    });
    assert.equal(resumed.controlHonored, true);
    assert.equal(resumed.resumedWaitingIds.length, 1);
    assert.equal(ledger.controlStateForBooking("booking-001"), "active");
    assert.equal(ledger.listDueWork({ nowIso: AFTER_FOLLOWUP_DUE }).length, 1);

    const cancelled = ledger.applyOwnerControl({
      dedupeKey: "ctrl-cancel-001",
      kind: "cancel",
      bookingId: "booking-001",
      attestedBy: "fictional-owner",
    });
    assert.equal(cancelled.controlHonored, true);
    assert.equal(cancelled.invalidatedWaitingIds.length, 1);
    assert.equal(ledger.controlStateForBooking("booking-001"), "cancelled");
    assert.equal(ledger.listDueWork({ nowIso: AFTER_FOLLOWUP_DUE }).length, 0);

    // Cancellation is terminal: resume is refused, and redelivery is idempotent.
    assert.throws(
      () => ledger.applyOwnerControl({ dedupeKey: "ctrl-resume-002", kind: "resume", bookingId: "booking-001", attestedBy: "fictional-owner" }),
      /terminal/,
    );
    const repeat = ledger.applyOwnerControl({ dedupeKey: "ctrl-cancel-001", kind: "cancel", bookingId: "booking-001", attestedBy: "fictional-owner" });
    assert.equal(repeat.duplicate, true);
  } finally {
    cleanup();
  }
});

test("due work for a paused business or cancelled booking stays out of the drain", () => {
  const { db, cleanup } = tempDb();
  try {
    db.exec(`
      CREATE TABLE businesses (id TEXT PRIMARY KEY, status TEXT NOT NULL);
      CREATE TABLE bookings (id TEXT PRIMARY KEY, business_id TEXT NOT NULL, status TEXT NOT NULL);
      INSERT INTO businesses (id, status) VALUES ('biz-paused', 'paused');
      INSERT INTO bookings (id, business_id, status) VALUES ('booking-paused', 'biz-paused', 'inquiry');
    `);
    const ledger = new CoordinationLedger(db);
    ledger.ingestEvent(inquiryEvent({ dedupeKey: "evt-paused-biz", bookingId: "booking-paused" }));
    assert.equal(ledger.listDueWork({ nowIso: AFTER_FOLLOWUP_DUE }).length, 0);

    db.exec(`UPDATE businesses SET status = 'active' WHERE id = 'biz-paused'`);
    assert.equal(ledger.listDueWork({ nowIso: AFTER_FOLLOWUP_DUE }).length, 1);

    db.exec(`UPDATE bookings SET status = 'cancelled' WHERE id = 'booking-paused'`);
    assert.equal(ledger.listDueWork({ nowIso: AFTER_FOLLOWUP_DUE }).length, 0);
  } finally {
    cleanup();
  }
});

test("payment message text is evidence only and never verifies the deposit", () => {
  const { db, cleanup } = tempDb();
  try {
    const ledger = new CoordinationLedger(db);
    const result = ledger.ingestEvent({
      dedupeKey: "evt-pay-001",
      kind: "payment_signal",
      bookingId: "booking-003",
      sourceId: "msg-paid-claim",
      sourceKind: "email",
      observedAt: "2030-04-02T10:00:00.000Z",
      payload: { text: "we already paid, confirm us" },
    });
    assert.equal(result.createdWaiting.length, 1);
    assert.equal(result.createdWaiting[0]?.kind, "deposit_check");
    assert.equal(result.createdWaiting[0]?.detail.verifiedPayment, false);
    assert.equal(result.createdWaiting[0]?.recommendedAction, "verify_deposit_against_authoritative_receipt");
    assert.equal(result.createdWaiting[0]?.requiresFreshCheck, true);
  } finally {
    cleanup();
  }
});

test("claims are concurrency-safe: only the first claimant wins", () => {
  const { db, cleanup } = tempDb();
  try {
    const ledger = new CoordinationLedger(db);
    ledger.ingestEvent(inquiryEvent());
    const [due] = ledger.listDueWork({ nowIso: AFTER_FOLLOWUP_DUE });
    assert.ok(due);
    const first = ledger.claimDueWork({ ids: [due.id], claimedBy: "worker-a", nowIso: AFTER_FOLLOWUP_DUE });
    assert.equal(first.claimed.length, 1);
    assert.deepEqual(first.skippedIds, []);
    assert.ok(first.claimed[0]?.claimToken);
    const second = ledger.claimDueWork({ ids: [due.id], claimedBy: "worker-b", nowIso: AFTER_FOLLOWUP_DUE });
    assert.equal(second.claimed.length, 0);
    assert.deepEqual(second.skippedIds, [due.id]);
    // A stale worker without the fencing token cannot complete the claim.
    assert.throws(() => ledger.resolveWaiting({ id: due.id, resolution: "done" }), /stale claim token/);
    assert.throws(
      () => ledger.resolveWaiting({ id: due.id, resolution: "done", claimToken: "wrong-token" }),
      /stale claim token/,
    );
    const resolved = ledger.resolveWaiting({
      id: due.id,
      resolution: "done",
      note: "followup approved and sent",
      claimToken: first.claimed[0]?.claimToken,
    });
    assert.equal(resolved.status, "done");
  } finally {
    cleanup();
  }
});

test("unknown-boundary validation rejects malformed intake and drain calls", () => {
  const { db, cleanup } = tempDb();
  try {
    const ledger = new CoordinationLedger(db);
    assert.throws(() => ledger.ingestEvent({ kind: "inquiry" }), /dedupeKey/);
    assert.throws(
      () =>
        ledger.ingestEvent({
          dedupeKey: "bad",
          kind: "teleport",
          bookingId: "b",
          sourceId: "s",
          sourceKind: "email",
          observedAt: INQUIRY_OBSERVED,
        }),
      /kind/,
    );
    assert.throws(() => ledger.listDueWork({ nowIso: "not-a-date" }), /nowIso/);
    assert.throws(() => ledger.claimDueWork({ ids: [], claimedBy: "w", nowIso: AFTER_FOLLOWUP_DUE }), /ids/);
    assert.throws(
      () => ledger.applyOwnerControl({ dedupeKey: "x", kind: "pause", bookingId: "b" }),
      /attestedBy/,
    );
    assert.throws(
      () => ledger.recordVerifiedReceipt({ dedupeKey: "x", bookingId: "b", receiptLocator: "r" }),
      /verifiedBy/,
    );
  } finally {
    cleanup();
  }
});

test("dedupe-key reuse with different content is a conflict, not a silent collision", () => {
  const { db, cleanup } = tempDb();
  try {
    const ledger = new CoordinationLedger(db);
    ledger.ingestEvent(inquiryEvent());
    // Same booking, same key, different source: conflict.
    assert.throws(
      () => ledger.ingestEvent(inquiryEvent({ sourceId: "thread-different" })),
      /different content/,
    );
    // No extra waiting was created by the rejected reuse.
    assert.equal(ledger.listWaitingForBooking("booking-001").length, 1);
  } finally {
    cleanup();
  }
});

test("dedupe keys are scoped per booking: the same provider key serves two bookings", () => {
  const { db, cleanup } = tempDb();
  try {
    const ledger = new CoordinationLedger(db);
    ledger.ingestEvent(inquiryEvent({ dedupeKey: "email:shared-thread", bookingId: "booking-a" }));
    // Same provider thread linked to a second booking: separate row, no conflict.
    const second = ledger.ingestEvent(inquiryEvent({ dedupeKey: "email:shared-thread", bookingId: "booking-b" }));
    assert.equal(second.duplicate, false);
    assert.equal(ledger.listWaitingForBooking("booking-a").length, 1);
    assert.equal(ledger.listWaitingForBooking("booking-b").length, 1);
  } finally {
    cleanup();
  }
});

test("legacy global-unique dedupe tables upgrade with data preserved", () => {
  const { db, cleanup } = tempDb();
  try {
    // Simulate the pre-scoped schema from the earlier milestone.
    db.exec(`
      CREATE TABLE coord_events (
        id TEXT PRIMARY KEY,
        dedupe_key TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        booking_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        revision INTEGER,
        payload_json TEXT NOT NULL,
        stale INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO coord_events
        (id, dedupe_key, kind, booking_id, source_id, source_kind, observed_at, received_at, revision, payload_json, stale)
        VALUES ('evt-legacy-1', 'email:legacy', 'inquiry', 'booking-legacy', 's', 'email',
          '2030-04-01T10:00:00.000Z', '2030-04-01T10:00:00.000Z', NULL, '{}', 0);
    `);
    const ledger = new CoordinationLedger(db);
    const preserved = ledger.getEventByDedupeKey("booking-legacy", "email:legacy");
    assert.equal(preserved.id, "evt-legacy-1");
    // The same provider key now serves a second booking (scoped uniqueness).
    const second = ledger.ingestEvent(inquiryEvent({ dedupeKey: "email:legacy", bookingId: "booking-new" }));
    assert.equal(second.duplicate, false);
  } finally {
    cleanup();
  }
});

test("claim rechecks reply suppression atomically: a reply after the snapshot wins", () => {
  const { db, cleanup } = tempDb();
  try {
    const ledger = new CoordinationLedger(db);
    ledger.ingestEvent(inquiryEvent());
    const [due] = ledger.listDueWork({ nowIso: AFTER_FOLLOWUP_DUE });
    assert.ok(due);
    // Reply arrives after the drain snapshot but before the claim.
    ledger.ingestEvent({
      dedupeKey: "evt-reply-late",
      kind: "reply",
      bookingId: "booking-001",
      sourceId: "msg-reply-late",
      sourceKind: "email",
      observedAt: "2030-04-02T09:00:00.000Z",
    });
    const claim = ledger.claimDueWork({ ids: [due.id], claimedBy: "worker-a", nowIso: AFTER_FOLLOWUP_DUE });
    assert.equal(claim.claimed.length, 0);
    // The reply already suppressed it at ingest; the claim stays consistent either way.
    const [waiting] = ledger.listWaitingForBooking("booking-001");
    assert.equal(waiting?.status, "suppressed");
  } finally {
    cleanup();
  }
});

test("a reply received before its followup leaves fresh work claimable", () => {
  const { db, cleanup } = tempDb();
  try {
    // Deterministic received order via injected clock: reply received at T1,
    // followup created at T2. Same-millisecond wall clocks must not decide.
    let now = "2030-04-02T09:00:00.000Z";
    const ledger = new CoordinationLedger(db, { clock: () => now });
    // Reply ingested first (no followup yet), then the inquiry: received
    // order puts the reply before the followup, so the fresh inquiry still
    // raises claimable work instead of inheriting a stale suppression.
    ledger.ingestEvent({
      dedupeKey: "evt-reply-first",
      kind: "reply",
      bookingId: "booking-010",
      sourceId: "msg-early",
      sourceKind: "email",
      observedAt: "2030-04-02T09:00:00.000Z",
    });
    now = "2030-04-02T09:00:00.001Z";
    ledger.ingestEvent(inquiryEvent({ dedupeKey: "evt-inquiry-010", bookingId: "booking-010" }));
    const [due] = ledger.listDueWork({ nowIso: AFTER_FOLLOWUP_DUE, bookingId: "booking-010" });
    assert.ok(due);
    const claim = ledger.claimDueWork({ ids: [due.id], claimedBy: "worker-a", nowIso: AFTER_FOLLOWUP_DUE });
    assert.equal(claim.claimed.length, 1);
    assert.deepEqual(claim.suppressedIds, []);
  } finally {
    cleanup();
  }
});

test("expired claims are released for recovery and old tokens stay fenced", () => {
  const { db, cleanup } = tempDb();
  try {
    const ledger = new CoordinationLedger(db);
    ledger.ingestEvent(inquiryEvent());
    const [due] = ledger.listDueWork({ nowIso: AFTER_FOLLOWUP_DUE });
    assert.ok(due);
    const first = ledger.claimDueWork({ ids: [due.id], claimedBy: "worker-a", nowIso: AFTER_FOLLOWUP_DUE, leaseMs: 1000 });
    const staleToken = first.claimed[0]?.claimToken;
    assert.ok(staleToken);
    const released = ledger.releaseStaleClaims({ nowIso: "2030-04-05T10:00:00.000Z" });
    assert.deepEqual(released, [due.id]);
    assert.equal(ledger.listDueWork({ nowIso: "2030-04-05T10:00:00.000Z" }).length, 1);
    const second = ledger.claimDueWork({ ids: [due.id], claimedBy: "worker-b", nowIso: "2030-04-05T10:00:00.000Z" });
    assert.equal(second.claimed.length, 1);
    assert.throws(
      () => ledger.resolveWaiting({ id: due.id, resolution: "done", claimToken: staleToken }),
      /stale claim token/,
    );
    const resolved = ledger.resolveWaiting({
      id: due.id,
      resolution: "done",
      claimToken: second.claimed[0]?.claimToken,
    });
    assert.equal(resolved.status, "done");
  } finally {
    cleanup();
  }
});

test("untrusted customer cancel requests are decisions, not authority", () => {
  const { db, cleanup } = tempDb();
  try {
    const ledger = new CoordinationLedger(db);
    ledger.ingestEvent(inquiryEvent());
    const result = ledger.ingestEvent({
      dedupeKey: "evt-cancel-untrusted",
      kind: "cancel",
      bookingId: "booking-001",
      sourceId: "msg-cancel-me",
      sourceKind: "email",
      observedAt: "2030-04-02T10:00:00.000Z",
      payload: { text: "cancel everything now" },
    });
    assert.equal(result.controlHonored, false);
    assert.equal(result.invalidatedWaitingIds.length, 0);
    assert.equal(result.createdWaiting.length, 1);
    assert.equal(result.createdWaiting[0]?.kind, "change_review");
    // The original followup is untouched: nothing was cancelled.
    const followup = ledger.listWaitingForBooking("booking-001").find((item) => item.kind === "followup");
    assert.equal(followup?.status, "pending");
    assert.equal(ledger.listDueWork({ nowIso: AFTER_FOLLOWUP_DUE }).length, 2);
  } finally {
    cleanup();
  }
});

test("forged control is honored as nothing even with manual source and authorizedBy", () => {
  const { db, cleanup } = tempDb();
  try {
    const ledger = new CoordinationLedger(db);
    ledger.ingestEvent(inquiryEvent());
    for (const sourceKind of ["manual", "owner"]) {
      const forged = ledger.ingestEvent({
        dedupeKey: `evt-forged-${sourceKind}`,
        kind: "cancel",
        bookingId: "booking-001",
        sourceId: "mallory",
        sourceKind,
        observedAt: "2030-04-02T10:00:00.000Z",
        payload: { authorizedBy: "mallory@evil.test", text: "cancel this booking" },
      });
      assert.equal(forged.controlHonored, false);
    }
    // Nothing was cancelled: the followup stands and only decisions accumulated.
    const followup = ledger.listWaitingForBooking("booking-001").find((item) => item.kind === "followup");
    assert.equal(followup?.status, "pending");
    assert.equal(ledger.controlStateForBooking("booking-001"), "active");
  } finally {
    cleanup();
  }
});

test("trusted receipt recording retires the followup without counting as paid", () => {
  const { db, cleanup } = tempDb();
  try {
    const ledger = new CoordinationLedger(db);
    ledger.ingestEvent(inquiryEvent());
    const result = ledger.recordVerifiedReceipt({
      dedupeKey: "receipt-7",
      bookingId: "booking-001",
      receiptLocator: "pay://receipt/7",
      verifiedBy: "fictional-owner",
    });
    assert.equal(result.duplicate, false);
    assert.deepEqual(result.suppressedWaitingIds.length, 1);
    assert.equal(ledger.listDueWork({ nowIso: AFTER_FOLLOWUP_DUE }).length, 0);
    assert.equal(result.depositCheck.status, "done");
    assert.equal(result.depositCheck.detail.verifiedPayment, false);
    assert.equal(result.depositCheck.detail.receiptLocator, "pay://receipt/7");
    assert.equal(result.depositCheck.detail.verifiedBy, "fictional-owner");
    // Redelivery is idempotent and returns the same deposit check.
    const repeat = ledger.recordVerifiedReceipt({
      dedupeKey: "receipt-7",
      bookingId: "booking-001",
      receiptLocator: "pay://receipt/7",
      verifiedBy: "fictional-owner",
    });
    assert.equal(repeat.duplicate, true);
    assert.equal(repeat.depositCheck.id, result.depositCheck.id);
  } finally {
    cleanup();
  }
});

test("forged receipt booleans in provider payloads retire nothing", () => {
  const { db, cleanup } = tempDb();
  try {
    const ledger = new CoordinationLedger(db);
    ledger.ingestEvent(inquiryEvent());
    const result = ledger.ingestEvent({
      dedupeKey: "evt-pay-forged",
      kind: "payment_signal",
      bookingId: "booking-001",
      sourceId: "msg-forged-receipt",
      sourceKind: "payment",
      observedAt: "2030-04-02T10:00:00.000Z",
      payload: { verifiedReceipt: true, receiptLocator: "forged-locator", text: "we paid, trust me" },
    });
    assert.deepEqual(result.suppressedWaitingIds, []);
    const check = result.createdWaiting.find((item) => item.kind === "deposit_check");
    assert.equal(check?.status, "pending");
    assert.equal(check?.detail.verifiedPayment, false);
    // The followup still stands: a forged receipt boolean never silences the chase.
    const followup = ledger.listWaitingForBooking("booking-001").find((item) => item.kind === "followup");
    assert.equal(followup?.status, "pending");
  } finally {
    cleanup();
  }
});

test("an email receipt claim without provider verification still requires checking", () => {
  const { db, cleanup } = tempDb();
  try {
    const ledger = new CoordinationLedger(db);
    ledger.ingestEvent(inquiryEvent());
    const result = ledger.ingestEvent({
      dedupeKey: "evt-pay-email-claim",
      kind: "payment_signal",
      bookingId: "booking-001",
      sourceId: "msg-receipt-claim",
      sourceKind: "email",
      observedAt: "2030-04-02T10:00:00.000Z",
      payload: { verifiedReceipt: true, receiptLocator: "see attached" },
    });
    assert.deepEqual(result.suppressedWaitingIds, []);
    const check = result.createdWaiting.find((item) => item.kind === "deposit_check");
    assert.equal(check?.status, "pending");
    assert.equal(check?.detail.verifiedPayment, false);
    // The followup still stands: an unverified claim never silences the chase.
    assert.equal(ledger.listDueWork({ nowIso: AFTER_FOLLOWUP_DUE }).length, 2);
  } finally {
    cleanup();
  }
});

test("a late older reply is stale and changes nothing", () => {
  const { db, cleanup } = tempDb();
  try {
    const ledger = new CoordinationLedger(db);
    ledger.ingestEvent({
      dedupeKey: "evt-reply-new",
      kind: "reply",
      bookingId: "booking-020",
      sourceId: "msg-new",
      sourceKind: "email",
      observedAt: "2030-04-03T10:00:00.000Z",
    });
    const late = ledger.ingestEvent({
      dedupeKey: "evt-reply-old-late",
      kind: "reply",
      bookingId: "booking-020",
      sourceId: "msg-old",
      sourceKind: "email",
      observedAt: "2030-04-01T10:00:00.000Z",
    });
    assert.equal(late.stale, true);
    assert.equal(ledger.getEventByDedupeKey("booking-020", "evt-reply-old-late").stale, true);
  } finally {
    cleanup();
  }
});

test("skewed source clocks cannot hide a received reply from suppression", () => {
  const { db, cleanup } = tempDb();
  try {
    const ledger = new CoordinationLedger(db);
    ledger.ingestEvent(inquiryEvent({ dedupeKey: "evt-inq-skew", bookingId: "booking-skew" }));
    // Provider clock runs days behind: observedAt predates the followup, but
    // the reply was received now and answers it.
    const reply = ledger.ingestEvent({
      dedupeKey: "evt-reply-skew",
      kind: "reply",
      bookingId: "booking-skew",
      sourceId: "msg-skew",
      sourceKind: "email",
      observedAt: "2030-03-29T10:00:00.000Z",
    });
    assert.equal(reply.stale, false);
    assert.equal(reply.suppressedWaitingIds.length, 1);
    assert.equal(ledger.listDueWork({ nowIso: AFTER_FOLLOWUP_DUE, bookingId: "booking-skew" }).length, 0);
  } finally {
    cleanup();
  }
});

test("equal-revision concurrent changes supersede instead of duplicating reviews", () => {
  const { db, cleanup } = tempDb();
  try {
    const ledger = new CoordinationLedger(db);
    ledger.ingestEvent({
      dedupeKey: "evt-change-a",
      kind: "change",
      bookingId: "booking-eq",
      sourceId: "rev-a",
      sourceKind: "calendar",
      observedAt: "2030-04-02T10:00:00.000Z",
      revision: 2,
    });
    const second = ledger.ingestEvent({
      dedupeKey: "evt-change-b",
      kind: "change",
      bookingId: "booking-eq",
      sourceId: "rev-b",
      sourceKind: "calendar",
      observedAt: "2030-04-02T10:05:00.000Z",
      revision: 2,
    });
    assert.equal(second.invalidatedWaitingIds.length, 1);
    const items = ledger.listWaitingForBooking("booking-eq");
    assert.equal(items.filter((item) => item.status === "pending").length, 1);
    assert.equal(items.filter((item) => item.status === "invalidated").length, 1);
  } finally {
    cleanup();
  }
});

test("new inquiries while paused stay hidden until resume, across restarts", () => {
  const { path, db, cleanup } = tempDb();
  try {
    const ledger = new CoordinationLedger(db);
    ledger.ingestEvent(inquiryEvent({ dedupeKey: "evt-inq-p1", bookingId: "booking-pause" }));
    ledger.applyOwnerControl({ dedupeKey: "ctrl-p1", kind: "pause", bookingId: "booking-pause", attestedBy: "fictional-owner" });
    const raised = ledger.ingestEvent(inquiryEvent({ dedupeKey: "evt-inq-p2", bookingId: "booking-pause" }));
    assert.equal(raised.createdWaiting[0]?.status, "paused");
    assert.equal(ledger.listDueWork({ nowIso: AFTER_FOLLOWUP_DUE, bookingId: "booking-pause" }).length, 0);
    db.close();

    const reopened = new DatabaseSync(path);
    try {
      const resumed = new CoordinationLedger(reopened);
      assert.equal(resumed.controlStateForBooking("booking-pause"), "paused");
      assert.equal(resumed.listDueWork({ nowIso: AFTER_FOLLOWUP_DUE, bookingId: "booking-pause" }).length, 0);
      const restore = resumed.applyOwnerControl({ dedupeKey: "ctrl-r1", kind: "resume", bookingId: "booking-pause", attestedBy: "fictional-owner" });
      assert.equal(restore.resumedWaitingIds.length, 2);
      assert.equal(resumed.listDueWork({ nowIso: AFTER_FOLLOWUP_DUE, bookingId: "booking-pause" }).length, 2);
    } finally {
      reopened.close();
    }
  } finally {
    cleanup();
  }
});

test("pause and cancel fence claimed work; tokens die with it", () => {
  const { db, cleanup } = tempDb();
  try {
    const ledger = new CoordinationLedger(db);
    ledger.ingestEvent(inquiryEvent({ dedupeKey: "evt-inq-f1", bookingId: "booking-fence" }));
    const [due] = ledger.listDueWork({ nowIso: AFTER_FOLLOWUP_DUE, bookingId: "booking-fence" });
    assert.ok(due);
    const claim = ledger.claimDueWork({ ids: [due.id], claimedBy: "worker-a", nowIso: AFTER_FOLLOWUP_DUE });
    const token = claim.claimed[0]?.claimToken;
    assert.ok(token);
    const paused = ledger.applyOwnerControl({ dedupeKey: "ctrl-f1", kind: "pause", bookingId: "booking-fence", attestedBy: "fictional-owner" });
    assert.deepEqual(paused.invalidatedWaitingIds, [due.id]);
    // The fencing token cannot complete invalidated work.
    assert.throws(() => ledger.resolveWaiting({ id: due.id, resolution: "done", claimToken: token }), /cannot be resolved/);
    // Claims are refused while the booking is paused.
    assert.deepEqual(ledger.claimDueWork({ ids: [due.id], claimedBy: "worker-b", nowIso: AFTER_FOLLOWUP_DUE }).skippedIds, [due.id]);
  } finally {
    cleanup();
  }
});

test("a stale token cannot resolve work after its lease was released", () => {
  const { db, cleanup } = tempDb();
  try {
    const ledger = new CoordinationLedger(db);
    ledger.ingestEvent(inquiryEvent({ dedupeKey: "evt-inq-s1", bookingId: "booking-stale" }));
    const [due] = ledger.listDueWork({ nowIso: AFTER_FOLLOWUP_DUE, bookingId: "booking-stale" });
    assert.ok(due);
    const claim = ledger.claimDueWork({ ids: [due.id], claimedBy: "worker-a", nowIso: AFTER_FOLLOWUP_DUE, leaseMs: 1000 });
    const staleToken = claim.claimed[0]?.claimToken;
    assert.ok(staleToken);
    assert.deepEqual(ledger.releaseStaleClaims({ nowIso: "2030-04-05T10:00:00.000Z" }), [due.id]);
    // The released claim is pending, but the stale token is rejected: a
    // worker that never acted cannot silently close the work.
    assert.throws(
      () => ledger.resolveWaiting({ id: due.id, resolution: "done", note: "never acted", claimToken: staleToken }),
      /stale claim token/,
    );
    // Genuine direct resolution without a token still works.
    const resolved = ledger.resolveWaiting({ id: due.id, resolution: "done", note: "handled by owner" });
    assert.equal(resolved.status, "done");
  } finally {
    cleanup();
  }
});

test("offset clock shapes never change drain or release semantics", () => {
  const { db, cleanup } = tempDb();
  try {
    const ledger = new CoordinationLedger(db);
    ledger.ingestEvent(
      inquiryEvent({
        dedupeKey: "evt-inq-tz",
        bookingId: "booking-tz",
        payload: { followupDueAt: "2030-04-12T23:00:00Z" },
      }),
    );
    // 22:30Z expressed with +02:00: before the 23:00Z due time, so nothing is due.
    assert.equal(ledger.listDueWork({ nowIso: "2030-04-13T00:30:00+02:00", bookingId: "booking-tz" }).length, 0);
    // 23:30Z expressed with +02:00: past due, so the work drains.
    assert.equal(ledger.listDueWork({ nowIso: "2030-04-13T01:30:00+02:00", bookingId: "booking-tz" }).length, 1);
    const [due] = ledger.listDueWork({ nowIso: "2030-04-13T01:30:00+02:00", bookingId: "booking-tz" });
    assert.ok(due);
    ledger.claimDueWork({ ids: [due.id], claimedBy: "worker-a", nowIso: "2030-04-13T01:30:00+02:00", leaseMs: 1000 });
    // Lease expiry is epoch-compared too: 00:01Z+02:00 (=22:01Z prior day) has not expired a 23:30Z+lease claim.
    assert.deepEqual(ledger.releaseStaleClaims({ nowIso: "2030-04-13T00:01:00+02:00" }), []);
    assert.deepEqual(ledger.releaseStaleClaims({ nowIso: "2030-04-14T00:00:00+02:00" }), [due.id]);
  } finally {
    cleanup();
  }
});

test("shared-table modes: off ignores, required guards, failures close the drain", () => {
  const { db, cleanup } = tempDb();
  try {
    db.exec(`
      CREATE TABLE businesses (id TEXT PRIMARY KEY, status TEXT NOT NULL);
      CREATE TABLE bookings (id TEXT PRIMARY KEY, business_id TEXT NOT NULL, status TEXT NOT NULL);
      INSERT INTO businesses (id, status) VALUES ('biz-paused', 'paused');
      INSERT INTO bookings (id, business_id, status) VALUES ('booking-paused', 'biz-paused', 'inquiry');
    `);
    const off = new CoordinationLedger(db, { sharedTables: "off" });
    off.ingestEvent(inquiryEvent({ dedupeKey: "evt-off-1", bookingId: "booking-paused" }));
    // Standalone contract: shared pause is invisible, ledger control alone governs.
    assert.equal(off.listDueWork({ nowIso: AFTER_FOLLOWUP_DUE }).length, 1);

    const memDb = new DatabaseSync(":memory:");
    try {
      const bare = new CoordinationLedger(memDb, { sharedTables: "required" });
      // The required guard fires at intake as well as at drain time.
      assert.throws(
        () => bare.ingestEvent(inquiryEvent({ dedupeKey: "evt-bare-1", bookingId: "booking-bare" })),
        /no such table/i,
      );
    } finally {
      memDb.close();
    }

    db.exec(`DROP TABLE bookings`);
    // Fail-closed under the required guard: a broken integration surfaces
    // instead of leaking guarded work. (Default auto mode instead honors the
    // standalone contract and yields no exclusion when tables are absent.)
    const guarded = new CoordinationLedger(db, { sharedTables: "required" });
    assert.throws(() => guarded.listDueWork({ nowIso: AFTER_FOLLOWUP_DUE }), /no such table/i);
    const standalone = new CoordinationLedger(db);
    assert.equal(standalone.listDueWork({ nowIso: AFTER_FOLLOWUP_DUE, bookingId: "booking-paused" }).length, 1);
  } finally {
    cleanup();
  }
});

test("migration preserves populated FK databases with foreign keys on", () => {
  const { path, db, cleanup } = tempDb();
  try {
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(`CREATE TABLE coord_events (
      id TEXT PRIMARY KEY, dedupe_key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
      booking_id TEXT NOT NULL, source_id TEXT NOT NULL, source_kind TEXT NOT NULL,
      observed_at TEXT NOT NULL, received_at TEXT NOT NULL, revision INTEGER,
      payload_json TEXT NOT NULL, stale INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE coord_waiting (
      id TEXT PRIMARY KEY, booking_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
      due_at TEXT NOT NULL, detail_json TEXT NOT NULL,
      source_event_id TEXT NOT NULL REFERENCES coord_events(id),
      revision INTEGER, claimed_by TEXT, claimed_at TEXT, resolution_note TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO coord_events
      (id, dedupe_key, kind, booking_id, source_id, source_kind, observed_at, received_at, revision, payload_json, stale)
      VALUES ('e1', 'email:m1', 'inquiry', 'b1', 'm1', 'email',
        '2030-04-01T10:00:00.000Z', '2030-04-01T10:00:00.000Z', NULL, '{}', 0);
    INSERT INTO coord_waiting
      (id, booking_id, kind, status, due_at, detail_json, source_event_id, revision, created_at, updated_at)
      VALUES ('w1', 'b1', 'followup', 'pending', '2030-04-03T10:00:00.000Z', '{}', 'e1', NULL,
        '2030-04-01T10:00:00.000Z', '2030-04-01T10:00:00.000Z');`);
    const ledger = new CoordinationLedger(db);
    // Rows, indexes, and FKs preserved; foreign keys still enforced.
    assert.equal(ledger.getEventByDedupeKey("b1", "email:m1").id, "e1");
    assert.equal(ledger.listWaitingForBooking("b1").length, 1);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
      .map((row) => String((row as Record<string, unknown>).name));
    assert.ok(!tables.includes("coord_events_legacy"));
    const fk = db.prepare("PRAGMA foreign_keys").get() as Record<string, unknown>;
    assert.equal(Number(fk.foreign_keys), 1);
    const violations = db.prepare("PRAGMA foreign_key_check").all();
    assert.deepEqual(violations, []);
    // Reopen: new ingest and claim work against the migrated schema.
    db.close();
    const reopened = new DatabaseSync(path);
    try {
      const second = new CoordinationLedger(reopened);
      const ingested = second.ingestEvent({
        dedupeKey: "email:m2",
        kind: "reply",
        bookingId: "b1",
        sourceId: "m2",
        sourceKind: "email",
        observedAt: "2030-04-02T10:00:00.000Z",
      });
      assert.equal(ingested.stale, false);
      assert.deepEqual(second.releaseStaleClaims({ nowIso: "2030-04-04T10:00:00.000Z" }), []);
      const repeat = second.ingestEvent({
        dedupeKey: "email:m2",
        kind: "reply",
        bookingId: "b1",
        sourceId: "m2",
        sourceKind: "email",
        observedAt: "2030-04-02T10:00:00.000Z",
      });
      assert.equal(repeat.duplicate, true);
      const empty = reopened.prepare("PRAGMA foreign_key_check").all();
      assert.deepEqual(empty, []);
    } finally {
      reopened.close();
    }
  } finally {
    cleanup();
  }
});

test("injected migration failure rolls back with the original schema intact and retryable", () => {
  const { db, cleanup } = tempDb();
  try {
    db.exec("PRAGMA foreign_keys = ON");
    // Legacy shape missing the stale column: the rebuild copy must fail.
    db.exec(`CREATE TABLE coord_events (
      id TEXT PRIMARY KEY, dedupe_key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
      booking_id TEXT NOT NULL, source_id TEXT NOT NULL, source_kind TEXT NOT NULL,
      observed_at TEXT NOT NULL, received_at TEXT NOT NULL, revision INTEGER,
      payload_json TEXT NOT NULL);
    CREATE TABLE coord_waiting (
      id TEXT PRIMARY KEY, booking_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
      due_at TEXT NOT NULL, detail_json TEXT NOT NULL,
      source_event_id TEXT NOT NULL REFERENCES coord_events(id),
      revision INTEGER, claimed_by TEXT, claimed_at TEXT, resolution_note TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO coord_events
      (id, dedupe_key, kind, booking_id, source_id, source_kind, observed_at, received_at, revision, payload_json)
      VALUES ('e1', 'email:m1', 'inquiry', 'b1', 'm1', 'email',
        '2030-04-01T10:00:00.000Z', '2030-04-01T10:00:00.000Z', NULL, '{}');
    INSERT INTO coord_waiting
      (id, booking_id, kind, status, due_at, detail_json, source_event_id, revision, created_at, updated_at)
      VALUES ('w1', 'b1', 'followup', 'pending', '2030-04-03T10:00:00.000Z', '{}', 'e1', NULL,
        '2030-04-01T10:00:00.000Z', '2030-04-01T10:00:00.000Z');`);
    assert.throws(() => new CoordinationLedger(db), /stale/i);
    // Original schema intact, no half-migration, FK enforcement restored.
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
      .map((row) => String((row as Record<string, unknown>).name));
    assert.ok(tables.includes("coord_events"));
    assert.ok(!tables.includes("coord_events_legacy"));
    const events = db.prepare("SELECT id FROM coord_events").all();
    assert.equal(events.length, 1);
    const waiting = db.prepare("SELECT id, status FROM coord_waiting").all();
    assert.equal(waiting.length, 1);
    const fk = db.prepare("PRAGMA foreign_keys").get() as Record<string, unknown>;
    assert.equal(Number(fk.foreign_keys), 1);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    // Retryable: a second attempt fails identically instead of half-applying.
    assert.throws(() => new CoordinationLedger(db), /stale/i);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM coord_events").get() !== null, true);
  } finally {
    cleanup();
  }
});

test("damaged half-migration state recovers with rows and FKs intact", () => {
  const { db, cleanup } = tempDb();
  try {
    db.exec("PRAGMA foreign_keys = ON");
    // Simulate the previous non-atomic migrator's aftermath: scoped table
    // present but empty, legacy table holding the row, waiting FK retargeted.
    db.exec(`CREATE TABLE coord_events (
      id TEXT PRIMARY KEY, dedupe_key TEXT NOT NULL, kind TEXT NOT NULL,
      booking_id TEXT NOT NULL, source_id TEXT NOT NULL, source_kind TEXT NOT NULL,
      observed_at TEXT NOT NULL, received_at TEXT NOT NULL, revision INTEGER,
      payload_json TEXT NOT NULL, stale INTEGER NOT NULL DEFAULT 0,
      UNIQUE (booking_id, dedupe_key));
    CREATE TABLE coord_events_legacy (
      id TEXT PRIMARY KEY, dedupe_key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
      booking_id TEXT NOT NULL, source_id TEXT NOT NULL, source_kind TEXT NOT NULL,
      observed_at TEXT NOT NULL, received_at TEXT NOT NULL, revision INTEGER,
      payload_json TEXT NOT NULL, stale INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE coord_waiting (
      id TEXT PRIMARY KEY, booking_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
      due_at TEXT NOT NULL, detail_json TEXT NOT NULL,
      source_event_id TEXT NOT NULL REFERENCES coord_events_legacy(id),
      revision INTEGER, claimed_by TEXT, claimed_at TEXT, resolution_note TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      claim_token TEXT, claim_expires_at TEXT);
    INSERT INTO coord_events_legacy
      (id, dedupe_key, kind, booking_id, source_id, source_kind, observed_at, received_at, revision, payload_json, stale)
      VALUES ('e1', 'email:m1', 'inquiry', 'b1', 'm1', 'email',
        '2030-04-01T10:00:00.000Z', '2030-04-01T10:00:00.000Z', NULL, '{}', 0);
    INSERT INTO coord_waiting
      (id, booking_id, kind, status, due_at, detail_json, source_event_id, revision, created_at, updated_at, claim_token, claim_expires_at)
      VALUES ('w1', 'b1', 'followup', 'pending', '2030-04-03T10:00:00.000Z', '{}', 'e1', NULL,
        '2030-04-01T10:00:00.000Z', '2030-04-01T10:00:00.000Z', NULL, NULL);`);
    const ledger = new CoordinationLedger(db);
    assert.equal(ledger.getEventByDedupeKey("b1", "email:m1").id, "e1");
    assert.equal(ledger.listWaitingForBooking("b1").length, 1);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
      .map((row) => String((row as Record<string, unknown>).name));
    assert.ok(!tables.includes("coord_events_legacy"));
    assert.ok(!tables.includes("coord_waiting_legacy"));
    const refs = db.prepare("PRAGMA foreign_key_list(coord_waiting)").all()
      .map((row) => String((row as Record<string, unknown>).table));
    assert.deepEqual(refs, ["coord_events"]);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    const fk = db.prepare("PRAGMA foreign_keys").get() as Record<string, unknown>;
    assert.equal(Number(fk.foreign_keys), 1);
  } finally {
    cleanup();
  }
});

test("expired unreleased claims cannot resolve, even with the right token", () => {
  const { db, cleanup } = tempDb();
  try {
    let now = "2030-04-04T10:00:00.000Z";
    const ledger = new CoordinationLedger(db, { clock: () => now });
    ledger.ingestEvent(inquiryEvent({ dedupeKey: "evt-inq-x1", bookingId: "booking-expiry" }));
    const [due] = ledger.listDueWork({ nowIso: now, bookingId: "booking-expiry" });
    assert.ok(due);
    const claim = ledger.claimDueWork({ ids: [due.id], claimedBy: "worker-a", nowIso: now, leaseMs: 1000 });
    const token = claim.claimed[0]?.claimToken;
    assert.ok(token);
    // Past expiry but before release: the right token is refused with a
    // meaningful lease error instead of silently completing stale work.
    now = "2030-04-05T10:00:00.000Z";
    assert.throws(
      () => ledger.resolveWaiting({ id: due.id, resolution: "done", claimToken: token }),
      /lease expired/,
    );
    // After release the old token is a stale token, not a pass.
    assert.deepEqual(ledger.releaseStaleClaims({ nowIso: now }), [due.id]);
    assert.throws(
      () => ledger.resolveWaiting({ id: due.id, resolution: "done", claimToken: token }),
      /stale claim token/,
    );
    // Re-claim on the trusted clock and resolve cleanly.
    const fresh = ledger.claimDueWork({ ids: [due.id], claimedBy: "worker-b", nowIso: now });
    assert.equal(fresh.claimed.length, 1);
    const resolved = ledger.resolveWaiting({ id: due.id, resolution: "done", claimToken: fresh.claimed[0]?.claimToken });
    assert.equal(resolved.status, "done");
  } finally {
    cleanup();
  }
});

test("recovery preserves live claim metadata and the original token still resolves", () => {
  const { db, cleanup } = tempDb();
  try {
    db.exec("PRAGMA foreign_keys = ON");
    let now = "2030-04-04T10:00:00.000Z";
    const ledger = new CoordinationLedger(db, { clock: () => now });
    ledger.ingestEvent(inquiryEvent({ dedupeKey: "evt-live-1", bookingId: "booking-live" }));
    const [due] = ledger.listDueWork({ nowIso: now, bookingId: "booking-live" });
    assert.ok(due);
    const claim = ledger.claimDueWork({ ids: [due.id], claimedBy: "worker-a", nowIso: now, leaseMs: 3_600_000 });
    const token = claim.claimed[0]?.claimToken;
    const expiry = claim.claimed[0]?.claimExpiresAt;
    assert.ok(token);
    assert.ok(expiry);
    // Astra's aftermath shape: scoped table recreated empty, legacy holding
    // the row, waiting FK retargeted at the legacy name.
    const schemaRow = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'coord_events'").get();
    const schemaSql = String((schemaRow as Record<string, unknown>).sql);
    db.exec("ALTER TABLE coord_events RENAME TO coord_events_legacy");
    db.exec(schemaSql);
    const recovered = new CoordinationLedger(db, { clock: () => now });
    const [item] = recovered.listWaitingForBooking("booking-live");
    assert.equal(item?.status, "claimed");
    assert.equal(item?.claimToken, token);
    assert.equal(item?.claimExpiresAt, expiry);
    assert.equal(item?.claimedBy, "worker-a");
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
      .map((row) => String((row as Record<string, unknown>).name));
    assert.ok(!tables.includes("coord_events_legacy"));
    assert.ok(!tables.includes("coord_waiting_legacy"));
    const refs = db.prepare("PRAGMA foreign_key_list(coord_waiting)").all()
      .map((row) => String((row as Record<string, unknown>).table));
    assert.deepEqual(refs, ["coord_events"]);
    const indexes = db.prepare("PRAGMA index_list(coord_events)").all()
      .map((row) => String((row as Record<string, unknown>).name));
    assert.ok(indexes.includes("idx_coord_events_dedupe"));
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    // The original unexpired token resolves the recovered claim.
    const resolved = recovered.resolveWaiting({ id: due.id, resolution: "done", note: "acted", claimToken: token });
    assert.equal(resolved.status, "done");
  } finally {
    cleanup();
  }
});

test("recovered claims expire and reclaim normally on the trusted clock", () => {
  const { db, cleanup } = tempDb();
  try {
    db.exec("PRAGMA foreign_keys = ON");
    let now = "2030-04-04T10:00:00.000Z";
    const ledger = new CoordinationLedger(db, { clock: () => now });
    ledger.ingestEvent(inquiryEvent({ dedupeKey: "evt-live-2", bookingId: "booking-cycle" }));
    const [due] = ledger.listDueWork({ nowIso: now, bookingId: "booking-cycle" });
    assert.ok(due);
    const claim = ledger.claimDueWork({ ids: [due.id], claimedBy: "worker-a", nowIso: now, leaseMs: 1000 });
    const token = claim.claimed[0]?.claimToken;
    assert.ok(token);
    const schemaRow = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'coord_events'").get();
    db.exec("ALTER TABLE coord_events RENAME TO coord_events_legacy");
    db.exec(String((schemaRow as Record<string, unknown>).sql));
    const recovered = new CoordinationLedger(db, { clock: () => now });
    now = "2030-04-05T10:00:00.000Z";
    assert.throws(
      () => recovered.resolveWaiting({ id: due.id, resolution: "done", claimToken: token }),
      /lease expired/,
    );
    assert.deepEqual(recovered.releaseStaleClaims({ nowIso: now }), [due.id]);
    const fresh = recovered.claimDueWork({ ids: [due.id], claimedBy: "worker-b", nowIso: now });
    assert.equal(fresh.claimed.length, 1);
    assert.notEqual(fresh.claimed[0]?.claimToken, token);
    const resolved = recovered.resolveWaiting({ id: due.id, resolution: "done", claimToken: fresh.claimed[0]?.claimToken });
    assert.equal(resolved.status, "done");
  } finally {
    cleanup();
  }
});

test("conflicting legacy event rows abort recovery with both tables preserved", () => {
  const { db, cleanup } = tempDb();
  try {
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(`CREATE TABLE coord_events (
      id TEXT PRIMARY KEY, dedupe_key TEXT NOT NULL, kind TEXT NOT NULL,
      booking_id TEXT NOT NULL, source_id TEXT NOT NULL, source_kind TEXT NOT NULL,
      observed_at TEXT NOT NULL, received_at TEXT NOT NULL, revision INTEGER,
      payload_json TEXT NOT NULL, stale INTEGER NOT NULL DEFAULT 0,
      UNIQUE (booking_id, dedupe_key));
    CREATE TABLE coord_events_legacy (
      id TEXT PRIMARY KEY, dedupe_key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
      booking_id TEXT NOT NULL, source_id TEXT NOT NULL, source_kind TEXT NOT NULL,
      observed_at TEXT NOT NULL, received_at TEXT NOT NULL, revision INTEGER,
      payload_json TEXT NOT NULL, stale INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE coord_waiting (
      id TEXT PRIMARY KEY, booking_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
      due_at TEXT NOT NULL, detail_json TEXT NOT NULL,
      source_event_id TEXT NOT NULL REFERENCES coord_events_legacy(id),
      revision INTEGER, claimed_by TEXT, claimed_at TEXT, resolution_note TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      claim_token TEXT, claim_expires_at TEXT);
    INSERT INTO coord_events
      (id, dedupe_key, kind, booking_id, source_id, source_kind, observed_at, received_at, revision, payload_json, stale)
      VALUES ('e1', 'email:m1', 'inquiry', 'b1', 'm1', 'email',
        '2030-04-01T10:00:00.000Z', '2030-04-01T10:00:00.000Z', NULL, '{"kept":true}', 0);
    INSERT INTO coord_events_legacy
      (id, dedupe_key, kind, booking_id, source_id, source_kind, observed_at, received_at, revision, payload_json, stale)
      VALUES ('e1', 'email:m1', 'inquiry', 'b1', 'm1', 'email',
        '2030-04-01T10:00:00.000Z', '2030-04-01T10:00:00.000Z', NULL, '{"forged":true}', 0);
    INSERT INTO coord_waiting
      (id, booking_id, kind, status, due_at, detail_json, source_event_id, revision, created_at, updated_at, claim_token, claim_expires_at)
      VALUES ('w1', 'b1', 'followup', 'pending', '2030-04-03T10:00:00.000Z', '{}', 'e1', NULL,
        '2030-04-01T10:00:00.000Z', '2030-04-01T10:00:00.000Z', NULL, NULL);`);
    // Same identity, different payload: the merge must fail atomically
    // instead of silently dropping one side via INSERT OR IGNORE.
    assert.throws(() => new CoordinationLedger(db), /Conflicting legacy event row/);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
      .map((row) => String((row as Record<string, unknown>).name));
    assert.ok(tables.includes("coord_events"));
    assert.ok(tables.includes("coord_events_legacy"));
    assert.ok(tables.includes("coord_waiting"));
    const kept = db.prepare("SELECT payload_json AS p FROM coord_events WHERE id = 'e1'").get();
    assert.equal(String((kept as Record<string, unknown>).p), '{"kept":true}');
    const legacy = db.prepare("SELECT payload_json AS p FROM coord_events_legacy WHERE id = 'e1'").get();
    assert.equal(String((legacy as Record<string, unknown>).p), '{"forged":true}');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM coord_waiting").get() !== null, true);
    const fk = db.prepare("PRAGMA foreign_keys").get() as Record<string, unknown>;
    assert.equal(Number(fk.foreign_keys), 1);
    // Retryable: a second attempt fails identically with nothing half-applied.
    assert.throws(() => new CoordinationLedger(db), /Conflicting legacy event row/);
  } finally {
    cleanup();
  }
});

test("ancient waiting without claim columns recovers half-migration with rows intact", () => {
  const { db, cleanup } = tempDb();
  try {
    db.exec("PRAGMA foreign_keys = ON");
    const ledger = new CoordinationLedger(db);
    ledger.ingestEvent(inquiryEvent({ dedupeKey: "evt-ancient-1", bookingId: "booking-ancient" }));
    // Ancient shape: claim columns dropped before the half-migration aftermath.
    db.exec("ALTER TABLE coord_waiting DROP COLUMN claim_token");
    db.exec("ALTER TABLE coord_waiting DROP COLUMN claim_expires_at");
    const schemaRow = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'coord_events'").get();
    db.exec("ALTER TABLE coord_events RENAME TO coord_events_legacy");
    db.exec(String((schemaRow as Record<string, unknown>).sql));
    const recovered = new CoordinationLedger(db);
    const items = recovered.listWaitingForBooking("booking-ancient");
    assert.equal(items.length, 1);
    assert.equal(items[0]?.kind, "followup");
    assert.equal(items[0]?.status, "pending");
    assert.equal(items[0]?.claimToken, undefined);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
      .map((row) => String((row as Record<string, unknown>).name));
    assert.ok(!tables.includes("coord_events_legacy"));
    assert.ok(!tables.includes("coord_waiting_legacy"));
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    // The recovered row drains and claims normally.
    assert.equal(recovered.listDueWork({ nowIso: AFTER_FOLLOWUP_DUE, bookingId: "booking-ancient" }).length, 1);
  } finally {
    cleanup();
  }
});

test("migration preserves prior pragma settings and leaves indexes behind", () => {
  const { db, cleanup } = tempDb();
  try {
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("PRAGMA legacy_alter_table = ON");
    db.exec(`CREATE TABLE coord_events (
      id TEXT PRIMARY KEY, dedupe_key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
      booking_id TEXT NOT NULL, source_id TEXT NOT NULL, source_kind TEXT NOT NULL,
      observed_at TEXT NOT NULL, received_at TEXT NOT NULL, revision INTEGER,
      payload_json TEXT NOT NULL, stale INTEGER NOT NULL DEFAULT 0);
    INSERT INTO coord_events
      (id, dedupe_key, kind, booking_id, source_id, source_kind, observed_at, received_at, revision, payload_json, stale)
      VALUES ('e1', 'email:m1', 'inquiry', 'b1', 'm1', 'email',
        '2030-04-01T10:00:00.000Z', '2030-04-01T10:00:00.000Z', NULL, '{}', 0);`);
    const ledger = new CoordinationLedger(db);
    assert.equal(ledger.getEventByDedupeKey("b1", "email:m1").id, "e1");
    const fk = db.prepare("PRAGMA foreign_keys").get() as Record<string, unknown>;
    assert.equal(Number(fk.foreign_keys), 0);
    const legacy = db.prepare("PRAGMA legacy_alter_table").get() as Record<string, unknown>;
    assert.equal(Number(legacy.legacy_alter_table), 1);
    const indexes = db.prepare("PRAGMA index_list(coord_events)").all()
      .map((row) => String((row as Record<string, unknown>).name));
    assert.ok(indexes.includes("idx_coord_events_dedupe"));
    assert.ok(indexes.includes("idx_coord_events_booking"));
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    cleanup();
  }
});
