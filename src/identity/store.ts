import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { GatherStore } from "../server/sqlite-store.ts";

/**
 * Durable identity tables owned by the booking-identity module (PRD G04).
 *
 * These tables live inside the injected GatherStore SQLite database — no new
 * database file, no generic graph/wiki machinery. Every function here takes
 * the host GatherStore and ensures its own tables idempotently, so links
 * survive process restarts without an explicit init step.
 *
 * Tables:
 * - booking_identity_links: one row per source key at most (PRIMARY KEY on
 *   source_key); history is never deleted — unlink/correction flips status
 *   and appends audit rows.
 * - booking_identity_decisions: owner-decision requests. At most one OPEN
 *   row per source key, enforced by a partial UNIQUE index; superseded rows
 *   are kept for audit.
 * - booking_identity_audit: append-only transition log.
 *
 * All multi-write operations run inside BEGIN IMMEDIATE so link/decision
 * state is re-read under the write lock and audit can never be orphaned.
 */

export type IdentityLinkOrigin = "verified_receipt" | "owner_resolution";

export type IdentityLinkStatus = "active" | "unlinked";

/**
 * Where the binding proof comes from:
 * - "demo": simulated fixture receipt (never presented as a real provider).
 * - "live": host-verified provider-correlated receipt.
 * - "owner": explicit owner assertion inside this workspace — authoritative
 *   for identity but NOT provider-verified and not necessarily fictional.
 */
export type ProvenanceMode = "demo" | "live" | "owner";

export interface IdentityLinkRow {
  sourceKey: string;
  bookingId: string;
  businessId: string;
  accountId: string;
  provider: string;
  origin: IdentityLinkOrigin;
  provenanceMode: ProvenanceMode;
  receiptOperationKey: string | undefined;
  status: IdentityLinkStatus;
  /** Monotonic per-row revision: every binding change increments it, so a stale reviewed state can never apply. */
  linkRevision: number;
  createdAt: string;
  updatedAt: string;
}

export interface IdentityDecisionRow {
  id: string;
  sourceKey: string;
  candidateVersion: number;
  candidateFingerprint: string;
  candidateIdsJson: string;
  status: "open" | "resolved" | "superseded";
  resolvedBookingId: string | undefined;
  decidedBy: string | undefined;
  createdAt: string;
  resolvedAt: string | undefined;
}

export interface IdentityAuditRow {
  id: number;
  sourceKey: string;
  action: string;
  bookingId: string | undefined;
  actor: string;
  reason: string;
  /** Link revision the entry transitioned to, when it touched a link row. */
  linkRevision: number | undefined;
  createdAt: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

const LINK_DDL = `
  CREATE TABLE IF NOT EXISTS booking_identity_links (
    source_key TEXT PRIMARY KEY,
    booking_id TEXT NOT NULL,
    business_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('verified_receipt', 'owner_resolution')),
    provenance_mode TEXT NOT NULL CHECK (provenance_mode IN ('demo', 'live', 'owner')),
    receipt_operation_key TEXT,
    status TEXT NOT NULL CHECK (status IN ('active', 'unlinked')),
    link_revision INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;

/** Columns a pre-link_revision table must have, in order, to be a known legacy shape. */
const LEGACY_LINK_COLUMNS = [
  "source_key",
  "booking_id",
  "business_id",
  "account_id",
  "provider",
  "origin",
  "provenance_mode",
  "receipt_operation_key",
  "status",
  "created_at",
  "updated_at",
] as const;

function tableColumns(db: DatabaseSync, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.map((row) => String(row.name));
}

/**
 * Failure-atomic schema upgrade for booking_identity_links.
 *
 * Two states need work:
 * - pre-'owner' provenance CHECK constraint: a full table rebuild
 *   (rename -> create -> copy -> drop -> recreate indexes) inside ONE
 *   BEGIN IMMEDIATE transaction with PRAGMA foreign_keys held OFF and a
 *   foreign_key_check before commit — a mid-migration failure rolls the
 *   rename back too, so the table is never left as *_legacy.
 * - post-'owner' shape missing link_revision: a plain additive
 *   ALTER TABLE ADD COLUMN DEFAULT 1.
 *
 * The legacy shape is validated column-for-column before anything is
 * renamed; an unrecognized shape refuses rather than guessing. Running
 * inside an existing transaction is refused explicitly: entry points call
 * ensureBookingIdentityTables before BEGIN, so the upgrade always happens
 * on an autocommit boundary where the FK pragma can be toggled.
 */
export function migrateIdentityLinksTable(db: DatabaseSync, opts: { createSql?: string } = {}): void {
  const found = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'booking_identity_links'",
  ).get();
  if (!found) return;
  const ddl = String((found as SqlRow).sql ?? "");
  const columns = tableColumns(db, "booking_identity_links");
  const hasRevision = columns.includes("link_revision");
  const hasOwnerMode = ddl.includes("'owner'");
  if (hasOwnerMode && hasRevision) return;
  if (hasOwnerMode && !hasRevision) {
    db.exec("ALTER TABLE booking_identity_links ADD COLUMN link_revision INTEGER NOT NULL DEFAULT 1");
    return;
  }
  // Full rebuild path: the legacy shape must match exactly before touching it.
  const legacyColumns = hasRevision ? columns.slice(0, columns.indexOf("link_revision")) : columns;
  if (
    legacyColumns.length !== LEGACY_LINK_COLUMNS.length ||
    !LEGACY_LINK_COLUMNS.every((name, index) => legacyColumns[index] === name)
  ) {
    throw new Error(
      `Refusing to migrate booking_identity_links: unexpected column shape [${columns.join(", ")}]; expected the known legacy shape`,
    );
  }
  if (db.isTransaction) {
    throw new Error(
      "Refusing to migrate booking_identity_links inside an open transaction; the upgrade needs an autocommit boundary",
    );
  }
  // Preserve any secondary indexes: their definitions are captured before the
  // rename (SQLite repoints them at the legacy name) and replayed on the new
  // table once the legacy table — and its indexes — is dropped.
  const indexRows = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'booking_identity_links' AND sql IS NOT NULL",
  ).all() as SqlRow[];
  const indexSql = indexRows.map((value) => String(value.sql));
  const foreignKeysWereOn = Number(
    (db.prepare("PRAGMA foreign_keys").get() as SqlRow | undefined)?.foreign_keys ?? 0,
  ) === 1;
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("ALTER TABLE booking_identity_links RENAME TO booking_identity_links_legacy");
    db.exec(opts.createSql ?? LINK_DDL.replace("IF NOT EXISTS ", "") + ";");
    db.exec(
      `INSERT INTO booking_identity_links (${LEGACY_LINK_COLUMNS.join(", ")}, link_revision)
       SELECT ${LEGACY_LINK_COLUMNS.join(", ")}, 1 FROM booking_identity_links_legacy`,
    );
    db.exec("DROP TABLE booking_identity_links_legacy");
    for (const sql of indexSql) db.exec(sql + ";");
    const violations = db.prepare("PRAGMA foreign_key_check").all() as SqlRow[];
    if (violations.length > 0) {
      throw new Error(`Foreign key check failed after identity links migration (${violations.length} violation(s))`);
    }
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Already rolled back; surface the original failure.
    }
    throw error;
  } finally {
    db.exec(`PRAGMA foreign_keys = ${foreignKeysWereOn ? "ON" : "OFF"}`);
  }
}

/** Create identity tables when missing. Idempotent; safe to call per operation. */
export function ensureBookingIdentityTables(store: GatherStore): void {
  const db: DatabaseSync = store.db;
  db.exec(LINK_DDL + ";");
  migrateIdentityLinksTable(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS booking_identity_decisions (
      id TEXT PRIMARY KEY,
      source_key TEXT NOT NULL,
      candidate_version INTEGER NOT NULL,
      candidate_fingerprint TEXT NOT NULL,
      candidate_ids_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('open', 'resolved', 'superseded')),
      resolved_booking_id TEXT,
      decided_by TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_identity_decisions_key
      ON booking_identity_decisions(source_key, candidate_version);
    CREATE TABLE IF NOT EXISTS booking_identity_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_key TEXT NOT NULL,
      action TEXT NOT NULL,
      booking_id TEXT,
      actor TEXT NOT NULL,
      reason TEXT NOT NULL,
      link_revision INTEGER,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_identity_audit_key ON booking_identity_audit(source_key, id);
  `);
  // Audit rows predating link revisions gain the column additively.
  if (!tableColumns(db, "booking_identity_audit").includes("link_revision")) {
    db.exec("ALTER TABLE booking_identity_audit ADD COLUMN link_revision INTEGER");
  }
  // Databases created before the one-open-decision constraint may hold
  // multiple open rows; keep the newest per source key before indexing.
  db.prepare(
    `UPDATE booking_identity_decisions SET status = 'superseded'
       WHERE status = 'open' AND rowid NOT IN (
         SELECT MAX(rowid) FROM booking_identity_decisions WHERE status = 'open' GROUP BY source_key
       )`,
  ).run();
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_identity_decisions_open
      ON booking_identity_decisions(source_key) WHERE status = 'open';
  `);
}

/** Deterministic fingerprint over the ordered candidate set for one source key. */
export function fingerprintCandidates(sourceKey: string, candidateIds: string[]): string {
  const ordered = [...candidateIds].sort();
  return createHash("sha256").update(JSON.stringify({ sourceKey, candidates: ordered })).digest("hex");
}

type SqlRow = Record<string, unknown>;

function asRow(value: unknown): SqlRow {
  if (!value || typeof value !== "object") throw new Error("Expected a SQLite row");
  return value as SqlRow;
}

function toLinkRow(value: SqlRow): IdentityLinkRow {
  return {
    sourceKey: String(value.source_key),
    bookingId: String(value.booking_id),
    businessId: String(value.business_id),
    accountId: String(value.account_id),
    provider: String(value.provider),
    origin: value.origin as IdentityLinkOrigin,
    provenanceMode: value.provenance_mode as ProvenanceMode,
    receiptOperationKey: value.receipt_operation_key ? String(value.receipt_operation_key) : undefined,
    status: value.status as IdentityLinkStatus,
    linkRevision: Number(value.link_revision ?? 1),
    createdAt: String(value.created_at),
    updatedAt: String(value.updated_at),
  };
}

function toDecisionRow(value: SqlRow): IdentityDecisionRow {
  return {
    id: String(value.id),
    sourceKey: String(value.source_key),
    candidateVersion: Number(value.candidate_version),
    candidateFingerprint: String(value.candidate_fingerprint),
    candidateIdsJson: String(value.candidate_ids_json),
    status: value.status as IdentityDecisionRow["status"],
    resolvedBookingId: value.resolved_booking_id ? String(value.resolved_booking_id) : undefined,
    decidedBy: value.decided_by ? String(value.decided_by) : undefined,
    createdAt: String(value.created_at),
    resolvedAt: value.resolved_at ? String(value.resolved_at) : undefined,
  };
}

export function getIdentityLink(store: GatherStore, sourceKey: string): IdentityLinkRow | undefined {
  ensureBookingIdentityTables(store);
  const found = store.db.prepare("SELECT * FROM booking_identity_links WHERE source_key = $key").get({ $key: sourceKey });
  return found ? toLinkRow(asRow(found)) : undefined;
}

export function getActiveIdentityLink(store: GatherStore, sourceKey: string): IdentityLinkRow | undefined {
  const link = getIdentityLink(store, sourceKey);
  return link && link.status === "active" ? link : undefined;
}

export function listIdentityAudit(store: GatherStore, sourceKey: string): IdentityAuditRow[] {
  ensureBookingIdentityTables(store);
  const rows = store.db.prepare("SELECT * FROM booking_identity_audit WHERE source_key = $key ORDER BY id").all({ $key: sourceKey });
  return rows.map((item) => {
    const value = asRow(item);
    return {
      id: Number(value.id),
      sourceKey: String(value.source_key),
      action: String(value.action),
      bookingId: value.booking_id ? String(value.booking_id) : undefined,
      actor: String(value.actor),
      reason: String(value.reason),
      linkRevision: value.link_revision == null ? undefined : Number(value.link_revision),
      createdAt: String(value.created_at),
    };
  });
}

export function appendIdentityAudit(
  store: GatherStore,
  entry: { sourceKey: string; action: string; bookingId?: string; actor: string; reason: string; linkRevision?: number },
): void {
  ensureBookingIdentityTables(store);
  store.db.prepare(
    `INSERT INTO booking_identity_audit (source_key, action, booking_id, actor, reason, link_revision, created_at)
     VALUES ($key, $action, $booking, $actor, $reason, $rev, $at)`,
  ).run({
    $key: entry.sourceKey,
    $action: entry.action,
    $booking: entry.bookingId ?? null,
    $actor: entry.actor,
    $reason: entry.reason,
    $rev: entry.linkRevision ?? null,
    $at: nowIso(),
  });
}

export function getOpenIdentityDecision(store: GatherStore, sourceKey: string): IdentityDecisionRow | undefined {
  ensureBookingIdentityTables(store);
  const found = store.db.prepare(
    "SELECT * FROM booking_identity_decisions WHERE source_key = $key AND status = 'open' ORDER BY candidate_version DESC LIMIT 1",
  ).get({ $key: sourceKey });
  return found ? toDecisionRow(asRow(found)) : undefined;
}

export function listIdentityDecisions(store: GatherStore, sourceKey: string): IdentityDecisionRow[] {
  ensureBookingIdentityTables(store);
  const rows = store.db.prepare(
    "SELECT * FROM booking_identity_decisions WHERE source_key = $key ORDER BY candidate_version",
  ).all({ $key: sourceKey });
  return rows.map((item) => toDecisionRow(asRow(item)));
}

/**
 * Open (or reuse) the decision for this exact candidate set. Runs inside
 * BEGIN IMMEDIATE: the open row is re-read under the write lock, a new
 * version is cut only when the fingerprint changes, and the
 * decision_opened audit row commits with the insert — a failed audit can
 * never leave a decision behind. The partial UNIQUE index on open rows
 * makes concurrent opens for the same source key impossible to interleave
 * into two open decisions.
 */
export function openOrReuseIdentityDecision(
  store: GatherStore,
  sourceKey: string,
  candidateIds: string[],
): IdentityDecisionRow {
  ensureBookingIdentityTables(store);
  const fingerprint = fingerprintCandidates(sourceKey, candidateIds);
  store.db.exec("BEGIN IMMEDIATE");
  try {
    const open = getOpenIdentityDecision(store, sourceKey);
    if (open && open.candidateFingerprint === fingerprint) {
      store.db.exec("COMMIT");
      return open;
    }
    const timestamp = nowIso();
    const nextVersion = open ? open.candidateVersion + 1 : nextDecisionVersion(store, sourceKey);
    if (open) {
      const info = store.db.prepare(
        "UPDATE booking_identity_decisions SET status = 'superseded' WHERE id = $id AND status = 'open'",
      ).run({ $id: open.id });
      if (Number(info.changes) !== 1) {
        throw new Error(`Identity decision ${open.id} changed while being superseded`);
      }
    }
    const id = randomUUID();
    store.db.prepare(
      `INSERT INTO booking_identity_decisions
        (id, source_key, candidate_version, candidate_fingerprint, candidate_ids_json, status, created_at)
       VALUES ($id, $key, $version, $fingerprint, $ids, 'open', $at)`,
    ).run({
      $id: id,
      $key: sourceKey,
      $version: nextVersion,
      $fingerprint: fingerprint,
      $ids: JSON.stringify([...candidateIds].sort()),
      $at: timestamp,
    });
    appendIdentityAudit(store, {
      sourceKey,
      action: "decision_opened",
      actor: "system",
      reason: `Candidate set v${nextVersion} (${candidateIds.length} candidate(s), fingerprint ${fingerprint.slice(0, 12)}...) requires owner resolution`,
    });
    store.db.exec("COMMIT");
    return getIdentityDecisionById(store, id);
  } catch (error) {
    try {
      store.db.exec("ROLLBACK");
    } catch {
      // Already rolled back; surface the original failure.
    }
    throw error;
  }
}

function nextDecisionVersion(store: GatherStore, sourceKey: string): number {
  const found = store.db.prepare(
    "SELECT MAX(candidate_version) AS peak FROM booking_identity_decisions WHERE source_key = $key",
  ).get({ $key: sourceKey });
  const peak = found ? asRow(found).peak : undefined;
  return peak === null || peak === undefined ? 1 : Number(peak) + 1;
}

export function getIdentityDecisionById(store: GatherStore, id: string): IdentityDecisionRow {
  ensureBookingIdentityTables(store);
  const found = store.db.prepare("SELECT * FROM booking_identity_decisions WHERE id = $id").get({ $id: id });
  if (!found) throw new Error(`Identity decision not found: ${id}`);
  return toDecisionRow(asRow(found));
}

/**
 * Resolve a decision only if it is still open (conditional UPDATE under the
 * caller's transaction). Returns false when another writer already resolved
 * or superseded it — the caller maps that to a stale-decision error.
 */
export function resolveDecisionIfOpen(
  store: GatherStore,
  decisionId: string,
  resolvedBookingId: string,
  decidedBy: string,
): boolean {
  const info = store.db.prepare(
    `UPDATE booking_identity_decisions
     SET status = 'resolved', resolved_booking_id = $booking, decided_by = $by, resolved_at = $at
     WHERE id = $id AND status = 'open'`,
  ).run({ $booking: resolvedBookingId, $by: decidedBy, $at: nowIso(), $id: decisionId });
  return Number(info.changes) === 1;
}

export function markDecisionResolved(
  store: GatherStore,
  decisionId: string,
  resolvedBookingId: string,
  decidedBy: string,
): IdentityDecisionRow {
  if (!resolveDecisionIfOpen(store, decisionId, resolvedBookingId, decidedBy)) {
    throw new Error(`Identity decision ${decisionId} is no longer open`);
  }
  return getIdentityDecisionById(store, decisionId);
}
