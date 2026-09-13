import { createHash } from "node:crypto";
import type { CalendarAvailabilityReader } from "../../connectors/contracts.ts";
import type { AcceptedProposal, BookingSnapshot, OperationalHandoff, ReadinessDecision } from "../../delivery/contracts.ts";
import { buildHandoff } from "../../delivery/handoff.ts";
import { evaluateBookingReadiness } from "../../delivery/verifiers.ts";
import type { Booking, ProposedAction } from "../../domain/contracts.ts";
import { emailOperationKey, holdOperationKey, ServiceError } from "../booking-service.ts";
import type { GatherStore } from "../sqlite-store.ts";
import { DeliveryStore } from "./store.ts";
import { CollectingVerifiers, StoreDeliveryVerifiers } from "./verifiers.ts";

export interface BookingDeliveryDeps {
  store: GatherStore;
  delivery: DeliveryStore;
  /**
   * Injected availability provider boundary. Without a verified provider
   * adapter, availability proofs fail closed — readiness stays unavailable
   * rather than silently using fixture evidence for a real confirmation.
   */
  calendar?: CalendarAvailabilityReader;
  ownerId?: string;
  now?: () => string;
  /**
   * Test seam only: invoked synchronously after evaluation completes and
   * before the atomic commit transaction begins, letting tests simulate
   * evidence or proposal drift between evaluation and commit.
   */
  beforeCommitRevalidation?: () => void;
}

export interface ConfirmRequestDTO {
  bookingId: string;
  proposedActionId: string;
  proposalVersion: number;
  proposalFingerprint: string;
  /** Caller-chosen idempotency key: the same command replays canonically. */
  confirmKey: string;
}

export interface ConfirmResponseDTO {
  /** True only when the evaluated evidence is not live provenance — a live-ready confirmation is never mislabeled demo. */
  demo: boolean;
  command: { confirmKey: string; status: "confirmed" | "blocked" | "failed" };
  booking: Booking;
  /** The evaluated decision for this command; null when the command failed before evaluation completed. */
  decision: ReadinessDecision | null;
  /** True only when the booking transitioned to confirmed in this command. */
  confirmedBooking: boolean;
  note: string;
}

export interface ReadinessResponseDTO {
  demo: boolean;
  booking: Booking;
  binding: ReadinessDecision["binding"];
  decision: ReadinessDecision;
}

export type HandoffState = "ready" | "preliminary" | "blocked";

export interface HandoffResponseDTO {
  demo: boolean;
  booking: Booking;
  /**
   * Numbered revision of the persisted handoff this view corresponds to.
   * GET is read-only: it reports the latest persisted revision (null when
   * none) and never creates one. POST builds and persists a new revision.
   */
  revision: number | null;
  /**
   * `ready` requires a live approval for the current exact proposal
   * version, a freshly evaluated ready+live-ready decision, and a
   * confirmed booking. `preliminary` means the approval is live but the
   * binding has not fully confirmed. `blocked` means the proposal has no
   * live approval or evaluation could not run — `reason` is explicit.
   */
  state: HandoffState;
  reason?: string;
  handoff: OperationalHandoff | null;
}

/** Lease on an in-progress confirm command before it becomes reclaimable. */
export const CONFIRM_COMMAND_LEASE_MS = 120_000;

function clockIso(deps: BookingDeliveryDeps): string {
  return deps.now ? deps.now() : new Date().toISOString();
}

function clockMs(deps: BookingDeliveryDeps): number {
  return deps.now ? Date.parse(deps.now()) : Date.now();
}

function snapshotBooking(booking: Booking): BookingSnapshot {
  return {
    id: booking.id,
    businessId: booking.businessId,
    status: booking.status,
    eventName: booking.eventName,
    startAt: booking.startAt,
    endAt: booking.endAt,
    guestCount: booking.guestCount,
    notes: booking.notes,
    sourceReferences: booking.sourceReferences,
  };
}

function snapshotProposal(action: ProposedAction, booking: Booking): AcceptedProposal {
  return {
    bookingId: booking.id,
    businessId: booking.businessId,
    proposalVersion: action.proposalVersion,
    proposalFingerprint: action.proposalFingerprint,
    kind: action.kind,
    payload: action.payload,
    sourceReferences: action.sourceReferences,
  };
}

/** Responses are demo-marked unless every cited evidence item was live. */
function demoOf(provenance: ReadinessDecision["provenance"] | undefined): boolean {
  return provenance !== "live";
}

/**
 * Executable steps the approved proposal must have durably completed before
 * confirmation — the authoritative contract is the action kind, matching the
 * steps approveAndExecute runs under their canonical operation keys. A hold
 * alone never confirms, and neither does an approval whose hold or email
 * step never ran, is still pending, or failed/uncertain.
 */
const REQUIRED_EXECUTION_STEPS: Record<string, readonly { step: "hold" | "email"; key: (actionId: string, version: number) => string }[]> = {
  create_provisional_hold: [
    { step: "hold", key: holdOperationKey },
    { step: "email", key: emailOperationKey },
  ],
};

/**
 * Require a succeeded execution under the canonical operation key for every
 * required step of the exact approved proposal version. Runs inside the
 * commit transaction so a step that completes mid-flight is seen, and a
 * mid-flight version bump was already fenced by the binding snapshot.
 */
function requireCompletedExecutions(deps: BookingDeliveryDeps, action: ProposedAction): void {
  const requiredSteps = REQUIRED_EXECUTION_STEPS[action.kind];
  if (requiredSteps === undefined) {
    throw new ServiceError("CONFLICT", `Proposal kind ${action.kind} has no declared execution steps; confirmation cannot verify it`, false);
  }
  for (const { step, key } of requiredSteps) {
    const execution = deps.store.getExecutionByIdempotencyKey(key(action.id, action.proposalVersion));
    if (execution?.status === "succeeded") continue;
    if (execution && (execution.status === "pending" || execution.status === "uncertain" || execution.status === "partial")) {
      throw new ServiceError("CONFLICT", `Required ${step} execution is still ${execution.status} for proposal v${action.proposalVersion}; reconcile it before confirming`, true);
    }
    throw new ServiceError(
      "CONFLICT",
      execution
        ? `Required ${step} execution ${execution.status} for proposal v${action.proposalVersion}; re-run the approved step before confirming`
        : `No ${step} execution exists for the approved proposal v${action.proposalVersion}; the approved steps must durably complete before confirmation`,
      false,
    );
  }
}

/** Canonical request hash binding a confirm key to its exact inputs. */
export function confirmRequestHash(input: Pick<ConfirmRequestDTO, "bookingId" | "proposedActionId" | "proposalVersion" | "proposalFingerprint">): string {
  return canonicalHash({
    bookingId: input.bookingId,
    proposedActionId: input.proposedActionId,
    proposalVersion: input.proposalVersion,
    proposalFingerprint: input.proposalFingerprint,
  });
}

function canonicalHash(value: unknown): string {
  const canonicalize = (input: unknown): unknown =>
    Array.isArray(input)
      ? input.map(canonicalize)
      : input !== null && typeof input === "object"
        ? Object.fromEntries(
            Object.entries(input as Record<string, unknown>)
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([key, nested]) => [key, canonicalize(nested)]),
          )
        : input;
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

/** The booking's current proposed action — the only proposal confirm can bind to. */
function currentAction(store: GatherStore, bookingId: string): ProposedAction {
  const actions = store.listProposedActionsForBooking(bookingId);
  const action = actions.at(-1);
  if (!action) {
    throw new ServiceError("NOT_FOUND", `No proposed action exists for booking ${bookingId}; nothing can be confirmed`, false);
  }
  return action;
}

async function evaluateForAction(
  deps: BookingDeliveryDeps,
  booking: Booking,
  action: ProposedAction,
  collecting?: CollectingVerifiers,
): Promise<ReadinessDecision> {
  const verifiers = collecting ?? new CollectingVerifiers(new StoreDeliveryVerifiers(deps.delivery, deps.calendar, () => clockIso(deps)));
  return evaluateBookingReadiness({
    nowIso: clockIso(deps),
    businessId: booking.businessId,
    booking: snapshotBooking(booking),
    proposal: snapshotProposal(action, booking),
    verifiers,
  });
}

/**
 * Read-only readiness evaluation through the trusted verifier boundary.
 * Evaluates the booking's current proposed action and returns the full
 * decision; nothing is persisted and no status ever changes on this path.
 */
export async function readinessForBooking(deps: BookingDeliveryDeps, bookingId: string): Promise<ReadinessResponseDTO> {
  const booking = deps.store.getBooking(bookingId);
  const action = currentAction(deps.store, bookingId);
  const decision = await evaluateForAction(deps, booking, action);
  return { demo: demoOf(decision.provenance), booking, binding: decision.binding, decision };
}

interface BindingSnapshot {
  bookingStatus: Booking["status"];
  actionVersion: number;
  actionFingerprint: string;
  actionStatus: ProposedAction["status"];
  approvalLive: boolean;
}

function bindingSnapshot(deps: BookingDeliveryDeps, bookingId: string, actionId: string): BindingSnapshot {
  const booking = deps.store.getBooking(bookingId);
  const action = deps.store.getProposedAction(actionId);
  const approvalLive = deps.store.listApprovals(actionId).some(
    (approval) =>
      approval.status === "approved" &&
      approval.proposalVersion === action.proposalVersion &&
      approval.proposalFingerprint === action.proposalFingerprint,
  );
  return {
    bookingStatus: booking.status,
    actionVersion: action.proposalVersion,
    actionFingerprint: action.proposalFingerprint,
    actionStatus: action.status,
    approvalLive,
  };
}

/**
 * Guarded confirmation. Revalidates the current proposal binding, fetches
 * fresh proofs through the trusted verifier boundary, then — inside one
 * transaction — re-reads the binding and every store-backed evidence set,
 * persists the evaluated decision, and transitions the booking only when
 * the decision is ready AND live-ready. A hold alone, a payment link, or
 * fixture evidence never confirms.
 *
 * The transaction never spans awaited provider calls: evaluation happens
 * first, then the commit re-validates optimistically and fails closed on
 * any drift.
 */
export async function confirmBooking(deps: BookingDeliveryDeps, input: ConfirmRequestDTO): Promise<ConfirmResponseDTO> {
  const { store, delivery } = deps;
  const booking = store.getBooking(input.bookingId);
  const action = store.getProposedAction(input.proposedActionId);
  if (action.bookingId !== booking.id) {
    throw new ServiceError("CROSS_BOOKING", "Proposed action belongs to a different booking; cross-booking confirmation is denied", false);
  }
  if (action.proposalVersion !== input.proposalVersion || action.proposalFingerprint !== input.proposalFingerprint) {
    throw new ServiceError(
      "STALE_PROPOSAL",
      `Stale proposal: expected v${action.proposalVersion}/${action.proposalFingerprint.slice(0, 12)}…, refusing confirmation`,
      false,
    );
  }
  // Authority: confirmation requires a live exact-version owner approval.
  const hasLiveApproval = store.listApprovals(action.id).some(
    (approval) =>
      approval.status === "approved" &&
      approval.proposalVersion === action.proposalVersion &&
      approval.proposalFingerprint === action.proposalFingerprint,
  );
  if (!hasLiveApproval) {
    throw new ServiceError(
      "STALE_PROPOSAL",
      `No live approval for the current proposal version (v${action.proposalVersion}); the owner must approve the displayed proposal before it can be confirmed`,
      false,
    );
  }

  const requestHash = confirmRequestHash(input);
  const reservation = delivery.reserveConfirmCommand({
    confirmKey: input.confirmKey,
    bookingId: input.bookingId,
    proposedActionId: input.proposedActionId,
    proposalVersion: input.proposalVersion,
    proposalFingerprint: input.proposalFingerprint,
    requestHash,
    leaseMs: CONFIRM_COMMAND_LEASE_MS,
    nowMs: clockMs(deps),
  });
  if (reservation.kind === "conflict") {
    throw new ServiceError("CONFLICT", `Confirm key ${input.confirmKey} is bound to a different confirmation request`, false);
  }
  if (reservation.kind === "in_progress") {
    throw new ServiceError("CONFLICT", `Confirm command ${input.confirmKey} is already in progress; retry the same command later`, true);
  }
  if (reservation.kind === "replay") {
    const command = reservation.command;
    const persisted = command.response ?? {};
    const persistedDecision = persisted.decision as ReadinessDecision | undefined;
    return {
      demo: demoOf(persistedDecision?.provenance),
      command: { confirmKey: command.confirmKey, status: command.status as "confirmed" | "blocked" | "failed" },
      booking: store.getBooking(command.bookingId),
      decision: persistedDecision ?? null,
      confirmedBooking: command.status === "confirmed",
      note: `Canonical replay of confirm command ${command.confirmKey}.`,
    };
  }

  try {
    const snapshotBefore = bindingSnapshot(deps, booking.id, action.id);
    const collecting = new CollectingVerifiers(new StoreDeliveryVerifiers(deps.delivery, deps.calendar, () => clockIso(deps)));
    const decision = await evaluateForAction(deps, booking, action, collecting);
    // A policy/evaluator throw propagates as-is (fail closed).
    deps.beforeCommitRevalidation?.();
    const outcome = delivery.transaction(() => {
      const snapshotAfter = bindingSnapshot(deps, booking.id, action.id);
      if (
        snapshotAfter.actionVersion !== snapshotBefore.actionVersion ||
        snapshotAfter.actionFingerprint !== snapshotBefore.actionFingerprint ||
        snapshotAfter.bookingStatus !== snapshotBefore.bookingStatus ||
        snapshotAfter.actionStatus !== snapshotBefore.actionStatus ||
        !snapshotAfter.approvalLive
      ) {
        throw new ServiceError("STALE_PROPOSAL", "The booking or proposal changed while proofs were being verified; the evaluation was discarded — re-confirm", true);
      }
      const drifted = collecting.driftedStoreFetches();
      if (drifted.length > 0) {
        throw new ServiceError("CONFLICT", `Evidence changed while confirmation was in flight (${drifted.join(", ")}); re-confirm against fresh proofs`, true);
      }
      // Last-line availability guard: the durable hold-conflict set must not
      // have claimed this window under a different operation while proofs
      // were verified.
      const startAt = typeof action.payload.startAt === "string" ? action.payload.startAt : undefined;
      const endAt = typeof action.payload.endAt === "string" ? action.payload.endAt : undefined;
      const calendarId = typeof action.payload.calendarId === "string" ? action.payload.calendarId : undefined;
      if (startAt && endAt && calendarId) {
        const conflict = store.findHoldConflict(calendarId, startAt, endAt, {
          excludeOperationKey: holdOperationKey(action.id, action.proposalVersion),
          nowMs: clockMs(deps),
        });
        if (conflict) {
          throw new ServiceError("SLOT_UNAVAILABLE", `The window became durably held while confirmation was in flight (record ${conflict}); confirmation refused`, false);
        }
      }
      const canConfirm = decision.ready && decision.liveReady;
      if (canConfirm) {
        // The approved steps themselves must be durably complete: confirmation
        // requires a succeeded hold AND email execution for the exact version —
        // a hold alone, a missing step, or a pending/failed/uncertain step
        // never confirms.
        requireCompletedExecutions(deps, action);
        store.updateBookingStatus(booking.id, "confirmed");
      }
      const decisionId = delivery.insertDecision(decision, action.id);
      const status = canConfirm ? "confirmed" : "blocked";
      const response: Record<string, unknown> = {
        command: { confirmKey: input.confirmKey, status },
        decision,
        decisionId,
        confirmedBooking: canConfirm,
      };
      delivery.finishConfirmCommand(input.confirmKey, status, response);
      return { canConfirm };
    });
    return {
      demo: demoOf(decision.provenance),
      command: { confirmKey: input.confirmKey, status: outcome.canConfirm ? "confirmed" : "blocked" },
      booking: store.getBooking(booking.id),
      decision,
      confirmedBooking: outcome.canConfirm,
      note: outcome.canConfirm
        ? "Booking confirmed against current verified evidence for the exact accepted proposal."
        : "Confirmation refused: readiness conditions or live provenance were not met — the decision is persisted and reviewable.",
    };
  } catch (error) {
    try {
      delivery.finishConfirmCommand(input.confirmKey, "failed", {
        error: error instanceof Error ? error.message : "confirmation failed",
      });
    } catch {
      // Command already finished or reclaimed; the original error stands.
    }
    throw error;
  }
}

/**
 * Evaluate the current handoff view. Freshness is enforced by evaluating
 * through the verifier boundary on every call — a persisted decision is
 * never reused, because its availability evidence can be stale. A live
 * approval for the exact current version is required before any handoff is
 * produced; without one the view is explicitly blocked.
 */
async function evaluateHandoff(
  deps: BookingDeliveryDeps,
  bookingId: string,
): Promise<Omit<HandoffResponseDTO, "revision">> {
  const { store } = deps;
  const booking = store.getBooking(bookingId);
  const action = currentAction(store, bookingId);
  const approvalLive = store.listApprovals(action.id).some(
    (approval) =>
      approval.status === "approved" &&
      approval.proposalVersion === action.proposalVersion &&
      approval.proposalFingerprint === action.proposalFingerprint,
  );
  const current = store.getBooking(booking.id);
  if (!approvalLive) {
    return {
      demo: true,
      booking: current,
      state: "blocked",
      reason: `No live owner approval for the current proposal v${action.proposalVersion}; an operational handoff is only prepared for the approved proposal`,
      handoff: null,
    };
  }
  let decision: ReadinessDecision;
  try {
    decision = await evaluateForAction(deps, booking, action);
  } catch (error) {
    return {
      demo: true,
      booking: current,
      state: "blocked",
      reason: `Handoff evaluation unavailable: ${error instanceof Error ? error.message : "unknown error"}`,
      handoff: null,
    };
  }
  const handoff = buildHandoff({
    decision,
    booking: snapshotBooking(current),
    proposal: snapshotProposal(action, current),
  });
  if (decision.ready && decision.liveReady && current.status === "confirmed") {
    return { demo: demoOf(decision.provenance), booking: current, state: "ready", handoff };
  }
  const reason = !decision.ready
    ? `Handoff is preliminary: the proposal is approved but readiness is blocked (${decision.blockedBy.join("; ") || "conditions unmet"})`
    : !decision.liveReady
      ? "Handoff is preliminary: the proposal is approved and ready on demo evidence, but live provenance has not been verified"
      : "Handoff is preliminary: the proposal is approved and live-ready, but the booking is not confirmed yet";
  return { demo: demoOf(decision.provenance), booking: current, state: "preliminary", reason, handoff };
}

/**
 * Read-only operational handoff for the booking's current proposal (GET).
 * Never persists: reports the latest previously built revision, or null.
 */
export async function handoffForBooking(deps: BookingDeliveryDeps, bookingId: string): Promise<HandoffResponseDTO> {
  const view = await evaluateHandoff(deps, bookingId);
  const latest = deps.delivery.latestHandoff(currentAction(deps.store, bookingId).id);
  return { ...view, revision: latest?.revision ?? null };
}

/**
 * Build and persist a new numbered handoff revision (POST). The revision is
 * created only when an evaluated handoff exists; a blocked view persists
 * nothing and reports the same explicit state.
 */
export async function recordHandoff(deps: BookingDeliveryDeps, bookingId: string): Promise<HandoffResponseDTO> {
  const view = await evaluateHandoff(deps, bookingId);
  if (view.handoff === null) {
    return { ...view, revision: deps.delivery.latestHandoff(currentAction(deps.store, bookingId).id)?.revision ?? null };
  }
  const revision = deps.delivery.insertHandoffRevision(currentAction(deps.store, bookingId).id, view.handoff);
  return { ...view, revision: revision.revision };
}
