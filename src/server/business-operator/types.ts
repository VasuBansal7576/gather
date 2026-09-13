import type {
  BusinessFact,
  ProposedAction,
  SourceReference,
} from "../../domain/contracts.ts";
import type {
  KnowledgeCandidate,
  KnowledgeDecision,
  OffersKnowledgeSnapshot,
} from "../../knowledge/types.ts";
import type { ConfirmResult } from "../../knowledge/service.ts";
import type { OfferPreparationResult } from "../../offers/index.ts";
import type { ProposalConsequencesDTO } from "../dto.ts";

/**
 * Public operator contract. All timestamps are ISO strings; all fixture
 * content must stay explicitly labeled by its sources (the operator never
 * relabels provenance).
 */

export interface OperatorPrepareEmail {
  to: string[];
  subject: string;
  body: string;
}

export interface OperatorPrepareRequest {
  /** Explicit booking identity under test. Optional sourceKey resolves via the active identity link. */
  bookingId: string;
  sourceKey?: string;
  /** Host-validated inquiry requirements (validator/validatedAt identify the validator). */
  inquiry: unknown;
  /** Freshly fetched, account-scoped calendar observations for the hold calendar. */
  availability: unknown;
  /** Explicit hold calendar. Must equal availability.calendarId. */
  calendarId: string;
  /** Explicit hold expiry (future-dated). Never defaulted. */
  expiresAt?: string;
  /** Explicit approved email content. Never invented. */
  email?: OperatorPrepareEmail;
  requestedVersion?: number;
  supersedesFingerprint?: string;
}

export interface ProposalMissingItem {
  code: string;
  detail: string;
}

export interface PersistedProposal {
  action: ProposedAction;
  consequences: ProposalConsequencesDTO;
  /** True when an identical proposal already existed (idempotent reuse). */
  reused: boolean;
}

export interface OperatorPrepareResult {
  demo: true;
  mode: { kind: "demo"; label: "DEMO ONLY"; fictional: true; simulated: true };
  bookingId: string;
  businessId: string;
  offer: OfferPreparationResult;
  proposal: PersistedProposal | null;
  /** Present when the offer cannot be persisted yet; resolve instead of sending. */
  missingForProposal: ProposalMissingItem[];
  notice: string;
}

export interface OperatorKnowledgeFacts {
  businessId: string;
  facts: BusinessFact[];
}

export type { KnowledgeCandidate, KnowledgeDecision, OffersKnowledgeSnapshot, ConfirmResult };
export type { SourceReference };
