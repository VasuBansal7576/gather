/**
 * Booking-specific cross-app identity resolver for PRD G04.
 *
 * Small service API, ready for later ingestion/UI integration. All state
 * lives in the injected GatherStore's SQLite database
 * (`booking_identity_*` tables) — no new database, graph, or wiki.
 *
 * Trust summary: weak hints and untrusted message claims only ever produce
 * `needs_decision` candidates; only a host-verified provider-correlated
 * receipt or an explicit trusted owner decision can bind.
 */
export {
  findCandidates,
  IdentityError,
  proposeBookingIdentity,
  recordOwnerIdentityDecision,
  recordVerifiedIdentityLink,
  unlinkIdentityLink,
  buildSourceKey,
  decodeSourceKey,
  fingerprintCandidates,
  type IdentityCandidate,
  type IdentityComponents,
  type IdentityErrorCode,
  type IdentityHints,
  type ProposeIdentityResult,
  type ProvenanceMode,
  type VerifiedReceipt,
} from "./service.ts";
export {
  appendIdentityAudit,
  ensureBookingIdentityTables,
  getActiveIdentityLink,
  getIdentityDecisionById,
  getIdentityLink,
  getOpenIdentityDecision,
  listIdentityAudit,
  listIdentityDecisions,
  type IdentityAuditRow,
  type IdentityDecisionRow,
  type IdentityLinkOrigin,
  type IdentityLinkRow,
  type IdentityLinkStatus,
} from "./store.ts";
export { normalizeComponents } from "./source-key.ts";
