import { ensureBookingIdentityTables } from "../../identity/store.ts";
import {
  proposeBookingIdentity,
  recordOwnerIdentityDecision,
  type IdentityComponents,
  type IdentityHints,
} from "../../identity/service.ts";
import { listSucceededHolds, ServiceError, type BookingServiceDeps } from "../booking-service.ts";
import {
  stageForBooking,
  type BookingLifecycleDTO,
  type LifecycleControlState,
} from "../../domain/lifecycle.ts";
import type { OfferPreparationResult } from "../../offers/index.ts";
import type { OperatorPrepareEmail, OperatorPrepareResult } from "./types.ts";
import { prepareBookingProposal, type OperatorDeps } from "./operator.ts";

/**
 * ADR-010 fresh inquiry-to-offer composition (C02/C04/C05/C06/C07).
 *
 * Composes the reviewed modules without replacing their algorithms:
 * identity (`proposeBookingIdentity` + versioned owner decisions) resolves
 * which booking an inquiry belongs to; the business operator prepares a
 * deterministic offer from confirmed knowledge and fresh availability; the
 * approve/retry pipeline (booking-service) owns holds and email.
 *
 * Identity rules enforced here:
 * - weak hints (sender/date/name similarities) surface as candidates and
 *   BLOCK booking-specific writes until the owner resolves the decision;
 * - zero candidates means a genuinely new inquiry: the host creates one
 *   booking (status `inquiry`, zero initial proposals) and binds it under
 *   the versioned owner decision, so a replay of the exact provider message
 *   re-links instead of creating a duplicate booking.
 */

export interface FreshInquiryIdentity {
  components: IdentityComponents;
  hints?: IdentityHints;
}

export interface FreshInquiryRequest {
  businessId: string;
  identity: FreshInquiryIdentity;
  /** Raw inquiry content; validated server-side by the operator. */
  inquiry: Record<string, unknown>;
  calendarId: string;
  expiresAt?: string;
  email?: OperatorPrepareEmail;
  requestedVersion?: number;
  supersedesFingerprint?: string;
}

export type FreshInquiryResult =
  | {
    outcome: "prepared";
    bookingId: string;
    sourceKey: string;
    identity: { outcome: "linked" | "resolved_new_inquiry"; linkRevision?: number };
    prepare: OperatorPrepareResult;
    qualification: string[];
    lifecycle: BookingLifecycleDTO;
    notice: string;
  }
  | {
    outcome: "needs_decision";
    bookingId?: string;
    sourceKey: string;
    identity: {
      outcome: "needs_decision";
      candidates: { bookingId: string; reasons: string[] }[];
      decision: { id: string; candidateVersion: number; candidateFingerprint: string };
    };
    prepare: null;
    qualification: string[];
    lifecycle: null;
    notice: string;
  };

function inquiryLocator(inquiryId: string): string {
  return `gather://inquiry/${inquiryId}`;
}

function findBookingByInquiry(deps: OperatorDeps, businessId: string, inquiryId: string): string | undefined {
  const locator = inquiryLocator(inquiryId);
  for (const booking of deps.store.listBookings(businessId)) {
    if (booking.sourceReferences.some((ref) => ref.locator === locator)) return booking.id;
  }
  return undefined;
}

function eventNameOf(inquiry: Record<string, unknown>, inquiryId: string): string {
  const eventType = typeof inquiry.eventType === "string" && inquiry.eventType.trim().length > 0
    ? inquiry.eventType.trim()
    : "Event";
  return `${eventType} inquiry ${inquiryId}`;
}

/**
 * Batch qualification into one question per unresolved field/version.
 * Deterministic over the offer result: missing information first (in offer
 * order), then owner decisions, deduplicated by code so the customer/owner
 * is asked once, not once per candidate.
 */
export function batchQualificationQuestions(offer: OfferPreparationResult): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of offer.missingInformation) {
    const key = `missing:${item.code}:${item.field ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item.ownerQuestion);
  }
  for (const decision of offer.ownerDecisions) {
    const key = `decision:${decision.code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(decision.question);
  }
  return out;
}

/** Owner-facing lifecycle snapshot for ADR-006 surfaces (pure store read). */
export function describeBookingLifecycle(
  bookingDeps: Pick<BookingServiceDeps, "store">,
  input: { bookingId: string; controlState?: LifecycleControlState; nowMs?: number },
): BookingLifecycleDTO {
  const { store } = bookingDeps;
  const booking = store.getBooking(input.bookingId);
  const controlState = input.controlState ?? "active";
  const current = store.getCurrentProposalAction(booking.id);
  let hasLiveApproval = false;
  if (current) {
    hasLiveApproval = store.listApprovals(current.id).some(
      (approval) =>
        approval.status === "approved" &&
        approval.proposalVersion === current.proposalVersion &&
        approval.proposalFingerprint === current.proposalFingerprint,
    );
  }
  const nowMs = input.nowMs ?? Date.now();
  const holds = listSucceededHolds(store, booking.id);
  const liveHold = holds.find((hold) => {
    const expiryMs = Date.parse(hold.window.expiresAt);
    return Number.isFinite(expiryMs) && expiryMs > nowMs;
  }) ?? holds[0];
  // A fresh inquiry booking already carrying its first persisted proposal
  // reads as proposed/approved: the stored status stays "inquiry" until
  // execution, but the owner-visible journey has moved past intake.
  let stage = stageForBooking({ status: booking.status, controlState, hasLiveApproval });
  if (booking.status === "inquiry" && current) {
    stage = hasLiveApproval ? "approved" : "proposed";
  }
  return {
    bookingId: booking.id,
    businessId: booking.businessId,
    stage,
    controlState,
    proposal: current
      ? {
        actionId: current.id,
        version: current.proposalVersion,
        fingerprint: current.proposalFingerprint,
        isCurrent: true,
        hasLiveApproval,
      }
      : null,
    hold: liveHold
      ? {
        operationKey: liveHold.operationKey,
        ...(liveHold.holdId === undefined ? {} : { holdId: liveHold.holdId }),
        calendarId: liveHold.window.calendarId,
        startAt: liveHold.window.startAt,
        endAt: liveHold.window.endAt,
        expiresAt: liveHold.window.expiresAt,
        expired: Date.parse(liveHold.window.expiresAt) <= nowMs,
      }
      : null,
    followup: null,
    outstanding: [
      ...(current && !hasLiveApproval ? ["Exact owner approval for the current proposal is outstanding."] : []),
      ...(booking.status === "uncertain" ? ["Uncertain steps require reconciliation before progress."] : []),
    ],
    provenanceNote: "Lifecycle view over durable store rows; holds and emails are authoritative only through their stored provider receipts.",
  };
}

export async function prepareFreshInquiry(deps: OperatorDeps, request: FreshInquiryRequest): Promise<FreshInquiryResult> {
  if (!request || typeof request !== "object") {
    throw new ServiceError("INVALID_REQUEST", "Fresh inquiry requires a JSON object", false);
  }
  if (!request.businessId || typeof request.businessId !== "string") {
    throw new ServiceError("INVALID_REQUEST", "businessId is required", false);
  }
  const rawInquiry: Record<string, unknown> = request.inquiry as Record<string, unknown>;
  const inquiryId = typeof rawInquiry.inquiryId === "string" && rawInquiry.inquiryId.trim().length > 0
    ? rawInquiry.inquiryId
    : undefined;
  if (!inquiryId) {
    throw new ServiceError("INVALID_REQUEST", "inquiry.inquiryId is required: idempotency and replay dedupe key on it", false);
  }
  if (request.identity?.components?.businessId !== request.businessId) {
    throw new ServiceError("CROSS_BOOKING", "Identity scope business does not match the requested business", false);
  }

  ensureBookingIdentityTables(deps.store);
  const proposed = proposeBookingIdentity(deps.store, {
    components: request.identity.components,
    ...(request.identity.hints === undefined ? {} : { hints: request.identity.hints }),
  });

  if (proposed.outcome === "linked") {
    const prepare = await prepareBookingProposal(deps, {
      bookingId: proposed.bookingId,
      inquiry: rawInquiry as never,
      calendarId: request.calendarId,
      ...(request.expiresAt === undefined ? {} : { expiresAt: request.expiresAt }),
      ...(request.email === undefined ? {} : { email: request.email }),
      ...(request.requestedVersion === undefined ? {} : { requestedVersion: request.requestedVersion }),
      ...(request.supersedesFingerprint === undefined ? {} : { supersedesFingerprint: request.supersedesFingerprint }),
    });
    return {
      outcome: "prepared",
      bookingId: proposed.bookingId,
      sourceKey: proposed.sourceKey,
      identity: { outcome: "linked", linkRevision: proposed.linkRevision },
      prepare,
      qualification: batchQualificationQuestions(prepare.offer),
      lifecycle: describeBookingLifecycle(deps.booking, { bookingId: proposed.bookingId }),
      notice: "Linked to the existing booking through verified identity; offer prepared deterministically from confirmed knowledge.",
    };
  }

  // needs_decision: weak hints with candidates block until the owner
  // resolves; zero candidates is a genuinely new inquiry.
  if (proposed.candidates.length > 0) {
    const questions = proposed.candidates.map(
      (candidate) => `Message may belong to booking ${candidate.bookingId} (${candidate.reasons.join("; ")}); owner decision required — hints never auto-link.`,
    );
    return {
      outcome: "needs_decision",
      sourceKey: proposed.sourceKey,
      identity: { outcome: "needs_decision", candidates: proposed.candidates, decision: proposed.decision },
      prepare: null,
      qualification: questions,
      lifecycle: null,
      notice: "Ambiguous identity: weak hints require an owner decision before any booking-specific write.",
    };
  }

  // New inquiry: replay of the exact provider message must not duplicate.
  const replayed = findBookingByInquiry(deps, request.businessId, inquiryId);
  const bookingId = replayed ?? deps.store.createBooking({
    businessId: request.businessId,
    eventName: eventNameOf(rawInquiry, inquiryId),
    status: "inquiry",
    sourceReferences: [
      ...(Array.isArray(rawInquiry.sourceReferences) ? (rawInquiry.sourceReferences as BookingLifecycleSourceRef[]) : []),
      { kind: "manual", locator: inquiryLocator(inquiryId), label: "Fresh inquiry intake marker" },
    ],
  }).id;
  // Bind under the versioned owner decision the host just reviewed: the
  // candidate set was empty, so any booking chosen here is a new inquiry,
  // and the recorded decision makes the replay path link instead of fork.
  recordOwnerIdentityDecision(deps.store, {
    sourceKey: proposed.sourceKey,
    chosenBookingId: bookingId,
    actor: { kind: "owner", id: deps.ownerId },
    candidateVersion: proposed.decision.candidateVersion,
    candidateFingerprint: proposed.decision.candidateFingerprint,
  });

  const prepare = await prepareBookingProposal(deps, {
    bookingId,
    inquiry: rawInquiry as never,
    calendarId: request.calendarId,
    ...(request.expiresAt === undefined ? {} : { expiresAt: request.expiresAt }),
    ...(request.email === undefined ? {} : { email: request.email }),
    ...(request.requestedVersion === undefined ? {} : { requestedVersion: request.requestedVersion }),
    ...(request.supersedesFingerprint === undefined ? {} : { supersedesFingerprint: request.supersedesFingerprint }),
  });
  return {
    outcome: "prepared",
    bookingId,
    sourceKey: proposed.sourceKey,
    identity: { outcome: "resolved_new_inquiry" },
    prepare,
    qualification: batchQualificationQuestions(prepare.offer),
    lifecycle: describeBookingLifecycle(deps.booking, { bookingId }),
    notice: replayed
      ? "Replay of the exact provider message re-linked to the existing inquiry booking; no duplicate booking was created."
      : "Fresh inquiry booking created with zero initial proposals; offer prepared deterministically from confirmed knowledge.",
  };
}

interface BookingLifecycleSourceRef {
  kind: "connected_account" | "document" | "email" | "calendar" | "manual" | "fixture";
  locator: string;
  label?: string;
  fictional?: boolean;
}
