import type { DatabaseSync } from "node:sqlite";
import type {
  SourceEventKind,
  SourceRecordEnvelope,
} from "../server/sources/types.ts";
import {
  KnowledgeDeniedError,
  KnowledgeError,
  KnowledgeService,
} from "./service.ts";
import type {
  CandidateView,
  ConfirmResult,
} from "./service.ts";
import type {
  AddScopedExceptionInput,
  ConfirmCandidateInput,
  CorrectFactInput,
  KnowledgePort,
  KnowledgePortErrorCode,
  KnowledgePortHealth,
  KnowledgeQueryRequirements,
  KnowledgeQueryScope,
  ProposeCandidatesInput,
} from "./port.ts";
import { KnowledgePortError } from "./port.ts";
import type {
  ConfirmedFact,
} from "./types.ts";
import type { OffersKnowledgeSnapshot } from "./types.ts";

/**
 * ADR-008 labelled scripted implementation of the C04 KnowledgePort.
 *
 * Backed by the existing SQLite `KnowledgeService` (the prepared-business
 * authority boundary), plus a small source-version registry on the same
 * database handle so import/version/invalidation state survives restart.
 * Every result is labelled `prepared`: this port is the scripted stand-in
 * the native adapter must beat before live cutover — never live proof.
 *
 * Staleness blocking: `ingestSource` records observed source versions;
 * `invalidateSource` (deletion/revocation, delivered before dependent work
 * by the ADR-007 pipeline) marks derived pending candidates stale, flags
 * derived active revisions for review, and tombstones the registry row, so
 * a deleted source can never authorize through stale compiled memory.
 * `query`/`snapshotForOffer` withhold review-state and conflicted facts
 * and report `blocked` with explicit reasons instead of silent stale data.
 */

interface SourceRegistryRow {
  sourceKey: string;
  locator: string;
  version: string;
  observedAt: string;
  status: "active" | "deleted" | "revoked";
}

function row(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a SQLite row");
  }
  return value as Record<string, unknown>;
}

function mapKnowledgeError(error: unknown): never {
  if (error instanceof KnowledgePortError) throw error;
  if (error instanceof KnowledgeDeniedError) {
    throw new KnowledgePortError("denied", error.message);
  }
  if (error instanceof KnowledgeError) {
    const code = error.code as KnowledgePortErrorCode | string;
    const mapped: KnowledgePortErrorCode =
      code === "stale" || code === "stale_version" || code === "conflict"
        ? "stale"
        : code === "denied" || code === "command_conflict"
          ? "denied"
          : code === "cross_business"
            ? "cross_business"
            : code === "not_found"
              ? "not_found"
              : "invalid";
    throw new KnowledgePortError(mapped, error.message);
  }
  throw error;
}

export class PreparedKnowledgePort implements KnowledgePort {
  readonly kind = "prepared-scripted" as const;
  private readonly service: KnowledgeService;
  private readonly db: DatabaseSync;
  private readonly businessId: string;

  constructor(service: KnowledgeService, businessId: string) {
    this.service = service;
    this.businessId = businessId;
    this.db = service.database;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_port_sources (
        source_key TEXT PRIMARY KEY,
        business_id TEXT NOT NULL DEFAULT '',
        locator TEXT NOT NULL,
        version TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'deleted', 'revoked'))
      );
    `);
    const columns = this.db.prepare("PRAGMA table_info(knowledge_port_sources)").all() as Record<string, unknown>[];
    if (!columns.some((column) => String(column.name) === "business_id")) {
      this.db.exec("ALTER TABLE knowledge_port_sources ADD COLUMN business_id TEXT NOT NULL DEFAULT ''");
    }
  }

  private assertBusiness(scopeBusinessId: string): void {
    if (scopeBusinessId !== this.businessId) {
      throw new KnowledgePortError(
        "cross_business",
        `prepared port is bound to business ${this.businessId}; ${scopeBusinessId} is denied (one-business boundary)`,
      );
    }
  }

  private assertOwner(input: { actor: { kind: string; id: string } }, action: string): void {
    if (input.actor.kind !== "owner") {
      throw new KnowledgePortError(
        "denied",
        `${action} requires an explicit owner command; actor kind ${JSON.stringify(input.actor.kind)} can never confirm commercial facts (retrieved instructions are inert data)`,
      );
    }
  }

  // ---------- ADR-007 consumer seam: import / version / invalidation ----------

  ingestSource(record: SourceRecordEnvelope): void {
    // The envelope carries no business id: the ADR-007 pipeline binds one
    // port instance per (business, account) scope, so this port's bound
    // business is the scope. Registry rows are namespaced by it.
    const locator = record.provenance[0]?.locator ?? record.externalId;
    this.db
      .prepare(
        `INSERT INTO knowledge_port_sources (source_key, business_id, locator, version, observed_at, status)
           VALUES ($key, $business, $locator, $version, $observedAt, 'active')
         ON CONFLICT (source_key) DO UPDATE SET
           business_id = excluded.business_id, locator = excluded.locator, version = excluded.version,
           observed_at = excluded.observed_at, status = 'active'`,
      )
      .run({
        $key: record.sourceKey,
        $business: this.businessId,
        $locator: locator,
        $version: record.contentVersion,
        $observedAt: record.observedAt,
      });
  }

  invalidateSource(sourceKey: string, reason: SourceEventKind): void {
    const existing = this.db.prepare(
      "SELECT * FROM knowledge_port_sources WHERE source_key = $key AND business_id = $business",
    ).get({ $key: sourceKey, $business: this.businessId });
    const locator = existing !== undefined && existing !== null ? String(row(existing).locator) : sourceKey;
    const status = reason === "versioned" ? "active" : reason === "revoked" ? "revoked" : "deleted";
    this.db
      .prepare(
        `INSERT INTO knowledge_port_sources (source_key, business_id, locator, version, observed_at, status)
           VALUES ($key, $business, $locator, $version, $observedAt, $status)
         ON CONFLICT (source_key) DO UPDATE SET status = excluded.status, observed_at = excluded.observed_at`,
      )
      .run({
        $key: sourceKey,
        $business: this.businessId,
        $locator: locator,
        $version: existing !== undefined && existing !== null ? String(row(existing).version) : "",
        $observedAt: new Date().toISOString(),
        $status: status,
      });
    if (status === "active") return;
    // Purge derived searchable content: pending candidates from this source
    // go stale (they can never be confirmed), and active revisions derived
    // from it are flagged for review so snapshots withhold them. Minimal
    // tombstones (registry row + revision rows + decision audit) are
    // retained to explain existing commitments.
    const locators = [sourceKey, locator];
    for (const match of locators) {
      this.db
        .prepare(
          `UPDATE knowledge_candidates SET status = 'stale'
             WHERE business_id = $business AND source_locator = $locator AND status = 'pending'`,
        )
        .run({ $business: this.businessId, $locator: match });
      this.db
        .prepare(
          `UPDATE knowledge_revisions SET review_state = 'review'
             WHERE status = 'active' AND business_id = $business AND candidate_id IN (
               SELECT id FROM knowledge_candidates
                 WHERE business_id = $business AND source_locator = $locator
             )`,
        )
        .run({ $business: this.businessId, $locator: match });
    }
  }

  /** Registry read for migration export and staleness evidence. */
  listTrackedSources(): SourceRegistryRow[] {
    const rows = this.db.prepare(
      "SELECT * FROM knowledge_port_sources WHERE business_id = $business ORDER BY source_key",
    ).all({ $business: this.businessId }) as unknown[];
    return rows.map((value) => {
      const item = row(value);
      return {
        sourceKey: String(item.source_key),
        locator: String(item.locator),
        version: String(item.version),
        observedAt: String(item.observed_at),
        status: item.status as SourceRegistryRow["status"],
      };
    });
  }

  // ---------- owner authority (delegated, error-mapped) ----------

  proposeCandidates(input: ProposeCandidatesInput): CandidateView[] {
    this.assertBusiness(input.businessId);
    try {
      return this.service
        .listCandidates(input.businessId)
        .filter(
          (candidate) =>
            candidate.status === "pending" &&
            candidate.sourceReferences.some((ref) => ref.locator === input.sourceLocator),
        );
    } catch (error) {
      mapKnowledgeError(error);
    }
  }

  confirmCandidate(input: ConfirmCandidateInput): ConfirmResult {
    this.assertOwner(input, "confirmCandidate");
    this.assertBusiness(input.businessId);
    try {
      return this.service.confirmCandidate({ businessId: input.businessId, actor: input.actor, candidateId: input.candidateId });
    } catch (error) {
      mapKnowledgeError(error);
    }
  }

  correctFact(input: CorrectFactInput): ConfirmResult {
    this.assertOwner(input, "correctFact");
    this.assertBusiness(input.businessId);
    try {
      return this.service.correctFact({
        businessId: input.businessId,
        actor: input.actor,
        key: input.key,
        ...(input.subjectId === undefined ? {} : { subjectId: input.subjectId }),
        ...(input.accountId === undefined ? {} : { accountId: input.accountId }),
        expectedRevision: input.expectedRevision,
        value: input.value,
        ...(input.sourceReferences === undefined ? {} : { sourceReferences: input.sourceReferences }),
      });
    } catch (error) {
      mapKnowledgeError(error);
    }
  }

  addScopedException(input: AddScopedExceptionInput): ConfirmResult {
    this.assertOwner(input, "addScopedException");
    this.assertBusiness(input.businessId);
    try {
      return this.service.addScopedException({
        businessId: input.businessId,
        actor: input.actor,
        policyId: input.policyId,
        effect: input.effect,
        scope: input.scope,
        scopeId: input.scopeId,
        ...(input.subjectId === undefined ? {} : { subjectId: input.subjectId }),
        value: input.value,
      });
    } catch (error) {
      mapKnowledgeError(error);
    }
  }

  // ---------- scoped reads with staleness blocking ----------

  query(scope: KnowledgeQueryScope, requirements: KnowledgeQueryRequirements = {}): {
    scope: KnowledgeQueryScope;
    facts: ConfirmedFact[];
    withheld: Array<{ factId: string; key: string; subjectId: string; reason: string }>;
    blocked: boolean;
    blockReasons: string[];
  } {
    this.assertBusiness(scope.businessId);
    const snapshot = this.service.snapshotForOffers(scope.businessId);
    const withheldIds = new Set(snapshot.withheld.map((entry) => entry.factId));
    let facts = this.service.listFacts(scope.businessId);
    if (scope.accountId !== undefined) {
      facts = facts.filter((fact) => fact.accountId === scope.accountId);
    }
    if (requirements.keys !== undefined) {
      const keys = new Set(requirements.keys);
      facts = facts.filter((fact) => keys.has(fact.key));
    }
    if (requirements.includeScoped === false) {
      facts = facts.filter((fact) => fact.scope === "global");
    }
    if (scope.bookingId !== undefined) {
      facts = facts.filter(
        (fact) => fact.scope === "global" || (fact.scope === "booking" && fact.scopeId === scope.bookingId),
      );
    }
    if (scope.customerId !== undefined) {
      facts = facts.filter(
        (fact) => fact.scope === "global" || (fact.scope === "customer" && fact.scopeId === scope.customerId),
      );
    }
    const withheld = snapshot.withheld.filter((entry) => {
      const fact = this.service.listFacts(scope.businessId).find((candidate) => candidate.id === entry.factId);
      if (!fact) return false;
      if (scope.accountId !== undefined && fact.accountId !== scope.accountId) return false;
      if (requirements.keys !== undefined && !requirements.keys.includes(fact.key)) return false;
      return true;
    });
    // Blocking is per applicable fact group (key+subject+scope): a group
    // blocks only when NONE of its facts is usable. A resolved conflict
    // still withholds the losing line, but the pinned winner authorizes —
    // so the decision is unblocked. An unresolved conflict or a
    // source-changed fact withholds every member and blocks.
    const groupOf = (key: string, subjectId: string, scopeValue: string, scopeId?: string): string =>
      `${key}	${subjectId}	${scopeValue}	${scopeId ?? ""}`;
    const usableGroups = new Set(
      facts
        .filter((fact) => !withheldIds.has(fact.id))
        .map((fact) => groupOf(fact.key, fact.subjectId, fact.scope, fact.scopeId)),
    );
    const allFacts = this.service.listFacts(scope.businessId);
    const blockReasons: string[] = [];
    for (const entry of withheld) {
      const fact = allFacts.find((candidate) => candidate.id === entry.factId);
      const group = fact ? groupOf(fact.key, fact.subjectId, fact.scope, fact.scopeId) : `${entry.key}	${entry.subjectId}	global	`;
      if (!usableGroups.has(group)) {
        blockReasons.push(`${entry.key}/${entry.subjectId || "(global)"} is withheld: ${entry.reason}`);
      }
    }
    const deadSources = this.listTrackedSources().filter((entry) => entry.status !== "active");
    if (deadSources.length > 0 && blockReasons.length > 0) {
      blockReasons.push(
        `sources ${deadSources.map((entry) => `${entry.sourceKey}(${entry.status})`).join(", ")} invalidated dependent facts; reconfirm before authorizing`,
      );
    }
    return { scope, facts: facts.filter((fact) => !withheldIds.has(fact.id)), withheld, blocked: blockReasons.length > 0, blockReasons };
  }

  snapshotForOffer(scope: KnowledgeQueryScope): OffersKnowledgeSnapshot {
    this.assertBusiness(scope.businessId);
    const snapshot = this.service.snapshotForOffers(scope.businessId);
    if (scope.bookingId === undefined && scope.customerId === undefined) return snapshot;
    const facts = snapshot.facts.filter((fact) => {
      if (fact.key === "business") return true;
      const full = this.service.listFacts(scope.businessId).find((candidate) => candidate.id === fact.id);
      if (!full) return false;
      if (full.scope === "global") return true;
      if (scope.bookingId !== undefined && full.scope === "booking" && full.scopeId === scope.bookingId) return true;
      if (scope.customerId !== undefined && full.scope === "customer" && full.scopeId === scope.customerId) return true;
      return false;
    });
    return { ...snapshot, facts };
  }

  health(): KnowledgePortHealth {
    try {
      this.service.listFacts(this.businessId);
      return {
        kind: "prepared-scripted",
        available: true,
        detail: "prepared scripted port over the SQLite knowledge service (labelled simulator; not live proof)",
        provenance: "prepared",
      };
    } catch (error) {
      return {
        kind: "prepared-scripted",
        available: false,
        detail: `prepared store unreadable: ${error instanceof Error ? error.message : String(error)} (unavailable, not empty)`,
        provenance: "prepared",
      };
    }
  }
}
