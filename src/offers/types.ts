import type { SourceReference } from "../domain/contracts.ts";

/**
 * Offer preparation contracts.
 *
 * This module is a pure, deterministic boundary: it takes validated inquiry
 * requirements, attributable business knowledge, and fresh availability
 * evidence, and produces versionable offer candidates (or explicit
 * missing/conflicting information and owner decisions). It performs no I/O,
 * calls no connectors, grants no approval, and invents no prices or costs.
 */

export type FactConfidence = "verified" | "probable" | "uncertain";

export interface InquiryRequirements {
  inquiryId: string;
  businessId: string;
  eventType: string;
  startAt: string;
  endAt: string;
  guestCount: number;
  serviceRequirements: string[];
  budgetCents?: {
    min?: number;
    max?: number;
  };
  customerId?: string;
  bookingId?: string;
  preferredSpaceId?: string;
  sourceReferences: SourceReference[];
  /** Upstream validation marker: who validated the raw inquiry and when. */
  validatedAt: string;
  validator: string;
}

export interface SpaceKnowledge {
  spaceId: string;
  name: string;
  capacityMin: number;
  capacityMax: number;
  confidence: FactConfidence;
  sourceReferences: SourceReference[];
}

export type PolicyEffect = "allow" | "deny" | "require_owner_decision";

export interface PolicyRule {
  policyId: string;
  statement: string;
  effect: PolicyEffect;
  /** Empty or absent means the policy applies to all event types. */
  appliesToEventTypes?: string[];
  /** Empty or absent means the policy applies regardless of service. */
  appliesToServices?: string[];
  minGuests?: number;
  maxGuests?: number;
  confidence: FactConfidence;
  sourceReferences: SourceReference[];
}

export interface ExceptionScope {
  inquiryId?: string;
  customerId?: string;
  bookingId?: string;
}

export interface ScopedException {
  exceptionId: string;
  policyId: string;
  scope: ExceptionScope;
  effect: "allow" | "require_owner_decision";
  approvedBy: string;
  sourceReferences: SourceReference[];
}

export type PricingBasis = "per_event" | "per_guest" | "per_hour";

export interface PriceLine {
  lineId: string;
  label: string;
  pricingBasis: PricingBasis;
  /** Null means the unit price is unknown: it must never be invented. */
  unitCents: number | null;
  confidence: FactConfidence;
  sourceReferences: SourceReference[];
}

export interface CostLine {
  costId: string;
  label: string;
  /** Null means the cost is unknown or incomplete. */
  amountCents: number | null;
  confidence: FactConfidence;
  sourceReferences: SourceReference[];
}

export interface PriceBook {
  currency: string;
  lines: PriceLine[];
  costs: CostLine[];
  /**
   * Source-backed attestation that the cost ledger is complete. An empty
   * costs array (or any null amount) means UNKNOWN costs unless this is
   * true — including genuine zero-cost businesses, which must attest that
   * explicitly rather than relying on an empty list.
   */
  costsComplete: boolean;
  /** Null means no floor is configured. */
  floorCents: number | null;
  /** Null means no margin target is configured. Basis points, e.g. 2000 = 20%. */
  minMarginBps: number | null;
  /** Null means no deposit rule is configured. Basis points. */
  depositBps: number | null;
  sourceReferences: SourceReference[];
}

export interface ServiceCapability {
  serviceId: string;
  label: string;
  available: boolean;
  sourceReferences: SourceReference[];
}

export interface BusinessKnowledge {
  businessId: string;
  /** IANA business timezone, used for local-time alternative placement. */
  timezone: string;
  spaces: SpaceKnowledge[];
  policies: PolicyRule[];
  scopedExceptions: ScopedException[];
  priceBook: PriceBook;
  services: ServiceCapability[];
  sourceReferences: SourceReference[];
}

export interface AvailabilitySlot {
  startAt: string;
  endAt: string;
  available: boolean;
  reason?: string;
  /**
   * Explicit scope: either venue-wide evidence or evidence for named spaces.
   * There is no silent default — a slot is venue-wide only with
   * `venueWide: true`, otherwise `spaceIds` must name its spaces, so Room A
   * evidence can never authorize Room B (and Room B busy never blocks A).
   */
  venueWide?: boolean;
  spaceIds?: string[];
  sourceReferences: SourceReference[];
}

export interface AvailabilityEvidence {
  calendarId: string;
  /** When the provider data was observed. */
  observedAt: string;
  /** Caller clock at preparation time; used for the freshness check. */
  asOf: string;
  /** Evidence older than this is stale and blocks offer preparation. */
  maxFreshnessMs: number;
  slots: AvailabilitySlot[];
  sourceReferences: SourceReference[];
}

export interface PrepareOfferInput {
  inquiry: InquiryRequirements;
  knowledge: BusinessKnowledge;
  availability: AvailabilityEvidence;
  /** Caller-supplied clock so the result is deterministic for fixed inputs. */
  preparedAt: string;
  requestedVersion?: number;
  supersedesFingerprint?: string;
}

export interface OfferLine {
  lineId: string;
  label: string;
  pricingBasis: PricingBasis;
  quantity: number;
  unitCents: number | null;
  lineTotalCents: number | null;
  unknownUnit: boolean;
}

export type OfferRank = "primary" | "alternative";

export interface OfferCandidate {
  offerId: string;
  version: number;
  rank: OfferRank;
  startAt: string;
  endAt: string;
  spaceId: string;
  spaceName: string;
  guestCount: number;
  currency: string;
  lines: OfferLine[];
  /** Null when any priced line has an unknown unit. */
  totalCents: number | null;
  totalKnown: boolean;
  /** Null when the total or the deposit rule is unknown. */
  depositCents: number | null;
  unknownCostIds: string[];
  unknownPriceIds: string[];
  /** True only when every price and cost is known and floor/margin pass. */
  profitabilityClaimed: boolean;
  consequences: string[];
  sources: SourceReference[];
  fingerprint: string;
  supersedesFingerprint?: string;
  note?: string;
}

export interface MissingItem {
  code: string;
  field?: string;
  detail: string;
  ownerQuestion: string;
}

export interface ConflictItem {
  code: string;
  detail: string;
  involvedPolicyIds?: string[];
  evidence: SourceReference[];
}

export interface OwnerDecisionRequest {
  code: string;
  question: string;
  context: string;
  evidence: SourceReference[];
}

export type ProfitabilityClaim =
  | "profitable"
  | "below_floor"
  | "below_margin"
  | "unprofitable"
  | "unknown";

export interface ProfitabilityAssessment {
  claim: ProfitabilityClaim;
  totalCents: number | null;
  costTotalCents: number | null;
  floorCents: number | null;
  marginBps: number | null;
  minMarginBps: number | null;
  unknownCostIds: string[];
  unknownPriceIds: string[];
  explanation: string;
}

export interface EvidenceBundle {
  inquiry: SourceReference[];
  business: SourceReference[];
  availability: SourceReference[];
  pricing: SourceReference[];
  /** True when every cited source is marked fictional fixture data. */
  allFictional: boolean;
  provenanceNote: string;
}

export type OfferStatus = "feasible" | "alternatives" | "blocked";

export interface OfferPreparationResult {
  inquiryId: string;
  businessId: string;
  preparedAt: string;
  status: OfferStatus;
  version: number;
  /** Binds this exact result for downstream exact-version approval. */
  fingerprint: string;
  supersedesFingerprint?: string;
  offers: OfferCandidate[];
  primaryOffer?: OfferCandidate;
  missingInformation: MissingItem[];
  conflicts: ConflictItem[];
  ownerDecisions: OwnerDecisionRequest[];
  profitability: ProfitabilityAssessment;
  evidence: EvidenceBundle;
  /** Concrete consequences a reviewer or approval step must see. */
  consequences: string[];
}
