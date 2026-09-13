/**
 * Source-backed, business-aware offer preparation.
 *
 * CALLER CONTRACT (what the host/runtime must do):
 * - Validate the raw inquiry upstream and pass InquiryRequirements with a
 *   real `validator` identity and `validatedAt` timestamp. This module
 *   re-validates shape (input is `unknown` at the boundary) but does not
 *   parse free text.
 * - Fetch availability FRESH immediately before calling: `observedAt` must
 *   be within `maxFreshnessMs` of `asOf`, or the result is `blocked` with
 *   `stale_availability` instead of an offer. Recheck again immediately
 *   before any provisional hold; this result is never a hold.
 * - Supply attributable business knowledge (spaces, policies, scoped
 *   exceptions, price book, services) with source references. Unknown or
 *   incomplete prices/costs are expressed as `null`, never invented.
 * - Bind owner approval to the exact returned `version` + `fingerprint`.
 *   Any change to dates, price, space, or terms requires a new call with an
 *   incremented `requestedVersion` and the previous `supersedesFingerprint`.
 * - Never present a `profitability.claim` of `unknown` as profitable, and
 *   never send an `alternatives`/`blocked` result as an offer.
 * - Pass a caller clock as `preparedAt` for deterministic, replayable
 *   results: identical inputs always produce byte-identical results.
 *
 * WHAT THIS MODULE GUARANTEES:
 * - Pure and deterministic: no I/O, no network, no LLM, no new graph.
 * - Capacity, service, policy (with scoped-only exceptions), pricing floor,
 *   and margin boundaries are enforced from evidence.
 * - Every consequential number cites its sources in `evidence` and each
 *   candidate carries concrete `consequences` for approval review.
 */

export type {
  AvailabilityEvidence,
  AvailabilitySlot,
  BusinessKnowledge,
  ConflictItem,
  CostLine,
  EvidenceBundle,
  ExceptionScope,
  FactConfidence,
  InquiryRequirements,
  MissingItem,
  OfferCandidate,
  OfferLine,
  OfferPreparationResult,
  OfferRank,
  OfferStatus,
  OwnerDecisionRequest,
  PolicyEffect,
  PolicyRule,
  PrepareOfferInput,
  PriceBook,
  PriceLine,
  PricingBasis,
  ProfitabilityAssessment,
  ProfitabilityClaim,
  ScopedException,
  ServiceCapability,
  SpaceKnowledge,
} from "./types.ts";
export { prepareOffer, readAvailabilityEvidence, readBusinessKnowledge, readInquiryRequirements } from "./prepare.ts";
export type { AdaptableFact, AdaptedKnowledge, AvailabilityBuildInput } from "./adapters.ts";
export { adaptBusinessFacts, buildAvailabilityEvidence } from "./adapters.ts";
