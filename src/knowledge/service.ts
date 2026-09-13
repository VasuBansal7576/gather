import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { BusinessFact, SourceReference } from "../domain/contracts.ts";
import type {
  AgreementGroup,
  BusinessConflict,
  CandidateConfidence,
  ConflictRevision,
  ConfirmedFact,
  DecisionKind,
  FactScope,
  KnowledgeActor,
  KnowledgeCandidate,
  KnowledgeDecision,
  KnowledgeRevision,
  KnowledgeStorePort,
  OffersKnowledgeSnapshot,
  WithheldFact,
} from "./types.ts";

/**
 * Source-linked business understanding boundary.
 *
 * Pipeline: attributable extraction -> probable/uncertain candidates ->
 * explicit owner confirmation -> versioned confirmed facts -> offers
 * snapshot. Authority lives only in the owner actor kind; retrieved content
 * and any other actor class can never approve. Every mutating call is
 * idempotent (candidate status and the knowledge_decisions command log) and
 * runs inside one transaction, so a confirmed fact and its audit trail can
 * never drift apart.
 */

export class KnowledgeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "KnowledgeError";
    this.code = code;
  }
}

export class KnowledgeDeniedError extends KnowledgeError {
  constructor(message: string) {
    super("denied", message);
    this.name = "KnowledgeDeniedError";
  }
}

/** Fresh availability belongs to the evidence path, never to static confirmed knowledge. */
const RESERVED_KEY = /^(availability|calendar|freebusy|slots?|windows?|schedule)/i;
const DECISION_ACTORS: ReadonlySet<string> = new Set(["owner"]);

/**
 * Bounded booking-business fact vocabulary shared with the offers adapter
 * (business/space/policy/scoped_exception/price_line/cost/service/
 * pricing_bounds). Anything else — including generic wiki-style keys — is
 * rejected at intake so unmapped content can never mint verified authority.
 */
const KNOWN_FACT_KEYS: ReadonlySet<string> = new Set([
  "business",
  "space",
  "policy",
  "scoped_exception",
  "price_line",
  "cost",
  "service",
  "pricing_bounds",
]);

type SqlRow = Record<string, unknown>;

function row<T extends SqlRow>(value: unknown): T {
  if (!value || typeof value !== "object") throw new Error("Expected a SQLite row");
  return value as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function now(): string {
  return new Date().toISOString();
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  return JSON.parse(value) as T;
}

/** Bounded attempts for acquiring the write lock under true concurrency. */
const MAX_TXN_ATTEMPTS = 25;

function isBusyError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const err = error as { errcode?: unknown; code?: unknown; message?: unknown };
  if (err.errcode === 5) return true;
  const code = typeof err.code === "string" ? err.code : "";
  const message = typeof err.message === "string" ? err.message : "";
  return code === "ERR_SQLITE_ERROR" && /database is locked|database table is locked/i.test(message);
}

function backoffSleep(attempt: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(5 + attempt * 5, 50));
}

/**
 * Rebuild the typed rejection a recorded decision row describes. Rejected
 * replays throw this instead of casting the audit detail into a successful
 * result with absent fact/revision rows. Rows written by older versions
 * without explicit code/message fall back to their reason.
 */
function rejectedReplayError(kind: DecisionKind, detail: Record<string, unknown>): KnowledgeError {
  const code = typeof detail.code === "string" ? detail.code : typeof detail.reason === "string" ? detail.reason : "rejected";
  const message = typeof detail.message === "string"
    ? detail.message
    : `rejected ${kind} command replayed (recorded reason: ${typeof detail.reason === "string" ? detail.reason : "unknown"})`;
  if (code === "denied") return new KnowledgeDeniedError(message);
  return new KnowledgeError(code, message);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export interface IntakeCandidateInput {
  businessId: string;
  key: string;
  /**
   * Stable account identity the observation belongs to, fixed by the host
   * caller (never model-asserted). Canonical dedupe, supersede detection,
   * and revision lineage are all scoped by it, so two accounts observing
   * identical content mint separate rows instead of aliasing.
   */
  accountId?: string;
  /** Optional identity of the thing the fact describes (spaceId, lineId, ...). */
  subjectId?: string;
  value: Record<string, unknown>;
  confidence: CandidateConfidence;
  sourceReferences: SourceReference[];
  sourceRevision?: string;
  observedAt?: string;
  note?: string;
  /** Re-ingest dedupe: repeat calls with the same key return the same candidate. */
  intakeId?: string;
  /**
   * Hook executed inside the intake transaction after the candidate row
   * and supersede updates, before commit. Lets a caller persist
   * same-connection lineage atomically with intake: if the hook throws,
   * the whole transaction rolls back and no candidate row survives.
   */
  atomically?: (db: DatabaseSync) => void;
}

export interface CandidateView extends KnowledgeCandidate {
  /** Other pending candidate ids for the same key+subjectId carrying a different value. */
  conflictsWith: string[];
}

export interface DecisionCommand {
  businessId: string;
  actor: KnowledgeActor;
  /** Caller-supplied idempotency key; repeats return the recorded outcome. */
  commandId?: string;
}

export interface ConfirmResult {
  fact: BusinessFact;
  revision: KnowledgeRevision;
  /** True when this confirm was already applied (double-confirm is a no-op). */
  alreadyConfirmed: boolean;
  /** True when the same commandId was replayed. */
  duplicate: boolean;
}

export interface ResolveConflictResult {
  /** Owner-pinned winning revision id (exact revision, never a value match). */
  winningRevisionId: string;
  /** Exact active revision id set this resolution governs. */
  consideredRevisionIds: string[];
  /** Resolution row id (the commandId). */
  resolutionId: string;
  /** True when the same commandId was replayed. */
  duplicate: boolean;
}

export class KnowledgeService {
  private readonly store: KnowledgeStorePort;

  constructor(store: KnowledgeStorePort) {
    this.store = store;
    // Idempotent schema setup tolerates concurrent first-start DDL the same
    // way mutations do: busy retries, genuine errors propagate.
    this.transact(() => {
      this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_candidates (
        id TEXT PRIMARY KEY,
        business_id TEXT NOT NULL,
        account_id TEXT NOT NULL DEFAULT '',
        key TEXT NOT NULL,
        subject_id TEXT NOT NULL DEFAULT '',
        value_json TEXT NOT NULL,
        confidence TEXT NOT NULL CHECK (confidence IN ('probable', 'uncertain')),
        source_references_json TEXT NOT NULL,
        source_locator TEXT NOT NULL,
        source_revision TEXT,
        observed_at TEXT NOT NULL,
        ingested_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'rejected', 'stale')),
        confirmed_fact_id TEXT,
        note TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_candidates_key
        ON knowledge_candidates(business_id, key, subject_id, status);
      CREATE TABLE IF NOT EXISTS knowledge_revisions (
        id TEXT PRIMARY KEY,
        fact_id TEXT NOT NULL,
        business_id TEXT NOT NULL,
        account_id TEXT NOT NULL DEFAULT '',
        key TEXT NOT NULL,
        subject_id TEXT NOT NULL DEFAULT '',
        revision INTEGER NOT NULL,
        value_json TEXT NOT NULL,
        scope TEXT NOT NULL CHECK (scope IN ('global', 'booking', 'customer')),
        scope_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('active', 'superseded')),
        review_state TEXT NOT NULL DEFAULT 'none' CHECK (review_state IN ('none', 'review')),
        approved_by TEXT NOT NULL,
        approved_at TEXT NOT NULL,
        candidate_id TEXT,
        source_references_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS knowledge_decisions (
        command_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        business_id TEXT NOT NULL,
        actor_kind TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('applied', 'duplicate', 'rejected')),
        detail_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_decisions_business
        ON knowledge_decisions(business_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_knowledge_candidates_account
        ON knowledge_candidates(business_id, account_id, key, subject_id, status);
      CREATE TABLE IF NOT EXISTS knowledge_conflict_resolutions (
        id TEXT PRIMARY KEY,
        business_id TEXT NOT NULL,
        key TEXT NOT NULL,
        subject_id TEXT NOT NULL DEFAULT '',
        scope TEXT NOT NULL,
        scope_id TEXT,
        winning_revision_id TEXT NOT NULL,
        considered_revision_ids_json TEXT NOT NULL,
        resolved_by TEXT NOT NULL,
        resolved_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_conflict_resolutions_group
        ON knowledge_conflict_resolutions(business_id, key, subject_id, scope, COALESCE(scope_id, ''));
    `);
    });
    // Migrate pre-account databases in place: add the columns, then replace
    // the account-blind active-revision uniqueness with the account-scoped
    // one (the old index would otherwise forbid two accounts holding the
    // same key). Legacy rows read back as account ''.
    this.ensureColumn("knowledge_candidates", "account_id", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("knowledge_revisions", "account_id", "TEXT NOT NULL DEFAULT ''");
    this.store.db.exec("DROP INDEX IF EXISTS idx_knowledge_active_revision");
    this.store.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_active_revision_account
        ON knowledge_revisions(business_id, account_id, key, subject_id, scope, COALESCE(scope_id, ''))
        WHERE status = 'active'`);
  }

  /**
   * The underlying database handle — the same connection intake
   * transactions run on. Callers needing same-connection atomicity
   * (e.g. lineage writes via `IntakeCandidateInput.atomically`) must use
   * this handle; a different connection cannot join those transactions.
   */
  get database(): DatabaseSync {
    return this.store.db;
  }

  private ensureColumn(table: string, column: string, type: string): void {
    const info = this.store.db.prepare(`PRAGMA table_info(${table})`).all() as SqlRow[];
    const names = new Set(info.map((entry) => String(row(entry).name)));
    if (!names.has(column)) {
      this.store.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }

  /**
   * Run fn inside exactly one BEGIN IMMEDIATE transaction with bounded
   * lock-busy retries. Only lock contention (SQLITE_BUSY) is retried, up to
   * MAX_TXN_ATTEMPTS with a short backoff; anything else — including UNIQUE
   * constraint conflicts and application errors — rolls back and propagates
   * unchanged, so a real conflict is never swallowed or converted. When
   * retries are exhausted a KnowledgeError("busy") names the honest outcome:
   * retry the whole command.
   */
  private transact<T>(fn: () => T): T {
    let attempt = 0;
    for (;;) {
      try {
        this.store.db.exec("BEGIN IMMEDIATE");
      } catch (error) {
        if (isBusyError(error) && attempt < MAX_TXN_ATTEMPTS) {
          attempt += 1;
          backoffSleep(attempt);
          continue;
        }
        if (isBusyError(error)) throw new KnowledgeError("busy", "knowledge store is busy; retry the command");
        throw error;
      }
      try {
        const out = fn();
        this.store.db.exec("COMMIT");
        return out;
      } catch (error) {
        try {
          this.store.db.exec("ROLLBACK");
        } catch {
          // Nothing to roll back; surface the original failure.
        }
        if (isBusyError(error) && attempt < MAX_TXN_ATTEMPTS) {
          attempt += 1;
          backoffSleep(attempt);
          continue;
        }
        if (isBusyError(error)) throw new KnowledgeError("busy", "knowledge store is busy; retry the command");
        throw error;
      }
    }
  }

  // ---------- candidate intake (untrusted side) ----------

  intakeCandidate(input: IntakeCandidateInput): KnowledgeCandidate {
    const business = this.store.getBusiness(input.businessId); // throws if unknown
    if (!isNonEmptyString(input.key)) throw new KnowledgeError("invalid", "key must be a non-empty string");
    if (RESERVED_KEY.test(input.key)) {
      throw new KnowledgeError(
        "reserved_key",
        `key "${input.key}" is reserved for fresh availability evidence and cannot enter static confirmed knowledge`,
      );
    }
    if (!KNOWN_FACT_KEYS.has(input.key)) {
      throw new KnowledgeError(
        "unknown_key",
        `key "${input.key}" is outside the booking-business fact vocabulary; unmapped content cannot mint verified authority`,
      );
    }
    if (input.confidence !== "probable" && input.confidence !== "uncertain") {
      throw new KnowledgeError(
        "invalid_confidence",
        `extracted candidates must be probable or uncertain; "${String(input.confidence)}" can never be minted by untrusted content`,
      );
    }
    if (!isRecord(input.value)) throw new KnowledgeError("invalid", "value must be an object");
    if (!Array.isArray(input.sourceReferences) || input.sourceReferences.length === 0) {
      throw new KnowledgeError("invalid", "candidates must carry at least one attributable source reference");
    }
    const primary = input.sourceReferences[0]!;
    if (!isNonEmptyString(primary.locator)) {
      throw new KnowledgeError("invalid", "primary source reference needs a locator");
    }
    const subjectId = input.subjectId ?? "";
    // Server-fixed account scope: the host caller pins which account the
    // observation belongs to. Every identity check below includes it, so
    // identical content from two accounts never aliases one row.
    const accountId = input.accountId ?? "";
    // Canonical form (key-order insensitive) for both storage and every
    // comparison below: semantically identical values dedupe and never raise
    // spurious change flags.
    const valueJson = canonical(input.value);
    const refsJson = JSON.stringify(input.sourceReferences);
    const observedAt = input.observedAt ?? now();

    // The transaction covers the dedupe check through commit, so concurrent
    // connections on the shared store serialize here instead of inserting
    // duplicate candidates for the same observation. Lock contention retries
    // with backoff; genuine conflicts propagate unchanged.
    let insertedId: string | undefined;
    let dedupedId: string | undefined;
    this.transact(() => {
      // Idempotent re-ingest: same business+account+key+subject+locator+value.
      // The source revision is deliberately NOT part of the identity: a
      // revision bump with identical canonical content is a re-observation,
      // and the stored revision advances to the newest observation.
      const existing = this.store.db.prepare(
        `SELECT * FROM knowledge_candidates WHERE business_id = $businessId AND account_id = $account
           AND key = $key AND subject_id = $subjectId AND source_locator = $locator
           AND value_json = $value
           AND status IN ('pending', 'confirmed') ORDER BY ingested_at LIMIT 1`,
      ).get({
        $businessId: business.id, $account: accountId, $key: input.key, $subjectId: subjectId,
        $locator: primary.locator, $value: valueJson,
      });
      if (existing) {
        const found = row(existing);
        if (input.sourceRevision !== undefined && found.source_revision !== input.sourceRevision) {
          this.store.db.prepare("UPDATE knowledge_candidates SET source_revision = $revision WHERE id = $id").run({
            $revision: input.sourceRevision, $id: String(found.id),
          });
        }
        dedupedId = String(found.id);
        return;
      }

      const id = input.intakeId ?? `kc_${randomUUID()}`;
      insertedId = id;
      const ingestedAt = now();
      this.store.db.prepare(
        `INSERT INTO knowledge_candidates
          (id, business_id, account_id, key, subject_id, value_json, confidence, source_references_json,
           source_locator, source_revision, observed_at, ingested_at, status, note)
         VALUES ($id, $businessId, $account, $key, $subjectId, $value, $confidence, $refs,
           $locator, $revision, $observedAt, $ingestedAt, 'pending', $note)`,
      ).run({
        $id: id, $businessId: business.id, $account: accountId, $key: input.key, $subjectId: subjectId,
        $value: valueJson, $confidence: input.confidence, $refs: refsJson,
        $locator: primary.locator, $revision: input.sourceRevision ?? null,
        $observedAt: observedAt, $ingestedAt: ingestedAt, $note: input.note ?? null,
      });
      // Changed source: prior pending candidates from the same account and
      // locator for this key+subject carrying a DIFFERENT value are
      // superseded, and confirmed revisions derived from that locator are
      // flagged for review rather than silently updated. A revision bump
      // with identical content is a re-observation, not a change.
      this.store.db.prepare(
        `UPDATE knowledge_candidates SET status = 'stale'
           WHERE business_id = $businessId AND account_id = $account AND key = $key AND subject_id = $subjectId
             AND source_locator = $locator AND status = 'pending' AND id != $id
             AND value_json != $value`,
      ).run({
        $businessId: business.id, $account: accountId, $key: input.key, $subjectId: subjectId,
        $locator: primary.locator, $value: valueJson, $id: id,
      });
      this.store.db.prepare(
        `UPDATE knowledge_revisions SET review_state = 'review'
           WHERE status = 'active' AND business_id = $businessId AND account_id = $account AND key = $key AND subject_id = $subjectId
              AND candidate_id IN (
                SELECT id FROM knowledge_candidates
                  WHERE business_id = $businessId AND account_id = $account AND source_locator = $locator AND value_json != $value
              )`,
      ).run({
        $businessId: business.id, $account: accountId, $key: input.key, $subjectId: subjectId,
        $locator: primary.locator, $value: valueJson,
      });
      // Same-connection atomicity for caller lineage: runs inside this
      // transaction, so a throwing hook rolls back the candidate row,
      // the supersede updates, and any partial lineage write together.
      if (input.atomically) input.atomically(this.store.db);
    });
    if (dedupedId !== undefined) return this.getCandidate(dedupedId);
    if (insertedId === undefined) throw new KnowledgeError("not_found", "candidate intake recorded nothing");
    return this.readCandidate(row(
      this.store.db.prepare("SELECT * FROM knowledge_candidates WHERE id = $id").get({ $id: insertedId }),
    ));
  }

  listCandidates(businessId: string, opts: { status?: string } = {}): CandidateView[] {
    const rows = opts.status
      ? this.store.db.prepare(
          "SELECT * FROM knowledge_candidates WHERE business_id = $b AND status = $s ORDER BY ingested_at",
        ).all({ $b: businessId, $s: opts.status })
      : this.store.db.prepare(
          "SELECT * FROM knowledge_candidates WHERE business_id = $b ORDER BY ingested_at",
        ).all({ $b: businessId });
    const candidates = rows.map((value) => this.readCandidate(row(value)));
    const pending = candidates.filter((candidate) => candidate.status === "pending");
    return candidates.map((candidate) => {
      // Pending conflicts are business-wide: same key+subject with a
      // different value conflicts across account lines too, so a second
      // account's observation can never silently agree or override. Account
      // lineage stays distinct; only the conflict link crosses accounts.
      const conflictsWith = candidate.status !== "pending" ? [] : pending
        .filter(
          (other) =>
            other.id !== candidate.id &&
            other.key === candidate.key &&
            other.subjectId === candidate.subjectId &&
            canonical(other.value) !== canonical(candidate.value),
        )
        .map((other) => other.id);
      return { ...candidate, conflictsWith };
    });
  }

  rejectCandidate(input: DecisionCommand & { candidateId: string; reason?: string }): KnowledgeCandidate {
    const fingerprint = this.requestFingerprint("reject_candidate", input, { candidateId: input.candidateId });
    const replay = this.replayDecision(input, "reject_candidate", fingerprint);
    if (replay) return this.getCandidate(input.candidateId);
    const candidate = this.getCandidate(input.candidateId);
    this.assertAuthority(input, "reject_candidate", { candidateId: candidate.id });
    try {
      this.assertBusiness(input.businessId, candidate.businessId);
    } catch (error) {
      this.reject(input, "reject_candidate",
        { requestFingerprint: fingerprint, candidateId: candidate.id, reason: "cross_business" },
        "cross_business", (error as Error).message);
    }
    // State check and mutation run atomically: a concurrent confirm/reject
    // either serializes first (then this sees the terminal state) or loses
    // the lock (honest busy), never double-applies.
    try {
      this.transact(() => {
        const fresh = this.requireFreshCommand(input, "reject_candidate", fingerprint);
        if (fresh) return;
        const current = this.getCandidate(candidate.id);
        if (current.status !== "pending") {
          throw new KnowledgeError("stale", `candidate ${candidate.id} is ${current.status}, not pending`);
        }
        const updated = this.store.db.prepare(
          "UPDATE knowledge_candidates SET status = 'rejected' WHERE id = $id AND status = 'pending'",
        ).run({ $id: candidate.id });
        if (updated.changes !== 1) {
          throw new KnowledgeError("stale", `candidate ${candidate.id} left pending while rejecting`);
        }
        this.recordDecision(input, "reject_candidate", "applied", {
          requestFingerprint: fingerprint,
          candidateId: candidate.id,
          reason: input.reason ?? null,
        });
      });
    } catch (error) {
      if (error instanceof KnowledgeError && error.code === "stale") {
        const status = this.safeCandidateStatus(candidate.id);
        this.reject(input, "reject_candidate",
          { requestFingerprint: fingerprint, candidateId: candidate.id, reason: "not_pending", status },
          "stale", `candidate ${candidate.id} is ${status}, not pending`);
      }
      throw error;
    }
    return this.getCandidate(candidate.id);
  }

  /** Best-effort status read for post-rollback audit detail (never throws). */
  private safeCandidateStatus(id: string): string {
    try {
      return this.getCandidate(id).status;
    } catch {
      return "unknown";
    }
  }

  // ---------- owner-confirmed side ----------

  confirmCandidate(input: DecisionCommand & { candidateId: string }): ConfirmResult {
    const fingerprint = this.requestFingerprint("confirm", input, { candidateId: input.candidateId });
    const replay = this.replayDecision(input, "confirm", fingerprint);
    if (replay) return replay as ConfirmResult;

    const candidate = this.getCandidate(input.candidateId);
    this.assertAuthority(input, "confirm", { candidateId: candidate.id });
    try {
      this.assertBusiness(input.businessId, candidate.businessId);
    } catch (error) {
      this.reject(input, "confirm",
        { requestFingerprint: fingerprint, candidateId: candidate.id, reason: "cross_business" },
        "cross_business", (error as Error).message);
    }

    // Every state read below re-runs inside the write transaction: a
    // concurrent confirm/correct either commits first (then this path
    // observes the terminal state and answers idempotently) or loses the
    // lock (honest busy). The conditional status update is the second
    // fence; the partial unique index on active revisions is the last.
    const approvedAt = now();
    try {
      return this.transact(() => {
        const fresh = this.requireFreshCommand(input, "confirm", fingerprint);
        if (fresh) return fresh.recorded as unknown as ConfirmResult;
        const current = this.getCandidate(candidate.id);
        if (current.status === "confirmed") {
          // Always answer with the live revision pair, never by pairing the
          // candidate's original confirmedFactId with a newer unrelated
          // active revision after a correction moved the fact forward.
          const live = this.activeRevisionFor(current.businessId, current.accountId, current.key, current.subjectId, "global");
          if (!live) {
            throw new KnowledgeError("not_found", `confirmed candidate ${current.id} has no live revision row`);
          }
          const fact = this.getFact(live.factId);
          return { fact, revision: live, alreadyConfirmed: true, duplicate: false };
        }
        if (current.status !== "pending") {
          throw new KnowledgeError("stale", `candidate ${current.id} is ${current.status}, not pending`);
        }
        const fact = this.store.addBusinessFact({
          businessId: current.businessId,
          key: current.key,
          value: current.value,
          confidence: "verified",
          sourceReferences: current.sourceReferences,
          observedAt: current.observedAt,
        });
        const revision = this.insertRevision({
          factId: fact.id,
          businessId: current.businessId,
          accountId: current.accountId,
          key: current.key,
          subjectId: current.subjectId,
          value: current.value,
          scope: "global",
          approvedBy: input.actor.id,
          approvedAt,
          candidateId: current.id,
          sourceReferences: current.sourceReferences,
        });
        const claimed = this.store.db.prepare(
          "UPDATE knowledge_candidates SET status = 'confirmed', confirmed_fact_id = $factId WHERE id = $id AND status = 'pending'",
        ).run({ $factId: fact.id, $id: current.id });
        if (claimed.changes !== 1) {
          throw new KnowledgeError("stale", `candidate ${current.id} left pending while confirming`);
        }
        const result: ConfirmResult = { fact, revision, alreadyConfirmed: false, duplicate: false };
        this.recordDecision(input, "confirm", "applied", {
          requestFingerprint: fingerprint,
          candidateId: current.id,
          factId: fact.id,
          revisionId: revision.id,
          result,
        });
        return result;
      });
    } catch (error) {
      if (error instanceof KnowledgeError && (error.code === "stale" || error.code === "not_found")) {
        // Rejection evidence is recorded outside the rolled-back
        // transaction so the audit survives the failure it describes.
        const status = this.safeCandidateStatus(candidate.id);
        this.reject(input, "confirm",
          { requestFingerprint: fingerprint, candidateId: candidate.id, reason: error.code === "stale" ? "not_pending" : "not_found", status },
          error.code, error.message);
      }
      throw error;
    }
  }

  correctFact(input: DecisionCommand & {
    key: string;
    subjectId?: string;
    /** Account scope of the revision line being corrected (default ''). */
    accountId?: string;
    expectedRevision: number;
    value: Record<string, unknown>;
    sourceReferences?: SourceReference[];
  }): ConfirmResult {
    const subjectId = input.subjectId ?? "";
    const accountId = input.accountId ?? "";
    // The fingerprint binds the effective provenance: explicit sources are
    // named, inherited sources resolve from the live revision (so an altered
    // provenance can never replay as an identical command). The account is
    // part of the fingerprint so one commandId can never confirm two
    // accounts' lines interchangeably.
    const inherited = input.sourceReferences === undefined
      ? this.activeRevisionFor(input.businessId, accountId, input.key, subjectId, "global")?.sourceReferences ?? null
      : undefined;
    const fingerprint = this.requestFingerprint("correct", input, {
      key: input.key, subjectId, accountId, expectedRevision: input.expectedRevision, value: isRecord(input.value) ? input.value : null,
      sourceReferences: input.sourceReferences ?? inherited,
    });
    const replay = this.replayDecision(input, "correct", fingerprint);
    if (replay) {
      const prior = replay as unknown as { duplicate?: unknown; fact?: unknown };
      if (prior.duplicate === true && prior.fact !== undefined) {
        return replay as unknown as ConfirmResult;
      }
      // A recorded outcome without fact rows is a rejected decision replayed
      // as success by an older path: re-raise it as its typed rejection.
      throw new KnowledgeError("conflict", `commandId ${input.commandId ?? "(absent)"} has a recorded non-success outcome; replays cannot mint a confirmation`);
    }

    this.assertAuthority(input, "correct", { key: input.key });
    // Rejected inputs are audited with scalar metadata only — corrected
    // values themselves are never written to the decision log on failure.
    if (!KNOWN_FACT_KEYS.has(input.key)) {
      this.reject(input, "correct",
        { requestFingerprint: fingerprint, reason: "unknown_key", key: input.key, subjectId },
        "unknown_key", `key "${input.key}" is outside the booking-business fact vocabulary`);
    }
    if (!isRecord(input.value)) {
      this.reject(input, "correct",
        { requestFingerprint: fingerprint, reason: "invalid", key: input.key, subjectId },
        "invalid", "corrected value must be an object");
    }
    // The live revision is re-read inside the write transaction: a
    // concurrent correction either commits first (then this sees the new
    // version and reports stale) or loses the lock (honest busy). The
    // conditional supersede is the second fence; the partial unique index
    // on active revisions is the last.
    const approvedAt = now();
    try {
      return this.transact(() => {
        const fresh = this.requireFreshCommand(input, "correct", fingerprint);
        if (fresh) return fresh.recorded as unknown as ConfirmResult;
        const current = this.activeRevisionFor(input.businessId, accountId, input.key, subjectId, "global");
        if (!current) {
          throw new KnowledgeError("not_found", `no active confirmed fact ${input.key}/${subjectId} for ${input.businessId}`);
        }
        if (current.revision !== input.expectedRevision) {
          throw new KnowledgeError(
            "stale_version",
            `stale correction: expected revision ${input.expectedRevision}, active revision is ${current.revision}`,
          );
        }
        const sources = input.sourceReferences ?? current.sourceReferences;
        const fact = this.store.addBusinessFact({
          businessId: input.businessId,
          key: input.key,
          value: input.value,
          confidence: "verified",
          sourceReferences: sources,
        });
        const superseded = this.store.db.prepare(
          "UPDATE knowledge_revisions SET status = 'superseded' WHERE id = $id AND status = 'active'",
        ).run({ $id: current.id });
        if (superseded.changes !== 1) {
          throw new KnowledgeError(
            "stale_version",
            `stale correction: revision ${current.revision} was superseded while correcting`,
          );
        }
        const revision = this.insertRevision({
          factId: fact.id,
          businessId: input.businessId,
          accountId,
          key: input.key,
          subjectId,
          revision: current.revision + 1,
          value: input.value,
          scope: "global",
          approvedBy: input.actor.id,
          approvedAt,
          sourceReferences: sources,
        });
        const result: ConfirmResult = { fact, revision, alreadyConfirmed: false, duplicate: false };
        this.recordDecision(input, "correct", "applied", {
          requestFingerprint: fingerprint,
          supersedesRevisionId: current.id,
          factId: fact.id,
          revisionId: revision.id,
          result,
        });
        return result;
      });
    } catch (error) {
      if (error instanceof KnowledgeError && (error.code === "not_found" || error.code === "stale_version")) {
        // Rejection evidence is recorded outside the rolled-back
        // transaction so the audit survives the failure it describes.
        const detail: Record<string, unknown> = { requestFingerprint: fingerprint, key: input.key, subjectId, accountId };
        if (error.code === "not_found") {
          detail.reason = "not_found";
        } else {
          const live = this.activeRevisionFor(input.businessId, accountId, input.key, subjectId, "global");
          detail.reason = "stale_version";
          detail.expectedRevision = input.expectedRevision;
          detail.currentRevision = live?.revision;
        }
        this.recordDecision(input, "correct", "rejected", detail);
      }
      throw error;
    }
  }

  // ---------- business-wide conflicts ----------

  /**
   * Business-wide conflict groups: active revisions for the same applicable
   * fact (key + subject + scope) carrying different values on different
   * account lines. Account lineage is never merged — rows stay distinct and
   * only the comparison crosses accounts. Revisions under review (stale
   * source) are listed for visibility but never trigger a conflict on their
   * own; they are already withheld from consequential use.
   */
  listConflicts(businessId: string): BusinessConflict[] {
    this.store.getBusiness(businessId); // throws if unknown
    const rows = this.store.db.prepare(
      `SELECT * FROM knowledge_revisions WHERE business_id = $b AND status = 'active'
         ORDER BY key, subject_id, scope, COALESCE(scope_id, ''), approved_at, id`,
    ).all({ $b: businessId });
    const groups = new Map<string, KnowledgeRevision[]>();
    for (const value of rows) {
      const revision = this.readRevision(row(value));
      const group = `${revision.key}	${revision.subjectId}	${revision.scope}	${revision.scopeId ?? ""}`;
      const list = groups.get(group);
      if (list) list.push(revision);
      else groups.set(group, [revision]);
    }
    const conflicts: BusinessConflict[] = [];
    for (const revisions of groups.values()) {
      const usable = revisions.filter((revision) => revision.reviewState === "none");
      const distinct = new Set(usable.map((revision) => canonical(revision.value)));
      if (distinct.size < 2) continue;
      const first = revisions[0]!;
      const currentIds = revisions.map((revision) => revision.id).sort();
      const governing = this.governingResolution(
        businessId, first.key, first.subjectId, first.scope, first.scopeId, currentIds,
      );
      conflicts.push({
        key: first.key,
        subjectId: first.subjectId,
        scope: first.scope,
        ...(first.scopeId === undefined ? {} : { scopeId: first.scopeId }),
        revisions: revisions.map((revision) => ({
          revisionId: revision.id,
          factId: revision.factId,
          accountId: revision.accountId,
          revision: revision.revision,
          value: revision.value,
          reviewState: revision.reviewState,
          approvedBy: revision.approvedBy,
          approvedAt: revision.approvedAt,
        })),
        status: governing ? "resolved" : "conflicted",
        ...(governing ? { resolutionId: governing.id, winningRevisionId: governing.winningRevisionId } : {}),
      });
    }
    return conflicts;
  }

  private governingResolution(
    businessId: string,
    key: string,
    subjectId: string,
    scope: FactScope,
    scopeId: string | undefined,
    currentIds: string[],
  ): { id: string; winningRevisionId: string } | null {
    const rows = this.store.db.prepare(
      `SELECT * FROM knowledge_conflict_resolutions
         WHERE business_id = $b AND key = $k AND subject_id = $s
           AND scope = $scope AND COALESCE(scope_id, '') = $scopeId
         ORDER BY rowid DESC`,
    ).all({ $b: businessId, $k: key, $s: subjectId, $scope: scope, $scopeId: scopeId ?? "" });
    const wanted = [...currentIds].sort().join(",");
    for (const value of rows) {
      const item = row(value);
      const considered = parseJson<string[]>(item.considered_revision_ids_json, []);
      if ([...considered].sort().join(",") !== wanted) continue;
      const winner = String(item.winning_revision_id);
      if (!currentIds.includes(winner)) continue;
      return { id: String(item.id), winningRevisionId: winner };
    }
    return null;
  }

  /**
   * Owner-only conflict resolution pinned to exact revisions: the winner is
   * a revision id, never a value match, and the resolution governs exactly
   * the commanded revision set — the exact ids the owner reviewed, carried
   * on the command. The submitted set must equal the active applicable set
   * atomically inside the write transaction: a new rival, a missing rival,
   * a revision change, or a newly stale source since the owner's review
   * rejects the command as stale instead of silently resolving an unseen
   * conflict. Any later correction mints a new revision id, the set
   * changes, and the conflict reopens — nothing silently carries forward.
   * Losing lines keep their rows and lineage; they are withheld from offer
   * preparation, never erased or merged. Resolution synthesizes nothing, so
   * unknown costs can never gain a profit figure and scoped exceptions keep
   * their commanded scope.
   */
  resolveConflict(
    input: DecisionCommand & {
      key: string;
      subjectId?: string;
      scope?: FactScope;
      scopeId?: string;
      winningRevisionId: string;
      consideredRevisionIds: string[];
    },
  ): ResolveConflictResult {
    const subjectId = input.subjectId ?? "";
    const scope = input.scope ?? "global";
    const scopeId = input.scopeId;
    const commanded = Array.isArray(input.consideredRevisionIds)
      ? [...input.consideredRevisionIds].sort()
      : [];
    const fingerprint = this.requestFingerprint("resolve_conflict", input, {
      key: input.key, subjectId, scope, scopeId: scopeId ?? null, winningRevisionId: input.winningRevisionId,
      consideredRevisionIds: commanded,
    });
    const replay = this.replayDecision(input, "resolve_conflict", fingerprint);
    if (replay) {
      return { ...(replay as ResolveConflictResult), duplicate: true };
    }
    this.assertAuthority(input, "resolve_conflict", { key: input.key, subjectId });
    const rejectInvalid = (reason: string): never => {
      this.recordDecision(input, "resolve_conflict", "rejected", {
        requestFingerprint: fingerprint, reason, key: input.key, subjectId,
      });
      throw new KnowledgeError("invalid", reason);
    };
    if (!KNOWN_FACT_KEYS.has(input.key)) {
      rejectInvalid(`key "${input.key}" is outside the booking-business fact vocabulary`);
    }
    if (!isNonEmptyString(input.winningRevisionId)) {
      rejectInvalid("resolution requires an exact winningRevisionId; values are never matched");
    }
    if (
      !Array.isArray(input.consideredRevisionIds) ||
      input.consideredRevisionIds.length === 0 ||
      !input.consideredRevisionIds.every(isNonEmptyString) ||
      new Set(input.consideredRevisionIds).size !== input.consideredRevisionIds.length
    ) {
      rejectInvalid("resolution requires the exact non-empty unique consideredRevisionIds shown to the owner");
    }
    if (!commanded.includes(input.winningRevisionId)) {
      rejectInvalid("winningRevisionId must be a member of the commanded consideredRevisionIds");
    }
    try {
      return this.transact(() => {
        const fresh = this.requireFreshCommand(input, "resolve_conflict", fingerprint);
        if (fresh) return { ...(fresh.recorded as unknown as ResolveConflictResult), duplicate: true };
        const group = this.store.db.prepare(
          `SELECT * FROM knowledge_revisions WHERE business_id = $b AND key = $k AND subject_id = $s
             AND scope = $scope AND COALESCE(scope_id, '') = $scopeId AND status = 'active'
             ORDER BY approved_at, id`,
        ).all({ $b: input.businessId, $k: input.key, $s: subjectId, $scope: scope, $scopeId: scopeId ?? "" })
          .map((value) => this.readRevision(row(value)));
        const active = group.map((revision) => revision.id).sort();
        const winner = group.find((revision) => revision.id === input.winningRevisionId) ?? null;
        if (!winner) {
          throw new KnowledgeError("not_found", `winning revision ${input.winningRevisionId} is not an active revision of ${input.key}/${subjectId}`);
        }
        if (active.join(",") !== commanded.join(",")) {
          throw new KnowledgeError(
            "stale",
            `conflict revision set changed since owner review for ${input.key}/${subjectId}: owner considered [${commanded.join(", ")}], active set is [${active.join(", ")}]; re-review before resolving`,
          );
        }
        const staleSource = group.find((revision) => revision.reviewState !== "none") ?? null;
        if (staleSource) {
          throw new KnowledgeError(
            "stale",
            `revision ${staleSource.id} is under review (stale source) since owner review; reconfirm it before resolving ${input.key}/${subjectId}`,
          );
        }
        const usable = group.filter((revision) => revision.reviewState === "none");
        if (new Set(usable.map((revision) => canonical(revision.value))).size < 2) {
          throw new KnowledgeError("invalid", `no cross-account value conflict to resolve for ${input.key}/${subjectId}`);
        }
        const considered = commanded;
        const resolutionId = input.commandId ?? `kd_${createHash("sha256").update(canonical({ kind: "resolve_conflict", at: randomUUID() })).digest("hex").slice(0, 24)}`;
        this.store.db.prepare(
          `INSERT INTO knowledge_conflict_resolutions
             (id, business_id, key, subject_id, scope, scope_id, winning_revision_id,
              considered_revision_ids_json, resolved_by, resolved_at)
           VALUES ($id, $b, $k, $s, $scope, $scopeId, $winner, $considered, $by, $at)`,
        ).run({
          $id: resolutionId, $b: input.businessId, $k: input.key, $s: subjectId,
          $scope: scope, $scopeId: scopeId ?? null, $winner: winner.id,
          $considered: JSON.stringify(considered), $by: input.actor.id, $at: now(),
        });
        const result: ResolveConflictResult = {
          winningRevisionId: winner.id,
          consideredRevisionIds: considered,
          resolutionId,
          duplicate: false,
        };
        this.recordDecision(input, "resolve_conflict", "applied", {
          requestFingerprint: fingerprint,
          key: input.key,
          subjectId,
          scope,
          scopeId: scopeId ?? null,
          winningRevisionId: winner.id,
          consideredRevisionIds: considered,
          result,
        });
        return result;
      });
    } catch (error) {
      if (error instanceof KnowledgeError && (error.code === "not_found" || error.code === "invalid" || error.code === "stale")) {
        this.recordDecision(input, "resolve_conflict", "rejected", {
          requestFingerprint: fingerprint, reason: error.code, key: input.key, subjectId,
        });
      }
      throw error;
    }
  }

  /**
   * Owner-approved scoped exception with a canonical value shaped exactly
   * for the accepted offers adapter: { exceptionId (server-minted),
   * policyId, scope: { bookingId } | { customerId }, effect, approvedBy
   * (always the commanding owner id — client-supplied authority is
   * rejected, never normalized) }. The revision row keeps the same scope
   * for uniqueness; the snapshot therefore feeds adaptBusinessFacts records
   * it can actually consume, instead of revision-shaped values the adapter
   * must report unparseable.
   */
  addScopedException(input: DecisionCommand & {
    policyId: string;
    effect: "allow" | "require_owner_decision";
    scope: Exclude<FactScope, "global">;
    scopeId: string;
    subjectId?: string;
    value: Record<string, unknown>;
  }): ConfirmResult {
    const subjectPreview = {
      policyId: typeof input.policyId === "string" ? input.policyId : null,
      effect: input.effect,
      scope: input.scope,
      scopeId: input.scopeId,
      subjectId: input.subjectId ?? input.scopeId,
      sources: [`gather://knowledge-exception/${String(input.scope)}/${String(input.scopeId)}`],
      value: isRecord(input.value) ? input.value : null,
    };
    const fingerprint = this.requestFingerprint("exception", input, subjectPreview);
    const replay = this.replayDecision(input, "exception", fingerprint);
    if (replay) return replay as ConfirmResult;

    this.assertAuthority(input, "exception", { scope: input.scope, scopeId: input.scopeId });
    // Rejected inputs are audited with scalar metadata only.
    const rejectInvalid = (reason: string): never => {
      this.recordDecision(input, "exception", "rejected", {
        requestFingerprint: fingerprint, reason, scope: String(input.scope), scopeId: String(input.scopeId),
      });
      throw new KnowledgeError("invalid", reason);
    };
    if (!isNonEmptyString(input.policyId)) {
      rejectInvalid("scoped exceptions require an explicit policyId identifying the relaxed policy");
    }
    if (input.effect !== "allow" && input.effect !== "require_owner_decision") {
      rejectInvalid("scoped exceptions require an explicit effect of allow or require_owner_decision");
    }
    if (input.scope !== "booking" && input.scope !== "customer") {
      rejectInvalid("scoped exceptions must target a booking or customer scope");
    }
    if (!isNonEmptyString(input.scopeId)) {
      rejectInvalid("scoped exceptions require a scopeId; they can never silently globalize");
    }
    if (!isRecord(input.value)) rejectInvalid("exception value must be an object");
    // Canonical fields are server-derived or explicitly commanded: a value
    // carrying contradictory authority is rejected rather than normalized.
    const canonicalScope = input.scope === "booking" ? { bookingId: input.scopeId } : { customerId: input.scopeId };
    for (const [field, expected, actual] of [
      ["policyId", input.policyId, input.value.policyId],
      ["effect", input.effect, input.value.effect],
      ["approvedBy", input.actor.id, input.value.approvedBy],
      ["exceptionId", undefined, input.value.exceptionId],
    ] as const) {
      if (field === "exceptionId") {
        if (actual !== undefined) {
          rejectInvalid("value.exceptionId is server-minted; callers must not supply it");
        }
        continue;
      }
      if (actual !== undefined && actual !== expected) {
        rejectInvalid(`value.${field} contradicts the approved exception; refusing to normalize authority`);
      }
    }
    if (isRecord(input.value.scope)) {
      const embedded = input.value.scope as Record<string, unknown>;
      const expectedKey = input.scope === "booking" ? "bookingId" : "customerId";
      if (embedded[expectedKey] !== undefined && embedded[expectedKey] !== input.scopeId) {
        rejectInvalid("value.scope contradicts the command scope");
      }
      for (const key of Object.keys(embedded)) {
        if (key !== expectedKey && key !== "inquiryId") {
          rejectInvalid(`value.scope carries an unexpected key "${key}" for a ${input.scope}-scoped exception`);
        }
      }
    } else if (input.value.scope !== undefined) {
      rejectInvalid("value.scope must be an object when present");
    }
    const value = {
      ...input.value,
      exceptionId: `ex_${randomUUID()}`,
      policyId: input.policyId,
      scope: { ...(!isRecord(input.value.scope) ? {} : (input.value.scope as Record<string, unknown>)), ...canonicalScope },
      effect: input.effect,
      approvedBy: input.actor.id,
    };
    const subjectId = input.subjectId ?? input.scopeId;
    const sources: SourceReference[] = [
      { kind: "manual", locator: `gather://knowledge-exception/${input.scope}/${input.scopeId}`, label: "Owner-entered scoped exception" },
    ];
    const approvedAt = now();
    try {
      return this.transact(() => {
        const fresh = this.requireFreshCommand(input, "exception", fingerprint);
        if (fresh) return fresh.recorded as unknown as ConfirmResult;
        const fact = this.store.addBusinessFact({
          businessId: input.businessId,
          key: "scoped_exception",
          value,
          confidence: "verified",
          sourceReferences: sources,
        });
        const revision = this.insertRevision({
          factId: fact.id,
          businessId: input.businessId,
          accountId: "",
          key: "scoped_exception",
          subjectId,
          value,
          scope: input.scope,
          scopeId: input.scopeId,
          approvedBy: input.actor.id,
          approvedAt,
          sourceReferences: sources,
        });
        const result: ConfirmResult = { fact, revision, alreadyConfirmed: false, duplicate: false };
        this.recordDecision(input, "exception", "applied", {
          requestFingerprint: fingerprint,
          factId: fact.id,
          revisionId: revision.id,
          result,
        });
        return result;
      });
    } catch (error) {
      // Lock contention already retries inside transact; a unique-index
      // conflict here means an identical scoped exception already holds the
      // scope — surface it as a conflict, never silently swallow it.
      if (error instanceof Error && /UNIQUE constraint failed|unique/i.test(error.message)) {
        this.recordDecision(input, "exception", "rejected", {
          requestFingerprint: fingerprint, reason: "conflict", scope: String(input.scope), scopeId: String(input.scopeId),
        });
        throw new KnowledgeError("conflict", `a scoped exception already holds ${input.scope}/${input.scopeId} for this subject`);
      }
      throw error;
    }
  }

  // ---------- read side ----------

  listFacts(businessId: string): ConfirmedFact[] {
    const rows = this.store.db.prepare(
      `SELECT * FROM knowledge_revisions WHERE business_id = $b AND status = 'active'
         ORDER BY approved_at, revision`,
    ).all({ $b: businessId });
    return rows.map((value) => {
      const revision = this.readRevision(row(value));
      const fact = this.getFact(revision.factId);
      return { ...fact, revision: revision.revision, accountId: revision.accountId, subjectId: revision.subjectId, scope: revision.scope, scopeId: revision.scopeId, reviewState: revision.reviewState };
    });
  }

  listDecisions(businessId: string): KnowledgeDecision[] {
    const rows = this.store.db.prepare(
      "SELECT * FROM knowledge_decisions WHERE business_id = $b ORDER BY created_at, command_id",
    ).all({ $b: businessId });
    return rows.map((value) => {
      const item = row(value);
      return {
        commandId: String(item.command_id),
        kind: String(item.kind) as DecisionKind,
        businessId: String(item.business_id),
        actorKind: String(item.actor_kind) as KnowledgeDecision["actorKind"],
        actorId: String(item.actor_id),
        outcome: String(item.outcome) as KnowledgeDecision["outcome"],
        detail: parseJson(item.detail_json, {}),
        createdAt: String(item.created_at),
      };
    });
  }

  /**
   * Confirmed-fact snapshot for the offers adapter (adaptBusinessFacts).
   * Includes a synthesized verified `business` fact carrying the owner-
   * maintained businessId/timezone, plus every active confirmed fact that
   * is verified, attributed, registry-keyed, and NOT under review.
   * Source-changed facts are withheld (with explicit reasons) until an
   * owner reconfirms them, so consequential offers cannot use stale
   * pricing even when the host feeds `facts` straight through.
   */
  snapshotForOffers(businessId: string): OffersKnowledgeSnapshot {
    const business = this.store.getBusiness(businessId);
    const confirmed = this.listFacts(businessId);
    const withheld: WithheldFact[] = confirmed
      .filter((fact) => fact.reviewState !== "none")
      .map((fact) => ({
        factId: fact.id,
        key: fact.key,
        subjectId: fact.subjectId,
        reason: "source changed since owner confirmation; reconfirm via correctFact or by confirming the updated candidate",
      }));
    const reviewIds = new Set(withheld.map((fact) => fact.factId));
    const current = confirmed.filter((fact) => fact.reviewState === "none" && KNOWN_FACT_KEYS.has(fact.key));
    // Business-wide conflicts: unresolved groups withhold every involved
    // consequential fact until an owner resolution pins an exact winning
    // revision; a resolved group contributes the winner only. Withholding
    // is by fact id — losing account lines keep their rows and lineage.
    const kept = new Set(current.map((fact) => fact.id));
    for (const conflict of this.listConflicts(businessId)) {
      if (conflict.status === "resolved" && conflict.winningRevisionId) {
        const winner = conflict.revisions.find((revision) => revision.revisionId === conflict.winningRevisionId)!;
        for (const revision of conflict.revisions) {
          if (revision.factId === winner.factId || revision.reviewState !== "none") continue;
          kept.delete(revision.factId);
          withheld.push({
            factId: revision.factId,
            key: conflict.key,
            subjectId: conflict.subjectId,
            reason: `cross-account conflict resolved in favor of revision ${winner.revisionId} (account ${winner.accountId}); resolution ${conflict.resolutionId}`,
          });
        }
      } else {
        const rivals = conflict.revisions.filter((revision) => revision.reviewState === "none");
        for (const revision of rivals) {
          kept.delete(revision.factId);
          withheld.push({
            factId: revision.factId,
            key: conflict.key,
            subjectId: conflict.subjectId,
            reason: `unresolved cross-account conflict across revisions ${rivals.map((other) => `${other.revisionId}(account ${other.accountId})`).join(", ")}; owner resolution required`,
          });
        }
      }
    }
    // Agreement dedupes presentation only: identical values across account
    // lines appear once, while every line's revision row (provenance) stays
    // readable via listFacts/listConflicts.
    const agreements: AgreementGroup[] = [];
    const eligible = current.filter((fact) => kept.has(fact.id));
    const scopeByFactId = new Map(eligible.map((fact) => [fact.id, fact.scope]));
    const presentation: BusinessFact[] = [];
    const byGroup = new Map<string, ConfirmedFact[]>();
    for (const fact of eligible) {
      const group = `${fact.key}	${fact.subjectId}	${fact.scope}	${fact.scopeId ?? ""}`;
      const list = byGroup.get(group);
      if (list) list.push(fact);
      else byGroup.set(group, [fact]);
    }
    const strip = ({ revision: _r, accountId: _a, subjectId: _j, scope: _s, scopeId: _i, reviewState: _v, ...fact }: ConfirmedFact): BusinessFact => fact;
    for (const group of byGroup.values()) {
      const byValue = new Map<string, ConfirmedFact[]>();
      for (const fact of group) {
        const digest = canonical(fact.value);
        const list = byValue.get(digest);
        if (list) list.push(fact);
        else byValue.set(digest, [fact]);
      }
      for (const same of byValue.values()) {
        same.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
        presentation.push(strip(same[0]!));
        if (same.length > 1) {
          agreements.push({
            key: same[0]!.key,
            subjectId: same[0]!.subjectId,
            keptFactId: same[0]!.id,
            agreedFactIds: same.slice(1).map((fact) => fact.id),
          });
        }
      }
    }
    const businessFact: BusinessFact = {
      id: `gather:business:${business.id}`,
      businessId: business.id,
      key: "business",
      value: { businessId: business.id, timezone: business.timezone },
      confidence: "verified",
      sourceReferences: [
        { kind: "manual", locator: `gather://business/${business.id}`, label: "Owner-maintained business record" },
      ],
      observedAt: business.updatedAt,
    };
    return {
      businessId: business.id,
      timezone: business.timezone,
      generatedAt: now(),
      facts: [businessFact, ...presentation],
      // Compatibility: reviewFactIds names review-withheld facts only;
      // conflict withholding is explicit in `withheld` with its own reasons.
      reviewFactIds: [...reviewIds],
      withheld,
      scopedFactCount: presentation.filter((fact) => scopeByFactId.get(fact.id) !== "global").length,
      agreements,
    };
  }

  // ---------- internals ----------

  private getCandidate(id: string): KnowledgeCandidate {
    const found = this.store.db.prepare("SELECT * FROM knowledge_candidates WHERE id = $id").get({ $id: id });
    if (!found) throw new KnowledgeError("not_found", `unknown candidate ${id}`);
    return this.readCandidate(row(found));
  }

  private getFact(id: string): BusinessFact {
    const found = this.store.db.prepare("SELECT * FROM business_facts WHERE id = $id").get({ $id: id });
    if (!found) throw new KnowledgeError("not_found", `missing confirmed fact row ${id}`);
    const item = row(found);
    return {
      id: String(item.id),
      businessId: String(item.business_id),
      key: String(item.key),
      value: parseJson(item.value_json, undefined),
      confidence: String(item.confidence) as BusinessFact["confidence"],
      sourceReferences: parseJson(item.source_references_json, []),
      observedAt: String(item.observed_at),
    };
  }

  private activeRevisionFor(
    businessId: string,
    accountId: string,
    key: string,
    subjectId: string,
    scope: FactScope,
    scopeId?: string,
  ): KnowledgeRevision | null {
    const found = this.store.db.prepare(
      `SELECT * FROM knowledge_revisions WHERE business_id = $b AND account_id = $account AND key = $k AND subject_id = $s
         AND scope = $scope AND COALESCE(scope_id, '') = $scopeId AND status = 'active'
         ORDER BY revision DESC LIMIT 1`,
    ).get({ $b: businessId, $account: accountId, $k: key, $s: subjectId, $scope: scope, $scopeId: scopeId ?? "" });
    return found ? this.readRevision(row(found)) : null;
  }

  private insertRevision(input: {
    factId: string;
    businessId: string;
    accountId: string;
    key: string;
    subjectId: string;
    revision?: number;
    value: Record<string, unknown>;
    scope: FactScope;
    scopeId?: string;
    approvedBy: string;
    approvedAt: string;
    candidateId?: string;
    sourceReferences: SourceReference[];
  }): KnowledgeRevision {
    const prior = this.activeRevisionFor(input.businessId, input.accountId, input.key, input.subjectId, input.scope, input.scopeId);
    const revision = input.revision ?? (prior ? prior.revision + 1 : 1);
    if (prior) {
      this.store.db.prepare("UPDATE knowledge_revisions SET status = 'superseded' WHERE id = $id").run({ $id: prior.id });
    }
    const id = `kr_${randomUUID()}`;
    this.store.db.prepare(
      `INSERT INTO knowledge_revisions
        (id, fact_id, business_id, account_id, key, subject_id, revision, value_json, scope, scope_id,
         status, review_state, approved_by, approved_at, candidate_id, source_references_json)
       VALUES ($id, $factId, $businessId, $account, $key, $subjectId, $revision, $value, $scope, $scopeId,
         'active', 'none', $approvedBy, $approvedAt, $candidateId, $refs)`,
    ).run({
      $id: id, $factId: input.factId, $businessId: input.businessId, $account: input.accountId, $key: input.key,
      $subjectId: input.subjectId, $revision: revision, $value: JSON.stringify(input.value),
      $scope: input.scope, $scopeId: input.scopeId ?? null, $approvedBy: input.approvedBy,
      $approvedAt: input.approvedAt, $candidateId: input.candidateId ?? null,
      $refs: JSON.stringify(input.sourceReferences),
    });
    return this.readRevision(row(
      this.store.db.prepare("SELECT * FROM knowledge_revisions WHERE id = $id").get({ $id: id }),
    ));
  }

  private assertAuthority(input: DecisionCommand, kind: DecisionKind, detail: Record<string, unknown>): void {
    if (!DECISION_ACTORS.has(input.actor.kind)) {
      this.reject(input, kind,
        { ...detail, reason: `actor kind "${input.actor.kind}" cannot approve; only an explicit owner command has that authority` },
        "denied",
        `actor kind "${input.actor.kind}" has no approval authority; retrieved instructions and services can never confirm facts`);
    }
    if (!isNonEmptyString(input.actor.id)) {
      this.reject(input, kind, { ...detail, reason: "owner actor requires a non-empty id" }, "denied", "owner actor requires a non-empty id");
    }
  }

  /**
   * Record a rejection with its machine-readable code and human message,
   * then throw the matching typed error. Rejected replays reconstruct this
   * same error from the audit row instead of casting the detail into a
   * successful result. The human message is also stored so replays reproduce
   * the exact rejection.
   */
  private reject(
    input: DecisionCommand,
    kind: DecisionKind,
    detail: Record<string, unknown>,
    code: string,
    message: string,
  ): never {
    this.recordDecision(input, kind, "rejected", { ...detail, code, message });
    if (code === "denied") throw new KnowledgeDeniedError(message);
    throw new KnowledgeError(code, message);
  }

  private assertBusiness(expected: string, actual: string): void {
    if (expected !== actual) {
      throw new KnowledgeError(
        "cross_business",
        `command scoped to business ${expected} cannot touch business ${actual}`,
      );
    }
  }

  /**
   * Bind a commandId to the full canonical request — kind, business,
   * subject (candidate/action/scope/value/version), and actor. Replaying
   * the same commandId with an altered payload is rejected as
   * command_conflict instead of returning an unrelated recorded outcome.
   */
  private requestFingerprint(kind: DecisionKind, input: DecisionCommand, subject: Record<string, unknown>): string {
    return createHash("sha256").update(canonical({
      kind,
      businessId: input.businessId,
      actor: { kind: input.actor.kind, id: input.actor.id },
      subject,
    })).digest("hex");
  }

  private replayDecision(input: DecisionCommand, kind: DecisionKind, fingerprint: string): unknown {
    if (!input.commandId) return null;
    const found = this.store.db.prepare(
      "SELECT * FROM knowledge_decisions WHERE command_id = $id",
    ).get({ $id: input.commandId });
    if (!found) return null;
    const item = row(found);
    if (String(item.kind) !== kind || String(item.business_id) !== input.businessId) {
      throw new KnowledgeError(
        "command_conflict",
        `commandId ${input.commandId} was already used for a different decision (${String(item.kind)} on ${String(item.business_id)})`,
      );
    }
    const detail = parseJson<Record<string, unknown>>(item.detail_json, {});
    const recorded = detail.requestFingerprint;
    if (typeof recorded === "string" && recorded !== fingerprint) {
      throw new KnowledgeError(
        "command_conflict",
        `commandId ${input.commandId} was already used for a different payload; altered replays are rejected, never answered from another subject`,
      );
    }
    if (String(item.outcome) === "rejected") {
      // A rejected decision replays as its typed rejection, never as a
      // successful result with absent fact/revision rows.
      throw rejectedReplayError(kind, detail);
    }
    const result = (detail.result ?? detail) as Record<string, unknown>;
    return { ...result, duplicate: true };
  }

  /**
   * Re-check a command binding inside the write transaction, after acquiring
   * the lock but before any mutation. A concurrent committer that landed
   * between the fast-path replay check and this transaction is observed
   * here: exact matches return the recorded outcome (true idempotent
   * replay), anything else rolls back with command_conflict. Callers must
   * invoke this first inside transact(); without it, a shared commandId
   * could authorize two different mutations while INSERT OR IGNORE hid the
   * conflicting audit row.
   */
  private requireFreshCommand(
    input: DecisionCommand,
    kind: DecisionKind,
    fingerprint: string,
  ): { recorded: Record<string, unknown> } | null {
    if (!input.commandId) return null;
    const found = this.store.db.prepare(
      "SELECT * FROM knowledge_decisions WHERE command_id = $id",
    ).get({ $id: input.commandId });
    if (!found) return null;
    const item = row(found);
    if (String(item.kind) !== kind || String(item.business_id) !== input.businessId) {
      throw new KnowledgeError(
        "command_conflict",
        `commandId ${input.commandId} was already used for a different decision (${String(item.kind)} on ${String(item.business_id)})`,
      );
    }
    const detail = parseJson<Record<string, unknown>>(item.detail_json, {});
    const recorded = detail.requestFingerprint;
    if (typeof recorded === "string" && recorded !== fingerprint) {
      throw new KnowledgeError(
        "command_conflict",
        `commandId ${input.commandId} was already used for a different payload; altered replays are rejected, never answered from another subject`,
      );
    }
    if (String(item.outcome) === "rejected") {
      throw rejectedReplayError(kind, detail);
    }
    const result = (detail.result ?? detail) as Record<string, unknown>;
    return { recorded: { ...result, duplicate: true } };
  }

  private recordDecision(
    input: DecisionCommand,
    kind: DecisionKind,
    outcome: "applied" | "duplicate" | "rejected",
    detail: Record<string, unknown>,
  ): void {
    const commandId = input.commandId ?? `kd_${createHash("sha256").update(canonical({ kind, ...detail, at: randomUUID() })).digest("hex").slice(0, 24)}`;
    this.store.db.prepare(
      `INSERT OR IGNORE INTO knowledge_decisions
        (command_id, kind, business_id, actor_kind, actor_id, outcome, detail_json, created_at)
       VALUES ($id, $kind, $businessId, $actorKind, $actorId, $outcome, $detail, $createdAt)`,
    ).run({
      $id: commandId, $kind: kind, $businessId: input.businessId,
      $actorKind: input.actor.kind, $actorId: input.actor.id,
      $outcome: outcome, $detail: JSON.stringify(detail), $createdAt: now(),
    });
  }

  private readCandidate(item: SqlRow): KnowledgeCandidate {
    return {
      id: String(item.id),
      businessId: String(item.business_id),
      accountId: item.account_id == null ? "" : String(item.account_id),
      key: String(item.key),
      subjectId: String(item.subject_id ?? ""),
      value: parseJson(item.value_json, {}),
      confidence: String(item.confidence) as CandidateConfidence,
      sourceReferences: parseJson(item.source_references_json, []),
      sourceRevision: item.source_revision == null ? undefined : String(item.source_revision),
      observedAt: String(item.observed_at),
      ingestedAt: String(item.ingested_at),
      status: String(item.status) as KnowledgeCandidate["status"],
      confirmedFactId: item.confirmed_fact_id == null ? undefined : String(item.confirmed_fact_id),
      note: item.note == null ? undefined : String(item.note),
    };
  }

  private readRevision(item: SqlRow): KnowledgeRevision {
    return {
      id: String(item.id),
      factId: String(item.fact_id),
      businessId: String(item.business_id),
      accountId: item.account_id == null ? "" : String(item.account_id),
      key: String(item.key),
      subjectId: String(item.subject_id ?? ""),
      revision: Number(item.revision),
      value: parseJson(item.value_json, {}),
      scope: String(item.scope) as FactScope,
      scopeId: item.scope_id == null ? undefined : String(item.scope_id),
      status: String(item.status) as KnowledgeRevision["status"],
      reviewState: String(item.review_state) as KnowledgeRevision["reviewState"],
      approvedBy: String(item.approved_by),
      approvedAt: String(item.approved_at),
      candidateId: item.candidate_id === null ? undefined : String(item.candidate_id),
      sourceReferences: parseJson(item.source_references_json, []),
    };
  }
}
