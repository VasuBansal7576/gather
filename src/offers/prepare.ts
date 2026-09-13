import { createHash } from "node:crypto";
import type { SourceReference } from "../domain/contracts.ts";
import type {
  AvailabilityEvidence,
  AvailabilitySlot,
  BusinessKnowledge,
  ConflictItem,
  EvidenceBundle,
  ExceptionScope,
  InquiryRequirements,
  MissingItem,
  OfferCandidate,
  OfferLine,
  OfferPreparationResult,
  OfferRank,
  OfferStatus,
  OwnerDecisionRequest,
  PolicyRule,
  PriceBook,
  ProfitabilityAssessment,
  ScopedException,
  SpaceKnowledge,
} from "./types.ts";

/* ------------------------------------------------------------------ */
/* Unknown-boundary validation helpers                                 */
/* ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isSourceReference(value: unknown): value is SourceReference {
  if (!isRecord(value)) return false;
  return isNonEmptyString(value.kind) && isNonEmptyString(value.locator);
}

function readSourceReferences(value: unknown, path: string): SourceReference[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  for (const [index, entry] of value.entries()) {
    if (!isSourceReference(entry)) throw new Error(`${path}[${index}] must be a source reference with kind and locator`);
  }
  return value as SourceReference[];
}

function readOptionalNonEmptyString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (!isNonEmptyString(value)) throw new Error(`${path} must be a non-empty string when present`);
  return value;
}

function readNonNegativeIntOrNull(value: unknown, path: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${path} must be a non-negative integer or null`);
  }
  return value;
}

function readConfidence(value: unknown, path: string): "verified" | "probable" | "uncertain" {
  if (value === "verified" || value === "probable" || value === "uncertain") return value;
  throw new Error(`${path} must be one of verified, probable, uncertain`);
}

function parseInstant(value: string): number {
  return Date.parse(value);
}

/* ------------------------------------------------------------------ */
/* Deterministic canonicalization and fingerprinting                   */
/* ------------------------------------------------------------------ */

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

function fingerprintOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function stableId(parts: Record<string, string>): string {
  return fingerprintOf(parts).slice(0, 16);
}

function dedupeSources(lists: SourceReference[][]): SourceReference[] {
  const seen = new Set<string>();
  const out: SourceReference[] = [];
  for (const list of lists) {
    for (const source of list) {
      const key = `${source.kind}::${source.locator}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...source });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Validated input readers (throw on malformed envelopes)              */
/* ------------------------------------------------------------------ */

export function readInquiryRequirements(input: unknown): InquiryRequirements {
  if (!isRecord(input)) throw new Error("inquiry must be an object");
  if (!isNonEmptyString(input.inquiryId)) throw new Error("inquiry.inquiryId must be a non-empty string");
  if (!isNonEmptyString(input.businessId)) throw new Error("inquiry.businessId must be a non-empty string");
  if (typeof input.eventType !== "string") throw new Error("inquiry.eventType must be a string");
  if (typeof input.startAt !== "string") throw new Error("inquiry.startAt must be a string");
  if (typeof input.endAt !== "string") throw new Error("inquiry.endAt must be a string");
  if (typeof input.guestCount !== "number") throw new Error("inquiry.guestCount must be a number");
  if (!Array.isArray(input.serviceRequirements) || !input.serviceRequirements.every((s) => typeof s === "string")) {
    throw new Error("inquiry.serviceRequirements must be a string array");
  }
  let budget: InquiryRequirements["budgetCents"];
  if (input.budgetCents !== undefined) {
    if (!isRecord(input.budgetCents)) throw new Error("inquiry.budgetCents must be an object when present");
    const min = readNonNegativeIntOrNull(input.budgetCents.min, "inquiry.budgetCents.min");
    const max = readNonNegativeIntOrNull(input.budgetCents.max, "inquiry.budgetCents.max");
    budget = {
      ...(min === null ? {} : { min }),
      ...(max === null ? {} : { max }),
    };
  }
  if (!isNonEmptyString(input.validatedAt)) throw new Error("inquiry.validatedAt must be a non-empty string");
  if (!isNonEmptyString(input.validator)) throw new Error("inquiry.validator must be a non-empty string identifying the upstream validation");
  return {
    inquiryId: input.inquiryId,
    businessId: input.businessId,
    eventType: input.eventType,
    startAt: input.startAt,
    endAt: input.endAt,
    guestCount: input.guestCount,
    serviceRequirements: [...input.serviceRequirements] as string[],
    ...(budget === undefined ? {} : { budgetCents: budget }),
    ...(readOptionalNonEmptyString(input.customerId, "inquiry.customerId") === undefined
      ? {}
      : { customerId: input.customerId as string }),
    ...(readOptionalNonEmptyString(input.bookingId, "inquiry.bookingId") === undefined
      ? {}
      : { bookingId: input.bookingId as string }),
    ...(readOptionalNonEmptyString(input.preferredSpaceId, "inquiry.preferredSpaceId") === undefined
      ? {}
      : { preferredSpaceId: input.preferredSpaceId as string }),
    sourceReferences: readSourceReferences(input.sourceReferences, "inquiry.sourceReferences"),
    validatedAt: input.validatedAt,
    validator: input.validator,
  };
}

function readSpace(value: unknown, path: string): SpaceKnowledge {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  if (!isNonEmptyString(value.spaceId)) throw new Error(`${path}.spaceId must be a non-empty string`);
  if (!isNonEmptyString(value.name)) throw new Error(`${path}.name must be a non-empty string`);
  if (typeof value.capacityMin !== "number" || !Number.isInteger(value.capacityMin) || value.capacityMin < 0) {
    throw new Error(`${path}.capacityMin must be a non-negative integer`);
  }
  if (typeof value.capacityMax !== "number" || !Number.isInteger(value.capacityMax) || value.capacityMax < value.capacityMin) {
    throw new Error(`${path}.capacityMax must be an integer >= capacityMin`);
  }
  return {
    spaceId: value.spaceId,
    name: value.name,
    capacityMin: value.capacityMin,
    capacityMax: value.capacityMax,
    confidence: readConfidence(value.confidence, `${path}.confidence`),
    sourceReferences: readSourceReferences(value.sourceReferences, `${path}.sourceReferences`),
  };
}

function readPolicy(value: unknown, path: string): PolicyRule {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  if (!isNonEmptyString(value.policyId)) throw new Error(`${path}.policyId must be a non-empty string`);
  if (!isNonEmptyString(value.statement)) throw new Error(`${path}.statement must be a non-empty string`);
  if (value.effect !== "allow" && value.effect !== "deny" && value.effect !== "require_owner_decision") {
    throw new Error(`${path}.effect must be allow, deny, or require_owner_decision`);
  }
  const out: PolicyRule = {
    policyId: value.policyId,
    statement: value.statement,
    effect: value.effect,
    confidence: readConfidence(value.confidence, `${path}.confidence`),
    sourceReferences: readSourceReferences(value.sourceReferences, `${path}.sourceReferences`),
  };
  if (value.appliesToEventTypes !== undefined) {
    if (!Array.isArray(value.appliesToEventTypes) || !value.appliesToEventTypes.every((s) => typeof s === "string")) {
      throw new Error(`${path}.appliesToEventTypes must be a string array when present`);
    }
    out.appliesToEventTypes = [...value.appliesToEventTypes] as string[];
  }
  if (value.appliesToServices !== undefined) {
    if (!Array.isArray(value.appliesToServices) || !value.appliesToServices.every((s) => typeof s === "string")) {
      throw new Error(`${path}.appliesToServices must be a string array when present`);
    }
    out.appliesToServices = [...value.appliesToServices] as string[];
  }
  if (value.minGuests !== undefined) {
    if (typeof value.minGuests !== "number" || !Number.isInteger(value.minGuests) || value.minGuests < 0) {
      throw new Error(`${path}.minGuests must be a non-negative integer when present`);
    }
    out.minGuests = value.minGuests;
  }
  if (value.maxGuests !== undefined) {
    if (typeof value.maxGuests !== "number" || !Number.isInteger(value.maxGuests) || value.maxGuests < 0) {
      throw new Error(`${path}.maxGuests must be a non-negative integer when present`);
    }
    out.maxGuests = value.maxGuests;
  }
  return out;
}

function readScope(value: unknown, path: string): ExceptionScope {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  const scope: ExceptionScope = {};
  const inquiryId = readOptionalNonEmptyString(value.inquiryId, `${path}.inquiryId`);
  const customerId = readOptionalNonEmptyString(value.customerId, `${path}.customerId`);
  const bookingId = readOptionalNonEmptyString(value.bookingId, `${path}.bookingId`);
  if (inquiryId !== undefined) scope.inquiryId = inquiryId;
  if (customerId !== undefined) scope.customerId = customerId;
  if (bookingId !== undefined) scope.bookingId = bookingId;
  if (scope.inquiryId === undefined && scope.customerId === undefined && scope.bookingId === undefined) {
    throw new Error(`${path} must name at least one of inquiryId, customerId, bookingId`);
  }
  return scope;
}

function readScopedException(value: unknown, path: string): ScopedException {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  if (!isNonEmptyString(value.exceptionId)) throw new Error(`${path}.exceptionId must be a non-empty string`);
  if (!isNonEmptyString(value.policyId)) throw new Error(`${path}.policyId must be a non-empty string`);
  if (value.effect !== "allow" && value.effect !== "require_owner_decision") {
    throw new Error(`${path}.effect must be allow or require_owner_decision`);
  }
  if (!isNonEmptyString(value.approvedBy)) throw new Error(`${path}.approvedBy must be a non-empty string`);
  return {
    exceptionId: value.exceptionId,
    policyId: value.policyId,
    scope: readScope(value.scope, `${path}.scope`),
    effect: value.effect,
    approvedBy: value.approvedBy,
    sourceReferences: readSourceReferences(value.sourceReferences, `${path}.sourceReferences`),
  };
}

function readPriceBook(value: unknown, path: string): PriceBook {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  if (!isNonEmptyString(value.currency)) throw new Error(`${path}.currency must be a non-empty string`);
  if (!Array.isArray(value.lines)) throw new Error(`${path}.lines must be an array`);
  if (!Array.isArray(value.costs)) throw new Error(`${path}.costs must be an array`);
  const lines = value.lines.map((line, index) => {
    if (!isRecord(line)) throw new Error(`${path}.lines[${index}] must be an object`);
    if (!isNonEmptyString(line.lineId)) throw new Error(`${path}.lines[${index}].lineId must be a non-empty string`);
    if (!isNonEmptyString(line.label)) throw new Error(`${path}.lines[${index}].label must be a non-empty string`);
    const rawBasis: unknown = line.pricingBasis;
    if (rawBasis !== "per_event" && rawBasis !== "per_guest" && rawBasis !== "per_hour") {
      throw new Error(`${path}.lines[${index}].pricingBasis must be per_event, per_guest, or per_hour`);
    }
    const basis: "per_event" | "per_guest" | "per_hour" = rawBasis;
    return {
      lineId: line.lineId,
      label: line.label,
      pricingBasis: basis,
      unitCents: readNonNegativeIntOrNull(line.unitCents, `${path}.lines[${index}].unitCents`),
      sourceReferences: readSourceReferences(line.sourceReferences, `${path}.lines[${index}].sourceReferences`),
    };
  });
  const costs = value.costs.map((cost, index) => {
    if (!isRecord(cost)) throw new Error(`${path}.costs[${index}] must be an object`);
    if (!isNonEmptyString(cost.costId)) throw new Error(`${path}.costs[${index}].costId must be a non-empty string`);
    if (!isNonEmptyString(cost.label)) throw new Error(`${path}.costs[${index}].label must be a non-empty string`);
    return {
      costId: cost.costId,
      label: cost.label,
      amountCents: readNonNegativeIntOrNull(cost.amountCents, `${path}.costs[${index}].amountCents`),
      sourceReferences: readSourceReferences(cost.sourceReferences, `${path}.costs[${index}].sourceReferences`),
    };
  });
  return {
    currency: value.currency,
    lines,
    costs,
    floorCents: readNonNegativeIntOrNull(value.floorCents, `${path}.floorCents`),
    minMarginBps: readNonNegativeIntOrNull(value.minMarginBps, `${path}.minMarginBps`),
    depositBps: readNonNegativeIntOrNull(value.depositBps, `${path}.depositBps`),
    sourceReferences: readSourceReferences(value.sourceReferences, `${path}.sourceReferences`),
  };
}

export function readBusinessKnowledge(input: unknown): BusinessKnowledge {
  if (!isRecord(input)) throw new Error("knowledge must be an object");
  if (!Array.isArray(input.spaces)) throw new Error("knowledge.spaces must be an array");
  if (!Array.isArray(input.policies)) throw new Error("knowledge.policies must be an array");
  if (!Array.isArray(input.scopedExceptions)) throw new Error("knowledge.scopedExceptions must be an array");
  if (!Array.isArray(input.services)) throw new Error("knowledge.services must be an array");
  const services = input.services.map((service, index) => {
    if (!isRecord(service)) throw new Error(`knowledge.services[${index}] must be an object`);
    if (!isNonEmptyString(service.serviceId)) throw new Error(`knowledge.services[${index}].serviceId must be a non-empty string`);
    if (!isNonEmptyString(service.label)) throw new Error(`knowledge.services[${index}].label must be a non-empty string`);
    if (typeof service.available !== "boolean") throw new Error(`knowledge.services[${index}].available must be a boolean`);
    return {
      serviceId: service.serviceId,
      label: service.label,
      available: service.available,
      sourceReferences: readSourceReferences(service.sourceReferences, `knowledge.services[${index}].sourceReferences`),
    };
  });
  return {
    spaces: input.spaces.map((space, index) => readSpace(space, `knowledge.spaces[${index}]`)),
    policies: input.policies.map((policy, index) => readPolicy(policy, `knowledge.policies[${index}]`)),
    scopedExceptions: input.scopedExceptions.map((exception, index) =>
      readScopedException(exception, `knowledge.scopedExceptions[${index}]`),
    ),
    priceBook: readPriceBook(input.priceBook, "knowledge.priceBook"),
    services,
    sourceReferences: readSourceReferences(input.sourceReferences, "knowledge.sourceReferences"),
  };
}

function readSlot(value: unknown, path: string): AvailabilitySlot {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  if (typeof value.startAt !== "string") throw new Error(`${path}.startAt must be a string`);
  if (typeof value.endAt !== "string") throw new Error(`${path}.endAt must be a string`);
  if (typeof value.available !== "boolean") throw new Error(`${path}.available must be a boolean`);
  const slot: AvailabilitySlot = {
    startAt: value.startAt,
    endAt: value.endAt,
    available: value.available,
    sourceReferences: readSourceReferences(value.sourceReferences, `${path}.sourceReferences`),
  };
  const reason = readOptionalNonEmptyString(value.reason, `${path}.reason`);
  if (reason !== undefined) slot.reason = reason;
  return slot;
}

export function readAvailabilityEvidence(input: unknown): AvailabilityEvidence {
  if (!isRecord(input)) throw new Error("availability must be an object");
  if (!isNonEmptyString(input.calendarId)) throw new Error("availability.calendarId must be a non-empty string");
  if (typeof input.observedAt !== "string") throw new Error("availability.observedAt must be a string");
  if (typeof input.asOf !== "string") throw new Error("availability.asOf must be a string");
  if (typeof input.maxFreshnessMs !== "number" || !Number.isFinite(input.maxFreshnessMs) || input.maxFreshnessMs < 0) {
    throw new Error("availability.maxFreshnessMs must be a non-negative number");
  }
  if (!Array.isArray(input.slots)) throw new Error("availability.slots must be an array");
  return {
    calendarId: input.calendarId,
    observedAt: input.observedAt,
    asOf: input.asOf,
    maxFreshnessMs: input.maxFreshnessMs,
    slots: input.slots.map((slot, index) => readSlot(slot, `availability.slots[${index}]`)),
    sourceReferences: readSourceReferences(input.sourceReferences, "availability.sourceReferences"),
  };
}

/* ------------------------------------------------------------------ */
/* Policy, capacity, availability, and pricing evaluation              */
/* ------------------------------------------------------------------ */

function policyApplies(policy: PolicyRule, inquiry: InquiryRequirements): boolean {
  if (policy.appliesToEventTypes !== undefined && policy.appliesToEventTypes.length > 0) {
    if (!policy.appliesToEventTypes.includes(inquiry.eventType)) return false;
  }
  if (policy.appliesToServices !== undefined && policy.appliesToServices.length > 0) {
    if (!inquiry.serviceRequirements.some((service) => policy.appliesToServices?.includes(service) === true)) return false;
  }
  if (policy.minGuests !== undefined && inquiry.guestCount < policy.minGuests) return false;
  if (policy.maxGuests !== undefined && inquiry.guestCount > policy.maxGuests) return false;
  return true;
}

function scopeMatches(scope: ExceptionScope, inquiry: InquiryRequirements): boolean {
  if (scope.inquiryId !== undefined && scope.inquiryId !== inquiry.inquiryId) return false;
  if (scope.customerId !== undefined && (inquiry.customerId === undefined || scope.customerId !== inquiry.customerId)) return false;
  if (scope.bookingId !== undefined && (inquiry.bookingId === undefined || scope.bookingId !== inquiry.bookingId)) return false;
  return true;
}

interface PolicyOutcome {
  blocking: ConflictItem[];
  decisions: OwnerDecisionRequest[];
  notes: string[];
  scopeNotes: string[];
}

/**
 * Evaluate policies for one candidate. Scoped exceptions only relax the
 * matching policy for this inquiry scope; the global policy list is never
 * mutated and other inquiries are unaffected.
 */
function evaluatePolicies(
  inquiry: InquiryRequirements,
  knowledge: BusinessKnowledge,
): PolicyOutcome {
  const blocking: ConflictItem[] = [];
  const decisions: OwnerDecisionRequest[] = [];
  const notes: string[] = [];
  const scopeNotes: string[] = [];
  const applicable = knowledge.policies.filter((policy) => policyApplies(policy, inquiry));
  for (const policy of applicable) {
    const matching = knowledge.scopedExceptions.filter(
      (exception) => exception.policyId === policy.policyId && scopeMatches(exception.scope, inquiry),
    );
    if (policy.effect === "deny") {
      const allowance = matching.find((exception) => exception.effect === "allow");
      if (allowance !== undefined) {
        scopeNotes.push(
          `Scoped exception ${allowance.exceptionId} (approved by ${allowance.approvedBy}) permits this inquiry under policy ${policy.policyId}; the global policy is unchanged.`,
        );
        continue;
      }
      const conditional = matching.find((exception) => exception.effect === "require_owner_decision");
      if (conditional !== undefined) {
        decisions.push({
          code: "policy_exception_needs_owner",
          question: `Approve the scoped exception ${conditional.exceptionId} to policy "${policy.statement}" for this inquiry?`,
          context: `Policy ${policy.policyId} would otherwise deny this request. The exception stays scoped to this inquiry and does not change global policy.`,
          evidence: dedupeSources([policy.sourceReferences, conditional.sourceReferences]),
        });
        notes.push(`Scoped exception ${conditional.exceptionId} for policy ${policy.policyId} still needs an owner decision.`);
        continue;
      }
      blocking.push({
        code: "policy_denied",
        detail: `Policy "${policy.statement}" (${policy.policyId}) denies this request and no scoped exception covers this inquiry.`,
        involvedPolicyIds: [policy.policyId],
        evidence: [...policy.sourceReferences],
      });
    } else if (policy.effect === "require_owner_decision") {
      const allowance = matching.find((exception) => exception.effect === "allow");
      if (allowance !== undefined) {
        scopeNotes.push(
          `Scoped exception ${allowance.exceptionId} (approved by ${allowance.approvedBy}) already covers policy ${policy.policyId} for this inquiry.`,
        );
        continue;
      }
      decisions.push({
        code: "policy_requires_owner",
        question: `Approve proceeding under policy "${policy.statement}" (${policy.policyId}) for this inquiry?`,
        context: "The business requires an owner decision before selling under this policy.",
        evidence: [...policy.sourceReferences],
      });
      notes.push(`Policy ${policy.policyId} requires an owner decision before this offer can be sent.`);
    }
  }
  return { blocking, decisions, notes, scopeNotes };
}

function covers(containerStart: string, containerEnd: string, start: string, end: string): boolean {
  return (
    Number.isFinite(parseInstant(containerStart)) &&
    Number.isFinite(parseInstant(containerEnd)) &&
    parseInstant(containerStart) <= parseInstant(start) &&
    parseInstant(containerEnd) >= parseInstant(end)
  );
}

function rangeCovers(slot: AvailabilitySlot, start: string, end: string): boolean {
  return slot.available && covers(slot.startAt, slot.endAt, start, end);
}

function hoursBetween(start: string, end: string): number {
  return Math.max(1, Math.ceil((parseInstant(end) - parseInstant(start)) / 3_600_000));
}

interface PricedLines {
  lines: OfferLine[];
  totalCents: number | null;
  unknownPriceIds: string[];
}

function priceLines(priceBook: PriceBook, guestCount: number, start: string, end: string): PricedLines {
  const hours = hoursBetween(start, end);
  const lines: OfferLine[] = priceBook.lines.map((line) => {
    const quantity = line.pricingBasis === "per_event" ? 1 : line.pricingBasis === "per_guest" ? guestCount : hours;
    return {
      lineId: line.lineId,
      label: line.label,
      pricingBasis: line.pricingBasis,
      quantity,
      unitCents: line.unitCents,
      lineTotalCents: line.unitCents === null ? null : line.unitCents * quantity,
      unknownUnit: line.unitCents === null,
    };
  });
  const unknownPriceIds = lines.filter((line) => line.unknownUnit).map((line) => line.lineId);
  const totalCents = unknownPriceIds.length > 0 ? null : lines.reduce((sum, line) => sum + (line.lineTotalCents ?? 0), 0);
  return { lines, totalCents, unknownPriceIds };
}

function assessProfitability(args: {
  totalCents: number | null;
  unknownPriceIds: string[];
  costs: PriceBook["costs"];
  floorCents: number | null;
  minMarginBps: number | null;
}): ProfitabilityAssessment {
  const unknownCostIds = args.costs.filter((cost) => cost.amountCents === null).map((cost) => cost.costId);
  const base = {
    totalCents: args.totalCents,
    costTotalCents: null as number | null,
    floorCents: args.floorCents,
    marginBps: null as number | null,
    minMarginBps: args.minMarginBps,
    unknownCostIds,
    unknownPriceIds: [...args.unknownPriceIds],
  };
  if (args.totalCents === null || unknownCostIds.length > 0) {
    const reasons: string[] = [];
    if (args.totalCents === null) reasons.push(`unknown unit prices (${base.unknownPriceIds.join(", ") || "none listed"})`);
    if (unknownCostIds.length > 0) reasons.push(`unknown or incomplete costs (${unknownCostIds.join(", ")})`);
    return {
      ...base,
      claim: "unknown",
      explanation: `Profitability cannot be claimed: ${reasons.join("; ")}. No price or cost was invented to fill the gap.`,
    };
  }
  const costTotal = args.costs.reduce((sum, cost) => sum + (cost.amountCents ?? 0), 0);
  if (args.floorCents !== null && args.totalCents < args.floorCents) {
    return {
      ...base,
      costTotalCents: costTotal,
      claim: "below_floor",
      explanation: `Total ${args.totalCents} is below the approved floor ${args.floorCents}; the offer is rejected instead of discounting past the boundary.`,
    };
  }
  if (args.minMarginBps !== null) {
    const marginBps = args.totalCents === 0 ? 0 : Math.floor(((args.totalCents - costTotal) / args.totalCents) * 10_000);
    if (marginBps < args.minMarginBps) {
      return {
        ...base,
        costTotalCents: costTotal,
        marginBps,
        claim: "below_margin",
        explanation: `Margin ${marginBps}bps is below the approved minimum ${args.minMarginBps}bps; the offer is rejected instead of selling at any cost.`,
      };
    }
    return {
      ...base,
      costTotalCents: costTotal,
      marginBps,
      claim: "profitable",
      explanation: `Total ${args.totalCents} clears floor ${args.floorCents ?? "none"} with margin ${marginBps}bps against minimum ${args.minMarginBps}bps.`,
    };
  }
  return {
    ...base,
    costTotalCents: costTotal,
    claim: "profitable",
    explanation: `Total ${args.totalCents} clears floor ${args.floorCents ?? "none"}; no margin target is configured.`,
  };
}

/* ------------------------------------------------------------------ */
/* Candidate construction                                              */
/* ------------------------------------------------------------------ */

interface CandidateAttempt {
  candidate?: OfferCandidate;
  conflicts: ConflictItem[];
  decisions: OwnerDecisionRequest[];
  policyNotes: string[];
  scopeNotes: string[];
  profitability: ProfitabilityAssessment;
}

function buildCandidate(args: {
  inquiry: InquiryRequirements;
  knowledge: BusinessKnowledge;
  availability: AvailabilityEvidence;
  space: SpaceKnowledge;
  startAt: string;
  endAt: string;
  rank: OfferRank;
  version: number;
  supersedesFingerprint?: string;
  alternativeNote?: string;
}): CandidateAttempt {
  const { inquiry, knowledge, availability, space, startAt, endAt, rank, version } = args;
  const conflicts: ConflictItem[] = [];
  const priced = priceLines(knowledge.priceBook, inquiry.guestCount, startAt, endAt);
  const profitability = assessProfitability({
    totalCents: priced.totalCents,
    unknownPriceIds: priced.unknownPriceIds,
    costs: knowledge.priceBook.costs,
    floorCents: knowledge.priceBook.floorCents,
    minMarginBps: knowledge.priceBook.minMarginBps,
  });
  if (profitability.claim === "below_floor" || profitability.claim === "below_margin") {
    conflicts.push({
      code: profitability.claim === "below_floor" ? "below_price_floor" : "below_margin",
      detail: profitability.explanation,
      evidence: dedupeSources([knowledge.priceBook.sourceReferences]),
    });
    return { conflicts, decisions: [], policyNotes: [], scopeNotes: [], profitability };
  }

  const policy = evaluatePolicies(inquiry, knowledge);
  conflicts.push(...policy.blocking);
  if (policy.blocking.length > 0) {
    return { conflicts, decisions: policy.decisions, policyNotes: policy.notes, scopeNotes: policy.scopeNotes, profitability };
  }

  const covering = availability.slots.filter((slot) => rangeCovers(slot, startAt, endAt));
  const offerId = `offer:${stableId({ inquiry: inquiry.inquiryId, space: space.spaceId, start: startAt, end: endAt })}`;
  const depositCents =
    priced.totalCents === null || knowledge.priceBook.depositBps === null
      ? null
      : Math.round((priced.totalCents * knowledge.priceBook.depositBps) / 10_000);
  const consequences: string[] = [
    `Offer ${rank === "primary" ? "covers" : "alternatively covers"} ${inquiry.guestCount} guests for ${inquiry.eventType} in ${space.name} from ${startAt} to ${endAt}.`,
    priced.totalCents === null
      ? `Total is unknown because unit prices are missing for ${priced.unknownPriceIds.join(", ")}; profitability is not claimed.`
      : `Total ${priced.totalCents} ${knowledge.priceBook.currency} across ${priced.lines.length} priced lines.`,
    depositCents === null
      ? "Deposit cannot be computed until the total and deposit rule are both known."
      : `Deposit ${depositCents} ${knowledge.priceBook.currency} is due under the configured deposit rule.`,
    `Capacity check: ${inquiry.guestCount} guests fit ${space.name} (${space.capacityMin}-${space.capacityMax}).`,
    `Availability evidence: fresh calendar observation covering the offered window (${covering.length} covering slot${covering.length === 1 ? "" : "s"}).`,
    ...policy.scopeNotes,
    ...policy.notes,
    `Pricing boundary: ${profitability.explanation}`,
    `Approval must bind offer ${offerId} version ${version}; any change to dates, price, space, or terms needs a new version.`,
  ];
  if (args.alternativeNote !== undefined) consequences.unshift(args.alternativeNote);

  const body = {
    offerId,
    version,
    rank,
    startAt,
    endAt,
    spaceId: space.spaceId,
    spaceName: space.name,
    guestCount: inquiry.guestCount,
    currency: knowledge.priceBook.currency,
    lines: priced.lines,
    totalCents: priced.totalCents,
    totalKnown: priced.totalCents !== null,
    depositCents,
    unknownCostIds: profitability.unknownCostIds,
    unknownPriceIds: profitability.unknownPriceIds,
    profitabilityClaimed: profitability.claim === "profitable",
    consequences,
    sources: dedupeSources([
      inquiry.sourceReferences,
      space.sourceReferences,
      knowledge.priceBook.sourceReferences,
      ...covering.map((slot) => slot.sourceReferences),
    ]),
  };
  const candidate: OfferCandidate = {
    ...body,
    fingerprint: fingerprintOf(body),
    ...(args.supersedesFingerprint === undefined ? {} : { supersedesFingerprint: args.supersedesFingerprint }),
    ...(args.alternativeNote === undefined ? {} : { note: args.alternativeNote }),
  };
  return { candidate, conflicts, decisions: policy.decisions, policyNotes: policy.notes, scopeNotes: policy.scopeNotes, profitability };
}

/* ------------------------------------------------------------------ */
/* Main entry point                                                    */
/* ------------------------------------------------------------------ */

export function prepareOffer(input: unknown): OfferPreparationResult {
  if (!isRecord(input)) throw new Error("prepareOffer input must be an object");
  const inquiry = readInquiryRequirements(input.inquiry);
  const knowledge = readBusinessKnowledge(input.knowledge);
  const availability = readAvailabilityEvidence(input.availability);
  if (typeof input.preparedAt !== "string" || !Number.isFinite(parseInstant(input.preparedAt))) {
    throw new Error("preparedAt must be a valid date-time string");
  }
  const preparedAt: string = input.preparedAt;
  let version = 1;
  if (input.requestedVersion !== undefined) {
    if (typeof input.requestedVersion !== "number" || !Number.isInteger(input.requestedVersion) || input.requestedVersion < 1) {
      throw new Error("requestedVersion must be an integer >= 1 when present");
    }
    version = input.requestedVersion;
  }
  const supersedesFingerprint = readOptionalNonEmptyString(input.supersedesFingerprint, "supersedesFingerprint");

  const missingInformation: MissingItem[] = [];
  const conflicts: ConflictItem[] = [];
  const ownerDecisions: OwnerDecisionRequest[] = [];

  /* Semantic completeness checks: well-typed but undecidable inputs. */
  if (inquiry.eventType.trim().length === 0) {
    missingInformation.push({
      code: "missing_event_type",
      field: "inquiry.eventType",
      detail: "The inquiry does not state an event type, so applicable policies cannot be evaluated.",
      ownerQuestion: "What type of event is the customer requesting?",
    });
  }
  const startMs = parseInstant(inquiry.startAt);
  const endMs = parseInstant(inquiry.endAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) {
    missingInformation.push({
      code: "missing_event_window",
      field: "inquiry.startAt/inquiry.endAt",
      detail: "The requested event window is missing or not a valid start-before-end range.",
      ownerQuestion: "What are the requested event start and end times?",
    });
  }
  if (!Number.isInteger(inquiry.guestCount) || inquiry.guestCount <= 0) {
    missingInformation.push({
      code: "missing_guest_count",
      field: "inquiry.guestCount",
      detail: "The guest count is missing or not a positive integer, so capacity cannot be checked.",
      ownerQuestion: "How many guests will attend?",
    });
  }
  if (knowledge.spaces.length === 0) {
    missingInformation.push({
      code: "missing_spaces",
      field: "knowledge.spaces",
      detail: "No attributable space or capacity knowledge is available for this business.",
      ownerQuestion: "Which spaces and capacities can be sold for this business?",
    });
  }
  if (knowledge.priceBook.lines.length === 0) {
    missingInformation.push({
      code: "missing_price_lines",
      field: "knowledge.priceBook.lines",
      detail: "No attributable price lines are available, so no total can be computed.",
      ownerQuestion: "Which approved price lines apply to this event?",
    });
  }
  const observedMs = parseInstant(availability.observedAt);
  const asOfMs = parseInstant(availability.asOf);
  if (!Number.isFinite(observedMs) || !Number.isFinite(asOfMs)) {
    missingInformation.push({
      code: "missing_availability_time",
      field: "availability.observedAt/asOf",
      detail: "Availability evidence has no usable observation timestamps.",
      ownerQuestion: "Can availability be rechecked now so the evidence is fresh?",
    });
  } else if (asOfMs - observedMs > availability.maxFreshnessMs) {
    missingInformation.push({
      code: "stale_availability",
      field: "availability.observedAt",
      detail: `Availability was observed ${asOfMs - observedMs}ms ago, beyond the ${availability.maxFreshnessMs}ms freshness bound.`,
      ownerQuestion: "Recheck calendar availability immediately before preparing the offer?",
    });
  }
  if (availability.slots.length === 0) {
    missingInformation.push({
      code: "missing_availability_slots",
      field: "availability.slots",
      detail: "No availability slots were returned, so the requested window cannot be evidenced.",
      ownerQuestion: "Recheck calendar availability for the requested window?",
    });
  }

  /* Service requirements: unknown services need evidence; unavailable ones conflict. */
  const serviceById = new Map(knowledge.services.map((service) => [service.serviceId, service]));
  for (const required of inquiry.serviceRequirements) {
    const known = serviceById.get(required);
    if (known === undefined) {
      missingInformation.push({
        code: "missing_service_evidence",
        field: `knowledge.services[${required}]`,
        detail: `Required service "${required}" has no attributable business knowledge.`,
        ownerQuestion: `Can the business provide "${required}", and under which terms?`,
      });
    } else if (!known.available) {
      conflicts.push({
        code: "service_unavailable",
        detail: `Required service "${known.label}" (${known.serviceId}) is marked unavailable by business knowledge.`,
        evidence: [...known.sourceReferences],
      });
    }
  }

  const validWindow = missingInformation.every((item) => item.code !== "missing_event_window");
  const validGuests = missingInformation.every((item) => item.code !== "missing_guest_count");

  /* Capacity screen across all spaces. */
  let fittingSpaces: SpaceKnowledge[] = [];
  if (validGuests && knowledge.spaces.length > 0) {
    fittingSpaces = knowledge.spaces
      .filter((space) => inquiry.guestCount >= space.capacityMin && inquiry.guestCount <= space.capacityMax)
      .sort((left, right) => left.spaceId.localeCompare(right.spaceId));
    if (fittingSpaces.length === 0) {
      const capacities = knowledge.spaces
        .map((space) => `${space.name} (${space.capacityMin}-${space.capacityMax})`)
        .sort()
        .join("; ");
      conflicts.push({
        code: "capacity_exceeded",
        detail: `No known space fits ${inquiry.guestCount} guests. Known capacities: ${capacities}.`,
        evidence: dedupeSources(knowledge.spaces.map((space) => space.sourceReferences)),
      });
    }
  }

  const orderedSpaces = [...fittingSpaces].sort((left, right) => {
    if (inquiry.preferredSpaceId !== undefined) {
      if (left.spaceId === inquiry.preferredSpaceId) return -1;
      if (right.spaceId === inquiry.preferredSpaceId) return 1;
    }
    return left.spaceId.localeCompare(right.spaceId);
  });

  const offers: OfferCandidate[] = [];
  let primaryProfitability: ProfitabilityAssessment | undefined;
  const blocked = missingInformation.length > 0;

  if (!blocked && validWindow && orderedSpaces.length > 0) {
    const requestedCovered = availability.slots.some((slot) => rangeCovers(slot, inquiry.startAt, inquiry.endAt));
    if (requestedCovered) {
      let primaryPlaced = false;
      for (const space of orderedSpaces) {
        const attempt = buildCandidate({
          inquiry,
          knowledge,
          availability,
          space,
          startAt: inquiry.startAt,
          endAt: inquiry.endAt,
          rank: primaryPlaced ? "alternative" : "primary",
          version,
          ...(supersedesFingerprint === undefined ? {} : { supersedesFingerprint }),
        });
        conflicts.push(...attempt.conflicts);
        ownerDecisions.push(...attempt.decisions);
        if (primaryProfitability === undefined) primaryProfitability = attempt.profitability;
        if (attempt.candidate !== undefined) {
          offers.push(attempt.candidate);
          if (attempt.candidate.rank === "primary") primaryPlaced = true;
        }
        if (primaryPlaced) break;
      }
    } else {
      const unavailableEvidence = availability.slots.filter((slot) => !slot.available);
      conflicts.push({
        code: "requested_date_unavailable",
        detail: `The requested window ${inquiry.startAt} to ${inquiry.endAt} is not covered by any available slot.`,
        evidence: dedupeSources([
          ...unavailableEvidence.map((slot) => slot.sourceReferences),
          availability.sourceReferences,
        ]),
      });
      const alternates = availability.slots
        .filter((slot) => slot.available)
        .sort((left, right) => left.startAt.localeCompare(right.startAt))
        .slice(0, 3);
      for (const slot of alternates) {
        const space = orderedSpaces[0];
        if (space === undefined) break;
        const attempt = buildCandidate({
          inquiry,
          knowledge,
          availability,
          space,
          startAt: slot.startAt,
          endAt: slot.endAt,
          rank: "alternative",
          version,
          ...(supersedesFingerprint === undefined ? {} : { supersedesFingerprint }),
          alternativeNote: `Alternative date: the requested window is unavailable; this offer uses evidenced available slot ${slot.startAt} to ${slot.endAt}.`,
        });
        conflicts.push(...attempt.conflicts.filter((conflict) => conflict.code !== "requested_date_unavailable"));
        ownerDecisions.push(...attempt.decisions);
        if (primaryProfitability === undefined) primaryProfitability = attempt.profitability;
        if (attempt.candidate !== undefined) offers.push(attempt.candidate);
      }
      if (alternates.length === 0) {
        conflicts.push({
          code: "no_alternative_slots",
          detail: "No available alternative slots were evidenced, so no alternative can be offered.",
          evidence: [...availability.sourceReferences],
        });
      }
    }
  }

  /* Budget boundary: explicit conflict, never a silent overrun. */
  const primary = offers.find((offer) => offer.rank === "primary");
  if (primary !== undefined && primary.totalCents !== null && inquiry.budgetCents?.max !== undefined && primary.totalCents > inquiry.budgetCents.max) {
    conflicts.push({
      code: "exceeds_budget",
      detail: `Offer total ${primary.totalCents} exceeds the stated budget maximum ${inquiry.budgetCents.max}.`,
      evidence: dedupeSources([primary.sources, inquiry.sourceReferences]),
    });
  }

  const profitability: ProfitabilityAssessment =
    primaryProfitability ??
    assessProfitability({
      totalCents: null,
      unknownPriceIds: knowledge.priceBook.lines.filter((line) => line.unitCents === null).map((line) => line.lineId),
      costs: knowledge.priceBook.costs,
      floorCents: knowledge.priceBook.floorCents,
      minMarginBps: knowledge.priceBook.minMarginBps,
    });

  const status: OfferStatus =
    primary !== undefined && missingInformation.length === 0 && conflicts.length === 0
      ? "feasible"
      : offers.length > 0
        ? "alternatives"
        : "blocked";

  const evidence: EvidenceBundle = {
    inquiry: dedupeSources([inquiry.sourceReferences]),
    business: dedupeSources([knowledge.sourceReferences]),
    availability: dedupeSources([availability.sourceReferences]),
    pricing: dedupeSources([knowledge.priceBook.sourceReferences]),
    allFictional: false,
    provenanceNote: "",
  };
  const allSources = dedupeSources([evidence.inquiry, evidence.business, evidence.availability, evidence.pricing]);
  evidence.allFictional = allSources.length > 0 && allSources.every((source) => source.fictional === true);
  evidence.provenanceNote = evidence.allFictional
    ? "All cited evidence is fictional fixture data (DEMO ONLY); it must never be presented as a verified integration."
    : "Consequential facts cite their sources above; fictional fixtures, if any, are marked on their source references.";

  const consequences: string[] = [];
  if (primary !== undefined) {
    consequences.push(
      `Primary offer ${primary.offerId} v${version}: ${primary.guestCount} guests in ${primary.spaceName}, total ${primary.totalCents === null ? "unknown" : `${primary.totalCents} ${primary.currency}`}.`,
    );
  }
  for (const offer of offers.filter((item) => item.rank === "alternative")) {
    consequences.push(`Alternative ${offer.offerId}: ${offer.spaceName} from ${offer.startAt} to ${offer.endAt}.`);
  }
  if (status === "feasible") {
    consequences.push("The offer is feasible under current evidence; owner approval must still bind this exact version and fingerprint.");
    consequences.push("Availability must be rechecked immediately before any provisional hold; this result is not a hold.");
  } else if (status === "alternatives") {
    consequences.push("No primary offer can be sent as-is; review the alternatives, conflicts, and owner decisions before proceeding.");
  } else {
    consequences.push("No offer can be prepared until the missing information is supplied and conflicts are resolved.");
  }

  const result: OfferPreparationResult = {
    inquiryId: inquiry.inquiryId,
    businessId: inquiry.businessId,
    preparedAt,
    status,
    version,
    fingerprint: "",
    ...(supersedesFingerprint === undefined ? {} : { supersedesFingerprint }),
    offers,
    ...(primary === undefined ? {} : { primaryOffer: primary }),
    missingInformation,
    conflicts,
    ownerDecisions,
    profitability,
    evidence,
    consequences,
  };
  result.fingerprint = fingerprintOf({
    inquiryId: result.inquiryId,
    businessId: result.businessId,
    version: result.version,
    status: result.status,
    offers: result.offers,
    profitability: result.profitability,
    missing: result.missingInformation,
    conflicts: result.conflicts,
    decisions: result.ownerDecisions,
  });
  return result;
}
