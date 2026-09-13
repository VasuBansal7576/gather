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
 * Public operator contract. Inquiry content arrives in the request and is
 * validated server-side; availability evidence is always host-fetched and
 * can never arrive in the request. All timestamps are ISO strings; all
 * fixture content keeps its source labels (the operator never relabels
 * provenance).
 */

export interface OperatorPrepareEmail {
  to: string[];
  subject: string;
  body: string;
}

/** Raw inquiry content supplied for server-side validation (never trusted as-is). */
export interface OperatorInquiryContent {
  inquiryId?: unknown;
  eventType?: unknown;
  startAt?: unknown;
  endAt?: unknown;
  guestCount?: unknown;
  serviceRequirements?: unknown;
  budgetCents?: unknown;
  customerId?: unknown;
  preferredSpaceId?: unknown;
  sourceReferences?: unknown;
}

export interface OperatorPrepareRequest {
  /** Explicit booking identity under test. Optional sourceKey resolves via the active identity link. */
  bookingId: string;
  sourceKey?: string;
  /** Inquiry content to validate server-side (validator identity is always host-derived). */
  inquiry: OperatorInquiryContent;
  /** Explicit hold calendar. Fresh evidence is fetched for exactly this calendar. */
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

/** Mode correlated from the actual availability port and accepted facts. */
export interface OperatorMode {
  kind: "demo" | "live";
  label: string;
  fictional: boolean;
  simulated: boolean;
}

export interface OperatorPrepareResult {
  mode: OperatorMode;
  bookingId: string;
  businessId: string;
  availabilityFresh: boolean;
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
