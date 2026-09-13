import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  CursorCheckpoint,
  IntakeBatchRecord,
  IntakeItemRecord,
  IntakeItemStatus,
} from "./types.ts";

type SqlRow = Record<string, unknown>;

function row(value: unknown): SqlRow {
  if (!value || typeof value !== "object") throw new Error("Expected a SQLite row");
  return value as SqlRow;
}

function nowIso(): string {
  return new Date().toISOString();
}

export interface RawIntakeItem {
  messageId: string;
  threadId?: string;
  historyId?: string;
  observedAt: string;
}

/**
 * Operator intake tables on the shared database. Every method below owns
 * exactly one BEGIN/COMMIT of its own — ledger and identity calls happen
 * outside these transactions (they BEGIN themselves), so transactions
 * never nest.
 */
export class OperatorIntakeStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS intake_batches (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        provider_history_id TEXT,
        next_cursor TEXT,
        item_count INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('received', 'drained', 'failed')),
        simulation INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS intake_items (
        id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL REFERENCES intake_batches(id),
        message_id TEXT NOT NULL,
        thread_id TEXT,
        observed_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('received', 'linked', 'needs_decision', 'ingested', 'failed', 'skipped')),
        booking_id TEXT,
        source_key TEXT,
        ledger_event_id TEXT,
        error TEXT,
        UNIQUE (batch_id, message_id)
      );
      CREATE TABLE IF NOT EXISTS cursor_checkpoints (
        account_id TEXT PRIMARY KEY,
        cursor TEXT NOT NULL,
        provider_history_id TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS intake_failures (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_intake_items_batch ON intake_items(batch_id);
      CREATE INDEX IF NOT EXISTS idx_intake_items_status ON intake_items(status);
      CREATE INDEX IF NOT EXISTS idx_intake_failures_account ON intake_failures(account_id, created_at);
    `);
  }

  /** Durably record a poll/drain failure for health visibility. Own transaction. */
  recordFailure(accountId: string, scope: string, message: string): void {
    this.db.prepare(
      "INSERT INTO intake_failures (id, account_id, scope, message, created_at) VALUES ($id, $account, $scope, $message, $at)",
    ).run({
      $id: `if_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
      $account: accountId, $scope: scope, $message: message.slice(0, 2000), $at: nowIso(),
    });
  }

  listFailures(accountId: string, limit = 20): Array<{ scope: string; message: string; at: string }> {
    const rows = this.db.prepare(
      "SELECT scope, message, created_at FROM intake_failures WHERE account_id = $account ORDER BY created_at DESC LIMIT $limit",
    ).all({ $account: accountId, $limit: limit });
    return rows.map((value) => {
      const item = row(value);
      return { scope: String(item.scope), message: String(item.message), at: String(item.created_at) };
    });
  }

  /** Atomically persist one raw poll batch with all its items. */
  persistBatch(input: {
    accountId: string;
    providerHistoryId?: string;
    nextCursor?: string;
    items: RawIntakeItem[];
    simulation: boolean;
  }): IntakeBatchRecord {
    const timestamp = nowIso();
    const batchId = `ib_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(
        `INSERT INTO intake_batches (id, account_id, provider_history_id, next_cursor, item_count, status, simulation, created_at, updated_at)
         VALUES ($id, $account, $history, $cursor, $count, 'received', $sim, $at, $at)`,
      ).run({
        $id: batchId, $account: input.accountId, $history: input.providerHistoryId ?? null,
        $cursor: input.nextCursor ?? null, $count: input.items.length,
        $sim: input.simulation ? 1 : 0, $at: timestamp,
      });
      const insertItem = this.db.prepare(
        `INSERT OR IGNORE INTO intake_items (id, batch_id, message_id, thread_id, observed_at, status)
         VALUES ($id, $batch, $message, $thread, $observed, 'received')`,
      );
      for (const item of input.items) {
        insertItem.run({
          $id: `ii_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
          $batch: batchId, $message: item.messageId, $thread: item.threadId ?? null, $observed: item.observedAt,
        });
      }
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Best-effort; surface the original failure.
      }
      throw error;
    }
    return this.getBatch(batchId);
  }

  getBatch(id: string): IntakeBatchRecord {
    const found = this.db.prepare("SELECT * FROM intake_batches WHERE id = $id").get({ $id: id });
    if (!found) throw new Error(`Intake batch not found: ${id}`);
    return toBatch(row(found));
  }

  listItems(batchId: string): IntakeItemRecord[] {
    const rows = this.db.prepare("SELECT * FROM intake_items WHERE batch_id = $batch ORDER BY observed_at, message_id").all({ $batch: batchId });
    return rows.map((value) => toItem(row(value)));
  }

  updateItem(id: string, patch: {
    status: IntakeItemStatus;
    bookingId?: string;
    sourceKey?: string;
    ledgerEventId?: string;
    error?: string;
  }): void {
    this.db.prepare(
      `UPDATE intake_items SET status = $status, booking_id = $booking, source_key = $source,
        ledger_event_id = $event, error = $error WHERE id = $id`,
    ).run({
      $status: patch.status, $booking: patch.bookingId ?? null, $source: patch.sourceKey ?? null,
      $event: patch.ledgerEventId ?? null, $error: patch.error ?? null, $id: id,
    });
  }

  markBatch(id: string, status: "drained" | "failed"): void {
    this.db.prepare("UPDATE intake_batches SET status = $status, updated_at = $at WHERE id = $id").run({
      $status: status, $at: nowIso(), $id: id,
    });
  }

  /** Commit the cursor checkpoint only after the batch fully drained. */
  commitCursor(accountId: string, cursor: string, providerHistoryId?: string): CursorCheckpoint {
    const timestamp = nowIso();
    this.db.prepare(
      `INSERT INTO cursor_checkpoints (account_id, cursor, provider_history_id, updated_at)
       VALUES ($account, $cursor, $history, $at)
       ON CONFLICT(account_id) DO UPDATE SET cursor = excluded.cursor,
         provider_history_id = excluded.provider_history_id, updated_at = excluded.updated_at`,
    ).run({ $account: accountId, $cursor: cursor, $history: providerHistoryId ?? null, $at: timestamp });
    return this.getCursor(accountId)!;
  }

  getCursor(accountId: string): CursorCheckpoint | undefined {
    const found = this.db.prepare("SELECT * FROM cursor_checkpoints WHERE account_id = $account").get({ $account: accountId });
    return found ? toCursor(row(found)) : undefined;
  }

  /**
   * Durably clear a dead cursor (history 404): the next sweep polls
   * cursor-less and full-syncs instead of replaying the expired cursor
   * forever. Own transaction.
   */
  clearCursor(accountId: string): void {
    this.db.prepare("DELETE FROM cursor_checkpoints WHERE account_id = $account").run({ $account: accountId });
  }

  /**
   * Parked items (needs_decision/failed) across all batches for one
   * account, oldest first, bounded. Re-driven after owner resolution or
   * restart even when the next poll returns nothing new.
   */
  listParked(accountId: string, limit = 50): IntakeItemRecord[] {
    const rows = this.db.prepare(
      `SELECT items.* FROM intake_items AS items
       JOIN intake_batches AS batches ON batches.id = items.batch_id
       WHERE batches.account_id = $account AND items.status IN ('needs_decision', 'failed')
       ORDER BY items.observed_at, items.message_id LIMIT $limit`,
    ).all({ $account: accountId, $limit: limit });
    return rows.map((value) => toItem(row(value)));
  }

  latestBatch(accountId: string): IntakeBatchRecord | undefined {
    const found = this.db.prepare(
      "SELECT * FROM intake_batches WHERE account_id = $account ORDER BY created_at DESC LIMIT 1",
    ).get({ $account: accountId });
    return found ? toBatch(row(found)) : undefined;
  }

  /**
   * Surface simulation flag derived from durable evidence (latest batch
   * wiring). With no evidence yet, assume simulated rather than live.
   */
  latestSimulation(accountId: string): boolean {
    return this.latestBatch(accountId)?.simulation ?? true;
  }
}

function toBatch(value: SqlRow): IntakeBatchRecord {
  return {
    id: String(value.id),
    accountId: String(value.account_id),
    providerHistoryId: value.provider_history_id ? String(value.provider_history_id) : undefined,
    nextCursor: value.next_cursor ? String(value.next_cursor) : undefined,
    itemCount: Number(value.item_count),
    status: value.status as IntakeBatchRecord["status"],
    simulation: Number(value.simulation) === 1,
    createdAt: String(value.created_at),
    updatedAt: String(value.updated_at),
  };
}

function toItem(value: SqlRow): IntakeItemRecord {
  return {
    id: String(value.id),
    batchId: String(value.batch_id),
    messageId: String(value.message_id),
    threadId: value.thread_id ? String(value.thread_id) : undefined,
    observedAt: String(value.observed_at),
    status: value.status as IntakeItemStatus,
    bookingId: value.booking_id ? String(value.booking_id) : undefined,
    sourceKey: value.source_key ? String(value.source_key) : undefined,
    ledgerEventId: value.ledger_event_id ? String(value.ledger_event_id) : undefined,
    error: value.error ? String(value.error) : undefined,
  };
}

function toCursor(value: SqlRow): CursorCheckpoint {
  return {
    accountId: String(value.account_id),
    cursor: String(value.cursor),
    providerHistoryId: value.provider_history_id ? String(value.provider_history_id) : undefined,
    updatedAt: String(value.updated_at),
  };
}
