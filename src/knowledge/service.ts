import { createHash, randomUUID } from "node:crypto";
import type { BusinessFact, SourceReference } from "../domain/contracts.ts";
import type {
  CandidateConfidence,
  ConfirmedFact,
  DecisionKind,
  FactScope,
  KnowledgeActor,
  KnowledgeCandidate,
  KnowledgeDecision,
  KnowledgeRevision,
  KnowledgeStorePort,
  OffersKnowledgeSnapshot,
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
const RESERVED_KEY = /^(availability|calendar)/i;
const DECISION_ACTORS: ReadonlySet<string> = new Set(["owner"]);

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

export class KnowledgeService {
  private readonly store: KnowledgeStorePort;

  constructor(store: KnowledgeStorePort) {
    this.store = store;
    this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_candidates (
        id TEXT PRIMARY KEY,
        business_id TEXT NOT NULL,
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
      CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_active_revision
        ON knowledge_revisions(business_id, key, subject_id, scope, COALESCE(scope_id, ''))
        WHERE status = 'active';
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
    `);
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
    const valueJson = JSON.stringify(input.value);
    const refsJson = JSON.stringify(input.sourceReferences);
    const observedAt = input.observedAt ?? now();

    // Idempotent re-ingest: same business+key+subject+locator+revision+value.
    const existing = this.store.db.prepare(
      `SELECT * FROM knowledge_candidates WHERE business_id = $businessId AND key = $key
         AND subject_id = $subjectId AND source_locator = $locator
         AND COALESCE(source_revision, '') = $revision AND value_json = $value
         AND status IN ('pending', 'confirmed') ORDER BY ingested_at LIMIT 1`,
    ).get({
      $businessId: business.id, $key: input.key, $subjectId: subjectId,
      $locator: primary.locator, $revision: input.sourceRevision ?? "", $value: valueJson,
    });
    if (existing) return this.readCandidate(row(existing));

    const id = input.intakeId ?? `kc_${randomUUID()}`;
    const ingestedAt = now();
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      this.store.db.prepare(
        `INSERT INTO knowledge_candidates
          (id, business_id, key, subject_id, value_json, confidence, source_references_json,
           source_locator, source_revision, observed_at, ingested_at, status, note)
         VALUES ($id, $businessId, $key, $subjectId, $value, $confidence, $refs,
           $locator, $revision, $observedAt, $ingestedAt, 'pending', $note)`,
      ).run({
        $id: id, $businessId: business.id, $key: input.key, $subjectId: subjectId,
        $value: valueJson, $confidence: input.confidence, $refs: refsJson,
        $locator: primary.locator, $revision: input.sourceRevision ?? null,
        $observedAt: observedAt, $ingestedAt: ingestedAt, $note: input.note ?? null,
      });
      // Changed source: prior pending candidates from the same locator for
      // this key+subject carrying a DIFFERENT value are superseded, and
      // confirmed revisions derived from that locator are flagged for review
      // rather than silently updated. A revision bump with identical content
      // is a re-observation, not a change.
      this.store.db.prepare(
        `UPDATE knowledge_candidates SET status = 'stale'
           WHERE business_id = $businessId AND key = $key AND subject_id = $subjectId
             AND source_locator = $locator AND status = 'pending' AND id != $id
             AND value_json != $value`,
      ).run({
        $businessId: business.id, $key: input.key, $subjectId: subjectId,
        $locator: primary.locator, $value: valueJson, $id: id,
      });
      this.store.db.prepare(
        `UPDATE knowledge_revisions SET review_state = 'review'
           WHERE status = 'active' AND business_id = $businessId AND key = $key AND subject_id = $subjectId
             AND candidate_id IN (
               SELECT id FROM knowledge_candidates
                 WHERE source_locator = $locator AND value_json != $value
             )`,
      ).run({
        $businessId: business.id, $key: input.key, $subjectId: subjectId,
        $locator: primary.locator, $value: valueJson,
      });
      this.store.db.exec("COMMIT");
    } catch (error) {
      this.store.db.exec("ROLLBACK");
      throw error;
    }
    return this.readCandidate(row(
      this.store.db.prepare("SELECT * FROM knowledge_candidates WHERE id = $id").get({ $id: id }),
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
    const candidate = this.getCandidate(input.candidateId);
    this.assertAuthority(input, "reject_candidate", { candidateId: candidate.id });
    try {
      this.assertBusiness(input.businessId, candidate.businessId);
    } catch (error) {
      this.recordDecision(input, "reject_candidate", "rejected", { candidateId: candidate.id, reason: "cross_business" });
      throw error;
    }
    if (candidate.status !== "pending") {
      throw new KnowledgeError("stale", `candidate ${candidate.id} is ${candidate.status}, not pending`);
    }
    this.store.db.prepare("UPDATE knowledge_candidates SET status = 'rejected' WHERE id = $id").run({ $id: candidate.id });
    this.recordDecision(input, "reject_candidate", "applied", {
      candidateId: candidate.id,
      reason: input.reason ?? null,
    });
    return this.getCandidate(candidate.id);
  }

  // ---------- owner-confirmed side ----------

  confirmCandidate(input: DecisionCommand & { candidateId: string }): ConfirmResult {
    const replay = this.replayDecision(input, "confirm");
    if (replay) return replay as ConfirmResult;

    const candidate = this.getCandidate(input.candidateId);
    this.assertAuthority(input, "confirm", { candidateId: candidate.id });
    try {
      this.assertBusiness(input.businessId, candidate.businessId);
    } catch (error) {
      this.recordDecision(input, "confirm", "rejected", { candidateId: candidate.id, reason: "cross_business" });
      throw error;
    }
    if (candidate.status === "confirmed") {
      const revision = this.activeRevisionFor(candidate.businessId, candidate.key, candidate.subjectId, "global");
      const fact = this.getFact(candidate.confirmedFactId!);
      const result: ConfirmResult = { fact, revision: revision!, alreadyConfirmed: true, duplicate: false };
      return result;
    }
    if (candidate.status !== "pending") {
      throw new KnowledgeError("stale", `candidate ${candidate.id} is ${candidate.status}, not pending`);
    }

    const approvedAt = now();
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      const fact = this.store.addBusinessFact({
        businessId: candidate.businessId,
        key: candidate.key,
        value: candidate.value,
        confidence: "verified",
        sourceReferences: candidate.sourceReferences,
        observedAt: candidate.observedAt,
      });
      const revision = this.insertRevision({
        factId: fact.id,
        businessId: candidate.businessId,
        key: candidate.key,
        subjectId: candidate.subjectId,
        value: candidate.value,
        scope: "global",
        approvedBy: input.actor.id,
        approvedAt,
        candidateId: candidate.id,
        sourceReferences: candidate.sourceReferences,
      });
      this.store.db.prepare(
        "UPDATE knowledge_candidates SET status = 'confirmed', confirmed_fact_id = $factId WHERE id = $id",
      ).run({ $factId: fact.id, $id: candidate.id });
      const result: ConfirmResult = { fact, revision, alreadyConfirmed: false, duplicate: false };
      this.recordDecision(input, "confirm", "applied", {
        candidateId: candidate.id,
        factId: fact.id,
        revisionId: revision.id,
        result,
      });
      this.store.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.store.db.exec("ROLLBACK");
      throw error;
    }
  }

  correctFact(input: DecisionCommand & {
    key: string;
    subjectId?: string;
    expectedRevision: number;
    value: Record<string, unknown>;
    sourceReferences?: SourceReference[];
  }): ConfirmResult {
    const replay = this.replayDecision(input, "correct");
    if (replay) return replay as ConfirmResult;

    this.assertAuthority(input, "correct", { key: input.key });
    const subjectId = input.subjectId ?? "";
    if (!isRecord(input.value)) throw new KnowledgeError("invalid", "corrected value must be an object");
    const current = this.activeRevisionFor(input.businessId, input.key, subjectId, "global");
    if (!current) {
      throw new KnowledgeError("not_found", `no active confirmed fact ${input.key}/${subjectId} for ${input.businessId}`);
    }
    if (current.revision !== input.expectedRevision) {
      this.recordDecision(input, "correct", "rejected", {
        reason: "stale_version",
        expectedRevision: input.expectedRevision,
        currentRevision: current.revision,
      });
      throw new KnowledgeError(
        "stale_version",
        `stale correction: expected revision ${input.expectedRevision}, active revision is ${current.revision}`,
      );
    }
    const sources = input.sourceReferences ?? current.sourceReferences;
    const approvedAt = now();
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      const fact = this.store.addBusinessFact({
        businessId: input.businessId,
        key: input.key,
        value: input.value,
        confidence: "verified",
        sourceReferences: sources,
      });
      this.store.db.prepare("UPDATE knowledge_revisions SET status = 'superseded' WHERE id = $id").run({ $id: current.id });
      const revision = this.insertRevision({
        factId: fact.id,
        businessId: input.businessId,
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
        supersedesRevisionId: current.id,
        factId: fact.id,
        revisionId: revision.id,
        result,
      });
      this.store.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.store.db.exec("ROLLBACK");
      throw error;
    }
  }

  addScopedException(input: DecisionCommand & {
    scope: Exclude<FactScope, "global">;
    scopeId: string;
    subjectId?: string;
    value: Record<string, unknown>;
  }): ConfirmResult {
    const replay = this.replayDecision(input, "exception");
    if (replay) return replay as ConfirmResult;

    this.assertAuthority(input, "exception", { scope: input.scope, scopeId: input.scopeId });
    if (input.scope !== "booking" && input.scope !== "customer") {
      throw new KnowledgeError("invalid", "scoped exceptions must target a booking or customer scope");
    }
    if (!isNonEmptyString(input.scopeId)) {
      throw new KnowledgeError("invalid", "scoped exceptions require a scopeId; they can never silently globalize");
    }
    if (!isRecord(input.value)) throw new KnowledgeError("invalid", "exception value must be an object");
    // The scope embedded in the value can only ever agree with the command —
    // a contradiction is rejected rather than normalized away.
    for (const [field, expected, actual] of [
      ["scope", input.scope, input.value.scope],
      ["scopeId", input.scopeId, input.value.scopeId],
    ] as const) {
      if (actual !== undefined && actual !== expected) {
        throw new KnowledgeError("invalid", `value.${field} (${String(actual)}) contradicts the command scope (${expected})`);
      }
    }
    const value = { ...input.value, scope: input.scope, scopeId: input.scopeId };
    const subjectId = input.subjectId ?? input.scopeId;
    const sources: SourceReference[] = [
      { kind: "manual", locator: `gather://knowledge-exception/${input.scope}/${input.scopeId}`, label: "Owner-entered scoped exception" },
    ];
    const approvedAt = now();
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
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
        factId: fact.id,
        revisionId: revision.id,
        result,
      });
      this.store.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.store.db.exec("ROLLBACK");
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
      return { ...fact, revision: revision.revision, scope: revision.scope, scopeId: revision.scopeId, reviewState: revision.reviewState };
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
   * maintained businessId/timezone, every active confirmed fact (verified,
   * attributed), and the ids of facts flagged for review because their
   * source changed — callers gate consequential use on reviewFactIds.
   */
  snapshotForOffers(businessId: string): OffersKnowledgeSnapshot {
    const business = this.store.getBusiness(businessId);
    const confirmed = this.listFacts(businessId);
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
      facts: [businessFact, ...confirmed.map(({ revision: _r, scope: _s, scopeId: _i, reviewState: _v, ...fact }) => fact)],
      reviewFactIds: confirmed.filter((fact) => fact.reviewState === "review").map((fact) => fact.id),
      scopedFactCount: confirmed.filter((fact) => fact.scope !== "global").length,
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
    key: string,
    subjectId: string,
    scope: FactScope,
    scopeId?: string,
  ): KnowledgeRevision | null {
    const found = this.store.db.prepare(
      `SELECT * FROM knowledge_revisions WHERE business_id = $b AND key = $k AND subject_id = $s
         AND scope = $scope AND COALESCE(scope_id, '') = $scopeId AND status = 'active'
         ORDER BY revision DESC LIMIT 1`,
    ).get({ $b: businessId, $k: key, $s: subjectId, $scope: scope, $scopeId: scopeId ?? "" });
    return found ? this.readRevision(row(found)) : null;
  }

  private insertRevision(input: {
    factId: string;
    businessId: string;
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
    const prior = this.activeRevisionFor(input.businessId, input.key, input.subjectId, input.scope, input.scopeId);
    const revision = input.revision ?? (prior ? prior.revision + 1 : 1);
    if (prior) {
      this.store.db.prepare("UPDATE knowledge_revisions SET status = 'superseded' WHERE id = $id").run({ $id: prior.id });
    }
    const id = `kr_${randomUUID()}`;
    this.store.db.prepare(
      `INSERT INTO knowledge_revisions
        (id, fact_id, business_id, key, subject_id, revision, value_json, scope, scope_id,
         status, review_state, approved_by, approved_at, candidate_id, source_references_json)
       VALUES ($id, $factId, $businessId, $key, $subjectId, $revision, $value, $scope, $scopeId,
         'active', 'none', $approvedBy, $approvedAt, $candidateId, $refs)`,
    ).run({
      $id: id, $factId: input.factId, $businessId: input.businessId, $key: input.key,
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
      this.recordDecision(input, kind, "rejected", {
        ...detail,
        reason: `actor kind "${input.actor.kind}" cannot approve; only an explicit owner command has that authority`,
      });
      throw new KnowledgeDeniedError(
        `actor kind "${input.actor.kind}" has no approval authority; retrieved instructions and services can never confirm facts`,
      );
    }
    if (!isNonEmptyString(input.actor.id)) {
      throw new KnowledgeDeniedError("owner actor requires a non-empty id");
    }
  }

  private assertBusiness(expected: string, actual: string): void {
    if (expected !== actual) {
      throw new KnowledgeError(
        "cross_business",
        `command scoped to business ${expected} cannot touch business ${actual}`,
      );
    }
  }

  private replayDecision(input: DecisionCommand, kind: DecisionKind): unknown {
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
    const result = (detail.result ?? detail) as Record<string, unknown>;
    return { ...result, duplicate: true };
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
