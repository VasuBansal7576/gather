import type { BusinessFact } from "../domain/contracts.ts";
import type {
  SourceEventKind,
  SourceRecordEnvelope,
} from "../server/sources/types.ts";
import type {
  CandidateView,
  ConfirmResult,
  DecisionCommand,
  IntakeCandidateInput,
} from "./service.ts";
import type {
  ConfirmedFact,
  FactScope,
  KnowledgeActor,
  KnowledgeRevision,
  OffersKnowledgeSnapshot,
} from "./types.ts";

/**
 * ADR-008 / C04 thin KnowledgePort.
 *
 * This is a Gather interface, NOT a claim that OpenClaw exposes RPCs with
 * these names. Exactly one authority is active per mode (C04: no dual-write
 * competing policy database). Prepared mode binds the labelled scripted
 * implementation (`src/knowledge/prepared.ts`); live binds the native
 * recall/wiki adapter (`src/knowledge/native.ts`) only after the selection
 * gate passes. Consumers (ADR-005/010) program against this port, never
 * against a concrete store.
 *
 * `ingestSource` / `invalidateSource` double as the ADR-007
 * `SourceKnowledgeConsumer` seam: the source pipeline emits C02 envelopes
 * and deletion/revocation events into whichever port is active.
 */

export type KnowledgePortKind = "prepared-scripted" | "native-live";

export type KnowledgePortErrorCode =
  | "blocked_native_unavailable"
  | "stale"
  | "conflicted"
  | "denied"
  | "not_found"
  | "invalid"
  | "cross_business";

export class KnowledgePortError extends Error {
  readonly code: KnowledgePortErrorCode;
  constructor(code: KnowledgePortErrorCode, message: string) {
    super(message);
    this.name = "KnowledgePortError";
    this.code = code;
  }
}

/** Business/customer/booking applicability scope for reads. */
export interface KnowledgeQueryScope {
  businessId: string;
  /** Account line to read; absent means all lines (conflicts still block). */
  accountId?: string;
  bookingId?: string;
  customerId?: string;
}

export interface KnowledgeQueryRequirements {
  /** Restrict to these fact keys; absent means all known keys. */
  keys?: string[];
  /** Include booking/customer scoped exceptions (default true). */
  includeScoped?: boolean;
}

export interface KnowledgeQueryResult {
  scope: KnowledgeQueryScope;
  facts: ConfirmedFact[];
  /** Facts withheld from consequential use with explicit reasons. */
  withheld: Array<{ factId: string; key: string; subjectId: string; reason: string }>;
  /** True when unresolved conflicts/stale sources block the affected decision. */
  blocked: boolean;
  blockReasons: string[];
}

export interface ProposeCandidatesInput {
  businessId: string;
  /** Source locator (e.g. fixture/drive locator) whose pending candidates to list. */
  sourceLocator: string;
}

export interface ConfirmCandidateInput extends DecisionCommand {
  candidateId: string;
}

export interface CorrectFactInput extends DecisionCommand {
  key: string;
  subjectId?: string;
  accountId?: string;
  expectedRevision: number;
  value: Record<string, unknown>;
  sourceReferences?: IntakeCandidateInput["sourceReferences"];
}

export interface AddScopedExceptionInput extends DecisionCommand {
  policyId: string;
  effect: "allow" | "require_owner_decision";
  scope: Exclude<FactScope, "global">;
  scopeId: string;
  subjectId?: string;
  value: Record<string, unknown>;
}

export interface KnowledgePortHealth {
  kind: KnowledgePortKind;
  /** False means unavailable — never an empty result masquerading as no facts. */
  available: boolean;
  detail: string;
  /** Provenance label of every result this port emits. */
  provenance: "prepared" | "scripted-runtime" | "real-runtime" | "live-provider";
  /** Native capability evidence (native-live only; prepared reports not-applicable). */
  capability?: string;
}

export interface KnowledgePort {
  readonly kind: KnowledgePortKind;

  /** ADR-007 consumer seam: record a source version / observe content. */
  ingestSource(record: SourceRecordEnvelope): void | Promise<void>;
  /** ADR-007 consumer seam: source deletion/revocation arrives before dependent work. */
  invalidateSource(sourceKey: string, reason: SourceEventKind): void | Promise<void>;

  /** Pending candidates attributable to one source locator. */
  proposeCandidates(input: ProposeCandidatesInput): CandidateView[];

  /** Owner-only confirmation of a pending candidate. */
  confirmCandidate(input: ConfirmCandidateInput): ConfirmResult;
  /** Owner-only versioned correction (expectedRevision must equal active). */
  correctFact(input: CorrectFactInput): ConfirmResult;
  /** Owner-only scoped exception (booking/customer scope + scopeId required). */
  addScopedException(input: AddScopedExceptionInput): ConfirmResult;

  /** Scoped read with freshness/conflict blocking (never silent stale). */
  query(scope: KnowledgeQueryScope, requirements?: KnowledgeQueryRequirements): KnowledgeQueryResult;
  /** Offer-ready snapshot: verified, attributed, not-under-review facts only. */
  snapshotForOffer(scope: KnowledgeQueryScope): OffersKnowledgeSnapshot;

  /** Liveness that never depends on model execution. */
  health(): KnowledgePortHealth;
}

export type {
  BusinessFact,
  CandidateView,
  ConfirmedFact,
  FactScope,
  IntakeCandidateInput,
  KnowledgeActor,
  KnowledgeRevision,
  OffersKnowledgeSnapshot,
  SourceEventKind,
  SourceRecordEnvelope,
};
