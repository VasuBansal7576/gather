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

test("pause suspends due work, resume restores it, cancel invalidates it", () => {
  const { db, cleanup } = tempDb();
  try {
    const ledger = new CoordinationLedger(db);
    ledger.ingestEvent(inquiryEvent());
    const paused = ledger.ingestEvent({
      dedupeKey: "evt-pause-001",
      kind: "pause",
      bookingId: "booking-001",
      sourceId: "owner-pause",
      sourceKind: "manual",
      observedAt: "2030-04-02T10:00:00.000Z",
    });
    assert.equal(paused.pausedWaitingIds.length, 1);
    assert.equal(ledger.listDueWork({ nowIso: AFTER_FOLLOWUP_DUE }).length, 0);

    const resumed = ledger.ingestEvent({
      dedupeKey: "evt-resume-001",
      kind: "resume",
      bookingId: "booking-001",
      sourceId: "owner-resume",
      sourceKind: "manual",
      observedAt: "2030-04-02T12:00:00.000Z",
    });
    assert.equal(resumed.resumedWaitingIds.length, 1);
    assert.equal(ledger.listDueWork({ nowIso: AFTER_FOLLOWUP_DUE }).length, 1);

    const cancelled = ledger.ingestEvent({
      dedupeKey: "evt-cancel-001",
      kind: "cancel",
      bookingId: "booking-001",
      sourceId: "owner-cancel",
      sourceKind: "manual",
      observedAt: "2030-04-02T13:00:00.000Z",
    });
    assert.equal(cancelled.invalidatedWaitingIds.length, 1);
    assert.equal(ledger.listDueWork({ nowIso: AFTER_FOLLOWUP_DUE }).length, 0);
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
    const second = ledger.claimDueWork({ ids: [due.id], claimedBy: "worker-b", nowIso: AFTER_FOLLOWUP_DUE });
    assert.equal(second.claimed.length, 0);
    assert.deepEqual(second.skippedIds, [due.id]);
    const resolved = ledger.resolveWaiting({ id: due.id, resolution: "done", note: "followup approved and sent" });
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
  } finally {
    cleanup();
  }
});
