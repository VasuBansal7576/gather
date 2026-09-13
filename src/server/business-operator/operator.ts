import { proposalFingerprint } from "../../domain/proposals.ts";
import type { SourceReference } from "../../domain/contracts.ts";
import { randomUUID } from "node:crypto";
import { getActiveIdentityLink, ensureBookingIdentityTables } from "../../identity/store.ts";
import { KnowledgeService } from "../../knowledge/service.ts";
import type { IntakeCandidateInput } from "../../knowledge/service.ts";
import type { CalendarAvailabilityReader } from "../../connectors/contracts.ts";
import { availabilityOperationKey } from "../../connectors/contracts.ts";
import { adaptBusinessFacts, buildAvailabilityEvidence } from "../../offers/adapters.ts";
import { prepareOffer } from "../../offers/prepare.ts";
import type { OfferPreparationResult } from "../../offers/index.ts";
import type { GatherStore } from "../sqlite-store.ts";
import {
  previewConsequences,
  resolveHoldParams,
  ServiceError,
  type BookingServiceDeps,
} from "../booking-service.ts";
import type {
  OperatorPrepareEmail,
  OperatorPrepareRequest,
  OperatorPrepareResult,
  PersistedProposal,
  ProposalMissingItem,
} from "./types.ts";

/**
 * Business operator: candidate intake, owner decisions, and booking proposal
 * preparation/persistence over the shared GatherStore. It never approves,
 * sends, or holds anything itself — the existing approve/retry pipeline owns
 * execution. All fixture content keeps its source labels; nothing here mints
 * authority except explicit owner decisions recorded by KnowledgeService.
 */

export interface OperatorDeps {
  store: GatherStore;
  booking: BookingServiceDeps;
  /** Host-derived local owner identity; request-supplied actors are ignored. */
  ownerId: string;
  /**
   * Typed injected availability port the host fetched-approval path reads.
   * Always an approved provider port (scripted fakes in tests); the request
   * itself can never supply availability evidence.
   */
  availability: CalendarAvailabilityReader;
}

function clockMs(deps: OperatorDeps): number {
  if (!deps.booking.now) return Date.now();
  const parsed = Date.parse(deps.booking.now());
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function ownerActor(deps: OperatorDeps): { kind: "owner"; id: string } {
  return { kind: "owner", id: deps.ownerId };
}

/**
 * Strict nested source validation before anything reaches owner decisions:
 * every element must be a real source object (known kind, locator, typed
 * optionals) within sensible bounds. Malformed provenance is rejected here,
 * never laundered into verified authority downstream.
 */
const MAX_SOURCE_REFS = 100;
const MAX_LOCATOR_LENGTH = 500;
const MAX_LABEL_LENGTH = 500;

function readStrictSources(value: unknown, path: string): SourceReference[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SOURCE_REFS) {
    throw new ServiceError("INVALID_REQUEST", `${path} must be a non-empty array of at most ${MAX_SOURCE_REFS} references`, false);
  }
  return value.map((entry, index) => {
    const where = `${path}[${index}]`;
    if (!isRecord(entry)) throw new ServiceError("INVALID_REQUEST", `${where} must be an object`, false);
    if (typeof entry.kind !== "string" || !KNOWN_SOURCE_KINDS.has(entry.kind)) {
      throw new ServiceError("INVALID_REQUEST", `${where} has an unknown kind`, false);
    }
    if (!nonEmptyString(entry.locator) || (entry.locator as string).length > MAX_LOCATOR_LENGTH) {
      throw new ServiceError("INVALID_REQUEST", `${where} needs a non-empty locator of at most ${MAX_LOCATOR_LENGTH} characters`, false);
    }
    if (entry.label !== undefined && (typeof entry.label !== "string" || (entry.label as string).length > MAX_LABEL_LENGTH)) {
      throw new ServiceError("INVALID_REQUEST", `${where}.label must be a string of at most ${MAX_LABEL_LENGTH} characters`, false);
    }
    if (entry.fictional !== undefined && typeof entry.fictional !== "boolean") {
      throw new ServiceError("INVALID_REQUEST", `${where}.fictional must be a boolean`, false);
    }
    return entry as unknown as SourceReference;
  });
}

/** Attributable candidate intake from explicit connector evidence. */
export function intakeOperatorCandidate(deps: OperatorDeps, input: unknown): ReturnType<KnowledgeService["intakeCandidate"]> {
  if (!isRecord(input)) throw new ServiceError("INVALID_REQUEST", "Candidate intake requires a JSON object", false);
  const service = new KnowledgeService(deps.store);
  const candidate = { ...(input as Record<string, unknown>) };
  if (candidate.sourceReferences !== undefined) {
    candidate.sourceReferences = readStrictSources(candidate.sourceReferences, "sourceReferences");
  }
  return service.intakeCandidate(candidate as unknown as IntakeCandidateInput);
}

export type OperatorDecisionKind = "confirm" | "correct" | "reject" | "exception";

/**
 * Explicit owner decisions. The approving actor is always the host-derived
 * owner identity; any request-supplied actor (including customer or model
 * text) is ignored and can never mint authority.
 */
export function decideOperator(deps: OperatorDeps, kind: OperatorDecisionKind, params: Record<string, unknown>): unknown {
  const service = new KnowledgeService(deps.store);
  const actor = ownerActor(deps);
  switch (kind) {
    case "confirm": {
      const candidateId = nonEmptyString(params.candidateId);
      if (!candidateId) throw new ServiceError("INVALID_REQUEST", "confirm requires candidateId", false);
      return service.confirmCandidate({
        businessId: requireBusinessId(params), actor, candidateId,
        ...(typeof params.commandId === "string" ? { commandId: params.commandId } : {}),
      });
    }
    case "reject": {
      const candidateId = nonEmptyString(params.candidateId);
      if (!candidateId) throw new ServiceError("INVALID_REQUEST", "reject requires candidateId", false);
      return service.rejectCandidate({
        businessId: requireBusinessId(params), actor, candidateId,
        ...(typeof params.reason === "string" ? { reason: params.reason } : {}),
        ...(typeof params.commandId === "string" ? { commandId: params.commandId } : {}),
      });
    }
    case "correct": {
      const key = nonEmptyString(params.key);
      if (!key) throw new ServiceError("INVALID_REQUEST", "correct requires key", false);
      const expectedRevision = params.expectedRevision;
      if (typeof expectedRevision !== "number" || !Number.isInteger(expectedRevision) || expectedRevision < 1) {
        throw new ServiceError("INVALID_REQUEST", "correct requires a positive integer expectedRevision", false);
      }
      if (!isRecord(params.value)) throw new ServiceError("INVALID_REQUEST", "correct requires an object value", false);
      const correctSources = params.sourceReferences === undefined
        ? undefined
        : readStrictSources(params.sourceReferences, "sourceReferences");
      return service.correctFact({
        businessId: requireBusinessId(params), actor, key, expectedRevision, value: params.value,
        ...(nonEmptyString(params.subjectId) ? { subjectId: params.subjectId as string } : {}),
        ...(correctSources === undefined ? {} : { sourceReferences: correctSources }),
        ...(typeof params.commandId === "string" ? { commandId: params.commandId } : {}),
      });
    }
    case "exception": {
      const scope = params.scope;
      if (scope !== "booking" && scope !== "customer") {
        throw new ServiceError("INVALID_REQUEST", "exception requires scope booking or customer", false);
      }
      const scopeId = nonEmptyString(params.scopeId);
      const policyId = nonEmptyString(params.policyId);
      const effect = params.effect;
      if (!scopeId) throw new ServiceError("INVALID_REQUEST", "exception requires scopeId", false);
      if (!policyId) throw new ServiceError("INVALID_REQUEST", "exception requires policyId", false);
      if (effect !== "allow" && effect !== "require_owner_decision") {
        throw new ServiceError("INVALID_REQUEST", "exception requires effect allow or require_owner_decision", false);
      }
      if (!isRecord(params.value)) throw new ServiceError("INVALID_REQUEST", "exception requires an object value", false);
      return service.addScopedException({
        businessId: requireBusinessId(params), actor, policyId, effect, scope, scopeId, value: params.value,
        ...(nonEmptyString(params.subjectId) ? { subjectId: params.subjectId as string } : {}),
        ...(typeof params.commandId === "string" ? { commandId: params.commandId } : {}),
      });
    }
    default:
      throw new ServiceError("INVALID_REQUEST", `unknown decision kind ${(kind as string) ?? "missing"}`, false);
  }
}

function requireBusinessId(params: Record<string, unknown>): string {
  const businessId = nonEmptyString(params.businessId);
  if (!businessId) throw new ServiceError("INVALID_REQUEST", "businessId is required", false);
  return businessId;
}

/** Server-side validator identity: citations always name this host, never the request. */
const HOST_VALIDATOR = "business-operator-host";

/** Freshness bound for host-fetched availability evidence. */
const AVAILABILITY_FRESHNESS_MS = 5 * 60 * 1000;

interface ValidatedInquiry {
  inquiryId: string;
  businessId: string;
  eventType: string;
  startAt: string;
  endAt: string;
  guestCount: number;
  serviceRequirements: string[];
  budgetCents?: { min?: number; max?: number };
  customerId?: string;
  preferredSpaceId?: string;
  sourceReferences: SourceReference[];
  validatedAt: string;
  validator: string;
}

/**
 * Validate raw inquiry content server-side. Structural failures throw
 * INVALID_REQUEST naming the path; semantically empty values pass through
 * so prepareOffer reports them as explicit missing decisions. Any
 * request-supplied validator/validatedAt is stripped and replaced with this
 * host's citation — raw requests can never establish trusted evidence.
 */
function validateInquiryContent(deps: OperatorDeps, content: unknown, nowIso: string): ValidatedInquiry {
  if (!isRecord(content)) throw new ServiceError("INVALID_REQUEST", "inquiry must be an object", false);
  const fail = (detail: string): never => {
    throw new ServiceError("INVALID_REQUEST", `inquiry.${detail}`, false);
  };
  const inquiryId = nonEmptyString(content.inquiryId);
  if (!inquiryId) fail("inquiryId must be a non-empty string");
  const businessId = nonEmptyString(content.businessId);
  if (!businessId) fail("businessId must be a non-empty string");
  if (typeof content.eventType !== "string") fail("eventType must be a string");
  if (typeof content.startAt !== "string") fail("startAt must be a string");
  if (typeof content.endAt !== "string") fail("endAt must be a string");
  if (typeof content.guestCount !== "number") fail("guestCount must be a number");
  if (!Array.isArray(content.serviceRequirements) || !content.serviceRequirements.every((s) => typeof s === "string")) {
    fail("serviceRequirements must be a string array");
  }
  const out: ValidatedInquiry = {
    inquiryId: inquiryId as string,
    businessId: businessId as string,
    eventType: content.eventType as string,
    startAt: content.startAt as string,
    endAt: content.endAt as string,
    guestCount: content.guestCount as number,
    serviceRequirements: [...(content.serviceRequirements as string[])],
    sourceReferences: readInquirySources(content.sourceReferences),
    validatedAt: nowIso,
    validator: HOST_VALIDATOR,
  };
  if (content.budgetCents !== undefined) {
    if (!isRecord(content.budgetCents)) fail("budgetCents must be an object when present");
    const budget = content.budgetCents as Record<string, unknown>;
    const parsedBudget: { min?: number; max?: number } = {};
    for (const field of ["min", "max"] as const) {
      const entry: unknown = budget[field];
      if (entry === undefined || entry === null) continue;
      if (typeof entry === "number" && Number.isInteger(entry) && entry >= 0) {
        parsedBudget[field] = entry;
      } else {
        fail(`budgetCents.${field} must be a non-negative integer or null`);
      }
    }
    out.budgetCents = parsedBudget;
  }
  const customerId = content.customerId;
  if (customerId !== undefined) {
    if (!nonEmptyString(customerId)) fail("customerId must be a non-empty string when present");
    out.customerId = customerId as string;
  }
  const preferredSpaceId = content.preferredSpaceId;
  if (preferredSpaceId !== undefined) {
    if (!nonEmptyString(preferredSpaceId)) fail("preferredSpaceId must be a non-empty string when present");
    out.preferredSpaceId = preferredSpaceId as string;
  }
  return out;
}

const KNOWN_SOURCE_KINDS = new Set(["connected_account", "document", "email", "calendar", "manual", "fixture"]);

function readInquirySources(value: unknown): SourceReference[] {
  if (!Array.isArray(value)) throw new ServiceError("INVALID_REQUEST", "inquiry.sourceReferences must be an array", false);
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new ServiceError("INVALID_REQUEST", `inquiry.sourceReferences[${index}] must be an object`, false);
    if (typeof entry.kind !== "string" || !KNOWN_SOURCE_KINDS.has(entry.kind)) {
      throw new ServiceError("INVALID_REQUEST", `inquiry.sourceReferences[${index}] has an unknown kind`, false);
    }
    if (!nonEmptyString(entry.locator)) {
      throw new ServiceError("INVALID_REQUEST", `inquiry.sourceReferences[${index}] needs a locator`, false);
    }
    if (entry.label !== undefined && typeof entry.label !== "string") {
      throw new ServiceError("INVALID_REQUEST", `inquiry.sourceReferences[${index}].label must be a string`, false);
    }
    if (entry.fictional !== undefined && typeof entry.fictional !== "boolean") {
      throw new ServiceError("INVALID_REQUEST", `inquiry.sourceReferences[${index}].fictional must be a boolean`, false);
    }
    return entry as unknown as SourceReference;
  });
}

interface FetchedAvailability {
  /** Evidence input for buildAvailabilityEvidence (honest, possibly empty). */
  input: Record<string, unknown>;
  readerSimulated: boolean | null;
  failure?: string;
  fresh: boolean;
}

/**
 * Fetch fresh availability through the injected calendar port for exactly
 * the hold calendar and window. Slots are mapped to venue-wide offers
 * evidence because the hold decision consumes them at the hold-calendar
 * level for the requested window (per-room holds on other calendars need
 * their own preparations). A failing reader degrades to empty evidence —
 * explicitly unavailable, never invented — with the failure recorded.
 */
async function fetchAvailability(
  deps: OperatorDeps,
  bookingId: string,
  calendarId: string,
  startAt: string,
  endAt: string,
  nowIso: string,
): Promise<FetchedAvailability> {
  const operationKey =
    `operator-prepare:${bookingId}:${availabilityOperationKey({ calendarId, startAt, endAt })}:${nowIso}:${randomUUID().slice(0, 8)}`;
  let result;
  try {
    result = await deps.availability.checkAvailability({ operationKey, calendarId, startAt, endAt });
  } catch (error) {
    return {
      input: emptyEvidence(calendarId, nowIso),
      readerSimulated: null,
      failure: error instanceof Error ? error.message : "Availability read threw before responding",
      fresh: false,
    };
  }
  if (result.status !== "succeeded") {
    return {
      input: emptyEvidence(calendarId, nowIso),
      readerSimulated: null,
      failure: `${result.error.kind}: ${result.error.message}`,
      fresh: false,
    };
  }
  return {
    input: {
      calendarId,
      observedAt: nowIso,
      asOf: nowIso,
      maxFreshnessMs: AVAILABILITY_FRESHNESS_MS,
      slots: result.data.slots.map((slot) => ({
        startAt: slot.startAt,
        endAt: slot.endAt,
        available: slot.available,
        ...(slot.reason === undefined ? {} : { reason: slot.reason }),
        venueWide: true,
        sourceReferences: slot.sourceReferences,
      })),
      sourceReferences: result.data.provenance,
    },
    readerSimulated: result.metadata.simulated,
    fresh: true,
  };
}

function emptyEvidence(calendarId: string, nowIso: string): Record<string, unknown> {
  return {
    calendarId,
    observedAt: nowIso,
    asOf: nowIso,
    maxFreshnessMs: AVAILABILITY_FRESHNESS_MS,
    slots: [],
    sourceReferences: [{ kind: "manual", locator: "gather://operator/availability-unavailable", label: "Host reports no availability observations" }],
  };
}

export interface BuiltOffer {
  offer: OfferPreparationResult;
  /** Snapshot fact ids backing this offer (for the stale re-check at persist). */
  snapshotFactIds: string[];
  businessId: string;
  bookingId: string;
  calendarId: string;
  /** Null when the reader could not serve (degraded to empty evidence). */
  readerSimulated: boolean | null;
  readerFailure?: string;
  availabilityFresh: boolean;
}
/**
 * Build a booking offer from trusted current state without persisting
 * anything: exact matched booking, server-validated inquiry, confirmed
 * current knowledge (withheld facts excluded by the snapshot), and freshly
 * fetched account-scoped availability. Unknown recipients, dates, prices,
 * or business facts surface as the offer's own missing/conflict/decision
 * entries — never invented values. The request can never supply
 * availability evidence, provenance, or validator identity: slots come only
 * from the injected reader, provenance only from observed sources, and the
 * validator stamp is always this host.
 */
export async function buildBookingOffer(deps: OperatorDeps, request: OperatorPrepareRequest): Promise<BuiltOffer> {
  if (!isRecord(request as unknown)) throw new ServiceError("INVALID_REQUEST", "Prepare requires a JSON object", false);
  const bookingId = nonEmptyString(request.bookingId);
  const calendarId = nonEmptyString(request.calendarId);
  if (!bookingId) throw new ServiceError("INVALID_REQUEST", "bookingId is required", false);
  if (!calendarId) throw new ServiceError("INVALID_REQUEST", "calendarId is required", false);
  if ((request as unknown as Record<string, unknown>).availability !== undefined) {
    throw new ServiceError(
      "INVALID_REQUEST",
      "Availability evidence is host-fetched, never request-supplied: omit availability; the operator reads the injected calendar port",
      false,
    );
  }
  let booking;
  try {
    booking = deps.store.getBooking(bookingId);
  } catch {
    throw new ServiceError("NOT_FOUND", `Booking not found: ${bookingId}`, false);
  }
  if (request.sourceKey !== undefined) {
    if (!nonEmptyString(request.sourceKey)) throw new ServiceError("INVALID_REQUEST", "sourceKey must be a non-empty string", false);
    ensureBookingIdentityTables(deps.store);
    const link = getActiveIdentityLink(deps.store, request.sourceKey);
    if (!link) {
      throw new ServiceError("INVALID_REQUEST", "No active identity link for sourceKey; an owner decision is required before preparing", false);
    }
    if (link.bookingId !== bookingId) {
      throw new ServiceError("CROSS_BOOKING", "Active identity link points at a different booking; refusing cross-booking preparation", false);
    }
  }
  const nowMs = clockMs(deps);
  const nowIso = new Date(nowMs).toISOString();
  const inquiry = validateInquiryContent(deps, request.inquiry, nowIso);
  if (inquiry.businessId !== booking.businessId) {
    throw new ServiceError("CROSS_BOOKING", "Inquiry business does not match the booking business; refusing cross-booking preparation", false);
  }
  const service = new KnowledgeService(deps.store);
  const snapshot = service.snapshotForOffers(booking.businessId);
  let adapted;
  try {
    adapted = adaptBusinessFacts(snapshot.facts, { businessId: booking.businessId });
  } catch (error) {
    throw new ServiceError("INVALID_REQUEST", `Snapshot failed offers-adapter acceptance: ${error instanceof Error ? error.message : "unmapped facts"}`, false);
  }
  if (adapted.unparseable.length > 0) {
    throw new ServiceError(
      "INVALID_REQUEST",
      `Snapshot has ${adapted.unparseable.length} unparseable fact(s) (${adapted.unparseable.map((u) => u.factId).join(",")}); repair knowledge before preparing`,
      false,
    );
  }
  const fetched = await fetchAvailability(deps, bookingId, calendarId, inquiry.startAt, inquiry.endAt, nowIso);
  let availability;
  try {
    availability = buildAvailabilityEvidence(fetched.input);
  } catch (error) {
    throw new ServiceError("INVALID_REQUEST", `Availability evidence is malformed: ${error instanceof Error ? error.message : "bad shape"}`, false);
  }
  let offer: OfferPreparationResult;
  try {
    offer = prepareOffer({
      inquiry,
      knowledge: adapted.knowledge,
      availability,
      preparedAt: nowIso,
      ...(request.requestedVersion === undefined ? {} : { requestedVersion: request.requestedVersion }),
      ...(request.supersedesFingerprint === undefined ? {} : { supersedesFingerprint: request.supersedesFingerprint }),
    });
  } catch (error) {
    throw new ServiceError("INVALID_REQUEST", `Inquiry envelope malformed: ${error instanceof Error ? error.message : "bad shape"}`, false);
  }
  if (offer.businessId !== booking.businessId) {
    throw new ServiceError("CROSS_BOOKING", "Inquiry business does not match the booking business; refusing cross-booking preparation", false);
  }
  return {
    offer,
    snapshotFactIds: snapshot.facts.map((fact) => fact.id),
    businessId: booking.businessId,
    bookingId: booking.id,
    calendarId,
    readerSimulated: fetched.readerSimulated,
    ...(fetched.failure === undefined ? {} : { readerFailure: fetched.failure }),
    availabilityFresh: fetched.fresh,
  };
}

/**
 * Validated immutable copy of the reviewed primary's commercial terms for
 * the persisted payload. No model or raw-request offer snapshot is ever
 * accepted here — the input is always the primary already built from
 * confirmed knowledge, fresh availability, and validated inquiry — and the
 * copy is validated field by field so a malformed primary fails persistence
 * instead of persisting invented terms.
 */
function validatedOfferSnapshot(primary: OfferPreparationResult["offers"][number]): Record<string, unknown> {
  const fail = (detail: string): never => {
    throw new ServiceError("INVALID_REQUEST", `Primary offer snapshot invalid: ${detail}`, false);
  };
  if (!isRecord(primary)) fail("primary offer must be an object");
  if (!Array.isArray(primary.lines) || primary.lines.length === 0) fail("at least one priced line is required");
  if (!nonEmptyString(primary.currency)) fail("currency is required");
  if (!nonEmptyString(primary.spaceId) || !nonEmptyString(primary.spaceName)) fail("space identity is required");
  if (typeof primary.guestCount !== "number" || !Number.isInteger(primary.guestCount) || primary.guestCount < 0) {
    fail("guestCount must be a non-negative integer");
  }
  if (!Array.isArray(primary.consequences) || primary.consequences.length === 0) fail("consequences are required");
  if (!Array.isArray(primary.unknownCostIds) || !Array.isArray(primary.unknownPriceIds)) {
    fail("unknown-cost honesty lists are required");
  }
  if (primary.totalCents !== null && (typeof primary.totalCents !== "number" || !Number.isInteger(primary.totalCents) || primary.totalCents < 0)) {
    fail("totalCents must be a non-negative integer or null");
  }
  if (primary.depositCents !== null && (typeof primary.depositCents !== "number" || !Number.isInteger(primary.depositCents) || primary.depositCents < 0)) {
    fail("depositCents must be a non-negative integer or null");
  }
  return {
    offerId: primary.offerId,
    version: primary.version,
    rank: primary.rank,
    startAt: primary.startAt,
    endAt: primary.endAt,
    spaceId: primary.spaceId,
    spaceName: primary.spaceName,
    guestCount: primary.guestCount,
    currency: primary.currency,
    lines: structuredClone(primary.lines),
    totalCents: primary.totalCents,
    totalKnown: primary.totalKnown,
    depositCents: primary.depositCents,
    unknownCostIds: [...primary.unknownCostIds],
    unknownPriceIds: [...primary.unknownPriceIds],
    profitabilityClaimed: primary.profitabilityClaimed,
    consequences: [...primary.consequences],
  };
}

function missingEmail(args: { email?: OperatorPrepareEmail }): ProposalMissingItem[] {
  const missing: ProposalMissingItem[] = [];
  const email = args.email;
  if (email === undefined) {
    missing.push({ code: "email_content_missing", detail: "Approved email recipients, subject, and body are required to persist a proposal; they were not supplied." });
    return missing;
  }
  if (!Array.isArray(email.to) || email.to.length === 0 || email.to.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    missing.push({ code: "email_recipients_missing", detail: "emailTo must be a non-empty array of addresses; unknown recipients are never invented." });
  }
  if (typeof email.subject !== "string" || email.subject.trim().length === 0) {
    missing.push({ code: "email_subject_missing", detail: "emailSubject is required to persist a proposal." });
  }
  if (typeof email.body !== "string" || email.body.trim().length === 0) {
    missing.push({ code: "email_body_missing", detail: "emailBody is required to persist a proposal." });
  }
  return missing;
}

/**
 * Persist the exact proposal for a built feasible offer. Only a feasible
 * primary with a known total is persistable; everything else yields explicit
 * missing items and no row. Knowledge revisions backing the offer are
 * re-read under the write transaction: a concurrent correction that flagged
 * or superseded them aborts persistence with STALE_PROPOSAL instead of
 * publishing a stale version. Repeating an identical persist reuses the
 * existing proposal (fingerprint-bound idempotency).
 */
export function persistPreparedProposal(
  deps: OperatorDeps,
  built: BuiltOffer,
  args: { email?: OperatorPrepareEmail; expiresAt?: string },
): PersistedProposal | { missing: ProposalMissingItem[] } {
  const { offer } = built;
  const primary = offer.offers.find((item) => item.rank === "primary");
  if (offer.status !== "feasible" || !primary || !primary.totalKnown) {
    const missing: ProposalMissingItem[] = [{ code: "offer_not_feasible", detail: `Offer status is ${offer.status}; only a feasible primary with a known total may persist.` }];
    for (const item of offer.missingInformation) missing.push({ code: item.code, detail: item.detail });
    for (const item of offer.conflicts) missing.push({ code: item.code, detail: item.detail });
    for (const item of offer.ownerDecisions) missing.push({ code: item.code, detail: item.question });
    return { missing };
  }
  const missing = missingEmail(args);
  const expiresAt = args.expiresAt;
  if (expiresAt === undefined) {
    missing.push({ code: "hold_expiry_missing", detail: "expiresAt is required to persist a provisional hold; it is never defaulted." });
  }
  if (missing.length > 0) return { missing };
  const email = args.email as OperatorPrepareEmail;
  // The persisted exact snapshot: a validated immutable copy of the reviewed
  // primary's commercial terms (lines, totals, deposit, currency, space,
  // guests, consequences, unknown-cost honesty) plus the preparation
  // fingerprint. All of it sits inside the canonical proposalFingerprint,
  // so a price-only, deposit-only, or space/terms change can never reuse a
  // prior action or approval — it persists as a new action instead.
  const offerSnapshot = validatedOfferSnapshot(primary);
  const payload = {
    startAt: primary.startAt,
    endAt: primary.endAt,
    expiresAt: expiresAt as string,
    calendarId: built.calendarId,
    emailTo: email.to,
    emailSubject: email.subject,
    emailBody: email.body,
    offer: offerSnapshot,
    offerPreparationFingerprint: built.offer.fingerprint,
  };
  try {
    resolveHoldParams(payload, { nowMs: clockMs(deps) });
  } catch (error) {
    return { missing: [{ code: "proposal_window_invalid", detail: error instanceof Error ? error.message : "Proposal window is not executable" }] };
  }
  const sourceReferences = dedupeSources(primary.sources);
  const kind = "create_provisional_hold" as const;
  const fingerprint = proposalFingerprint({ bookingId: built.bookingId, kind, payload, sourceReferences });
  const nowMs = clockMs(deps);
  let action = findProposal(deps, built.bookingId, fingerprint);
  let reused = action !== undefined;
  if (!reused) {
    deps.store.db.exec("BEGIN IMMEDIATE");
    try {
      verifySnapshotCurrent(deps, built);
      action = findProposal(deps, built.bookingId, fingerprint);
      if (action) {
        // The reuse path still verifies: the found row must be live and
        // carry a live status — a deleted ghost or a superseded version is
        // never reused, and stale fact checks above are never bypassed.
        let live;
        try {
          live = deps.store.getProposedAction(action.id);
        } catch {
          live = undefined;
        }
        if (!live || (live.status !== "pending_approval" && live.status !== "approved")) {
          action = undefined;
        }
      }
      if (!action) {
        action = deps.store.createProposedAction({ bookingId: built.bookingId, kind, payload, sourceReferences });
      } else {
        reused = true;
      }
      deps.store.db.exec("COMMIT");
    } catch (error) {
      try {
        deps.store.db.exec("ROLLBACK");
      } catch {
        // Already rolled back; surface the original failure.
      }
      throw error;
    }
  }
  const preview = previewConsequences(payload, { nowMs });
  if (preview.consequences === null || !action) {
    return { missing: [{ code: "proposal_window_invalid", detail: preview.consequencesError ?? "Proposal window is not executable" }] };
  }
  return { action, consequences: preview.consequences, reused };
}

function dedupeSources(sources: SourceReference[]): SourceReference[] {
  const seen = new Set<string>();
  const out: SourceReference[] = [];
  for (const source of sources) {
    const key = `${source.kind}::${source.locator}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...source });
  }
  return out;
}

function findProposal(deps: OperatorDeps, bookingId: string, fingerprint: string) {
  return deps.store
    .listProposedActionsForBooking(bookingId)
    .find((item) => item.proposalFingerprint === fingerprint);
}

/**
 * Re-read every snapshot fact's live revision under the write lock: facts
 * that gained review flags, changed values, or lost active status since the
 * offer was built abort persistence as stale instead of publishing.
 */
function verifySnapshotCurrent(deps: OperatorDeps, built: BuiltOffer): void {
  const factIds = built.snapshotFactIds.filter((id) => !id.startsWith("gather:"));
  if (factIds.length === 0) return;
  const revisions = deps.store.db.prepare(
    "SELECT fact_id, status, review_state FROM knowledge_revisions WHERE fact_id IN (" +
      factIds.map(() => "?").join(",") +
      ")",
  ).all(...factIds) as Record<string, unknown>[];
  const seen = new Set(revisions.map((row) => String(row.fact_id)));
  for (const factId of factIds) {
    if (!seen.has(factId)) {
      throw new ServiceError("STALE_PROPOSAL", "Knowledge backing this offer changed during preparation; rebuild the offer", false);
    }
  }
  for (const row of revisions) {
    if (String(row.status) !== "active" || String(row.review_state) !== "none") {
      throw new ServiceError("STALE_PROPOSAL", "Knowledge backing this offer changed during preparation; rebuild the offer", false);
    }
  }
}

/**
 * Correlate the result mode from the actual availability port and the
 * accepted facts: live requires a live (non-simulated) reader response AND
 * zero fictional sources anywhere; anything else stays explicitly demo with
 * fixture content preserved as labeled. Simulated evidence is never passed
 * as live.
 */
export function deriveMode(readerSimulated: boolean | null, sources: SourceReference[]): OperatorPrepareResult["mode"] {
  const fictional = sources.some((source) => source.fictional === true);
  if (readerSimulated === false && !fictional) {
    return { kind: "live", label: "LIVE", fictional: false, simulated: false };
  }
  return { kind: "demo", label: "DEMO ONLY", fictional, simulated: true };
}

/**
 * One-call prepare: build the offer and, when feasible and fully specified,
 * persist the exact proposal. Never approves, sends, or holds.
 */
export async function prepareBookingProposal(deps: OperatorDeps, request: OperatorPrepareRequest): Promise<OperatorPrepareResult> {
  const built = await buildBookingOffer(deps, request);
  const persisted = persistPreparedProposal(deps, built, { email: request.email, expiresAt: request.expiresAt });
  const proposal = "missing" in persisted ? null : persisted;
  const missingForProposal = "missing" in persisted ? persisted.missing : [];
  if (built.readerFailure !== undefined) {
    missingForProposal.unshift({ code: "availability_unavailable", detail: `Fresh availability could not be read: ${built.readerFailure}.` });
  }
  const sources: SourceReference[] = [
    ...built.offer.evidence.inquiry,
    ...built.offer.evidence.business,
    ...built.offer.evidence.availability,
    ...built.offer.evidence.pricing,
  ];
  const mode = deriveMode(built.readerSimulated, sources);
  return {
    mode,
    bookingId: built.bookingId,
    businessId: built.businessId,
    availabilityFresh: built.availabilityFresh,
    offer: built.offer,
    proposal,
    missingForProposal,
    notice: mode.kind === "live"
      ? "Preparation only, from live provider evidence and attested facts. Approval, hold, and send run through the existing approve/retry pipeline with fresh availability."
      : "DEMO ONLY: preparation only. Approval, hold, and send run through the existing approve/retry pipeline with fresh availability.",
  };
}
