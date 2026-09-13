import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  assertValidClaimInput,
  assertValidEventInput,
  assertValidLedgerOptions,
  assertValidListDueWorkInput,
  assertValidOwnerControlInput,
  assertValidReleaseInput,
  assertValidResolveInput,
  assertValidVerifiedReceiptInput,
  recommendedFor,
} from "./contracts.ts";
import type {
  ClaimDueWorkInput,
  ClaimDueWorkResult,
  ControlState,
  CoordinationEventInput,
  CoordinationEventRecord,
  IngestResult,
  LedgerOptions,
  ListDueWorkInput,
  OwnerControlInput,
  OwnerControlResult,
  RecommendedAction,
  ReleaseStaleClaimsInput,
  ResolveWaitingInput,
  VerifiedReceiptInput,
  VerifiedReceiptResult,
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

/** Normalize a validated ISO-8601 timestamp to epoch millis for comparison. */
function epochOf(value: string): number {
  return Date.parse(value);
}

/** Normalize a validated ISO-8601 timestamp to canonical UTC for storage. */
function storedIso(value: string): string {
  return new Date(value).toISOString();
}

function plusHours(baseIso: string, hours: number): string {
  return new Date(Date.parse(baseIso) + hours * 3_600_000).toISOString();
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

/** Content fingerprint for dedupe-key reuse conflicts (excludes received_at). */
function eventContentFingerprint(input: {
  kind: string;
  bookingId: string;
  sourceId: string;
  sourceKind: string;
  observedAt: string;
  revision?: number;
  payload: Record<string, unknown>;
}): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(input))).digest("hex");
}

function followupDueAt(input: CoordinationEventInput): string {
  const hint: unknown = input.payload?.followupDueAt;
  if (typeof hint === "string" && !Number.isNaN(Date.parse(hint))) return new Date(hint).toISOString();
  return plusHours(input.observedAt, 48);
}

const EVENT_COLUMNS =
  "(id, dedupe_key, kind, booking_id, source_id, source_kind, observed_at, received_at, revision, payload_json, stale)";

const MODERN_EVENT_COLS = [
  "id", "dedupe_key", "kind", "booking_id", "source_id", "source_kind",
  "observed_at", "received_at", "revision", "payload_json", "stale",
];

const MODERN_WAITING_COLS = [
  "id", "booking_id", "kind", "status", "due_at", "detail_json", "source_event_id",
  "revision", "claimed_by", "claimed_at", "resolution_note", "created_at", "updated_at",
  "claim_token", "claim_expires_at",
];

const WAITING_SCHEMA = `
  CREATE TABLE coord_waiting (
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
    updated_at TEXT NOT NULL,
    claim_token TEXT,
    claim_expires_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_coord_waiting_booking_status_due
    ON coord_waiting(booking_id, status, due_at);
  CREATE INDEX IF NOT EXISTS idx_coord_waiting_status_due
    ON coord_waiting(status, due_at);
`;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS coord_events (
    id TEXT PRIMARY KEY,
    dedupe_key TEXT NOT NULL,
    kind TEXT NOT NULL,
    booking_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    received_at TEXT NOT NULL,
    revision INTEGER,
    payload_json TEXT NOT NULL,
    stale INTEGER NOT NULL DEFAULT 0,
    UNIQUE (booking_id, dedupe_key)
  );
  CREATE INDEX IF NOT EXISTS idx_coord_events_booking ON coord_events(booking_id);
  CREATE INDEX IF NOT EXISTS idx_coord_events_dedupe ON coord_events(booking_id, dedupe_key);
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
    updated_at TEXT NOT NULL,
    claim_token TEXT,
    claim_expires_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_coord_waiting_booking_status_due
    ON coord_waiting(booking_id, status, due_at);
  CREATE INDEX IF NOT EXISTS idx_coord_waiting_status_due
    ON coord_waiting(status, due_at);
  CREATE TABLE IF NOT EXISTS coord_control (
    booking_id TEXT PRIMARY KEY,
    state TEXT NOT NULL CHECK (state IN ('paused', 'cancelled')),
    updated_at TEXT NOT NULL,
    source_event_id TEXT NOT NULL
  );
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
 * Authority model: `ingestEvent` treats EVERYTHING as evidence and can never
 * honor pause/resume/cancel or retire deposit reminders, no matter what
 * sourceKind or payload it carries. Control authority flows only through
 * `applyOwnerControl` (explicit host attestation) and receipt retirement
 * only through `recordVerifiedReceipt` (explicit trusted verifier).
 */
export class CoordinationLedger {
  private readonly db: DatabaseSync;
  private readonly sharedTables: "auto" | "required" | "off";
  private readonly clock: () => string;

  constructor(db: DatabaseSync, options?: unknown) {
    assertValidLedgerOptions(options);
    const opts: LedgerOptions = (options ?? {}) as LedgerOptions;
    this.db = db;
    this.sharedTables = opts.sharedTables ?? "auto";
    this.clock = opts.clock ?? nowIso;
    this.upgradeLegacyDedupeScope();
    this.db.exec(SCHEMA);
    this.ensureColumn("coord_waiting", "claim_token", "TEXT");
    this.ensureColumn("coord_waiting", "claim_expires_at", "TEXT");
  }

  /** Trusted clock for lease-expiry enforcement (injectable for tests). */
  private now(): string {
    const value = this.clock();
    if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
      throw new Error("Ledger clock returned an invalid ISO-8601 timestamp");
    }
    return value;
  }

  private ensureColumn(table: string, column: string, type: string): void {
    const info = this.db.prepare(`PRAGMA table_info(${table})`).all() as SqlRow[];
    const names = new Set(info.map((row) => String(asRow(row).name)));
    if (!names.has(column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }

  private tableExists(name: string): boolean {
    const found = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = $name").get({ $name: name });
    return found !== null && found !== undefined;
  }

  private pragmaState(): { foreignKeys: boolean; legacyAlterTable: boolean } {
    const fk = this.db.prepare("PRAGMA foreign_keys").get();
    const legacy = this.db.prepare("PRAGMA legacy_alter_table").get();
    return {
      foreignKeys: fk !== null && fk !== undefined && Number(asRow(fk).foreign_keys) === 1,
      legacyAlterTable: legacy !== null && legacy !== undefined && Number(asRow(legacy).legacy_alter_table) === 1,
    };
  }

  /**
   * Freeze schema-rewriting behavior for a rebuild: enforcement off (so
   * intermediate states never fail) and legacy rename semantics on (so
   * RENAME never retargets other tables' REFERENCES clauses at the new
   * table). Both settings are always restored; see the finally blocks.
   */
  private freezeRebuildPragmas(): { foreignKeys: boolean; legacyAlterTable: boolean } {
    const prior = this.pragmaState();
    this.db.exec("PRAGMA foreign_keys = OFF");
    this.db.exec("PRAGMA legacy_alter_table = ON");
    return prior;
  }

  private restoreRebuildPragmas(prior: { foreignKeys: boolean; legacyAlterTable: boolean }): void {
    this.db.exec(`PRAGMA foreign_keys = ${prior.foreignKeys ? "ON" : "OFF"}`);
    this.db.exec(`PRAGMA legacy_alter_table = ${prior.legacyAlterTable ? "ON" : "OFF"}`);
  }

  /** True when coord_events already carries the scoped UNIQUE(booking_id, dedupe_key). */
  private hasScopedDedupe(): boolean {
    if (!this.tableExists("coord_events")) return false;
    const indexes = this.db.prepare("PRAGMA index_list(coord_events)").all() as SqlRow[];
    for (const entry of indexes) {
      const row = asRow(entry);
      if (row.origin !== "u" && row.origin !== "pk") continue;
      const columns = this.db.prepare(`PRAGMA index_info(${String(row.name)})`).all() as SqlRow[];
      const names = columns
        .map((column) => asRow(column))
        .sort((left, right) => Number(left.seqno) - Number(right.seqno))
        .map((column) => this.eventsColumnName(Number(column.cid)));
      if (names.length === 2 && names[0] === "booking_id" && names[1] === "dedupe_key") return true;
    }
    return false;
  }

  private eventsColumnName(cid: number): string {
    const info = this.db.prepare("PRAGMA table_info(coord_events)").all() as SqlRow[];
    for (const row of info) {
      const record = asRow(row);
      if (Number(record.cid) === cid) return String(record.name);
    }
    return "";
  }

  private foreignKeyCheckEmpty(): void {
    const violations = this.db.prepare("PRAGMA foreign_key_check").all() as SqlRow[];
    if (violations.length > 0) {
      throw new Error(`Migration left ${violations.length} foreign-key violation(s); refusing to commit a half-migration`);
    }
  }

  private rowCount(table: string): number {
    const found = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
    return found ? Number(asRow(found).n) : 0;
  }

  /**
   * Upgrade pre-scoped databases: the original schema enforced a GLOBAL
   * dedupe_key UNIQUE, contradicting the documented per-booking scope.
   *
   * Appropriate SQLite table-rebuild procedure: foreign keys are disabled
   * only for the duration of the rebuild (never permanently — the prior
   * setting is always restored), the rebuild runs inside one transaction
   * with row-count and foreign_key_check gates before commit, and any
   * failure rolls back to the original schema intact and retryable.
   */
  private upgradeLegacyDedupeScope(): void {
    if (this.hasScopedDedupe()) {
      this.recoverLegacyLeftover();
      return;
    }
    if (!this.tableExists("coord_events")) return; // Fresh database: SCHEMA creates.
    const prior = this.freezeRebuildPragmas();
    try {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.exec("ALTER TABLE coord_events RENAME TO coord_events_legacy");
        this.db.exec(SCHEMA);
        const before = this.rowCount("coord_events_legacy");
        this.db.exec(`INSERT INTO coord_events ${EVENT_COLUMNS} SELECT ${EVENT_COLUMNS.slice(1, -1)} FROM coord_events_legacy`);
        const after = this.rowCount("coord_events");
        if (before !== after) {
          throw new Error(`Migration row-count mismatch (legacy ${before}, rebuilt ${after}); refusing to drop work`);
        }
        this.foreignKeyCheckEmpty();
        this.db.exec("DROP TABLE coord_events_legacy");
        this.db.exec("COMMIT");
      } catch (error) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          // Surface the original migration failure below.
        }
        throw error;
      }
    } finally {
      this.restoreRebuildPragmas(prior);
    }
  }

  /**
   * Repair state left by the previous non-atomic migrator (both event tables
   * present, waiting FK possibly retargeted at the legacy name): merge
   * missing rows, rebuild the waiting table only if its FK targets the
   * legacy name, drop the legacy table. Every waiting column — including
   * live claim tokens, lease expiries, and resolution metadata — is copied
   * verbatim (NULL only where the legacy table predates the column), and
   * merged event rows are verified field-for-field: a same-id conflict
   * aborts atomically with both original tables preserved. Same atomicity
   * gates as migration.
   */
  private recoverLegacyLeftover(): void {
    if (!this.tableExists("coord_events_legacy")) return;
    const prior = this.freezeRebuildPragmas();
    try {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.exec(`INSERT OR IGNORE INTO coord_events ${EVENT_COLUMNS} SELECT ${EVENT_COLUMNS.slice(1, -1)} FROM coord_events_legacy`);
        this.verifyEventsMergeExact();
        if (this.waitingReferencesLegacyEvents()) {
          this.db.exec("ALTER TABLE coord_waiting RENAME TO coord_waiting_legacy");
          this.db.exec(WAITING_SCHEMA);
          // Copy every modern column verbatim; only columns the legacy
          // table predates default to NULL. Claim tokens, lease expiries,
          // and resolution notes are never silently discarded.
          const legacyInfo = this.db.prepare("PRAGMA table_info(coord_waiting_legacy)").all() as SqlRow[];
          const legacyCols = new Set(legacyInfo.map((row) => String(asRow(row).name)));
          const selectCols = MODERN_WAITING_COLS.map((column) => (legacyCols.has(column) ? column : "NULL"));
          this.db.exec(`INSERT INTO coord_waiting (${MODERN_WAITING_COLS.join(", ")}) SELECT ${selectCols.join(", ")} FROM coord_waiting_legacy`);
          this.verifyWaitingCopyExact();
          this.db.exec("DROP TABLE coord_waiting_legacy");
        }
        this.db.exec("DROP TABLE coord_events_legacy");
        this.foreignKeyCheckEmpty();
        this.db.exec("COMMIT");
      } catch (error) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          // Surface the original failure below.
        }
        throw error;
      }
    } finally {
      this.restoreRebuildPragmas(prior);
    }
  }

  /** Every legacy event row must have a field-identical twin after the merge. */
  private verifyEventsMergeExact(): void {
    const cols = MODERN_EVENT_COLS.join(", ");
    const legacyRows = this.db.prepare(`SELECT ${cols} FROM coord_events_legacy ORDER BY id`).all() as SqlRow[];
    for (const row of legacyRows) {
      const record = asRow(row);
      const twin = this.db.prepare(`SELECT ${cols} FROM coord_events WHERE id = $id`).get({ $id: String(record.id) });
      if (!twin || JSON.stringify(canonicalize(asRow(twin))) !== JSON.stringify(canonicalize(record))) {
        throw new Error(
          `Conflicting legacy event row ${String(record.id)}: merge would silently drop it; preserving both original tables`,
        );
      }
    }
  }

  /** Every rebuilt waiting row must match its legacy source field-for-field. */
  private verifyWaitingCopyExact(): void {
    const legacyInfo = this.db.prepare("PRAGMA table_info(coord_waiting_legacy)").all() as SqlRow[];
    const legacyCols = new Set(legacyInfo.map((row) => String(asRow(row).name)));
    const selectCols = MODERN_WAITING_COLS.map((column) => (legacyCols.has(column) ? column : "NULL"));
    const legacyRows = this.db
      .prepare(`SELECT ${selectCols.join(", ")} FROM coord_waiting_legacy ORDER BY id`)
      .all() as SqlRow[];
    const rebuiltRows = this.db
      .prepare(`SELECT ${MODERN_WAITING_COLS.join(", ")} FROM coord_waiting ORDER BY id`)
      .all() as SqlRow[];
    if (legacyRows.length !== rebuiltRows.length) {
      throw new Error(
        `Waiting rebuild row-count mismatch (legacy ${legacyRows.length}, rebuilt ${rebuiltRows.length}); refusing to drop work`,
      );
    }
    // NULL and JSON null normalize identically through canonicalization.
    for (const [index, legacyRow] of legacyRows.entries()) {
      const rebuilt = rebuiltRows[index] as SqlRow;
      if (JSON.stringify(canonicalize(asRow(legacyRow))) !== JSON.stringify(canonicalize(rebuilt))) {
        throw new Error(`Waiting rebuild value mismatch on row ${index}; refusing to drop work`);
      }
    }
  }

  private waitingReferencesLegacyEvents(): boolean {
    if (!this.tableExists("coord_waiting")) return false;
    const refs = this.db.prepare("PRAGMA foreign_key_list(coord_waiting)").all() as SqlRow[];
    return refs.some((row) => String(asRow(row).table) === "coord_events_legacy");
  }

  /** Durable, idempotent intake. Safe to retry; concurrent duplicates collapse on (booking, dedupe_key). */
  ingestEvent(raw: unknown): IngestResult {
    assertValidEventInput(raw);
    const input = raw;
    const empty = {
      createdWaiting: [],
      suppressedWaitingIds: [],
      invalidatedWaitingIds: [],
      pausedWaitingIds: [],
      resumedWaitingIds: [],
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.findEvent(input.bookingId, input.dedupeKey);
      if (existing) {
        this.assertSameContent(existing, {
          kind: input.kind,
          bookingId: input.bookingId,
          sourceId: input.sourceId,
          sourceKind: input.sourceKind,
          observedAt: storedIso(input.observedAt),
          revision: input.revision,
          payload: input.payload ?? {},
        });
        this.db.exec("COMMIT");
        return { duplicate: true, stale: existing.stale, eventId: existing.id, ...empty };
      }

      const maxRevision = this.maxRevisionForBooking(input.bookingId);
      if (input.revision !== undefined && maxRevision !== null && input.revision < maxRevision) {
        const eventId = this.insertEvent(input, true);
        this.db.exec("COMMIT");
        return { duplicate: false, stale: true, eventId, ...empty };
      }

      // Monotonic reply ordering: a reply older than the latest processed
      // reply for this booking arrives late and changes nothing.
      if (input.kind === "reply") {
        const latest = this.maxReplyObservedForBooking(input.bookingId);
        if (latest !== null && Date.parse(input.observedAt) < Date.parse(latest)) {
          const eventId = this.insertEvent(input, true);
          this.db.exec("COMMIT");
          return { duplicate: false, stale: true, eventId, ...empty };
        }
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

  /**
   * Trusted owner control. Authority comes ONLY from the host calling this
   * method with an explicit owner attestation. Raw event fields can never
   * reach this path: `ingestEvent` records control requests as decisions
   * and honors nothing.
   */
  applyOwnerControl(raw: unknown): OwnerControlResult {
    assertValidOwnerControlInput(raw);
    const input: OwnerControlInput = raw;
    const timestamp = this.now();
    const observedAt = storedIso(input.observedAt ?? timestamp);
    const empty: { pausedWaitingIds: string[]; resumedWaitingIds: string[]; invalidatedWaitingIds: string[] } = {
      pausedWaitingIds: [],
      resumedWaitingIds: [],
      invalidatedWaitingIds: [],
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const parts = {
        kind: input.kind,
        bookingId: input.bookingId,
        sourceId: `owner-control:${input.dedupeKey}`,
        sourceKind: "owner-control",
        observedAt,
        revision: undefined,
        payload: { attestedBy: input.attestedBy, ...(input.note === undefined ? {} : { note: input.note }) },
      };
      const existing = this.findEvent(input.bookingId, input.dedupeKey);
      if (existing) {
        // Attested redelivery: identity is the stable key plus semantic
        // content. observedAt defaults to intake time, so it is excluded
        // from the comparison — otherwise every retry would conflict.
        this.assertSameContent(existing, parts, true);
        this.db.exec("COMMIT");
        return { duplicate: true, eventId: existing.id, controlHonored: true, ...empty };
      }
      const eventId = this.insertAttestedEvent({ ...parts, dedupeKey: input.dedupeKey });
      const affected = { ...empty };
      if (input.kind === "pause") {
        this.setControlState(input.bookingId, "paused", eventId, timestamp);
        for (const id of this.waitingIdsIn(input.bookingId, ["pending"])) {
          this.db
            .prepare(`UPDATE coord_waiting SET status = 'paused', updated_at = $at WHERE id = $id`)
            .run({ $at: timestamp, $id: id });
          affected.pausedWaitingIds.push(id);
        }
        // Fence in-flight work: claimed items must not complete after a pause.
        for (const id of this.waitingIdsIn(input.bookingId, ["claimed"])) {
          this.invalidateWaiting(id, `Invalidated by pause (owner control ${input.dedupeKey})`, timestamp);
          affected.invalidatedWaitingIds.push(id);
        }
      } else if (input.kind === "resume") {
        if (this.getControlState(input.bookingId) === "cancelled") {
          throw new Error(`Booking ${input.bookingId} is cancelled; resume is refused (cancellation is terminal)`);
        }
        this.clearControlState(input.bookingId);
        for (const id of this.waitingIdsIn(input.bookingId, ["paused"])) {
          this.db
            .prepare(`UPDATE coord_waiting SET status = 'pending', updated_at = $at WHERE id = $id`)
            .run({ $at: timestamp, $id: id });
          affected.resumedWaitingIds.push(id);
        }
      } else {
        this.setControlState(input.bookingId, "cancelled", eventId, timestamp);
        for (const id of this.waitingIdsIn(input.bookingId, ["pending", "paused", "claimed"])) {
          this.invalidateWaiting(id, `Invalidated by cancellation (owner control ${input.dedupeKey})`, timestamp);
          affected.invalidatedWaitingIds.push(id);
        }
      }
      this.db.exec("COMMIT");
      return { duplicate: false, eventId, controlHonored: true, ...affected };
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Surface the original failure.
      }
      throw error;
    }
  }

  /**
   * Authoritative receipt recording. Only this host-attested call — naming an
   * explicit trusted verifier and receipt locator — retires deposit
   * followups. Raw `verifiedReceipt` booleans in provider payloads never do.
   * The deposit is still recorded as unverified evidence for the
   * confirmation worker (G12), never counted as paid.
   */
  recordVerifiedReceipt(raw: unknown): VerifiedReceiptResult {
    assertValidVerifiedReceiptInput(raw);
    const input: VerifiedReceiptInput = raw;
    const timestamp = this.now();
    const observedAt = storedIso(input.observedAt ?? timestamp);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const parts = {
        kind: "payment_signal",
        bookingId: input.bookingId,
        sourceId: `trusted-receipt:${input.dedupeKey}`,
        sourceKind: "trusted-receipt",
        observedAt,
        revision: undefined,
        payload: {
          receiptLocator: input.receiptLocator,
          verifiedBy: input.verifiedBy,
          ...(input.note === undefined ? {} : { note: input.note }),
        },
      };
      const existing = this.findEvent(input.bookingId, input.dedupeKey);
      if (existing) {
        // Same stable-identity rule as owner control: observedAt defaults to
        // intake time and is excluded from redelivery comparison.
        this.assertSameContent(existing, parts, true);
        const prior = this.db
          .prepare("SELECT * FROM coord_waiting WHERE source_event_id = $event AND kind = 'deposit_check' LIMIT 1")
          .get({ $event: existing.id });
        if (!prior) throw new Error(`Receipt event ${input.dedupeKey} has no deposit check; refusing to invent one`);
        this.db.exec("COMMIT");
        return { duplicate: true, eventId: existing.id, suppressedWaitingIds: [], depositCheck: this.toWaitingItem(asRow(prior)) };
      }
      const eventId = this.insertAttestedEvent({ ...parts, dedupeKey: input.dedupeKey });
      const suppressedWaitingIds = this.suppressFollowups(input.bookingId, timestamp);
      const depositCheck = this.insertWaiting(
        input.bookingId,
        "deposit_check",
        "done",
        observedAt,
        eventId,
        undefined,
        {
          reason: "receipt_evidence_attached_for_confirmation",
          verifiedPayment: false,
          receiptLocator: input.receiptLocator,
          verifiedBy: input.verifiedBy,
          note: "Receipt evidence recorded by a trusted verifier; confirmation still requires the authoritative receipt check.",
        },
      );
      this.db.exec("COMMIT");
      return { duplicate: false, eventId, suppressedWaitingIds, depositCheck };
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Surface the original failure.
      }
      throw error;
    }
  }

  /** Narrow drain contract for the runtime/host loop: pending waiting due at or before now. */
  listDueWork(raw: unknown): WaitingItem[] {
    assertValidListDueWorkInput(raw);
    const input: ListDueWorkInput = raw;
    const limit = input.limit ?? 50;
    // Normalize before comparing: stored timestamps are canonical UTC, and a
    // caller-supplied offset (e.g. +02:00) must not change drain semantics.
    const now = storedIso(input.nowIso);
    const rows = input.bookingId
      ? this.db
          .prepare(
            `SELECT * FROM coord_waiting WHERE status = 'pending' AND due_at <= $now AND booking_id = $booking
             ORDER BY due_at ASC LIMIT $limit`,
          )
          .all({ $now: now, $booking: input.bookingId, $limit: limit })
      : this.db
          .prepare(
            `SELECT * FROM coord_waiting WHERE status = 'pending' AND due_at <= $now
             ORDER BY due_at ASC LIMIT $limit`,
          )
          .all({ $now: now, $limit: limit });
    const items = rows.map((row) => this.toWaitingItem(asRow(row)));
    return items.filter((item) => !this.isBlockedBySharedState(item.bookingId));
  }

  /**
   * Concurrency-safe claim with atomic claim-time rechecks. Each id is
   * revalidated inside the claim transaction against pause/cancel state,
   * current revisions, and reply suppression — a stale `listDueWork`
   * snapshot alone can never hand out obsolete work. Only rows still
   * `pending` flip to `claimed`; a racing duplicate worker receives those
   * ids in `skippedIds`.
   */
  claimDueWork(raw: unknown): ClaimDueWorkResult {
    assertValidClaimInput(raw);
    const input: ClaimDueWorkInput = raw;
    const leaseMs = input.leaseMs ?? 300_000;
    const claimed: WaitingItem[] = [];
    const skippedIds: string[] = [];
    const suppressedIds: string[] = [];
    const invalidatedIds: string[] = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const id of input.ids) {
        const outcome = this.claimOne(id, input.claimedBy, input.nowIso, leaseMs);
        if (outcome === "claimed") claimed.push(this.getWaiting(id));
        else if (outcome === "suppressed") suppressedIds.push(id);
        else if (outcome === "invalidated") invalidatedIds.push(id);
        else skippedIds.push(id);
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
    return { claimed, skippedIds, suppressedIds, invalidatedIds };
  }

  /**
   * Durable claim recovery: claims whose lease expired without resolution
   * return to `pending` so a live worker can pick them up. Returns the
   * released waiting ids.
   */
  releaseStaleClaims(raw: unknown): string[] {
    assertValidReleaseInput(raw);
    const input: ReleaseStaleClaimsInput = raw;
    const timestamp = this.now();
    // Epoch comparison: caller clocks in any valid ISO shape behave identically.
    const nowMs = epochOf(input.nowIso);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db
        .prepare(
          `SELECT id, claim_expires_at FROM coord_waiting
           WHERE status = 'claimed' AND claim_expires_at IS NOT NULL`,
        )
        .all();
      const ids: string[] = [];
      for (const row of rows) {
        const record = asRow(row);
        const expires = String(record.claim_expires_at);
        if (!Number.isFinite(Date.parse(expires)) || Date.parse(expires) > nowMs) continue;
        ids.push(String(record.id));
      }
      for (const id of ids) {
        this.db
          .prepare(
            `UPDATE coord_waiting SET status = 'pending', claimed_by = NULL, claimed_at = NULL,
             claim_token = NULL, claim_expires_at = NULL, updated_at = $at WHERE id = $id`,
          )
          .run({ $at: timestamp, $id: id });
      }
      this.db.exec("COMMIT");
      return ids;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Surface the original failure.
      }
      throw error;
    }
  }

  /**
   * Guarded services mark work finished (or superseded) after they act.
   * Claimed work requires its fencing token, which must be present and
   * match, AND the claim lease must still hold on the trusted clock: an
   * expired unreleased claim cannot resolve even with the right token —
   * release it and re-claim first. Pending work resolves without a token —
   * but presenting any token against pending work throws, so a stale token
   * can never silently close a released claim. No external effect is
   * duplicated after uncertainty by this ledger alone; services must still
   * use stable operation keys and reconcile.
   */
  resolveWaiting(raw: unknown): WaitingItem {
    assertValidResolveInput(raw);
    const input: ResolveWaitingInput = raw;
    const timestamp = this.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.getWaiting(input.id);
      if (current.status === "claimed") {
        if (!current.claimToken || input.claimToken !== current.claimToken) {
          throw new Error(`Waiting ${input.id} was claimed by another worker (stale claim token)`);
        }
        if (
          current.claimExpiresAt !== undefined &&
          Number.isFinite(Date.parse(current.claimExpiresAt)) &&
          Date.parse(current.claimExpiresAt) <= epochOf(this.now())
        ) {
          throw new Error(
            `Waiting ${input.id} claim lease expired at ${current.claimExpiresAt}; release it and re-claim before resolving`,
          );
        }
      } else if (current.status === "pending") {
        if (input.claimToken !== undefined) {
          throw new Error(`Waiting ${input.id} is pending with no active claim (stale claim token)`);
        }
      } else {
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

  getEventByDedupeKey(bookingId: string, dedupeKey: string): CoordinationEventRecord {
    if (!bookingId || bookingId.trim().length === 0) throw new Error("bookingId must be a non-empty string");
    const found = this.findEvent(bookingId, dedupeKey);
    if (!found) throw new Error(`Coordination event not found: ${bookingId}/${dedupeKey}`);
    return found;
  }

  /** Persisted owner-control state for a booking (active when absent). */
  controlStateForBooking(bookingId: string): ControlState {
    if (!bookingId || bookingId.trim().length === 0) throw new Error("bookingId must be a non-empty string");
    return this.getControlState(bookingId) ?? "active";
  }

  private claimOne(id: string, claimedBy: string, nowIsoValue: string, leaseMs: number): string {
    const found = this.db.prepare("SELECT * FROM coord_waiting WHERE id = $id").get({ $id: id });
    if (!found) return "skipped";
    const item = this.toWaitingItem(asRow(found));
    if (item.status !== "pending") return "skipped";
    if (epochOf(item.dueAt) > epochOf(nowIsoValue)) return "skipped";
    if (this.isBlockedBySharedState(item.bookingId)) return "skipped";
    if (this.getControlState(item.bookingId) !== null) return "skipped";
    // Reply received after the list snapshot: suppress instead of handing
    // out a reminder the customer already answered.
    if (item.kind === "followup" && this.replyReceivedSince(item.bookingId, item.createdAt)) {
      this.db
        .prepare(`UPDATE coord_waiting SET status = 'suppressed', resolution_note = $note, updated_at = $at WHERE id = $id`)
        .run({
          $note: "Suppressed at claim time: reply received after the drain snapshot",
          $at: this.now(),
          $id: id,
        });
      return "suppressed";
    }
    // A newer revision landed after the list snapshot: invalidate stale review.
    const maxRevision = this.maxRevisionForBooking(item.bookingId);
    if (
      item.kind === "change_review" &&
      item.revision !== undefined &&
      maxRevision !== null &&
      item.revision < maxRevision
    ) {
      this.db
        .prepare(
          `UPDATE coord_waiting SET status = 'invalidated', resolution_note = $note, updated_at = $at WHERE id = $id`,
        )
        .run({ $note: "Invalidated at claim time: newer revision received", $at: this.now(), $id: id });
      return "invalidated";
    }
    const token = randomUUID();
    const expiresAt = new Date(Date.parse(nowIsoValue) + leaseMs).toISOString();
    this.db
      .prepare(
        `UPDATE coord_waiting SET status = 'claimed', claimed_by = $by, claimed_at = $at,
         claim_token = $token, claim_expires_at = $expires, updated_at = $at
         WHERE id = $id AND status = 'pending'`,
      )
      .run({ $by: claimedBy, $at: nowIsoValue, $token: token, $expires: expiresAt, $id: id });
    return "claimed";
  }

  private maxRevisionForBooking(bookingId: string): number | null {
    const found = this.db
      .prepare("SELECT MAX(revision) AS max_rev FROM coord_events WHERE booking_id = $booking AND stale = 0")
      .get({ $booking: bookingId });
    const value = found ? asRow(found).max_rev : null;
    return typeof value === "number" ? value : null;
  }

  private maxReplyObservedForBooking(bookingId: string): string | null {
    const found = this.db
      .prepare(
        "SELECT MAX(observed_at) AS max_obs FROM coord_events WHERE booking_id = $booking AND kind = 'reply' AND stale = 0",
      )
      .get({ $booking: bookingId });
    const value = found ? asRow(found).max_obs : null;
    return typeof value === "string" ? value : null;
  }

  /**
   * Received-order reply check: any non-stale reply received at or after the
   * waiting item was created answers it, regardless of source-clock skew in
   * observedAt. Stale (older-than-processed) replies never suppress.
   */
  private replyReceivedSince(bookingId: string, createdAt: string): boolean {
    const createdMs = epochOf(createdAt);
    const rows = this.db
      .prepare(
        `SELECT received_at FROM coord_events
         WHERE booking_id = $booking AND kind = 'reply' AND stale = 0`,
      )
      .all({ $booking: bookingId });
    for (const row of rows) {
      const received = asRow(row).received_at;
      if (typeof received === "string" && Number.isFinite(Date.parse(received)) && Date.parse(received) >= createdMs) {
        return true;
      }
    }
    return false;
  }

  private findEvent(bookingId: string, dedupeKey: string): CoordinationEventRecord | null {
    const found = this.db
      .prepare("SELECT * FROM coord_events WHERE booking_id = $booking AND dedupe_key = $key LIMIT 1")
      .get({ $booking: bookingId, $key: dedupeKey });
    return found ? this.toEventRecord(asRow(found)) : null;
  }

  private assertSameContent(
    stored: CoordinationEventRecord,
    incoming: {
      kind: string;
      bookingId: string;
      sourceId: string;
      sourceKind: string;
      observedAt: string;
      revision?: number;
      payload: Record<string, unknown>;
    },
    ignoreObserved = false,
  ): void {
    const storedParts = {
      kind: stored.kind,
      bookingId: stored.bookingId,
      sourceId: stored.sourceId,
      sourceKind: stored.sourceKind,
      observedAt: ignoreObserved ? "" : stored.observedAt,
      revision: stored.revision,
      payload: stored.payload,
    };
    const incomingParts = ignoreObserved ? { ...incoming, observedAt: "" } : incoming;
    const storedFingerprint = eventContentFingerprint(storedParts);
    const incomingFingerprint = eventContentFingerprint(incomingParts);
    if (storedFingerprint !== incomingFingerprint) {
      throw new Error(
        `Coordination dedupe key reuse with different content: ${incoming.bookingId}/${stored.dedupeKey} (scoped to booking ${stored.bookingId})`,
      );
    }
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
        $observed: storedIso(input.observedAt),
        $received: this.now(),
        $revision: input.revision ?? null,
        $payload: JSON.stringify(input.payload ?? {}),
        $stale: stale ? 1 : 0,
      });
    return id;
  }

  private insertAttestedEvent(input: {
    dedupeKey: string;
    kind: string;
    bookingId: string;
    sourceId: string;
    sourceKind: string;
    observedAt: string;
    revision?: number;
    payload: Record<string, unknown>;
  }): string {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO coord_events
         (id, dedupe_key, kind, booking_id, source_id, source_kind, observed_at, received_at, revision, payload_json, stale)
         VALUES ($id, $dedupe, $kind, $booking, $sourceId, $sourceKind, $observed, $received, $revision, $payload, 0)`,
      )
      .run({
        $id: id,
        $dedupe: input.dedupeKey,
        $kind: input.kind,
        $booking: input.bookingId,
        $sourceId: input.sourceId,
        $sourceKind: input.sourceKind,
        $observed: input.observedAt,
        $received: this.now(),
        $revision: input.revision ?? null,
        $payload: JSON.stringify(input.payload),
      });
    return id;
  }

  private getControlState(bookingId: string): "paused" | "cancelled" | null {
    const found = this.db.prepare("SELECT state FROM coord_control WHERE booking_id = $booking").get({ $booking: bookingId });
    if (!found) return null;
    const state = String(asRow(found).state);
    return state === "paused" || state === "cancelled" ? state : null;
  }

  private setControlState(bookingId: string, state: "paused" | "cancelled", eventId: string, timestamp: string): void {
    this.db
      .prepare(
        `INSERT INTO coord_control (booking_id, state, updated_at, source_event_id)
         VALUES ($booking, $state, $at, $event)
         ON CONFLICT (booking_id) DO UPDATE SET state = $state, updated_at = $at, source_event_id = $event`,
      )
      .run({ $booking: bookingId, $state: state, $at: timestamp, $event: eventId });
  }

  private clearControlState(bookingId: string): void {
    this.db.prepare("DELETE FROM coord_control WHERE booking_id = $booking").run({ $booking: bookingId });
  }

  private waitingIdsIn(bookingId: string, statuses: WaitingStatus[]): string[] {
    const placeholders = statuses.map((_, index) => `$s${index}`).join(", ");
    const params: Record<string, string> = { $booking: bookingId };
    statuses.forEach((status, index) => {
      params[`$s${index}`] = status;
    });
    const rows = this.db
      .prepare(`SELECT id FROM coord_waiting WHERE booking_id = $booking AND status IN (${placeholders})`)
      .all(params);
    return rows.map((row) => String(asRow(row).id));
  }

  private invalidateWaiting(id: string, note: string, timestamp: string): void {
    this.db
      .prepare(`UPDATE coord_waiting SET status = 'invalidated', resolution_note = $note, updated_at = $at WHERE id = $id`)
      .run({ $note: note, $at: timestamp, $id: id });
  }

  /** Entry status for newly raised work: cancelled bookings invalidate, paused bookings hide. */
  private entryStatus(bookingId: string, shared: "cancelled" | "paused" | null): WaitingStatus {
    const control = this.getControlState(bookingId);
    if (control === "cancelled" || shared === "cancelled") return "invalidated";
    if (control === "paused") return "paused";
    return "pending";
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
    let controlHonored: boolean | undefined;
    const timestamp = this.now();
    const shared = this.sharedBlockReason(input.bookingId);

    switch (input.kind) {
      case "inquiry": {
        const item = this.insertWaiting(
          input.bookingId,
          "followup",
          this.entryStatus(input.bookingId, shared),
          followupDueAt(input),
          eventId,
          input.revision,
          {
            ...(this.entryStatus(input.bookingId, shared) === "invalidated"
              ? { reason: "booking_cancelled", note: "Booking is cancelled; followup invalidated at intake." }
              : { reason: "awaiting_customer_reply", sourceId: input.sourceId }),
          },
        );
        createdWaiting.push(item);
        if (item.status === "invalidated") invalidatedWaitingIds.push(item.id);
        break;
      }
      case "reply": {
        // Received-order suppression: a non-stale reply received now answers
        // pending followups regardless of source-clock skew in observedAt.
        for (const id of this.suppressFollowups(input.bookingId, timestamp)) {
          suppressedWaitingIds.push(id);
        }
        break;
      }
      case "change": {
        const prior = this.db
          .prepare(
            `SELECT id, revision FROM coord_waiting
             WHERE booking_id = $booking AND kind = 'change_review' AND (status = 'pending' OR status = 'claimed')`,
          )
          .all({ $booking: input.bookingId });
        for (const row of prior) {
          const r = asRow(row);
          const priorRevision = typeof r.revision === "number" ? r.revision : null;
          // Equal revisions supersede: two concurrent rev-2 changes must not
          // leave two pending reviews for the same owner decision.
          if (input.revision === undefined || priorRevision === null || input.revision >= priorRevision) {
            const id = String(r.id);
            this.invalidateWaiting(
              id,
              `Superseded by change revision ${input.revision ?? "unversioned"} (event ${input.dedupeKey})`,
              timestamp,
            );
            invalidatedWaitingIds.push(id);
          }
        }
        const item = this.insertWaiting(
          input.bookingId,
          "change_review",
          this.entryStatus(input.bookingId, shared),
          storedIso(input.observedAt),
          eventId,
          input.revision,
          { reason: "booking_change_requires_review", sourceId: input.sourceId },
        );
        createdWaiting.push(item);
        if (item.status === "invalidated") invalidatedWaitingIds.push(item.id);
        break;
      }
      case "payment_signal": {
        // Evidence only, always: message text claiming payment never verifies
        // a deposit and never retires reminders. Retirement requires
        // recordVerifiedReceipt with a trusted verifier attestation.
        const item = this.insertWaiting(
          input.bookingId,
          "deposit_check",
          this.entryStatus(input.bookingId, shared),
          storedIso(input.observedAt),
          eventId,
          input.revision,
          {
            reason: "payment_claim_requires_authoritative_receipt",
            verifiedPayment: false,
            sourceId: input.sourceId,
            note: "Verify against the payment provider receipt; message text is not proof of payment.",
          },
        );
        createdWaiting.push(item);
        if (item.status === "invalidated") invalidatedWaitingIds.push(item.id);
        break;
      }
      case "resource_signal": {
        const item = this.insertWaiting(
          input.bookingId,
          "resource_check",
          this.entryStatus(input.bookingId, shared),
          storedIso(input.observedAt),
          eventId,
          input.revision,
          { reason: "resource_state_requires_verification", sourceId: input.sourceId },
        );
        createdWaiting.push(item);
        if (item.status === "invalidated") invalidatedWaitingIds.push(item.id);
        break;
      }
      case "pause":
      case "resume":
      case "cancel": {
        // Intake NEVER honors control: sourceKind and payload.authorizedBy
        // are raw event fields and prove nothing about the owner. Record the
        // request and raise an owner decision instead. Honored control flows
        // only through applyOwnerControl with host attestation.
        controlHonored = false;
        createdWaiting.push(
          this.insertWaiting(
            input.bookingId,
            "change_review",
            this.entryStatus(input.bookingId, shared),
            storedIso(input.observedAt),
            eventId,
            input.revision,
            {
              reason: "untrusted_control_request_requires_owner_decision",
              requestedControl: input.kind,
              sourceId: input.sourceId,
              note: `A ${input.sourceKind} message requested ${input.kind}; owner authority is required before acting. Use applyOwnerControl with host attestation.`,
            },
          ),
        );
        break;
      }
    }

    return { controlHonored, createdWaiting, suppressedWaitingIds, invalidatedWaitingIds, pausedWaitingIds, resumedWaitingIds };
  }

  /**
   * Received-order suppression: every pending or claimed followup for the
   * booking is answered by an event received now. Claimed items move too, so
   * their fencing tokens die with the obsolete work instead of completing it.
   */
  private suppressFollowups(bookingId: string, timestamp: string): string[] {
    const ids: string[] = [];
    const pending = this.db
      .prepare(
        `SELECT id FROM coord_waiting
         WHERE booking_id = $booking AND kind = 'followup' AND (status = 'pending' OR status = 'claimed')`,
      )
      .all({ $booking: bookingId });
    for (const row of pending) {
      const id = String(asRow(row).id);
      this.db
        .prepare(`UPDATE coord_waiting SET status = 'suppressed', resolution_note = $note, updated_at = $at WHERE id = $id`)
        .run({
          $note: `Suppressed by received reply: customer answered before followup was acted on`,
          $at: timestamp,
          $id: id,
        });
      ids.push(id);
    }
    return ids;
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
    const timestamp = this.now();
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
    const kind = String(value.kind);
    if (kind !== "followup" && kind !== "deposit_check" && kind !== "resource_check" && kind !== "change_review") {
      throw new Error(`Corrupt waiting row ${String(value.id)}: unknown kind ${kind}`);
    }
    const status = String(value.status);
    if (
      status !== "pending" && status !== "claimed" && status !== "done" &&
      status !== "suppressed" && status !== "invalidated" && status !== "paused"
    ) {
      throw new Error(`Corrupt waiting row ${String(value.id)}: unknown status ${status}`);
    }
    const recommendation = recommendedFor(kind as WaitingKind);
    const detail = parseRecord(value.detail_json);
    return {
      id: String(value.id),
      bookingId: String(value.booking_id),
      kind: kind as WaitingKind,
      status: status as WaitingStatus,
      dueAt: String(value.due_at),
      detail,
      sourceEventId: String(value.source_event_id),
      revision: typeof value.revision === "number" ? value.revision : undefined,
      claimedBy: value.claimed_by ? String(value.claimed_by) : undefined,
      claimedAt: value.claimed_at ? String(value.claimed_at) : undefined,
      claimToken: value.claim_token ? String(value.claim_token) : undefined,
      claimExpiresAt: value.claim_expires_at ? String(value.claim_expires_at) : undefined,
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
   * paused business. Reads the shared Gather tables according to the
   * declared mode. Fail-closed: unexpected query failures are rethrown so a
   * broken integration surfaces instead of leaking guarded work; only an
   * explicitly absent foundation (standalone contract) yields no exclusion.
   */
  private isBlockedBySharedState(bookingId: string): boolean {
    return this.sharedBlockReason(bookingId) !== null;
  }

  private sharedBlockReason(bookingId: string): "cancelled" | "paused" | null {
    if (this.sharedTables === "off") return null;
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
    } catch (error) {
      if (this.sharedTables === "required") throw error;
      if (error instanceof Error && /no such table/i.test(error.message)) return null;
      throw error;
    }
  }
}
