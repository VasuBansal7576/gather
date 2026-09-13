import type { SourceReference } from "../domain/contracts.ts";

/**
 * Delivery-readiness contracts (G12 confirmation readiness, G13 handoff).
 *
 * The evaluator is a pure, booking-specific function over an immutable
 * accepted proposal identity, a configured business policy, and typed
 * trusted verifier outputs. Raw external events are kept separate and can
 * never verify a condition; neither can an arbitrary `verified: true`
 * boolean. Only outputs from the explicit trusted resolver boundary count.
 */

export type ConditionKind =
  | "customer_acceptance"
  | "deposit"
  | "availability"
  | "resource_commitment";

export type ConditionStatus = "verified" | "missing" | "stale" | "conflicting";

export type Provenance = "live" | "demo" | "mixed" | "none";

export interface DepositRequirement {
  requiredAmountCents: number;
  currency: string;
}

export interface ResourceRequirement {
  requiredResourceIds: string[];
}

export interface ConditionConfig {
  kind: ConditionKind;
  /** Required conditions block readiness; optional ones are reported only. */
  required: boolean;
  deposit?: DepositRequirement;
  resources?: ResourceRequirement;
  /** Evidence older than this is stale. Defaults apply when omitted. */
  maxAgeMs?: number;
}

export interface ConfirmationPolicy {
  businessId: string;
  conditions: ConditionConfig[];
}

export interface BookingSnapshot {
  id: string;
  businessId: string;
  /** Booking lifecycle status; cancelled bookings can never be ready. */
  status: string;
  eventName: string;
  startAt?: string;
  endAt?: string;
  guestCount?: number;
  notes?: string;
  sourceReferences: SourceReference[];
}

export interface AcceptedProposal {
  bookingId: string;
  businessId: string;
  proposalVersion: number;
  proposalFingerprint: string;
  kind: string;
  payload: Record<string, unknown>;
  sourceReferences: SourceReference[];
}

/** Trusted resolver boundary. Each condition accepts only its resolvers. */
export type TrustedResolver =
  | "acceptance_record"
  | "deposit_ledger"
  | "calendar_provider"
  | "resource_registry"
  | "owner_authority";

export interface AcceptanceRecord {
  resolver: "acceptance_record";
  bookingId: string;
  proposalVersion: number;
  proposalFingerprint: string;
  acceptedAt: string;
  acceptedBy?: string;
  revoked?: boolean;
  sourceRefs: SourceReference[];
}

export interface DepositReceipt {
  resolver: "deposit_ledger";
  bookingId: string;
  receiptId: string;
  amountCents: number;
  currency: string;
  status: "settled" | "pending" | "rejected" | "refunded" | "revoked";
  /** Partial refund against this receipt; net settled is amount minus refunds. */
  refundedCents?: number;
  observedAt: string;
  sourceRefs: SourceReference[];
}

export interface AvailabilityAttestation {
  resolver: "calendar_provider";
  calendarId: string;
  startAt: string;
  endAt: string;
  available: boolean;
  holdId?: string;
  holdValidUntil?: string;
  observedAt: string;
  sourceRefs: SourceReference[];
}

export interface ResourceCommitment {
  resolver: "resource_registry";
  bookingId: string;
  resourceId: string;
  status: "committed" | "requested" | "rejected" | "revoked" | "expired";
  validUntil?: string;
  responsible?: string;
  observedAt: string;
  sourceRefs: SourceReference[];
}

export type VerifierOutput =
  | AcceptanceRecord
  | DepositReceipt
  | AvailabilityAttestation
  | ResourceCommitment;

/**
 * Scoped owner waiver. Only a persisted waiver naming the business,
 * booking, condition, and proposal version — recorded under an owner
 * identity — can stand in for evidence. A payload boolean never waives.
 */
export interface OwnerWaiver {
  resolver: "owner_authority";
  businessId: string;
  bookingId: string;
  condition: ConditionKind;
  proposalVersion: number;
  waivedBy: string;
  waivedAt: string;
  reason: string;
  sourceRefs: SourceReference[];
}

/** Raw external signals (payment links, email claims, requests). Never verifying. */
export interface RawExternalEvent {
  eventId: string;
  sourceKind: string;
  locator: string;
  fictional?: boolean;
  observedAt: string;
  summary: string;
}

export interface ResourceResult {
  resourceId: string;
  status: ConditionStatus;
  detail: string;
  responsible?: string;
}

export interface ConditionResult {
  kind: ConditionKind;
  required: boolean;
  status: ConditionStatus;
  detail: string;
  evidence: SourceReference[];
  waived: boolean;
  resources?: ResourceResult[];
}

export interface ReadinessBinding {
  businessId: string;
  bookingId: string;
  proposalVersion: number;
  proposalFingerprint: string;
}

export interface ReadinessDecision {
  binding: ReadinessBinding;
  evaluatedAt: string;
  conditions: ConditionResult[];
  ready: boolean;
  /** Ready AND every binding evidence item is live (non-fictional). */
  liveReady: boolean;
  provenance: Provenance;
  blockedBy: string[];
  ignoredRawSignals: number;
  rejectedEvidence: string[];
}

export interface EvaluateReadinessInput {
  nowIso: string;
  businessId: string;
  booking: BookingSnapshot;
  proposal: AcceptedProposal;
  policy: ConfirmationPolicy;
  evidence: VerifierOutput[];
  rawSignals?: RawExternalEvent[];
  waivers?: OwnerWaiver[];
}

export interface HandoffService {
  name: string;
  detail?: string;
  source: SourceReference[];
}

export interface HandoffResponsibility {
  party: string;
  task: string;
  source: SourceReference[];
}

export interface HandoffResource {
  resourceId: string;
  status: ConditionStatus;
  responsible?: string;
  source: SourceReference[];
}

export interface OperationalHandoff {
  binding: ReadinessBinding;
  provenance: Provenance;
  event: {
    name: string;
    startAt?: string;
    endAt?: string;
    guestCount?: number;
  };
  services: HandoffService[];
  responsibilities: HandoffResponsibility[];
  resources: HandoffResource[];
  outstanding: string[];
  ready: boolean;
}

export interface BuildHandoffInput {
  decision: ReadinessDecision;
  booking: BookingSnapshot;
  proposal: AcceptedProposal;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isIso(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));
}

function isSourceRef(value: unknown): value is SourceReference {
  if (!isRecord(value)) return false;
  if (typeof value.locator !== "string" || value.locator.length === 0) return false;
  if (typeof value.kind !== "string" || value.kind.length === 0) return false;
  if (value.fictional !== undefined && typeof value.fictional !== "boolean") return false;
  if (value.label !== undefined && typeof value.label !== "string") return false;
  return true;
}

function assertRefs(value: unknown, what: string): asserts value is SourceReference[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every(isSourceRef)) {
    throw new Error(`${what} must be a non-empty array of source references`);
  }
}

const CONDITION_KINDS: ReadonlySet<string> = new Set([
  "customer_acceptance",
  "deposit",
  "availability",
  "resource_commitment",
]);

export function assertConditionConfig(value: unknown, index: number): asserts value is ConditionConfig {
  if (!isRecord(value)) throw new Error(`policy.conditions[${index}] must be an object`);
  if (typeof value.kind !== "string" || !CONDITION_KINDS.has(value.kind)) {
    throw new Error(`policy.conditions[${index}].kind must be a known condition kind`);
  }
  if (typeof value.required !== "boolean") throw new Error(`policy.conditions[${index}].required must be a boolean`);
  if (value.maxAgeMs !== undefined) {
    if (typeof value.maxAgeMs !== "number" || !Number.isInteger(value.maxAgeMs) || value.maxAgeMs <= 0) {
      throw new Error(`policy.conditions[${index}].maxAgeMs must be a positive integer when present`);
    }
  }
  if (value.kind === "deposit") {
    if (!isRecord(value.deposit)) throw new Error(`deposit condition requires a deposit requirement`);
    const amount = value.deposit.requiredAmountCents;
    if (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0) {
      throw new Error(`deposit.requiredAmountCents must be a positive integer`);
    }
    if (!isNonEmptyString(value.deposit.currency)) throw new Error(`deposit.currency must be a non-empty string`);
  }
  if (value.kind === "resource_commitment") {
    if (!isRecord(value.resources)) throw new Error(`resource_commitment condition requires a resource requirement`);
    const ids: unknown = value.resources.requiredResourceIds;
    if (!Array.isArray(ids) || ids.length === 0 || !ids.every(isNonEmptyString)) {
      throw new Error(`resources.requiredResourceIds must be a non-empty array of resource ids`);
    }
  }
}

export function assertValidEvaluateInput(value: unknown): asserts value is EvaluateReadinessInput {
  if (!isRecord(value)) throw new Error("evaluate input must be an object");
  if (!isIso(value.nowIso)) throw new Error("nowIso must be an ISO-8601 timestamp");
  if (!isNonEmptyString(value.businessId)) throw new Error("businessId must be a non-empty string");
  if (!isRecord(value.booking)) throw new Error("booking must be an object");
  if (!isNonEmptyString(value.booking.id)) throw new Error("booking.id must be a non-empty string");
  if (!isNonEmptyString(value.booking.businessId)) throw new Error("booking.businessId must be a non-empty string");
  if (!isNonEmptyString(value.booking.status)) throw new Error("booking.status must be a non-empty string");
  if (!isNonEmptyString(value.booking.eventName)) throw new Error("booking.eventName must be a non-empty string");
  for (const field of ["startAt", "endAt"] as const) {
    const entry: unknown = value.booking[field];
    if (entry !== undefined && !isIso(entry)) throw new Error(`booking.${field} must be an ISO-8601 timestamp when present`);
  }
  if (!Array.isArray(value.booking.sourceReferences) || !value.booking.sourceReferences.every(isSourceRef)) {
    throw new Error("booking.sourceReferences must be an array of source references");
  }
  if (!isRecord(value.proposal)) throw new Error("proposal must be an object");
  if (!isNonEmptyString(value.proposal.bookingId)) throw new Error("proposal.bookingId must be a non-empty string");
  if (!isNonEmptyString(value.proposal.businessId)) throw new Error("proposal.businessId must be a non-empty string");
  if (typeof value.proposal.proposalVersion !== "number" || !Number.isInteger(value.proposal.proposalVersion) || value.proposal.proposalVersion <= 0) {
    throw new Error("proposal.proposalVersion must be a positive integer");
  }
  if (!isNonEmptyString(value.proposal.proposalFingerprint)) throw new Error("proposal.proposalFingerprint must be a non-empty string");
  if (!isNonEmptyString(value.proposal.kind)) throw new Error("proposal.kind must be a non-empty string");
  if (!isRecord(value.proposal.payload)) throw new Error("proposal.payload must be an object");
  assertRefs(value.proposal.sourceReferences, "proposal.sourceReferences");
  if (!isRecord(value.policy)) throw new Error("policy must be an object");
  if (!isNonEmptyString(value.policy.businessId)) throw new Error("policy.businessId must be a non-empty string");
  if (!Array.isArray(value.policy.conditions) || value.policy.conditions.length === 0) {
    throw new Error("policy.conditions must be a non-empty array");
  }
  value.policy.conditions.forEach(assertConditionConfig);
  if (!Array.isArray(value.evidence)) throw new Error("evidence must be an array");
  for (const item of value.evidence) {
    if (!isRecord(item)) throw new Error("every evidence item must be an object (untrusted shapes are rejected, not thrown, only when well-formed objects)");
  }
  if (value.rawSignals !== undefined) {
    if (!Array.isArray(value.rawSignals)) throw new Error("rawSignals must be an array when present");
    for (const signal of value.rawSignals) {
      if (!isRecord(signal) || !isNonEmptyString(signal.eventId) || !isIso(signal.observedAt)) {
        throw new Error("every raw signal must carry an eventId and observedAt");
      }
    }
  }
  if (value.waivers !== undefined && !Array.isArray(value.waivers)) throw new Error("waivers must be an array when present");
}

export function assertValidHandoffInput(value: unknown): asserts value is BuildHandoffInput {
  if (!isRecord(value)) throw new Error("handoff input must be an object");
  if (!isRecord(value.decision)) throw new Error("decision must be an object");
  if (!isRecord(value.decision.binding)) throw new Error("decision.binding must be an object");
  if (!Array.isArray(value.decision.conditions)) throw new Error("decision.conditions must be an array");
  if (!isRecord(value.booking) || !isRecord(value.proposal)) throw new Error("booking and proposal must be objects");
}
