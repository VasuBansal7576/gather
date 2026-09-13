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
  PriceLine,
  CostLine,
  ServiceCapability,
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

const KNOWN_SOURCE_KINDS = new Set([
  "connected_account",
  "document",
  "email",
  "calendar",
  "manual",
  "fixture",
]);

function isSourceReference(value: unknown): value is SourceReference {
  if (!isRecord(value)) return false;
  if (typeof value.kind !== "string" || !KNOWN_SOURCE_KINDS.has(value.kind)) return false;
  if (!isNonEmptyString(value.locator)) return false;
  if (value.label !== undefined && typeof value.label !== "string") return false;
  if (value.fictional !== undefined && typeof value.fictional !== "boolean") return false;
  return true;
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

export function canonicalizeValue(value: unknown): unknown {
  return canonicalize(value);
}

function fingerprintOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

/** Display money in proper currency units; never amountCents glued to a code. */
export function formatMoney(amountCents: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amountCents / 100);
  } catch {
    return `${(amountCents / 100).toFixed(2)} ${currency}`;
  }
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

export function readSpaceKnowledge(value: unknown, path: string): SpaceKnowledge {
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

export function readPolicyRule(value: unknown, path: string): PolicyRule {
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

export function readScopedExceptionValue(value: unknown, path: string): ScopedException {
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

export function readPriceLine(value: unknown, path: string): PriceLine {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  if (!isNonEmptyString(value.lineId)) throw new Error(`${path}.lineId must be a non-empty string`);
  if (!isNonEmptyString(value.label)) throw new Error(`${path}.label must be a non-empty string`);
  const rawBasis: unknown = value.pricingBasis;
  if (rawBasis !== "per_event" && rawBasis !== "per_guest" && rawBasis !== "per_hour") {
    throw new Error(`${path}.pricingBasis must be per_event, per_guest, or per_hour`);
  }
  const basis: "per_event" | "per_guest" | "per_hour" = rawBasis;
  return {
    lineId: value.lineId,
    label: value.label,
    pricingBasis: basis,
    unitCents: readNonNegativeIntOrNull(value.unitCents, `${path}.unitCents`),
    confidence: readConfidence(value.confidence, `${path}.confidence`),
    sourceReferences: readSourceReferences(value.sourceReferences, `${path}.sourceReferences`),
  };
}

export function readCostLine(value: unknown, path: string): CostLine {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  if (!isNonEmptyString(value.costId)) throw new Error(`${path}.costId must be a non-empty string`);
  if (!isNonEmptyString(value.label)) throw new Error(`${path}.label must be a non-empty string`);
  return {
    costId: value.costId,
    label: value.label,
    amountCents: readNonNegativeIntOrNull(value.amountCents, `${path}.amountCents`),
    confidence: readConfidence(value.confidence, `${path}.confidence`),
    sourceReferences: readSourceReferences(value.sourceReferences, `${path}.sourceReferences`),
  };
}

export function readServiceCapability(value: unknown, path: string): ServiceCapability {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  if (!isNonEmptyString(value.serviceId)) throw new Error(`${path}.serviceId must be a non-empty string`);
  if (!isNonEmptyString(value.label)) throw new Error(`${path}.label must be a non-empty string`);
  if (typeof value.available !== "boolean") throw new Error(`${path}.available must be a boolean`);
  return {
    serviceId: value.serviceId,
    label: value.label,
    available: value.available,
    sourceReferences: readSourceReferences(value.sourceReferences, `${path}.sourceReferences`),
  };
}

function readPriceBook(value: unknown, path: string): PriceBook {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  if (!isNonEmptyString(value.currency)) throw new Error(`${path}.currency must be a non-empty string`);
  if (!Array.isArray(value.lines)) throw new Error(`${path}.lines must be an array`);
  if (!Array.isArray(value.costs)) throw new Error(`${path}.costs must be an array`);
  const lines = value.lines.map((line, index) => readPriceLine(line, `${path}.lines[${index}]`));
  const costs = value.costs.map((cost, index) => readCostLine(cost, `${path}.costs[${index}]`));
  if (typeof value.costsComplete !== "boolean") {
    throw new Error(`${path}.costsComplete must be an explicit boolean attesting whether the cost ledger is complete`);
  }
  return {
    currency: value.currency,
    lines,
    costs,
    costsComplete: value.costsComplete,
    floorCents: readNonNegativeIntOrNull(value.floorCents, `${path}.floorCents`),
    minMarginBps: readNonNegativeIntOrNull(value.minMarginBps, `${path}.minMarginBps`),
    depositBps: readNonNegativeIntOrNull(value.depositBps, `${path}.depositBps`),
    sourceReferences: readSourceReferences(value.sourceReferences, `${path}.sourceReferences`),
  };
}

export function readTimezone(value: unknown, path: string): string {
  if (!isNonEmptyString(value)) throw new Error(`${path} must be a non-empty IANA timezone name`);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
  } catch {
    throw new Error(`${path} must be a valid IANA timezone name`);
  }
  return value;
}

export function readBusinessKnowledge(input: unknown): BusinessKnowledge {
  if (!isRecord(input)) throw new Error("knowledge must be an object");
  if (!isNonEmptyString(input.businessId)) throw new Error("knowledge.businessId must be a non-empty string");
  if (!Array.isArray(input.spaces)) throw new Error("knowledge.spaces must be an array");
  if (!Array.isArray(input.policies)) throw new Error("knowledge.policies must be an array");
  if (!Array.isArray(input.scopedExceptions)) throw new Error("knowledge.scopedExceptions must be an array");
  if (!Array.isArray(input.services)) throw new Error("knowledge.services must be an array");
  return {
    businessId: input.businessId,
    timezone: readTimezone(input.timezone, "knowledge.timezone"),
    spaces: input.spaces.map((space, index) => readSpaceKnowledge(space, `knowledge.spaces[${index}]`)),
    policies: input.policies.map((policy, index) => readPolicyRule(policy, `knowledge.policies[${index}]`)),
    scopedExceptions: input.scopedExceptions.map((exception, index) =>
      readScopedExceptionValue(exception, `knowledge.scopedExceptions[${index}]`),
    ),
    priceBook: readPriceBook(input.priceBook, "knowledge.priceBook"),
    services: input.services.map((service, index) => readServiceCapability(service, `knowledge.services[${index}]`)),
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
  /* Explicit scope: venue-wide only with venueWide: true, otherwise the
     slot must name its spaces. A missing scope is malformed, never
     silently venue-wide. */
  if (value.venueWide === true) {
    if (Array.isArray(value.spaceIds) && (value.spaceIds as unknown[]).length > 0) {
      throw new Error(`${path} is venue-wide and must not also name spaceIds`);
    }
    slot.venueWide = true;
  } else if (value.venueWide !== undefined && value.venueWide !== false) {
    throw new Error(`${path}.venueWide must be a boolean when present`);
  } else {
    if (!Array.isArray(value.spaceIds) || value.spaceIds.length === 0 || !value.spaceIds.every((entry) => isNonEmptyString(entry))) {
      throw new Error(`${path} must name a non-empty spaceIds array or set venueWide: true`);
    }
    slot.spaceIds = [...value.spaceIds] as string[];
  }
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

/** Two windows overlap when they share at least one instant. */
function rangesOverlap(leftStart: string, leftEnd: string, rightStart: string, rightEnd: string): boolean {
  const a = parseInstant(leftStart);
  const b = parseInstant(leftEnd);
  const c = parseInstant(rightStart);
  const d = parseInstant(rightEnd);
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c) || !Number.isFinite(d)) return false;
  return a < d && b > c;
}

/** A slot is evidence for a space when venue-wide or naming the space. */
function slotServesSpace(slot: AvailabilitySlot, spaceId: string): boolean {
  if (slot.venueWide === true) return true;
  return slot.spaceIds !== undefined && slot.spaceIds.includes(spaceId);
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
  costsComplete: boolean;
  floorCents: number | null;
  minMarginBps: number | null;
  currency: string;
}): ProfitabilityAssessment {
  const unknownCostIds = args.costs.filter((cost) => cost.amountCents === null).map((cost) => cost.costId);
  const unattestedLedger = !args.costsComplete;
  const base = {
    totalCents: args.totalCents,
    costTotalCents: null as number | null,
    floorCents: args.floorCents,
    marginBps: null as number | null,
    minMarginBps: args.minMarginBps,
    unknownCostIds,
    unknownPriceIds: [...args.unknownPriceIds],
  };
  if (args.totalCents === null) {
    const reasons: string[] = [];
    if (base.unknownPriceIds.length > 0) reasons.push(`unknown unit prices (${base.unknownPriceIds.join(", ")})`);
    if (unknownCostIds.length > 0) reasons.push(`unknown or incomplete costs (${unknownCostIds.join(", ")})`);
    if (unattestedLedger) reasons.push("the cost ledger has no source-backed completeness attestation");
    return {
      ...base,
      claim: "unknown",
      explanation: `Profitability cannot be claimed: ${reasons.join("; ") || "the total cannot be computed"}. No price or cost was invented to fill the gap.`,
    };
  }
  /* The pricing floor is a separate permission from cost knowledge: a known
     total below the floor is rejected even when costs are unknown. */
  if (args.floorCents !== null && args.totalCents < args.floorCents) {
    return {
      ...base,
      claim: "below_floor",
      explanation: `Total ${formatMoney(args.totalCents, args.currency)} is below the approved floor ${formatMoney(args.floorCents, args.currency)}; the offer is rejected instead of discounting past the boundary.`,
    };
  }
  /* Margin permission and profitability knowledge need a complete ledger:
     unknown costs, or an unattested ledger (including a bare empty list),
     keep profitability explicitly unknown. */
  if (unknownCostIds.length > 0 || unattestedLedger) {
    const reasons: string[] = [];
    if (unknownCostIds.length > 0) reasons.push(`unknown or incomplete costs (${unknownCostIds.join(", ")})`);
    if (unattestedLedger) reasons.push("the cost ledger has no source-backed completeness attestation (an empty cost list alone proves nothing)");
    return {
      ...base,
      claim: "unknown",
      explanation: `Profitability cannot be claimed: ${reasons.join("; ")}. No price or cost was invented to fill the gap.`,
    };
  }
  const costTotal = args.costs.reduce((sum, cost) => sum + (cost.amountCents ?? 0), 0);
  const profit = args.totalCents - costTotal;
  /* Positive profit must actually be > 0: breaking even is not profitable,
     and no margin target does not mean profitable. */
  if (profit <= 0) {
    return {
      ...base,
      costTotalCents: costTotal,
      claim: "unprofitable",
      explanation: `Known costs ${formatMoney(costTotal, args.currency)} meet or exceed the total ${formatMoney(args.totalCents, args.currency)} (profit ${formatMoney(profit, args.currency)}); the offer is rejected instead of selling at a known loss.`,
    };
  }
  if (args.minMarginBps !== null) {
    const marginBps = Math.floor((profit / args.totalCents) * 10_000);
    if (marginBps < args.minMarginBps) {
      return {
        ...base,
        costTotalCents: costTotal,
        marginBps,
        claim: "below_margin",
        explanation: `Margin ${marginBps}bps on profit ${formatMoney(profit, args.currency)} is below the approved minimum ${args.minMarginBps}bps; the offer is rejected instead of selling at any cost.`,
      };
    }
    return {
      ...base,
      costTotalCents: costTotal,
      marginBps,
      claim: "profitable",
      explanation: `Total ${formatMoney(args.totalCents, args.currency)} clears floor ${args.floorCents === null ? "none" : formatMoney(args.floorCents, args.currency)} with margin ${marginBps}bps against minimum ${args.minMarginBps}bps.`,
    };
  }
  return {
    ...base,
    costTotalCents: costTotal,
    claim: "profitable",
    explanation: `Known profit ${formatMoney(profit, args.currency)} is positive; no margin target is configured, which waives the margin permission but never implies profit on its own.`,
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

/** Confidence/source check: probable/uncertain facts, or empty provenance, need an explicit owner decision. */
function needsEvidenceDecision(confidence: string, sources: SourceReference[]): boolean {
  return confidence !== "verified" || sources.length === 0;
}

function describeConfidence(confidence: string, sources: SourceReference[]): string {
  if (sources.length === 0) return "unattributed (no source references)";
  return `marked ${confidence}`;
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
  const { inquiry, knowledge, availability, space, startAt, endAt, version } = args;
  let rank = args.rank;
  const conflicts: ConflictItem[] = [];
  const decisions: OwnerDecisionRequest[] = [];
  const priced = priceLines(knowledge.priceBook, inquiry.guestCount, startAt, endAt);
  const profitability = assessProfitability({
    totalCents: priced.totalCents,
    unknownPriceIds: priced.unknownPriceIds,
    costs: knowledge.priceBook.costs,
    costsComplete: knowledge.priceBook.costsComplete,
    floorCents: knowledge.priceBook.floorCents,
    minMarginBps: knowledge.priceBook.minMarginBps,
    currency: knowledge.priceBook.currency,
  });
  if (profitability.claim === "below_floor" || profitability.claim === "below_margin" || profitability.claim === "unprofitable") {
    const code = profitability.claim === "below_floor" ? "below_price_floor" : profitability.claim === "below_margin" ? "below_margin" : "unprofitable";
    conflicts.push({
      code,
      detail: profitability.explanation,
      evidence: dedupeSources([knowledge.priceBook.sourceReferences]),
    });
    return { conflicts, decisions, policyNotes: [], scopeNotes: [], profitability };
  }

  /* Window evidence: an available slot must cover the window for THIS space,
     and any overlapping busy/conflicting evidence for THIS space blocks the
     claimed window. Other spaces' busy evidence is irrelevant here. */
  const covering = availability.slots.filter(
    (slot) => rangeCovers(slot, startAt, endAt) && slotServesSpace(slot, space.spaceId),
  );
  const blockers = availability.slots.filter(
    (slot) => !slot.available && slotServesSpace(slot, space.spaceId) && rangesOverlap(slot.startAt, slot.endAt, startAt, endAt),
  );
  if (covering.length === 0 || blockers.length > 0) {
    const details: string[] = [];
    if (covering.length === 0) details.push(`no available slot covers ${startAt} to ${endAt} for ${space.name}`);
    if (blockers.length > 0) details.push(`${blockers.length} busy/conflicting slot${blockers.length === 1 ? "" : "s"} overlap${blockers.length === 1 ? "s" : ""} the claimed window`);
    conflicts.push({
      code: "conflicting_availability",
      detail: `${details.join("; ")}.`,
      evidence: dedupeSources([...blockers.map((slot) => slot.sourceReferences), availability.sourceReferences]),
    });
    return { conflicts, decisions, policyNotes: [], scopeNotes: [], profitability };
  }

  const policy = evaluatePolicies(inquiry, knowledge);
  conflicts.push(...policy.blocking);
  if (policy.blocking.length > 0) {
    return { conflicts, decisions: policy.decisions, policyNotes: policy.notes, scopeNotes: policy.scopeNotes, profitability };
  }
  decisions.push(...policy.decisions);
  /* Probable/uncertain (or unattributed) applicable policies need explicit review too. */
  for (const rule of knowledge.policies.filter((candidate) => policyApplies(candidate, inquiry))) {
    if (needsEvidenceDecision(rule.confidence, rule.sourceReferences)) {
      decisions.push({
        code: "unverified_policy",
        question: `Policy "${rule.statement}" (${rule.policyId}) is ${describeConfidence(rule.confidence, rule.sourceReferences)}; confirm it before sending?`,
        context: "Consequential policy evidence below verified confidence needs an explicit owner decision.",
        evidence: [...rule.sourceReferences],
      });
    }
  }

  /* Consequential capacity and pricing evidence below verified confidence. */
  if (needsEvidenceDecision(space.confidence, space.sourceReferences)) {
    decisions.push({
      code: "unverified_capacity",
      question: `Capacity for ${space.name} (${space.capacityMin}-${space.capacityMax}) is ${describeConfidence(space.confidence, space.sourceReferences)}; confirm before sending?`,
      context: "The guest count cannot be sold against unverified capacity without an owner decision.",
      evidence: [...space.sourceReferences],
    });
  }
  for (const line of knowledge.priceBook.lines) {
    if (needsEvidenceDecision(line.confidence, line.sourceReferences)) {
      decisions.push({
        code: "unverified_pricing",
        question: `Price line "${line.label}" (${line.lineId}) is ${describeConfidence(line.confidence, line.sourceReferences)}; confirm before sending?`,
        context: "Totals built from unverified prices need an explicit owner decision.",
        evidence: [...line.sourceReferences],
      });
    }
  }
  for (const cost of knowledge.priceBook.costs) {
    if (cost.amountCents !== null && needsEvidenceDecision(cost.confidence, cost.sourceReferences)) {
      decisions.push({
        code: "unverified_pricing",
        question: `Cost "${cost.label}" (${cost.costId}) is ${describeConfidence(cost.confidence, cost.sourceReferences)}; confirm before sending?`,
        context: "Margins computed from unverified costs need an explicit owner decision.",
        evidence: [...cost.sourceReferences],
      });
    }
  }
  /* Unknown profitability: commercial permission and profitability knowledge
     are separate. A known total clearing the floor with no cost-dependent
     margin rule may be offered with an explicit unknown-profit notice; an
     unknown total, or a configured margin floor with unknown costs, still
     needs resolution and keeps the result not ready-to-send. */
  let profitNotice: string | null = null;
  if (profitability.claim === "unknown") {
    const needsResolution = priced.totalCents === null || knowledge.priceBook.minMarginBps !== null;
    if (needsResolution) {
      decisions.push({
        code: "unknown_profitability",
        question: priced.totalCents === null
          ? "The offer total is unknown; establish the missing prices or costs before sending?"
          : "A margin floor is configured but cost knowledge is incomplete; complete it before sending?",
        context: profitability.explanation,
        evidence: dedupeSources([knowledge.priceBook.sourceReferences]),
      });
    } else {
      profitNotice = `Offered under approved pricing without a profit claim: ${profitability.explanation}`;
    }
  }

  /* Budget applies to every candidate: a known over-budget total is never
     suitable as-is — demote it and require an explicit decision. */
  if (priced.totalCents !== null && inquiry.budgetCents?.max !== undefined && priced.totalCents > inquiry.budgetCents.max) {
    rank = "alternative";
    conflicts.push({
      code: "exceeds_budget",
      detail: `Offer total ${formatMoney(priced.totalCents, knowledge.priceBook.currency)} exceeds the stated budget maximum ${formatMoney(inquiry.budgetCents.max, knowledge.priceBook.currency)}.`,
      evidence: dedupeSources([inquiry.sourceReferences, knowledge.priceBook.sourceReferences]),
    });
    decisions.push({
      code: "over_budget_approval",
      question: `Show this offer even though it exceeds the stated budget maximum of ${formatMoney(inquiry.budgetCents.max, knowledge.priceBook.currency)}?`,
      context: "A known-over-budget candidate is never suitable without an explicit owner decision.",
      evidence: dedupeSources([inquiry.sourceReferences, knowledge.priceBook.sourceReferences]),
    });
  }

  const offerId = `offer:${stableId({ inquiry: inquiry.inquiryId, space: space.spaceId, start: startAt, end: endAt })}`;
  const depositCents =
    priced.totalCents === null || knowledge.priceBook.depositBps === null
      ? null
      : Math.round((priced.totalCents * knowledge.priceBook.depositBps) / 10_000);
  const consequences: string[] = [
    `Offer ${rank === "primary" ? "covers" : "alternatively covers"} ${inquiry.guestCount} guests for ${inquiry.eventType} in ${space.name} from ${startAt} to ${endAt}.`,
    priced.totalCents === null
      ? `Total is unknown because unit prices are missing for ${priced.unknownPriceIds.join(", ")}; profitability is not claimed.`
      : `Total ${formatMoney(priced.totalCents, knowledge.priceBook.currency)} across ${priced.lines.length} priced lines.`,
    depositCents === null
      ? "Deposit cannot be computed until the total and deposit rule are both known."
      : `Deposit ${formatMoney(depositCents, knowledge.priceBook.currency)} is due under the configured deposit rule.`,
    `Capacity check: ${inquiry.guestCount} guests fit ${space.name} (${space.capacityMin}-${space.capacityMax}).`,
    `Availability evidence: fresh calendar observation covering the offered window for this space (${covering.length} covering slot${covering.length === 1 ? "" : "s"}, no overlapping busy evidence).`,
    ...policy.scopeNotes,
    ...policy.notes,
    `Pricing boundary: ${profitability.explanation}`,
    ...(profitNotice === null ? [] : [profitNotice]),
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
  return { candidate, conflicts, decisions, policyNotes: policy.notes, scopeNotes: policy.scopeNotes, profitability };
}

/* ------------------------------------------------------------------ */
/* Duration-preserving alternatives                                  */
/* ------------------------------------------------------------------ */

const DAY_MS = 86_400_000;

interface CarvedWindow {
  startAt: string;
  endAt: string;
  /** True when the window keeps the requested clock time on another date. */
  sameClockTime: boolean;
}

function windowOverlapsBusy(slots: AvailabilitySlot[], start: string, end: string, spaceId: string): boolean {
  return slots.some(
    (slot) => !slot.available && slotServesSpace(slot, spaceId) && rangesOverlap(slot.startAt, slot.endAt, start, end),
  );
}

/** A window is claimable for a space when covered for it and not overlapped by busy evidence for it. */
function windowClaimableForSpace(slots: AvailabilitySlot[], start: string, end: string, spaceId: string): boolean {
  const covered = slots.some((slot) => rangeCovers(slot, start, end) && slotServesSpace(slot, spaceId));
  return covered && !windowOverlapsBusy(slots, start, end, spaceId);
}

export function formatDuration(durationMs: number): string {
  const hours = Math.floor(durationMs / 3_600_000);
  const minutes = Math.round((durationMs - hours * 3_600_000) / 60_000);
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/* ------------------------------------------------------------------ */
/* Business-timezone wall-clock helpers (DST-safe)                     */
/* ------------------------------------------------------------------ */

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function tzOffsetMs(timeZone: string, instantMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instantMs));
  const get = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? NaN);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  if (!Number.isFinite(asUtc)) throw new Error(`Cannot resolve wall clock in timezone ${timeZone}`);
  return asUtc - instantMs;
}

function wallClockIn(timeZone: string, instantMs: number): WallClock {
  const offset = tzOffsetMs(timeZone, instantMs);
  const wall = new Date(instantMs + offset);
  return {
    year: wall.getUTCFullYear(),
    month: wall.getUTCMonth() + 1,
    day: wall.getUTCDate(),
    hour: wall.getUTCHours(),
    minute: wall.getUTCMinutes(),
    second: wall.getUTCSeconds(),
  };
}

/**
 * Resolve a wall-clock reading to a UTC instant, verifying the round trip.
 * Returns null across DST gaps or ambiguous fall-back hours, where local
 * suitability cannot be proven — the caller must then ask instead of guess.
 */
function utcFromWallClock(timeZone: string, wall: WallClock): number | null {
  const guess = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  const first = guess - tzOffsetMs(timeZone, guess);
  const second = guess - tzOffsetMs(timeZone, first);
  const back = wallClockIn(timeZone, second);
  if (
    back.year !== wall.year || back.month !== wall.month || back.day !== wall.day ||
    back.hour !== wall.hour || back.minute !== wall.minute || back.second !== wall.second
  ) {
    return null;
  }
  return second;
}

function sameWallClock(left: WallClock, right: WallClock): boolean {
  return left.hour === right.hour && left.minute === right.minute && left.second === right.second;
}

/**
 * Carve alternative windows that preserve the requested duration in
 * business-local time. Each available slot first offers the requested local
 * clock time on its own dates; only when that does not fit, collides with
 * busy evidence, or cannot be proven across a DST transition does the
 * earliest fitting window serve, flagged as a time shift so the host asks
 * instead of silently replacing an evening dinner with a midnight slot.
 */
function carveAlternativeWindows(args: {
  requestedStart: string;
  requestedEnd: string;
  slots: AvailabilitySlot[];
  timeZone: string;
  limit: number;
}): CarvedWindow[] {
  const durationMs = parseInstant(args.requestedEnd) - parseInstant(args.requestedStart);
  if (!Number.isFinite(durationMs) || durationMs <= 0) return [];
  const requestedWall = wallClockIn(args.timeZone, parseInstant(args.requestedStart));
  const out: CarvedWindow[] = [];
  const ordered = args.slots
    .filter((slot) => slot.available)
    .sort((left, right) => left.startAt.localeCompare(right.startAt));
  for (const slot of ordered) {
    if (out.length >= args.limit) break;
    const slotStart = parseInstant(slot.startAt);
    const slotEnd = parseInstant(slot.endAt);
    if (!Number.isFinite(slotStart) || !Number.isFinite(slotEnd) || slotEnd - slotStart < durationMs) continue;
    // Same local clock time on the slot's dates, advancing day by day.
    const baseWall = wallClockIn(args.timeZone, slotStart);
    let placedSameClock = false;
    let sameClockCollidesBusy = false;
    for (let dayOffset = 0; dayOffset < 366 && !placedSameClock; dayOffset += 1) {
      const date = new Date(Date.UTC(baseWall.year, baseWall.month - 1, baseWall.day) + dayOffset * DAY_MS);
      const candidate = utcFromWallClock(args.timeZone, {
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        day: date.getUTCDate(),
        hour: requestedWall.hour,
        minute: requestedWall.minute,
        second: requestedWall.second,
      });
      if (candidate === null || candidate < slotStart || candidate + durationMs > slotEnd) continue;
      const startAt = new Date(candidate).toISOString();
      const endAt = new Date(candidate + durationMs).toISOString();
      out.push({ startAt, endAt, sameClockTime: true });
      placedSameClock = true;
      sameClockCollidesBusy = args.slots.some(
        (busy) => !busy.available && rangesOverlap(busy.startAt, busy.endAt, startAt, endAt),
      );
    }
    /* Offer the earliest fitting window too when no same-clock window fit,
       or when the same-clock one collides with busy evidence and may be
       unusable for every space downstream. */
    if (placedSameClock && !sameClockCollidesBusy) continue;
    const fallbackStart = new Date(slotStart).toISOString();
    const fallbackEnd = new Date(slotStart + durationMs).toISOString();
    if (fallbackEnd <= slot.endAt) {
      out.push({
        startAt: fallbackStart,
        endAt: fallbackEnd,
        sameClockTime: sameWallClock(wallClockIn(args.timeZone, slotStart), requestedWall),
      });
    }
  }
  return out;
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

  /* Business scope: knowledge for one business can never authorize offers for another. */
  if (knowledge.businessId !== inquiry.businessId) {
    throw new Error(`knowledge.businessId ${knowledge.businessId} does not match inquiry.businessId ${inquiry.businessId}`);
  }

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
  const preparedMs = parseInstant(preparedAt);
  const observedMs = parseInstant(availability.observedAt);
  const asOfMs = parseInstant(availability.asOf);
  if (!Number.isFinite(observedMs) || !Number.isFinite(asOfMs)) {
    missingInformation.push({
      code: "missing_availability_time",
      field: "availability.observedAt/asOf",
      detail: "Availability evidence has no usable observation timestamps.",
      ownerQuestion: "Can availability be rechecked now so the evidence is fresh?",
    });
  } else if (observedMs > asOfMs || asOfMs > preparedMs) {
    /* Freshness is judged on the trusted preparation clock: evidence stamped
       after preparation, or observed after it was read, is inconsistent and
       cannot authorize an offer. */
    missingInformation.push({
      code: "stale_availability",
      field: "availability.observedAt/asOf",
      detail: `Availability timestamps are inconsistent with the trusted preparation clock (observedAt ${availability.observedAt}, asOf ${availability.asOf}, preparedAt ${preparedAt}).`,
      ownerQuestion: "Recheck calendar availability now so the evidence predates preparation?",
    });
  } else if (preparedMs - observedMs > availability.maxFreshnessMs) {
    missingInformation.push({
      code: "stale_availability",
      field: "availability.observedAt",
      detail: `Availability was observed ${preparedMs - observedMs}ms before the trusted preparation clock, beyond the ${availability.maxFreshnessMs}ms freshness bound.`,
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
    /* Primary path: only spaces whose requested window is covered for them
       and free of their own busy evidence are attempted, so Room B busy
       never blocks Room A (and vice versa). */
    const cleanSpaces = orderedSpaces.filter((space) =>
      windowClaimableForSpace(availability.slots, inquiry.startAt, inquiry.endAt, space.spaceId),
    );
    if (cleanSpaces.length > 0) {
      let primaryPlaced = false;
      for (const space of cleanSpaces) {
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
      const anyBusyOverlap = availability.slots.some(
        (slot) => !slot.available && rangesOverlap(slot.startAt, slot.endAt, inquiry.startAt, inquiry.endAt),
      );
      conflicts.push({
        code: "requested_date_unavailable",
        detail: anyBusyOverlap
          ? `The requested window ${inquiry.startAt} to ${inquiry.endAt} overlaps busy/conflicting evidence and cannot be claimed as feasible.`
          : `The requested window ${inquiry.startAt} to ${inquiry.endAt} is not covered by any available slot for a fitting space.`,
        evidence: dedupeSources([
          ...unavailableEvidence.map((slot) => slot.sourceReferences),
          availability.sourceReferences,
        ]),
      });
      const durationMs = endMs - startMs;
      const carved = carveAlternativeWindows({
        requestedStart: inquiry.startAt,
        requestedEnd: inquiry.endAt,
        slots: availability.slots,
        timeZone: knowledge.timezone,
        limit: 3,
      });
      let placedWindows = 0;
      const offeredWindows = new Set<string>();
      for (const window of carved) {
        if (offers.length >= 3) break;
        const windowKey = `${window.startAt}/${window.endAt}`;
        if (offeredWindows.has(windowKey)) continue;
        /* First fitting space whose carved window is claimable for it. */
        const viable = orderedSpaces.filter((space) =>
          windowClaimableForSpace(availability.slots, window.startAt, window.endAt, space.spaceId),
        );
        const space = viable[0];
        if (space === undefined) continue;
        const attempt = buildCandidate({
          inquiry,
          knowledge,
          availability,
          space,
          startAt: window.startAt,
          endAt: window.endAt,
          rank: "alternative",
          version,
          ...(supersedesFingerprint === undefined ? {} : { supersedesFingerprint }),
          alternativeNote: `Alternative ${window.sameClockTime ? "same local time, different date" : "different time"}: the requested window is unavailable; this offer preserves the requested ${formatDuration(durationMs)} duration at ${window.startAt} to ${window.endAt} (${knowledge.timezone}).`,
        });
        conflicts.push(...attempt.conflicts.filter((conflict) => conflict.code !== "requested_date_unavailable"));
        ownerDecisions.push(...attempt.decisions);
        if (attempt.candidate !== undefined) {
          offers.push(attempt.candidate);
          offeredWindows.add(windowKey);
          placedWindows += 1;
          if (!window.sameClockTime) {
            ownerDecisions.push({
              code: "alternative_time_shift",
              question: `The only fitting window is ${window.startAt} to ${window.endAt}, outside the requested local clock time; ask the customer before sending?`,
              context: "No suitable-time alternative was evidenced, so the shifted time needs an explicit decision instead of silently replacing the request.",
              evidence: dedupeSources([availability.sourceReferences]),
            });
          }
        }
        if (primaryProfitability === undefined) primaryProfitability = attempt.profitability;
      }
      if (placedWindows === 0) {
        conflicts.push({
          code: "no_alternative_slots",
          detail: "No available alternative window fitting the requested duration was evidenced for a fitting space, so no alternative can be offered.",
          evidence: [...availability.sourceReferences],
        });
      }
    }
  }

  /* Budget demotion already happened per candidate inside buildCandidate;
     every over-budget offer above carries its conflict and decision. */
  const primary = offers.find((offer) => offer.rank === "primary");

  const profitability: ProfitabilityAssessment =
    primaryProfitability ??
    assessProfitability({
      totalCents: null,
      unknownPriceIds: knowledge.priceBook.lines.filter((line) => line.unitCents === null).map((line) => line.lineId),
      costs: knowledge.priceBook.costs,
      costsComplete: knowledge.priceBook.costsComplete,
      floorCents: knowledge.priceBook.floorCents,
      minMarginBps: knowledge.priceBook.minMarginBps,
      currency: knowledge.priceBook.currency,
    });

  /* feasible means ready-to-send: a primary candidate with a known total
     and no unresolved missing, conflict, or owner decision. Profitability
     may be claimed-profitable, or explicitly unknown with notice when no
     cost-dependent margin rule exists (any unknown case needing resolution
     always raises a decision above, which already blocks feasibility). */
  const status: OfferStatus =
    primary !== undefined &&
    primary.totalKnown &&
    (primary.profitabilityClaimed || profitability.claim === "unknown") &&
    missingInformation.length === 0 &&
    conflicts.length === 0 &&
    ownerDecisions.length === 0
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
      `Primary offer ${primary.offerId} v${version}: ${primary.guestCount} guests in ${primary.spaceName}, total ${primary.totalCents === null ? "unknown" : formatMoney(primary.totalCents, primary.currency)}.`,
    );
  }
  for (const offer of offers.filter((item) => item.rank === "alternative")) {
    consequences.push(`Alternative ${offer.offerId}: ${offer.spaceName} from ${offer.startAt} to ${offer.endAt}.`);
  }
  if (status === "feasible") {
    consequences.push("The offer is ready-to-send under current evidence; owner approval must still bind this exact version and fingerprint.");
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
