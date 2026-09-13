import type { DatabaseSync } from "node:sqlite";
import type { Business, BusinessFact, ISODateTime, SourceReference } from "../domain/contracts.ts";

/**
 * Business-knowledge boundary types.
 *
 * Trust model: extracted content (documents, messages) is untrusted input —
 * it can only ever arrive as `probable` or `uncertain` candidates and can
 * never mint a verified fact. Only an explicit owner actor can confirm,
 * correct, or scope an exception. Confirmed facts are persisted through the
 * shared GatherStore business_facts path; knowledge_* tables track only the
 * candidate/revision/decision lifecycle around them.
 */

/** Structural subset of GatherStore this module needs. GatherStore satisfies it. */
export interface KnowledgeStorePort {
  readonly db: DatabaseSync;
  getBusiness(id: string): Business;
  addBusinessFact(
    input: Omit<BusinessFact, "id" | "observedAt"> & { id?: string; observedAt?: string },
  ): BusinessFact;
  listBusinessFacts(businessId: string): BusinessFact[];
}

/** Extraction output may never claim verified; only an owner decision produces verified facts. */
export type CandidateConfidence = "probable" | "uncertain";

export type CandidateStatus = "pending" | "confirmed" | "rejected" | "stale";

/** Global facts apply business-wide; scoped exceptions never silently globalize. */
export type FactScope = "global" | "booking" | "customer";

/**
 * Who is asking. Only "owner" can confirm, correct, or add exceptions.
 * "content" marks instructions retrieved from connected documents/messages —
 * that authority class can never approve anything, including itself.
 */
export type KnowledgeActorKind = "owner" | "service" | "agent" | "content";

export interface KnowledgeActor {
  kind: KnowledgeActorKind;
  id: string;
}

export interface KnowledgeCandidate {
  id: string;
  businessId: string;
  /**
   * Server-fixed account identity of the observation (host-pinned, never
   * model-asserted). Dedupe, supersede detection, conflicts, and revision
   * lineage are all scoped by it; legacy rows read back as "".
   */
  accountId: string;
  key: string;
  /**
   * Stable identity of the thing the fact is about (e.g. a spaceId or
   * lineId). Candidates for the same key+subjectId with different values
   * conflict; different subjectIds are different facts entirely.
   */
  subjectId: string;
  value: Record<string, unknown>;
  confidence: CandidateConfidence;
  sourceReferences: SourceReference[];
  /** Version/fingerprint of the source document or message, when known. */
  sourceRevision?: string;
  observedAt: ISODateTime;
  ingestedAt: ISODateTime;
  status: CandidateStatus;
  confirmedFactId?: string;
  note?: string;
}

export interface KnowledgeRevision {
  id: string;
  factId: string;
  businessId: string;
  /** Account line this revision belongs to; active uniqueness is per account. */
  accountId: string;
  key: string;
  subjectId: string;
  revision: number;
  value: Record<string, unknown>;
  scope: FactScope;
  scopeId?: string;
  status: "active" | "superseded";
  /** "review" means a changed source invalidated assumptions; raise it, do not silently change approved pricing. */
  reviewState: "none" | "review";
  approvedBy: string;
  approvedAt: ISODateTime;
  candidateId?: string;
  sourceReferences: SourceReference[];
}

/** A confirmed fact enriched with its versioning/scope metadata. */
export interface ConfirmedFact extends BusinessFact {
  revision: number;
  /** Account line this fact was confirmed on (mirrors the revision row). */
  accountId: string;
  /** Stable identity of the thing the fact is about (mirrors the revision row). */
  subjectId: string;
  scope: FactScope;
  scopeId?: string;
  reviewState: "none" | "review";
}

export type DecisionKind = "confirm" | "correct" | "exception" | "reject_candidate" | "resolve_conflict";

/**
 * One account line's live revision inside a business-wide conflict group.
 * Lineage stays account-distinct: rows are never merged, only compared.
 */
export interface ConflictRevision {
  revisionId: string;
  factId: string;
  accountId: string;
  revision: number;
  value: Record<string, unknown>;
  reviewState: "none" | "review";
  approvedBy: string;
  approvedAt: ISODateTime;
}

/**
 * A business-wide conflict: active revisions for the same applicable fact
 * (key + subject + scope) carry different values on different account
 * lines. Status is derived, never stored: "conflicted" until an owner
 * resolution pins a winner for exactly the current revision set, and back
 * to "conflicted" the moment any line moves (new revision id set).
 */
export interface BusinessConflict {
  key: string;
  subjectId: string;
  scope: FactScope;
  scopeId?: string;
  revisions: ConflictRevision[];
  status: "conflicted" | "resolved";
  /** Governing resolution id when status is resolved. */
  resolutionId?: string;
  /** Winning revision id when status is resolved. */
  winningRevisionId?: string;
}

/** Same value confirmed on several account lines: presented once, provenance kept. */
export interface AgreementGroup {
  key: string;
  subjectId: string;
  keptFactId: string;
  agreedFactIds: string[];
}
export type DecisionOutcome = "applied" | "duplicate" | "rejected";

export interface KnowledgeDecision {
  commandId: string;
  kind: DecisionKind;
  businessId: string;
  actorKind: KnowledgeActorKind;
  actorId: string;
  outcome: DecisionOutcome;
  detail: Record<string, unknown>;
  createdAt: ISODateTime;
}

/** A confirmed fact withheld from consequential use pending reconfirmation. */
export interface WithheldFact {
  factId: string;
  key: string;
  subjectId: string;
  /** Explicit decision reason — review flags are never silently ignorable. */
  reason: string;
}

/** Confirmed-fact snapshot shaped for the offers adapter's adaptBusinessFacts input. */
export interface OffersKnowledgeSnapshot {
  businessId: string;
  timezone: string;
  generatedAt: ISODateTime;
  /**
   * Offer-ready facts: verified, attributed, registry-keyed, and NOT under
   * review. Source-changed facts are withheld here until reconfirmed, so a
   * consumer feeding facts straight into adaptBusinessFacts cannot use
   * stale pricing.
   */
  facts: BusinessFact[];
  /** Ids withheld for review (same set as `withheld`, kept for compatibility). */
  reviewFactIds: string[];
  /** Withheld facts with explicit reasons. */
  withheld: WithheldFact[];
  /** Count of active scoped (non-global) facts included. */
  scopedFactCount: number;
  /**
   * Agreement groups deduped for presentation: one kept fact per identical
   * value across account lines. Provenance is NOT erased — every line's
   * revision row remains readable via listFacts/listConflicts.
   */
  agreements: AgreementGroup[];
}
