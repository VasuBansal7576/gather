import type { DatabaseSync } from "node:sqlite";

/**
 * Extraction-owned lineage ledger on the SAME SQLite handle as everything
 * else (never a second database). It records, per caller idempotency key,
 * the full attributable lineage of an extraction run — business, account,
 * source locator/revision/digest, backend/task identity, simulated origin,
 * and the original evidence quotes per candidate — so a candidate row can
 * always be traced back to the run that produced it, including across
 * restarts. First writes win; replays amend nothing but the run status.
 */

export interface ExtractionLedger {
  readonly db: DatabaseSync;
}

export interface ExtractionRunRecord {
  idempotencyKey: string;
  businessId: string;
  accountId: string;
  locator: string;
  sourceRevision: string | null;
  contentDigest: string;
  backendId: string;
  taskId: string | null;
  simulated: boolean;
  status: string;
  reason: string | null;
}

export interface ExtractionRunCandidate {
  candidateIndex: number;
  candidateId: string;
  intakeId: string;
  factKey: string;
  subjectId: string;
  confidence: string;
  evidenceJson: string;
}

/**
 * Thrown when a caller key is reused across scopes. A caller idempotency
 * key names exactly one source identity (business, account, locator,
 * content digest): reusing it elsewhere fails closed instead of skewing
 * the run row toward whichever scope wrote first.
 */
export class ExtractionScopeConflictError extends Error {
  readonly code = "extraction_scope_conflict" as const;
  constructor(message: string) {
    super(message);
    this.name = "ExtractionScopeConflictError";
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Create tables if absent and return the ledger port. Idempotent and safe to call per use. */
export function createExtractionLedger(db: DatabaseSync): ExtractionLedger {
  db.exec(`
    CREATE TABLE IF NOT EXISTS extraction_runs (
      idempotency_key TEXT PRIMARY KEY,
      business_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      locator TEXT NOT NULL,
      source_revision TEXT,
      content_digest TEXT NOT NULL,
      backend_id TEXT NOT NULL,
      task_id TEXT,
      simulated INTEGER NOT NULL,
      status TEXT NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS extraction_run_candidates (
      idempotency_key TEXT NOT NULL,
      candidate_index INTEGER NOT NULL,
      candidate_id TEXT NOT NULL,
      intake_id TEXT NOT NULL,
      fact_key TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      confidence TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (idempotency_key, candidate_index)
    );
  `);
  return { db };
}

export function recordExtractionRun(
  ledger: ExtractionLedger,
  run: Omit<ExtractionRunRecord, "reason" | "taskId"> & { reason?: string | null; taskId?: string | null },
): void {
  const existing = getExtractionRun(ledger, run.idempotencyKey);
  if (existing !== undefined) {
    const sameScope =
      existing.businessId === run.businessId &&
      existing.accountId === run.accountId &&
      existing.locator === run.locator &&
      existing.contentDigest === run.contentDigest;
    if (!sameScope) {
      throw new ExtractionScopeConflictError(
        `idempotency key ${run.idempotencyKey} already names ${existing.businessId}/${existing.accountId}/${existing.locator}; refusing cross-scope reuse`,
      );
    }
  }
  const timestamp = nowIso();
  ledger.db.prepare(
    `INSERT INTO extraction_runs
      (idempotency_key, business_id, account_id, locator, source_revision, content_digest,
       backend_id, task_id, simulated, status, reason, created_at, updated_at)
     VALUES ($key, $business, $account, $locator, $revision, $digest,
       $backend, $task, $simulated, $status, $reason, $timestamp, $timestamp)
     ON CONFLICT(idempotency_key) DO UPDATE SET
       status = excluded.status, reason = excluded.reason, task_id = excluded.task_id,
       updated_at = excluded.updated_at`,
  ).run({
    $key: run.idempotencyKey,
    $business: run.businessId,
    $account: run.accountId,
    $locator: run.locator,
    $revision: run.sourceRevision,
    $digest: run.contentDigest,
    $backend: run.backendId,
    $task: run.taskId ?? null,
    $simulated: run.simulated ? 1 : 0,
    $status: run.status,
    $reason: run.reason ?? null,
    $timestamp: timestamp,
  });
}

export function recordExtractionCandidate(
  ledger: ExtractionLedger,
  idempotencyKey: string,
  candidate: ExtractionRunCandidate,
): void {
  const prior = ledger.db.prepare(
    "SELECT candidate_id, intake_id, fact_key, subject_id, confidence, evidence_json FROM extraction_run_candidates WHERE idempotency_key = $key AND candidate_index = $index",
  ).get({ $key: idempotencyKey, $index: candidate.candidateIndex }) as Record<string, unknown> | undefined;
  if (prior !== undefined) {
    const same =
      String(prior.candidate_id) === candidate.candidateId &&
      String(prior.intake_id) === candidate.intakeId &&
      String(prior.fact_key) === candidate.factKey &&
      String(prior.subject_id) === candidate.subjectId &&
      String(prior.confidence) === candidate.confidence &&
      String(prior.evidence_json) === candidate.evidenceJson;
    if (!same) {
      throw new ExtractionScopeConflictError(
        `candidate slot ${candidate.candidateIndex} for ${idempotencyKey} already records different content; refusing to overwrite lineage`,
      );
    }
    return;
  }
  ledger.db.prepare(
    `INSERT INTO extraction_run_candidates
      (idempotency_key, candidate_index, candidate_id, intake_id, fact_key,
       subject_id, confidence, evidence_json, created_at)
     VALUES ($key, $index, $candidateId, $intakeId, $factKey,
       $subject, $confidence, $evidence, $timestamp)
     ON CONFLICT(idempotency_key, candidate_index) DO NOTHING`,
  ).run({
    $key: idempotencyKey,
    $index: candidate.candidateIndex,
    $candidateId: candidate.candidateId,
    $intakeId: candidate.intakeId,
    $factKey: candidate.factKey,
    $subject: candidate.subjectId,
    $confidence: candidate.confidence,
    $evidence: candidate.evidenceJson,
    $timestamp: nowIso(),
  });
}

export function getExtractionRun(ledger: ExtractionLedger, idempotencyKey: string): ExtractionRunRecord | undefined {
  const found = ledger.db.prepare("SELECT * FROM extraction_runs WHERE idempotency_key = $key").get({ $key: idempotencyKey }) as
    | Record<string, unknown>
    | undefined;
  if (!found) return undefined;
  return {
    idempotencyKey: String(found.idempotency_key),
    businessId: String(found.business_id),
    accountId: String(found.account_id),
    locator: String(found.locator),
    sourceRevision: found.source_revision == null ? null : String(found.source_revision),
    contentDigest: String(found.content_digest),
    backendId: String(found.backend_id),
    taskId: found.task_id == null ? null : String(found.task_id),
    simulated: Number(found.simulated) === 1,
    status: String(found.status),
    reason: found.reason == null ? null : String(found.reason),
  };
}

export function listExtractionRunCandidates(ledger: ExtractionLedger, idempotencyKey: string): ExtractionRunCandidate[] {
  const rows = ledger.db.prepare(
    "SELECT * FROM extraction_run_candidates WHERE idempotency_key = $key ORDER BY candidate_index",
  ).all({ $key: idempotencyKey }) as Record<string, unknown>[];
  return rows.map((row) => ({
    candidateIndex: Number(row.candidate_index),
    candidateId: String(row.candidate_id),
    intakeId: String(row.intake_id),
    factKey: String(row.fact_key),
    subjectId: String(row.subject_id),
    confidence: String(row.confidence),
    evidenceJson: String(row.evidence_json),
  }));
}
