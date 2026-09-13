import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  assertValidClaimInput,
  assertValidEventInput,
  assertValidListDueWorkInput,
  assertValidResolveInput,
  recommendedFor,
} from "./contracts.ts";
import type {
  ClaimDueWorkInput,
  ClaimDueWorkResult,
  CoordinationEventInput,
  CoordinationEventRecord,
  IngestResult,
  ListDueWorkInput,
  RecommendedAction,
  ResolveWaitingInput,
  WaitingItem,
  WaitingKind,
  WaitingStatus,
} from "./contracts.ts";

type SqlRow = Record<string, unknown>;

function asRow(value: unknown): SqlRow {
  if (!value || typeof value !== "object") throw new Error("Expected a SQLite row");
  return value as SqlRow;
}

function parseRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  const parsed: unknown = JSON.parse(value);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  return {};
}

function nowIso(): string {
  return new Date().toISOString();
}

function plusHours(baseIso: string, hours: number): string {
  return new Date(Date.parse(baseIso) + hours * 3_600_000).toISOString();
}

function followupDueAt(input: CoordinationEventInput): string {
  const hint: unknown = input.payload?.followupDueAt;
  if (typeof hint === "string" && !Number.isNaN(Date.parse(hint))) return new Date(hint).toISOString();
  return plusHours(input.observedAt, 48);
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS coord_events (
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
  CREATE INDEX IF NOT EXISTS idx_coord_events_booking ON coord_events(booking_id);
  CREATE INDEX IF NOT EXISTS idx_coord_events_dedupe ON coord_events(dedupe_key);
  CREATE TABLE IF NOT EXISTS coord_waiting (
    id TEXT PRIMARY KEY,
    booking_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    due_at TEXT NOT NULL,
    detail_json TEXT NOT NULL,
    source_event_id TEXT NOT NULL REFERENCES coord_events(id),
    revision INTEGER,
    claimed_by TEXT,
    claimed_at TEXT,
    resolution_note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_coord_waiting_booking_status_due
    ON coord_waiting(booking_id, status, due_at);
  CREATE INDEX IF NOT EXISTS idx_coord_waiting_status_due
    ON coord_waiting(status, due_at);
`;

/**
 * Booking-specific durable event intake + waiting-work ledger.
 *
 * Binds to an injected existing SQLite connection (e.g. `GatherStore.db`)
 * and creates only its own `coord_*` tables in the SAME database.
 * It never creates a second database, scheduler, daemon, or swarm, and it
 * never sends externally or forges approvals: `listDueWork` / `claimDueWork`
 * only return ready decisions for guarded Gather services (or the OpenClaw
 * host loop) to act on.
 *
 * External events are evidence: source IDs + observed timestamps are
 * preserved, but message text alone never verifies payment, availability,
 * or authority.
 */
export class CoordinationLedger {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec(SCHEMA);
  }

  /** Durable, idempotent intake. Safe to retry; concurrent duplicates collapse on dedupe_key. */
  ingestEvent(raw: unknown): IngestResult {
    assertValidEventInput(raw);
    const input = raw;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db
        .prepare("SELECT id FROM coord_events WHERE dedupe_key = $key LIMIT 1")
        .get({ $key: input.dedupeKey });
      if (existing) {
        this.db.exec("COMMIT");
        const record = this.getEventByDedupeKey(input.dedupeKey);
        return {
          duplicate: true,
          stale: record.stale,
          eventId: record.id,
          createdWaiting: [],
          suppressedWaitingIds: [],
          invalidatedWaitingIds: [],
          pausedWaitingIds: [],
          resumedWaitingIds: [],
        };
      }

      const maxRevision = this.maxRevisionForBooking(input.bookingId);
      if (input.revision !== undefined && maxRevision !== null && input.revision < maxRevision) {
        const eventId = this.insertEvent(input, true);
        this.db.exec("COMMIT");
        return {
          duplicate: false,
          stale: true,
          eventId,
          createdWaiting: [],
          suppressedWaitingIds: [],
          invalidatedWaitingIds: [],
          pausedWaitingIds: [],
          resumedWaitingIds: [],
        };
      }

      const eventId = this.insertEvent(input, false);
      const result = this.applySideEffects(input, eventId);
      this.db.exec("COMMIT");
      return { duplicate: false, stale: false, eventId, ...result };
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Rollback best-effort; surface the original failure.
      }
      throw error;
    }
  }

  /** Narrow drain contract for the runtime/host loop: pending waiting due at or before now. */
  listDueWork(raw: unknown): WaitingItem[] {
    assertValidListDueWorkInput(raw);
    const input: ListDueWorkInput = raw;
    const limit = input.limit ?? 50;
    const rows = input.bookingId
      ? this.db
          .prepare(
            `SELECT * FROM coord_waiting WHERE status = 'pending' AND due_at <= $now AND booking_id = $booking
             ORDER BY due_at ASC LIMIT $limit`,
          )
          .all({ $now: input.nowIso, $booking: input.bookingId, $limit: limit })
      : this.db
          .prepare(
            `SELECT * FROM coord_waiting WHERE status = 'pending' AND due_at <= $now
             ORDER BY due_at ASC LIMIT $limit`,
          )
          .all({ $now: input.nowIso, $limit: limit });
    const items = rows.map((row) => this.toWaitingItem(asRow(row)));
    return items.filter((item) => !this.isBlockedBySharedState(item.bookingId));
  }

  /**
   * Concurrency-safe claim: only rows still `pending` flip to `claimed`.
   * A duplicate worker racing the same ids gets them in `skippedIds`.
   */
  claimDueWork(raw: unknown): ClaimDueWorkResult {
    assertValidClaimInput(raw);
    const input: ClaimDueWorkInput = raw;
    const claimed: WaitingItem[] = [];
    const skippedIds: string[] = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const id of input.ids) {
        const updated = this.db
          .prepare(
            `UPDATE coord_waiting SET status = 'claimed', claimed_by = $by, claimed_at = $at, updated_at = $at
             WHERE id = $id AND status = 'pending'`,
          )
          .run({ $by: input.claimedBy, $at: input.nowIso, $id: id });
        const changes = (updated.changes as number | bigint | undefined) ?? 0;
        if (Number(changes) === 1) {
          claimed.push(this.getWaiting(id));
        } else {
          skippedIds.push(id);
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Surface the original failure.
      }
      throw error;
    }
    return { claimed, skippedIds };
  }

  /** Guarded services mark work finished (or superseded) after they act. */
  resolveWaiting(raw: unknown): WaitingItem {
    assertValidResolveInput(raw);
    const input: ResolveWaitingInput = raw;
    const timestamp = nowIso();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.getWaiting(input.id);
      if (current.status !== "pending" && current.status !== "claimed") {
        throw new Error(`Waiting ${input.id} is ${current.status} and cannot be resolved`);
      }
      this.db
        .prepare(
          `UPDATE coord_waiting SET status = $status, resolution_note = $note, updated_at = $at WHERE id = $id`,
        )
        .run({
          $status: input.resolution,
          $note: input.note ?? null,
          $at: timestamp,
          $id: input.id,
        });
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Surface the original failure.
      }
      throw error;
    }
    return this.getWaiting(input.id);
  }

  listWaitingForBooking(bookingId: string): WaitingItem[] {
    if (!bookingId || bookingId.trim().length === 0) throw new Error("bookingId must be a non-empty string");
    const rows = this.db
      .prepare("SELECT * FROM coord_waiting WHERE booking_id = $booking ORDER BY created_at ASC")
      .all({ $booking: bookingId });
    return rows.map((row) => this.toWaitingItem(asRow(row)));
  }

  getEventByDedupeKey(dedupeKey: string): CoordinationEventRecord {
    const found = this.db.prepare("SELECT * FROM coord_events WHERE dedupe_key = $key").get({ $key: dedupeKey });
    if (!found) throw new Error(`Coordination event not found: ${dedupeKey}`);
    return this.toEventRecord(asRow(found));
  }

  private maxRevisionForBooking(bookingId: string): number | null {
    const found = this.db
      .prepare("SELECT MAX(revision) AS max_rev FROM coord_events WHERE booking_id = $booking AND stale = 0")
      .get({ $booking: bookingId });
    const value = found ? asRow(found).max_rev : null;
    return typeof value === "number" ? value : null;
  }

  private insertEvent(input: CoordinationEventInput, stale: boolean): string {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO coord_events
         (id, dedupe_key, kind, booking_id, source_id, source_kind, observed_at, received_at, revision, payload_json, stale)
         VALUES ($id, $dedupe, $kind, $booking, $sourceId, $sourceKind, $observed, $received, $revision, $payload, $stale)`,
      )
      .run({
        $id: id,
        $dedupe: input.dedupeKey,
        $kind: input.kind,
        $booking: input.bookingId,
        $sourceId: input.sourceId,
        $sourceKind: input.sourceKind,
        $observed: new Date(input.observedAt).toISOString(),
        $received: nowIso(),
        $revision: input.revision ?? null,
        $payload: JSON.stringify(input.payload ?? {}),
        $stale: stale ? 1 : 0,
      });
    return id;
  }

  private applySideEffects(
    input: CoordinationEventInput,
    eventId: string,
  ): Omit<IngestResult, "duplicate" | "stale" | "eventId"> {
    const createdWaiting: WaitingItem[] = [];
    const suppressedWaitingIds: string[] = [];
    const invalidatedWaitingIds: string[] = [];
    const pausedWaitingIds: string[] = [];
    const resumedWaitingIds: string[] = [];
    const timestamp = nowIso();

    switch (input.kind) {
      case "inquiry": {
        if (this.sharedBlockReason(input.bookingId) === "cancelled") {
          createdWaiting.push(
            this.insertWaiting(input.bookingId, "followup", "invalidated", followupDueAt(input), eventId, input.revision, {
              reason: "booking_cancelled",
              note: "Booking is cancelled; followup invalidated at intake.",
            }),
          );
          invalidatedWaitingIds.push(createdWaiting[createdWaiting.length - 1]?.id ?? "");
          break;
        }
        // A paused business stays drain-excluded until it is active again,
        // so the followup is kept pending (restorable) rather than invalidated.
        createdWaiting.push(
          this.insertWaiting(input.bookingId, "followup", "pending", followupDueAt(input), eventId, input.revision, {
            reason: "awaiting_customer_reply",
            sourceId: input.sourceId,
          }),
        );
        break;
      }
      case "reply": {
        // Reply-before-followup: a reply observed before a followup is due
        // suppresses pending followups raised from earlier evidence.
        const pending = this.db
          .prepare(
            `SELECT id FROM coord_waiting
             WHERE booking_id = $booking AND kind = 'followup' AND status = 'pending' AND created_at <= $observed`,
          )
          .all({ $booking: input.bookingId, $observed: new Date(input.observedAt).toISOString() });
        for (const row of pending) {
          const id = String(asRow(row).id);
          this.db
            .prepare(
              `UPDATE coord_waiting SET status = 'suppressed', resolution_note = $note, updated_at = $at WHERE id = $id`,
            )
            .run({ $note: `Suppressed by reply ${input.sourceId} observed at ${input.observedAt}`, $at: timestamp, $id: id });
          suppressedWaitingIds.push(id);
        }
        break;
      }
      case "change": {
        const prior = this.db
          .prepare(
            `SELECT id, revision FROM coord_waiting
             WHERE booking_id = $booking AND kind = 'change_review' AND status = 'pending'`,
          )
          .all({ $booking: input.bookingId });
        for (const row of prior) {
          const r = asRow(row);
          const priorRevision = typeof r.revision === "number" ? r.revision : null;
          if (input.revision === undefined || priorRevision === null || input.revision > priorRevision) {
            const id = String(r.id);
            this.db
              .prepare(
                `UPDATE coord_waiting SET status = 'invalidated', resolution_note = $note, updated_at = $at WHERE id = $id`,
              )
              .run({
                $note: `Superseded by change revision ${input.revision ?? "unversioned"} (event ${input.dedupeKey})`,
                $at: timestamp,
                $id: id,
              });
            invalidatedWaitingIds.push(id);
          }
        }
        createdWaiting.push(
          this.insertWaiting(
            input.bookingId,
            "change_review",
            "pending",
            new Date(input.observedAt).toISOString(),
            eventId,
            input.revision,
            { reason: "booking_change_requires_review", sourceId: input.sourceId },
          ),
        );
        break;
      }
      case "payment_signal": {
        // Evidence only: message text claiming payment never verifies a deposit.
        createdWaiting.push(
          this.insertWaiting(
            input.bookingId,
            "deposit_check",
            "pending",
            new Date(input.observedAt).toISOString(),
            eventId,
            input.revision,
            {
              reason: "payment_claim_requires_authoritative_receipt",
              verifiedPayment: false,
              sourceId: input.sourceId,
              note: "Verify against the payment provider receipt; message text is not proof of payment.",
            },
          ),
        );
        break;
      }
      case "resource_signal": {
        createdWaiting.push(
          this.insertWaiting(
            input.bookingId,
            "resource_check",
            "pending",
            new Date(input.observedAt).toISOString(),
            eventId,
            input.revision,
            { reason: "resource_state_requires_verification", sourceId: input.sourceId },
          ),
        );
        break;
      }
      case "pause": {
        const pending = this.db
          .prepare(
            `SELECT id FROM coord_waiting WHERE booking_id = $booking AND status = 'pending'`,
          )
          .all({ $booking: input.bookingId });
        for (const row of pending) {
          const id = String(asRow(row).id);
          this.db
            .prepare(`UPDATE coord_waiting SET status = 'paused', updated_at = $at WHERE id = $id`)
            .run({ $at: timestamp, $id: id });
          pausedWaitingIds.push(id);
        }
        break;
      }
      case "resume": {
        const paused = this.db
          .prepare(`SELECT id FROM coord_waiting WHERE booking_id = $booking AND status = 'paused'`)
          .all({ $booking: input.bookingId });
        for (const row of paused) {
          const id = String(asRow(row).id);
          this.db
            .prepare(`UPDATE coord_waiting SET status = 'pending', updated_at = $at WHERE id = $id`)
            .run({ $at: timestamp, $id: id });
          resumedWaitingIds.push(id);
        }
        break;
      }
      case "cancel": {
        const open = this.db
          .prepare(
            `SELECT id FROM coord_waiting WHERE booking_id = $booking AND (status = 'pending' OR status = 'paused')`,
          )
          .all({ $booking: input.bookingId });
        for (const row of open) {
          const id = String(asRow(row).id);
          this.db
            .prepare(
              `UPDATE coord_waiting SET status = 'invalidated', resolution_note = $note, updated_at = $at WHERE id = $id`,
            )
            .run({ $note: `Invalidated by cancellation (event ${input.dedupeKey})`, $at: timestamp, $id: id });
          invalidatedWaitingIds.push(id);
        }
        break;
      }
    }

    return { createdWaiting, suppressedWaitingIds, invalidatedWaitingIds, pausedWaitingIds, resumedWaitingIds };
  }

  private insertWaiting(
    bookingId: string,
    kind: WaitingKind,
    status: WaitingStatus,
    dueAt: string,
    sourceEventId: string,
    revision: number | undefined,
    detail: Record<string, unknown>,
  ): WaitingItem {
    const id = randomUUID();
    const timestamp = nowIso();
    const recommendation = recommendedFor(kind);
    const stored: Record<string, unknown> = {
      ...detail,
      recommendedAction: recommendation.recommendedAction,
      requiresApproval: recommendation.requiresApproval,
      requiresFreshCheck: recommendation.requiresFreshCheck,
    };
    this.db
      .prepare(
        `INSERT INTO coord_waiting
         (id, booking_id, kind, status, due_at, detail_json, source_event_id, revision, created_at, updated_at)
         VALUES ($id, $booking, $kind, $status, $due, $detail, $event, $revision, $created, $updated)`,
      )
      .run({
        $id: id,
        $booking: bookingId,
        $kind: kind,
        $status: status,
        $due: dueAt,
        $detail: JSON.stringify(stored),
        $event: sourceEventId,
        $revision: revision ?? null,
        $created: timestamp,
        $updated: timestamp,
      });
    return this.getWaiting(id);
  }

  private getWaiting(id: string): WaitingItem {
    const found = this.db.prepare("SELECT * FROM coord_waiting WHERE id = $id").get({ $id: id });
    if (!found) throw new Error(`Waiting item not found: ${id}`);
    return this.toWaitingItem(asRow(found));
  }

  private toWaitingItem(value: SqlRow): WaitingItem {
    const kind = String(value.kind) as WaitingKind;
    const recommendation = recommendedFor(kind);
    const detail = parseRecord(value.detail_json);
    return {
      id: String(value.id),
      bookingId: String(value.booking_id),
      kind,
      status: value.status as WaitingStatus,
      dueAt: String(value.due_at),
      detail,
      sourceEventId: String(value.source_event_id),
      revision: typeof value.revision === "number" ? value.revision : undefined,
      claimedBy: value.claimed_by ? String(value.claimed_by) : undefined,
      claimedAt: value.claimed_at ? String(value.claimed_at) : undefined,
      resolutionNote: value.resolution_note ? String(value.resolution_note) : undefined,
      createdAt: String(value.created_at),
      updatedAt: String(value.updated_at),
      recommendedAction: (detail.recommendedAction as RecommendedAction | undefined) ?? recommendation.recommendedAction,
      requiresApproval: typeof detail.requiresApproval === "boolean" ? detail.requiresApproval : recommendation.requiresApproval,
      requiresFreshCheck:
        typeof detail.requiresFreshCheck === "boolean" ? detail.requiresFreshCheck : recommendation.requiresFreshCheck,
    };
  }

  private toEventRecord(value: SqlRow): CoordinationEventRecord {
    return {
      id: String(value.id),
      dedupeKey: String(value.dedupe_key),
      kind: value.kind as CoordinationEventInput["kind"],
      bookingId: String(value.booking_id),
      sourceId: String(value.source_id),
      sourceKind: String(value.source_kind),
      observedAt: String(value.observed_at),
      receivedAt: String(value.received_at),
      revision: typeof value.revision === "number" ? value.revision : undefined,
      payload: parseRecord(value.payload_json),
      stale: Number(value.stale) === 1,
    };
  }

  /**
   * Drain-time guard: never surface due work for a cancelled booking or a
   * paused business. Reads the shared Gather tables when present; a bare
   * injected connection without them simply yields no exclusion.
   */
  private isBlockedBySharedState(bookingId: string): boolean {
    return this.sharedBlockReason(bookingId) !== null;
  }

  private sharedBlockReason(bookingId: string): "cancelled" | "paused" | null {
    try {
      const booking = this.db.prepare("SELECT business_id, status FROM bookings WHERE id = $id").get({ $id: bookingId });
      if (!booking) return null;
      const row = asRow(booking);
      if (String(row.status) === "cancelled") return "cancelled";
      const businessId: unknown = row.business_id;
      if (typeof businessId !== "string" || businessId.length === 0) return null;
      const business = this.db.prepare("SELECT status FROM businesses WHERE id = $id").get({ $id: businessId });
      if (!business) return null;
      return String(asRow(business).status) === "paused" ? "paused" : null;
    } catch {
      return null;
    }
  }
}
