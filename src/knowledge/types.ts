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
  scope: FactScope;
  scopeId?: string;
  reviewState: "none" | "review";
}

export type DecisionKind = "confirm" | "correct" | "exception" | "reject_candidate";
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

/** Confirmed-fact snapshot shaped for the offers adapter's adaptBusinessFacts input. */
export interface OffersKnowledgeSnapshot {
  businessId: string;
  timezone: string;
  generatedAt: ISODateTime;
  facts: BusinessFact[];
  /** Confirmed facts whose source changed since confirmation; callers should gate consequential use. */
  reviewFactIds: string[];
  /** Count of active scoped (non-global) facts included. */
  scopedFactCount: number;
}
