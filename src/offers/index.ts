/**
 * Source-backed, business-aware offer preparation.
 *
 * CALLER CONTRACT (what the host/runtime must do):
 * - Validate the raw inquiry upstream and pass InquiryRequirements with a
 *   real `validator` identity and `validatedAt` timestamp. This module
 *   re-validates shape (input is `unknown` at the boundary) but does not
 *   parse free text.
 * - Fetch availability FRESH immediately before calling: `observedAt` must
 *   not postdate `asOf`, `asOf` must not postdate the trusted `preparedAt`
 *   clock, and `preparedAt - observedAt` must fit `maxFreshnessMs`, or the
 *   result is `blocked` with `stale_availability` instead of an offer.
 *   Recheck again immediately before any provisional hold; this result is
 *   never a hold.
 * - Supply attributable business knowledge (spaces, policies, scoped
 *   exceptions, price book, services) with source references. Unknown
 *   prices/costs are `null`, never invented. Facts below `verified`
 *   confidence, or with empty provenance, yield explicit owner decisions.
 * - Attest cost-ledger completeness via `priceBook.costsComplete`: an
 *   empty or partial ledger without this source-backed flag keeps
 *   profitability `unknown` (genuine zero-cost businesses attest `true`).
 * - Bind owner approval to the exact returned `version` + `fingerprint`
 *   and only when `status` is `feasible` (ready-to-send). Any change to
 *   dates, price, space, or terms requires a new call with an incremented
 *   `requestedVersion` and the previous `supersedesFingerprint`.
 * - Never present an `alternatives`/`blocked` result, an `unknown`
 *   profitability, or a decision-pending candidate as ready or profitable.
 *
 * WHAT THIS MODULE GUARANTEES:
 * - Pure and deterministic: no I/O, no network, no LLM, no new graph.
 * - Capacity, service, policy (with scoped-only exceptions), space-bound
 *   availability with busy-overlap blocks, pricing floor, margin, and
 *   positive-profit (> 0) boundaries are enforced from evidence.
 * - Floor permission is independent of cost knowledge; margin permission
 *   and profit claims need a complete ledger.
 * - Alternatives preserve the requested duration (same clock time when
 *   evidenced, otherwise flagged as a time shift); budget binds every
 *   candidate, never just the primary.
 * - Money renders in proper currency units via `formatMoney`.
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
export {
  prepareOffer,
  readAvailabilityEvidence,
  readBusinessKnowledge,
  readCostLine,
  readInquiryRequirements,
  readPolicyRule,
  readPriceLine,
  readServiceCapability,
  readSpaceKnowledge,
  readScopedExceptionValue,
  readTimezone,
  formatMoney,
  formatDuration,
  canonicalizeValue,
} from "./prepare.ts";
export type { AdaptableFact, AdaptedKnowledge, AdaptScope, AvailabilityBuildInput } from "./adapters.ts";
export { adaptBusinessFacts, buildAvailabilityEvidence } from "./adapters.ts";
