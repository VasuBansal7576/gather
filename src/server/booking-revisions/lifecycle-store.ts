import type { GatherStore } from "../sqlite-store.ts";
import { canonicalRequestHash, type BookingLifecycle, type RevisionCommandKind, type RevisionCommandRecord } from "./types.ts";

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Module-owned durable state on the shared SQLite handle. These two tables
 * are created and managed ONLY by the booking-revisions module — no shared
 * store file is edited for them:
 *
 * - `booking_lifecycle`: per-booking pause flag + cancellation state. The
 *   booking's own `status` is never rewritten to encode these (pausing must
 *   not lie about already-executed steps; cancellation stays requested until
 *   externally verified).
 * - `booking_revision_commands`: idempotent command log. Same command id +
 *   same request hash replays the stored response; same command id with a
 *   different hash is a conflict, never a silent overwrite.
 */
export class RevisionLifecycleStore {
  constructor(private readonly store: GatherStore) {
    this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS booking_lifecycle (
        booking_id TEXT PRIMARY KEY,
        paused INTEGER NOT NULL DEFAULT 0,
        cancel_state TEXT NOT NULL DEFAULT 'none' CHECK (cancel_state IN ('none', 'requested', 'verified')),
        cancel_command_id TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS booking_revision_commands (
        command_id TEXT PRIMARY KEY,
        booking_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('succeeded', 'blocked', 'failed')),
        response_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS hold_release_records (
        hold_operation_key TEXT PRIMARY KEY,
        release_operation_key TEXT NOT NULL,
        booking_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('released', 'uncertain')),
        receipt_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  getLifecycle(bookingId: string): BookingLifecycle {
    const found = this.store.db.prepare("SELECT * FROM booking_lifecycle WHERE booking_id = $bookingId").get({ $bookingId: bookingId }) as Record<string, unknown> | null;
    if (!found) {
      return { bookingId, paused: false, cancelState: "none", updatedAt: nowIso() };
    }
    return {
      bookingId,
      paused: Number(found.paused) === 1,
      cancelState: found.cancel_state as BookingLifecycle["cancelState"],
      ...(typeof found.cancel_command_id === "string" && found.cancel_command_id.length > 0 ? { cancelCommandId: found.cancel_command_id } : {}),
      updatedAt: String(found.updated_at),
    };
  }

  /** True when the booking currently refuses new writes (paused). */
  isPaused(bookingId: string): boolean {
    return this.getLifecycle(bookingId).paused;
  }

  setPaused(bookingId: string, paused: boolean): BookingLifecycle {
    const timestamp = nowIso();
    this.store.db.prepare(`INSERT INTO booking_lifecycle (booking_id, paused, cancel_state, updated_at)
      VALUES ($bookingId, $paused, 'none', $timestamp)
      ON CONFLICT(booking_id) DO UPDATE SET paused = excluded.paused, updated_at = excluded.updated_at`).run({
      $bookingId: bookingId, $paused: paused ? 1 : 0, $timestamp: timestamp,
    });
    return this.getLifecycle(bookingId);
  }

  setCancelState(bookingId: string, state: "requested" | "verified", commandId: string): BookingLifecycle {
    const timestamp = nowIso();
    this.store.db.prepare(`INSERT INTO booking_lifecycle (booking_id, paused, cancel_state, cancel_command_id, updated_at)
      VALUES ($bookingId, 0, $state, $commandId, $timestamp)
      ON CONFLICT(booking_id) DO UPDATE SET cancel_state = excluded.cancel_state, cancel_command_id = excluded.cancel_command_id, updated_at = excluded.updated_at`).run({
      $bookingId: bookingId, $state: state, $commandId: commandId, $timestamp: timestamp,
    });
    return this.getLifecycle(bookingId);
  }

  getCommand(commandId: string): RevisionCommandRecord | undefined {
    const found = this.store.db.prepare("SELECT * FROM booking_revision_commands WHERE command_id = $commandId").get({ $commandId: commandId }) as Record<string, unknown> | null;
    if (!found) return undefined;
    return {
      commandId: String(found.command_id),
      bookingId: String(found.booking_id),
      kind: found.kind as RevisionCommandKind,
      requestHash: String(found.request_hash),
      status: found.status as RevisionCommandRecord["status"],
      response: JSON.parse(String(found.response_json)) as Record<string, unknown>,
      createdAt: String(found.created_at),
      updatedAt: String(found.updated_at),
    };
  }

  /**
   * Idempotent command reservation. Same id + same hash replays the stored
   * response; same id + different hash throws (caller maps to conflict).
   * Returns null when this call owns the command and must execute it.
   */
  replayOrOwn(commandId: string, bookingId: string, kind: RevisionCommandKind, requestHash: string): RevisionCommandRecord | null {
    const prior = this.getCommand(commandId);
    if (prior) {
      if (prior.requestHash !== requestHash) {
        throw new Error(`Command id ${commandId} is bound to a different ${prior.kind} request; altered replays are rejected`);
      }
      return prior;
    }
    return null;
  }

  recordCommand(commandId: string, bookingId: string, kind: RevisionCommandKind, requestHash: string, status: RevisionCommandRecord["status"], response: Record<string, unknown>): RevisionCommandRecord {
    const timestamp = nowIso();
    const inserted = this.store.db.prepare(`INSERT INTO booking_revision_commands
      (command_id, booking_id, kind, request_hash, status, response_json, created_at, updated_at)
      VALUES ($commandId, $bookingId, $kind, $hash, $status, $response, $timestamp, $timestamp)
      ON CONFLICT(command_id) DO NOTHING`).run({
      $commandId: commandId, $bookingId: bookingId, $kind: kind, $hash: requestHash,
      $status: status, $response: JSON.stringify(response), $timestamp: timestamp,
    });
    if (inserted.changes === 0) {
      // Lost a race with a concurrent executor of the same command: replay
      // the winner instead of executing twice.
      const winner = this.getCommand(commandId);
      if (!winner) throw new Error("Command raced but no winner row is visible");
      if (winner.requestHash !== requestHash) {
        throw new Error(`Command id ${commandId} is bound to a different request; altered replays are rejected`);
      }
      return winner;
    }
    return this.getCommand(commandId) as RevisionCommandRecord;
  }

  getRelease(holdOperationKey: string): { status: "released" | "uncertain"; receipt: Record<string, unknown> } | undefined {
    const found = this.store.db.prepare("SELECT status, receipt_json FROM hold_release_records WHERE hold_operation_key = $key").get({ $key: holdOperationKey }) as Record<string, unknown> | null;
    if (!found) return undefined;
    return {
      status: found.status as "released" | "uncertain",
      receipt: JSON.parse(String(found.receipt_json)) as Record<string, unknown>,
    };
  }

  recordRelease(holdOperationKey: string, releaseOperationKey: string, bookingId: string, status: "released" | "uncertain", receipt: Record<string, unknown>): void {
    this.store.db.prepare(`INSERT INTO hold_release_records
      (hold_operation_key, release_operation_key, booking_id, status, receipt_json, updated_at)
      VALUES ($holdKey, $releaseKey, $bookingId, $status, $receipt, $timestamp)
      ON CONFLICT(hold_operation_key) DO UPDATE SET status = excluded.status, receipt_json = excluded.receipt_json, updated_at = excluded.updated_at`).run({
      $holdKey: holdOperationKey, $releaseKey: releaseOperationKey, $bookingId: bookingId,
      $status: status, $receipt: JSON.stringify(receipt), $timestamp: nowIso(),
    });
  }
}

export { canonicalRequestHash };
