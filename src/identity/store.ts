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
 * - booking_identity_links: one ACTIVE row per source key at most (UNIQUE on
 *   source_key with a partial index over active rows is emulated by keeping a
 *   single row per source key with a status column). History is never deleted:
 *   unlink/correction flips status and appends audit rows.
 * - booking_identity_decisions: owner-decision requests. One OPEN row per
 *   source key; superseded rows are kept for audit.
 * - booking_identity_audit: append-only transition log.
 */

export type IdentityLinkOrigin = "verified_receipt" | "owner_resolution";
export type IdentityLinkStatus = "active" | "unlinked";
export type ProvenanceMode = "demo" | "live";

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
  createdAt: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Create identity tables when missing. Idempotent; safe to call per operation. */
export function ensureBookingIdentityTables(store: GatherStore): void {
  const db: DatabaseSync = store.db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS booking_identity_links (
      source_key TEXT PRIMARY KEY,
      booking_id TEXT NOT NULL,
      business_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      origin TEXT NOT NULL CHECK (origin IN ('verified_receipt', 'owner_resolution')),
      provenance_mode TEXT NOT NULL CHECK (provenance_mode IN ('demo', 'live')),
      receipt_operation_key TEXT,
      status TEXT NOT NULL CHECK (status IN ('active', 'unlinked')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
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
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_identity_audit_key ON booking_identity_audit(source_key, id);
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
      createdAt: String(value.created_at),
    };
  });
}

export function appendIdentityAudit(
  store: GatherStore,
  entry: { sourceKey: string; action: string; bookingId?: string; actor: string; reason: string },
): void {
  ensureBookingIdentityTables(store);
  store.db.prepare(
    `INSERT INTO booking_identity_audit (source_key, action, booking_id, actor, reason, created_at)
     VALUES ($key, $action, $booking, $actor, $reason, $at)`,
  ).run({
    $key: entry.sourceKey,
    $action: entry.action,
    $booking: entry.bookingId ?? null,
    $actor: entry.actor,
    $reason: entry.reason,
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
 * Open (or reuse) the decision for this exact candidate set. A new version is
 * cut only when the fingerprint changes; re-proposing the same set is
 * idempotent and returns the existing open row.
 */
export function openOrReuseIdentityDecision(
  store: GatherStore,
  sourceKey: string,
  candidateIds: string[],
): IdentityDecisionRow {
  ensureBookingIdentityTables(store);
  const fingerprint = fingerprintCandidates(sourceKey, candidateIds);
  const open = getOpenIdentityDecision(store, sourceKey);
  if (open && open.candidateFingerprint === fingerprint) return open;
  const timestamp = nowIso();
  const nextVersion = open ? open.candidateVersion + 1 : nextDecisionVersion(store, sourceKey);
  if (open) {
    store.db.prepare("UPDATE booking_identity_decisions SET status = 'superseded' WHERE id = $id").run({ $id: open.id });
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
  return getIdentityDecisionById(store, id);
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

export function markDecisionResolved(
  store: GatherStore,
  decisionId: string,
  resolvedBookingId: string,
  decidedBy: string,
): IdentityDecisionRow {
  const timestamp = nowIso();
  store.db.prepare(
    `UPDATE booking_identity_decisions
     SET status = 'resolved', resolved_booking_id = $booking, decided_by = $by, resolved_at = $at
     WHERE id = $id`,
  ).run({ $booking: resolvedBookingId, $by: decidedBy, $at: timestamp, $id: decisionId });
  return getIdentityDecisionById(store, decisionId);
}
