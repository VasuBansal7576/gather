import type { BookingStatus } from "./contracts.ts";

/**
 * ADR-010 owner-facing booking lifecycle DTOs (exported for ADR-006 UI/API
 * composition).
 *
 * These types are an additive adapter over the existing durable domain
 * records: they never replace `BookingStatus`, `ProposedAction`,
 * `ActionExecution`, or the coordination waiting rows. The stage mapping
 * below translates stored states into the owner-visible journey
 * (inquiry/qualification -> proposed -> approved -> provisional -> accepted
 * -> confirmed, plus blocked/paused/cancelled) without a destructive enum
 * rewrite.
 */

export type LifecycleStage =
  | "inquiry"
  | "qualification"
  | "proposed"
  | "approved"
  | "provisional"
  | "accepted"
  | "confirmed"
  | "blocked"
  | "paused"
  | "cancelled";

export type LifecycleControlState = "active" | "paused" | "cancelled";

export interface LifecycleProposalRef {
  actionId: string;
  version: number;
  fingerprint: string;
  isCurrent: boolean;
  hasLiveApproval: boolean;
}

export interface LifecycleHoldRef {
  operationKey: string;
  holdId?: string;
  calendarId: string;
  startAt: string;
  endAt: string;
  expiresAt: string;
  expired: boolean;
  /** True when this receipt is reused by a later price-only revision. */
  reusedByLaterRevision?: boolean;
}

export interface LifecycleFollowupRef {
  waitingId?: string;
  status?: string;
  dueAt?: string;
  suppressedByReply?: boolean;
  paused?: boolean;
}

export interface BookingLifecycleDTO {
  bookingId: string;
  businessId: string;
  stage: LifecycleStage;
  controlState: LifecycleControlState;
  proposal: LifecycleProposalRef | null;
  hold: LifecycleHoldRef | null;
  followup: LifecycleFollowupRef | null;
  /** Owner-actionable outstanding items (questions, decisions, approvals). */
  outstanding: string[];
  provenanceNote: string;
}

/**
 * Map a stored booking status plus control state to the owner-visible
 * stage. Terminal states win: cancelled, then confirmed (accepted terms are
 * immutable and never demoted), then pause, then failure/uncertainty
 * (blocked), then the forward journey.
 */
export function stageForBooking(input: {
  status: BookingStatus;
  controlState: LifecycleControlState;
  hasLiveApproval: boolean;
}): LifecycleStage {
  if (input.controlState === "cancelled" || input.status === "cancelled") return "cancelled";
  if (input.status === "confirmed") return "confirmed";
  if (input.controlState === "paused") return "paused";
  if (input.status === "failed" || input.status === "uncertain") return "blocked";
  switch (input.status) {
    case "inquiry":
      return "inquiry";
    case "proposed":
    case "pending_approval":
      return input.hasLiveApproval ? "approved" : "proposed";
    case "provisional_hold":
      return "provisional";
    default:
      return "blocked";
  }
}

/**
 * Accepted is not confirmed: a booking with an accepted offer but
 * outstanding delivery conditions stays provisional until authoritative
 * evidence (or an explicit owner waiver) arrives. This helper renders that
 * distinction for owner surfaces without inventing a new stored status.
 */
export function stageWithAcceptance(input: {
  status: BookingStatus;
  controlState: LifecycleControlState;
  hasLiveApproval: boolean;
  acceptanceRecorded: boolean;
  conditionsOutstanding: boolean;
}): LifecycleStage {
  const base = stageForBooking(input);
  if (base === "provisional" && input.acceptanceRecorded && input.conditionsOutstanding) return "accepted";
  if (base === "provisional" && input.acceptanceRecorded) return "accepted";
  return base;
}
