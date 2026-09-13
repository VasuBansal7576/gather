import { proposalFingerprint } from "../../domain/proposals.ts";
import type { SourceReference } from "../../domain/contracts.ts";
import { getActiveIdentityLink, ensureBookingIdentityTables } from "../../identity/store.ts";
import { KnowledgeService } from "../../knowledge/service.ts";
import type { IntakeCandidateInput } from "../../knowledge/service.ts";
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

/** Attributable candidate intake from explicit connector evidence. */
export function intakeOperatorCandidate(deps: OperatorDeps, input: unknown): ReturnType<KnowledgeService["intakeCandidate"]> {
  if (!isRecord(input)) throw new ServiceError("INVALID_REQUEST", "Candidate intake requires a JSON object", false);
  const service = new KnowledgeService(deps.store);
  return service.intakeCandidate(input as unknown as IntakeCandidateInput);
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
      return service.correctFact({
        businessId: requireBusinessId(params), actor, key, expectedRevision, value: params.value,
        ...(nonEmptyString(params.subjectId) ? { subjectId: params.subjectId as string } : {}),
        ...(params.sourceReferences !== undefined ? { sourceReferences: params.sourceReferences as SourceReference[] } : {}),
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

export interface BuiltOffer {
  offer: OfferPreparationResult;
  /** Snapshot fact ids backing this offer (for the stale re-check at persist). */
  snapshotFactIds: string[];
  businessId: string;
  bookingId: string;
  calendarId: string;
}

/**
 * Build a booking offer from trusted current state without persisting
 * anything: exact matched booking, confirmed current knowledge (withheld
 * facts excluded by the snapshot), validated inquiry, and freshly supplied
 * account-scoped availability. Unknown recipients, dates, prices, or
 * business facts surface as the offer's own missing/conflict/decision
 * entries — never invented values.
 */
export function buildBookingOffer(deps: OperatorDeps, request: OperatorPrepareRequest): BuiltOffer {
  if (!isRecord(request as unknown)) throw new ServiceError("INVALID_REQUEST", "Prepare requires a JSON object", false);
  const bookingId = nonEmptyString(request.bookingId);
  const calendarId = nonEmptyString(request.calendarId);
  if (!bookingId) throw new ServiceError("INVALID_REQUEST", "bookingId is required", false);
  if (!calendarId) throw new ServiceError("INVALID_REQUEST", "calendarId is required", false);
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
  const service = new KnowledgeService(deps.store);
  const snapshot = service.snapshotForOffers(booking.businessId);  let adapted;
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
  let availability;
  try {
    availability = buildAvailabilityEvidence(request.availability);
  } catch (error) {
    throw new ServiceError("INVALID_REQUEST", `Availability evidence is malformed: ${error instanceof Error ? error.message : "bad shape"}`, false);
  }
  if (availability.calendarId !== calendarId) {
    throw new ServiceError("INVALID_REQUEST", "Availability evidence must scope the hold calendar", false);
  }
  if (isRecord(request.inquiry)) {
    const inquiryBusiness = request.inquiry.businessId;
    if (typeof inquiryBusiness === "string" && inquiryBusiness !== booking.businessId) {
      throw new ServiceError("CROSS_BOOKING", "Inquiry business does not match the booking business; refusing cross-booking preparation", false);
    }
  }
  let offer: OfferPreparationResult;
  try {
    offer = prepareOffer({
      inquiry: request.inquiry,
      knowledge: adapted.knowledge,
      availability,
      preparedAt: deps.booking.now ? deps.booking.now() : new Date().toISOString(),
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
  const payload = {
    startAt: primary.startAt,
    endAt: primary.endAt,
    expiresAt: expiresAt as string,
    calendarId: built.calendarId,
    emailTo: email.to,
    emailSubject: email.subject,
    emailBody: email.body,
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
 * One-call prepare: build the offer and, when feasible and fully specified,
 * persist the exact proposal. Never approves, sends, or holds.
 */
export function prepareBookingProposal(deps: OperatorDeps, request: OperatorPrepareRequest): OperatorPrepareResult {
  const built = buildBookingOffer(deps, request);
  const persisted = persistPreparedProposal(deps, built, { email: request.email, expiresAt: request.expiresAt });
  const proposal = "missing" in persisted ? null : persisted;
  return {
    demo: true,
    mode: { kind: "demo", label: "DEMO ONLY", fictional: true, simulated: true },
    bookingId: built.bookingId,
    businessId: built.businessId,
    offer: built.offer,
    proposal,
    missingForProposal: "missing" in persisted ? persisted.missing : [],
    notice: "DEMO ONLY: preparation only. Approval, hold, and send run through the existing approve/retry pipeline with fresh availability.",
  };
}
