import { assertConditionConfig, assertValidEvaluateInput } from "./contracts.ts";
import { evaluateReadiness } from "./readiness.ts";
import type {
  AcceptanceRecord,
  AvailabilityAttestation,
  ConfirmationPolicy,
  DepositReceipt,
  EvaluateReadinessInput,
  OwnerWaiver,
  RawExternalEvent,
  ReadinessDecision,
  ResourceCommitment,
} from "./contracts.ts";
import type { AcceptedProposal, BookingSnapshot } from "./contracts.ts";

export interface AcceptanceQuery {
  businessId: string;
  bookingId: string;
  proposalVersion: number;
  proposalFingerprint: string;
}

export interface DepositQuery {
  businessId: string;
  bookingId: string;
}

export interface AvailabilityQuery {
  businessId: string;
  calendarId: string;
  startAt: string;
  endAt: string;
}

export interface ResourceQuery {
  businessId: string;
  bookingId: string;
  proposalVersion: number;
  proposalFingerprint: string;
  resourceIds: string[];
}

export interface WaiverQuery {
  businessId: string;
  bookingId: string;
}

export interface PolicyQuery {
  businessId: string;
}

/**
 * Host-injected verifier boundary. A resolver kind string inside evidence
 * is not itself trusted, so raw input never reaches the evaluator: the
 * host fetches and verifies persisted/provider proofs for the exact
 * binding, and only those validated outputs are evaluated. Raw external
 * claims cannot choose `owner_authority`, mark a receipt verified, waive a
 * condition, or supply the policy — policy and waivers are sourced from the
 * trusted host as well. No live provider auth is needed to implement
 * against this interface; tests inject fakes and assert exact
 * business/booking/version queries.
 */
export interface DeliveryVerifiers {
  loadPolicy(query: PolicyQuery): Promise<ConfirmationPolicy>;
  fetchAcceptance(query: AcceptanceQuery): Promise<AcceptanceRecord[]>;
  fetchDepositReceipts(query: DepositQuery): Promise<DepositReceipt[]>;
  fetchAvailability(query: AvailabilityQuery): Promise<AvailabilityAttestation[]>;
  fetchResourceCommitments(query: ResourceQuery): Promise<ResourceCommitment[]>;
  fetchWaivers(query: WaiverQuery): Promise<OwnerWaiver[]>;
}

export interface BookingReadinessQuery {
  nowIso: string;
  businessId: string;
  booking: BookingSnapshot;
  proposal: AcceptedProposal;
  verifiers: DeliveryVerifiers;
  rawSignals?: RawExternalEvent[];
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

function assertValidBookingQuery(value: unknown): asserts value is BookingReadinessQuery {
  if (!isRecord(value)) throw new Error("booking readiness query must be an object");
  if (!isIso(value.nowIso)) throw new Error("nowIso must be an ISO-8601 timestamp");
  if (!isNonEmptyString(value.businessId)) throw new Error("businessId must be a non-empty string");
  if (!isRecord(value.booking)) throw new Error("booking must be an object");
  if (!isNonEmptyString(value.booking.id)) throw new Error("booking.id must be a non-empty string");
  if (!isNonEmptyString(value.booking.businessId)) throw new Error("booking.businessId must be a non-empty string");
  if (!isNonEmptyString(value.booking.status)) throw new Error("booking.status must be a non-empty string");
  if (!isNonEmptyString(value.booking.eventName)) throw new Error("booking.eventName must be a non-empty string");
  if (!isRecord(value.proposal)) throw new Error("proposal must be an object");
  if (!isNonEmptyString(value.proposal.bookingId)) throw new Error("proposal.bookingId must be a non-empty string");
  if (!isNonEmptyString(value.proposal.businessId)) throw new Error("proposal.businessId must be a non-empty string");
  if (typeof value.proposal.proposalVersion !== "number" || !Number.isInteger(value.proposal.proposalVersion)) {
    throw new Error("proposal.proposalVersion must be an integer");
  }
  if (!isNonEmptyString(value.proposal.proposalFingerprint)) throw new Error("proposal.proposalFingerprint must be a non-empty string");
  if (!isRecord(value.verifiers)) throw new Error("verifiers must be a host-injected verifier set");
  for (const name of ["loadPolicy", "fetchAcceptance", "fetchDepositReceipts", "fetchAvailability", "fetchResourceCommitments", "fetchWaivers"] as const) {
    if (typeof value.verifiers[name] !== "function") throw new Error(`verifiers.${name} must be a host-injected function`);
  }
  if (value.rawSignals !== undefined && !Array.isArray(value.rawSignals)) throw new Error("rawSignals must be an array when present");
}

function assertValidPolicy(value: unknown): asserts value is ConfirmationPolicy {
  if (!isRecord(value)) throw new Error("host policy must be an object");
  if (!isNonEmptyString(value.businessId)) throw new Error("host policy must carry a businessId");
  if (!Array.isArray(value.conditions) || value.conditions.length === 0) {
    throw new Error("host policy must carry a non-empty conditions array");
  }
  value.conditions.forEach(assertConditionConfig);
}

function asArray<T>(value: unknown, name: string): T[] {
  if (!Array.isArray(value)) throw new Error(`host verifier ${name} must return an array`);
  return value as T[];
}

/**
 * Host-boundary ingress for readiness. Fetches the policy and every proof
 * for the exact business/booking/version binding through injected
 * verifiers, then evaluates the validated outputs. A failing verifier
 * fails closed: its evidence set is empty (blocking readiness) and the
 * failure is recorded in `rejectedEvidence`.
 */
export async function evaluateBookingReadiness(raw: unknown): Promise<ReadinessDecision> {
  assertValidBookingQuery(raw);
  const input: BookingReadinessQuery = raw;

  if (input.booking.businessId !== input.businessId || input.proposal.businessId !== input.businessId) {
    throw new Error("Binding mismatch: booking and proposal must belong to the evaluated business");
  }
  if (input.proposal.bookingId !== input.booking.id) {
    throw new Error("Binding mismatch: proposal does not belong to the evaluated booking");
  }

  const rejectedEvidence: string[] = [];
  async function guarded<T>(name: string, run: () => Promise<T[]>): Promise<T[]> {
    try {
      return asArray<T>(await run(), name);
    } catch (error) {
      rejectedEvidence.push(`host verifier ${name} failed: ${error instanceof Error ? error.message : "unknown error"}`);
      return [];
    }
  }

  const policyRaw: unknown = await input.verifiers.loadPolicy({ businessId: input.businessId }).catch((error: unknown) => {
    throw new Error(`Host policy load failed: ${error instanceof Error ? error.message : "unknown error"}`);
  });
  assertValidPolicy(policyRaw);
  if (policyRaw.businessId !== input.businessId) {
    throw new Error("Binding mismatch: host policy belongs to a different business");
  }

  const startAt: unknown = input.proposal.payload.startAt;
  const endAt: unknown = input.proposal.payload.endAt;
  const calendarId: unknown = input.proposal.payload.calendarId;
  const hasWindow = isIso(startAt) && isIso(endAt) && isNonEmptyString(calendarId);

  const requiredResourceIds = policyRaw.conditions
    .filter((condition) => condition.kind === "resource_commitment")
    .flatMap((condition) => condition.resources?.requiredResourceIds ?? []);

  const [acceptance, deposits, availability, resources, waivers] = await Promise.all([
    guarded<AcceptanceRecord>("fetchAcceptance", () =>
      input.verifiers.fetchAcceptance({
        businessId: input.businessId,
        bookingId: input.booking.id,
        proposalVersion: input.proposal.proposalVersion,
        proposalFingerprint: input.proposal.proposalFingerprint,
      }),
    ),
    guarded<DepositReceipt>("fetchDepositReceipts", () =>
      input.verifiers.fetchDepositReceipts({ businessId: input.businessId, bookingId: input.booking.id }),
    ),
    hasWindow
      ? guarded<AvailabilityAttestation>("fetchAvailability", () =>
          input.verifiers.fetchAvailability({
            businessId: input.businessId,
            calendarId: calendarId as string,
            startAt: startAt as string,
            endAt: endAt as string,
          }),
        )
      : Promise.resolve([] as AvailabilityAttestation[]),
    requiredResourceIds.length > 0
      ? guarded<ResourceCommitment>("fetchResourceCommitments", () =>
          input.verifiers.fetchResourceCommitments({
            businessId: input.businessId,
            bookingId: input.booking.id,
            proposalVersion: input.proposal.proposalVersion,
            proposalFingerprint: input.proposal.proposalFingerprint,
            resourceIds: [...new Set(requiredResourceIds)],
          }),
        )
      : Promise.resolve([] as ResourceCommitment[]),
    guarded<OwnerWaiver>("fetchWaivers", () =>
      input.verifiers.fetchWaivers({ businessId: input.businessId, bookingId: input.booking.id }),
    ),
  ]);

  const trusted: EvaluateReadinessInput = {
    nowIso: input.nowIso,
    businessId: input.businessId,
    booking: input.booking,
    proposal: input.proposal,
    policy: policyRaw,
    evidence: [...acceptance, ...deposits, ...availability, ...resources],
    rawSignals: input.rawSignals,
    waivers,
  };
  assertValidEvaluateInput(trusted);
  const decision = evaluateReadiness(trusted);
  if (rejectedEvidence.length > 0) {
    return { ...decision, rejectedEvidence: [...rejectedEvidence, ...decision.rejectedEvidence] };
  }
  return decision;
}
