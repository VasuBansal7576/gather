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
 * The exact binding a handoff evaluation was built against. Re-read after
 * every await and transactionally before persist: anything that moved —
 * action identity, version, fingerprint, approval liveness, booking status
 * — invalidates the evaluated view instead of persisting it under drift.
 */
interface HandoffBinding {
  actionId: string;
  actionVersion: number;
  actionFingerprint: string;
  actionStatus: ProposedAction["status"];
  bookingStatus: Booking["status"];
  approvalLive: boolean;
}

function readHandoffBinding(deps: BookingDeliveryDeps, bookingId: string): { booking: Booking; action: ProposedAction; binding: HandoffBinding } {
  const booking = deps.store.getBooking(bookingId);
  const action = currentAction(deps.store, bookingId);
  const approvalLive = deps.store.listApprovals(action.id).some(
    (approval) =>
      approval.status === "approved" &&
      approval.proposalVersion === action.proposalVersion &&
      approval.proposalFingerprint === action.proposalFingerprint,
  );
  return {
    booking,
    action,
    binding: {
      actionId: action.id,
      actionVersion: action.proposalVersion,
      actionFingerprint: action.proposalFingerprint,
      actionStatus: action.status,
      bookingStatus: booking.status,
      approvalLive,
    },
  };
}

function sameHandoffBinding(left: HandoffBinding, right: HandoffBinding): boolean {
  return (
    left.actionId === right.actionId &&
    left.actionVersion === right.actionVersion &&
    left.actionFingerprint === right.actionFingerprint &&
    left.actionStatus === right.actionStatus &&
    left.bookingStatus === right.bookingStatus &&
    left.approvalLive === right.approvalLive
  );
}

function describeBindingDrift(before: HandoffBinding, after: HandoffBinding, driftedEvidence: string[]): string {
  if (after.actionId !== before.actionId) return "the current proposed action changed";
  if (after.actionVersion !== before.actionVersion || after.actionFingerprint !== before.actionFingerprint) {
    return "the proposal version changed";
  }
  if (before.approvalLive && !after.approvalLive) return "the owner approval was invalidated";
  if (after.bookingStatus !== before.bookingStatus) return "the booking status changed";
  if (driftedEvidence.length > 0) return `evidence changed (${driftedEvidence.join(", ")})`;
  return "the binding changed";
}

/**
 * Evaluate the current handoff view. Freshness is enforced by evaluating
 * through the verifier boundary on every call — a persisted decision is
 * never reused, because its availability evidence can be stale — and by
 * re-reading the exact binding after the await: a view evaluated under a
 * binding that moved (approval invalidated, new proposal or action,
 * booking paused or cancelled, evidence changed) is reported explicitly
 * blocked with nothing built, never persisted under drift.
 */
async function evaluateHandoff(
  deps: BookingDeliveryDeps,
  bookingId: string,
): Promise<Omit<HandoffResponseDTO, "revision"> & { binding: HandoffBinding; collecting?: CollectingVerifiers }> {
  const { store } = deps;
  const before = readHandoffBinding(deps, bookingId);
  if (!before.binding.approvalLive) {
    const current = store.getBooking(bookingId);
    return {
      demo: true,
      booking: current,
      state: "blocked",
      reason: `No live owner approval for the current proposal v${before.action.proposalVersion}; an operational handoff is only prepared for the approved proposal`,
      handoff: null,
      binding: before.binding,
    };
  }
  const collecting = new CollectingVerifiers(new StoreDeliveryVerifiers(deps.delivery, deps.calendar, () => clockIso(deps)));
  let decision: ReadinessDecision;
  try {
    decision = await evaluateForAction(deps, before.booking, before.action, collecting);
  } catch (error) {
    return {
      demo: true,
      booking: store.getBooking(bookingId),
      state: "blocked",
      reason: `Handoff evaluation unavailable: ${error instanceof Error ? error.message : "unknown error"}`,
      handoff: null,
      binding: before.binding,
      collecting,
    };
  }
  const after = readHandoffBinding(deps, bookingId);
  const driftedEvidence = collecting.driftedStoreFetches();
  if (!sameHandoffBinding(before.binding, after.binding) || driftedEvidence.length > 0) {
    return {
      demo: true,
      booking: after.booking,
      state: "blocked",
      reason: `Handoff evaluation went stale while proofs were verified (${describeBindingDrift(before.binding, after.binding, driftedEvidence)}); nothing was built or persisted — retry`,
      handoff: null,
      binding: after.binding,
      collecting,
    };
  }
  // The binding did not move, so the decision's binding matches the fresh
  // snapshots below exactly; the handoff content is built from current rows.
  const handoff = buildHandoff({
    decision,
    booking: snapshotBooking(after.booking),
    proposal: snapshotProposal(after.action, after.booking),
  });
  if (decision.ready && decision.liveReady && after.booking.status === "confirmed") {
    return { demo: demoOf(decision.provenance), booking: after.booking, state: "ready", handoff, binding: after.binding, collecting };
  }
  const reason = !decision.ready
    ? `Handoff is preliminary: the proposal is approved but readiness is blocked (${decision.blockedBy.join("; ") || "conditions unmet"})`
    : !decision.liveReady
      ? "Handoff is preliminary: the proposal is approved and ready on demo evidence, but live provenance has not been verified"
      : "Handoff is preliminary: the proposal is approved and live-ready, but the booking is not confirmed yet";
  return { demo: demoOf(decision.provenance), booking: after.booking, state: "preliminary", reason, handoff, binding: after.binding, collecting };
}

/**
 * Read-only operational handoff for the booking's current proposal (GET).
 * Never persists. The revision label corresponds to actually persisted
 * content only: it names the latest persisted revision when the freshly
 * evaluated view is byte-identical to it, and is null otherwise — a fresh
 * view that differs from anything persisted is an explicit unpersisted
 * preview, never paired with an old revision number.
 */
export async function handoffForBooking(deps: BookingDeliveryDeps, bookingId: string): Promise<HandoffResponseDTO> {
  const view = await evaluateHandoff(deps, bookingId);
  const { binding: _binding, collecting: _collecting, ...response } = view;
  if (view.handoff === null) return { ...response, handoff: null, revision: null };
  const latest = deps.delivery.latestHandoff(view.binding.actionId);
  const matches =
    latest !== undefined &&
    latest.bookingId === bookingId &&
    latest.proposalVersion === view.binding.actionVersion &&
    latest.proposalFingerprint === view.binding.actionFingerprint &&
    canonicalHash(latest.handoff) === canonicalHash(view.handoff);
  return { ...response, handoff: view.handoff, revision: matches ? latest.revision : null };
}

/**
 * Build and persist a new numbered handoff revision (POST). The evaluated
 * binding is revalidated transactionally before persist: if the action,
 * version, approval, or booking moved after evaluation, nothing is
 * persisted and the call reports blocked — an older view is never inserted
 * under a newer action. A blocked view persists nothing.
 */
export async function recordHandoff(deps: BookingDeliveryDeps, bookingId: string): Promise<HandoffResponseDTO> {
  const view = await evaluateHandoff(deps, bookingId);
  const { binding: _binding, collecting, ...response } = view;
  const handoff = view.handoff;
  if (handoff === null) {
    return { ...response, handoff: null, revision: null };
  }
  const evaluated = view.binding;
  try {
    return deps.delivery.transaction(() => {
      const live = readHandoffBinding(deps, bookingId);
      if (!sameHandoffBinding(live.binding, evaluated)) {
        throw new ServiceError(
          "STALE_PROPOSAL",
          `Handoff binding changed before persist (${describeBindingDrift(evaluated, live.binding, [])}); nothing was persisted — retry`,
          true,
        );
      }
      // Evidence is re-read inside the same transaction: anything that
      // changed after evaluation — however it interleaved — blocks the
      // persist instead of storing a stale view.
      const drifted = collecting?.driftedStoreFetches() ?? [];
      if (drifted.length > 0) {
        throw new ServiceError(
          "STALE_PROPOSAL",
          `Handoff evidence changed before persist (${drifted.join(", ")}); nothing was persisted — retry`,
          true,
        );
      }
      const revision = deps.delivery.insertHandoffRevision(evaluated.actionId, handoff);
      return { ...response, handoff, revision: revision.revision };
    });
  } catch (error) {
    if (error instanceof ServiceError && error.code === "STALE_PROPOSAL") {
      const current = deps.store.getBooking(bookingId);
      return {
        demo: true,
        booking: current,
        state: "blocked",
        reason: error.message,
        handoff: null,
        revision: null,
      };
    }
    throw error;
  }
}
