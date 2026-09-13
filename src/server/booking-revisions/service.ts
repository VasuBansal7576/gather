import type { CalendarAvailabilityReader } from "../../connectors/contracts.ts";
import { CoordinationLedger } from "../../coordination/ledger.ts";
import type { Booking, ProposedAction } from "../../domain/contracts.ts";
import { KnowledgeService } from "../../knowledge/index.ts";
import { GatherStore } from "../sqlite-store.ts";
import {
  buildBookingOffer,
  persistPreparedProposal,
  type OperatorDeps,
} from "../business-operator/index.ts";
import {
  previewConsequences,
  requireBookingWritable,
  ServiceError,
  type BookingServiceDeps,
} from "../booking-service.ts";
import { RevisionLifecycleStore } from "./lifecycle-store.ts";
import {
  canonicalRequestHash,
  releaseHoldOperationKey,
  releaseProofOf,
  type BlockedCondition,
  type BookingLifecycle,
  type CancellationRequestResponse,
  type CancellationVerifyResponse,
  type HoldReleasePort,
  type PauseResponse,
  type RevisionBinding,
  type RevisionCommandKind,
  type RevisionRequest,
  type RevisionResponse,
} from "./types.ts";

export interface RevisionsDeps {
  store: GatherStore;
  /** Host booking pipeline deps (clock, owner, connectors). */
  booking: BookingServiceDeps;
  /** Host-derived local owner identity; request-supplied actors are ignored. */
  ownerId: string;
  /**
   * Typed injected availability port for revision builds. Defaults to the
   * booking calendar reader. The request itself can never supply
   * availability evidence.
   */
  availability?: CalendarAvailabilityReader;
  /** Same-handle coordination ledger (actual pause/resume/cancel controls). */
  ledger?: CoordinationLedger;
  /**
   * Injected hold-release port (N's exact exported contract). Optional:
   * when absent, every release-gated verification fails closed with an
   * explicit blocked condition — never cancelled, never faked.
   */
  holdRelease?: HoldReleasePort;
  /** Injectable clock (ISO timestamp). */
  now?: () => string;
}

function clockIso(deps: RevisionsDeps): string {
  return deps.now ? deps.now() : new Date().toISOString();
}

function ledgerOf(deps: RevisionsDeps): CoordinationLedger {
  return deps.ledger ?? new CoordinationLedger(deps.store.db);
}

function operatorDeps(deps: RevisionsDeps): OperatorDeps {
  return {
    store: deps.store,
    booking: deps.booking,
    ownerId: deps.ownerId,
    availability: deps.availability ?? deps.booking.calendar,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/**
 * Exact authority binding shared by every command: host-owner business +
 * booking + the booking's durable current action triple. Anything else —
 * cross-business, version/fingerprint drift, or a superseded action — is
 * refused before any write. Currency always resolves through the store's
 * durable pointer; no second pointer exists here.
 */
function requireRevisionBinding(store: GatherStore, binding: RevisionBinding): { booking: Booking; action: ProposedAction } {
  let booking: Booking;
  try {
    booking = store.getBooking(binding.bookingId);
  } catch {
    throw new ServiceError("NOT_FOUND", `Booking not found: ${binding.bookingId}`, false);
  }
  if (booking.businessId !== binding.businessId) {
    throw new ServiceError("CROSS_BOOKING", "Binding business does not match the booking business; refusing cross-booking command", false);
  }
  let action: ProposedAction;
  try {
    action = store.getProposedAction(binding.proposedActionId);
  } catch {
    throw new ServiceError("NOT_FOUND", `Proposed action not found: ${binding.proposedActionId}`, false);
  }
  if (action.bookingId !== booking.id) {
    throw new ServiceError("CROSS_BOOKING", "Proposed action belongs to a different booking; cross-booking command is denied", false);
  }
  if (action.proposalVersion !== binding.proposalVersion || action.proposalFingerprint !== binding.proposalFingerprint) {
    throw new ServiceError(
      "STALE_PROPOSAL",
      `Stale binding: expected v${action.proposalVersion}/${action.proposalFingerprint.slice(0, 12)}…, refusing command`,
      false,
    );
  }
  if (!store.isCurrentProposalAction(action.id)) {
    throw new ServiceError(
      "STALE_PROPOSAL",
      "Binding names a superseded proposal: a newer proposal displaced it — rebind the command to the displayed proposal",
      false,
    );
  }
  return { booking, action };
}

interface CommandOutcome {
  status: "succeeded" | "blocked";
  response: Record<string, unknown>;
}

/**
 * Idempotent command envelope: same command id + same canonical hash
 * replays the stored response (restart-safe); same id + different hash is
 * a conflict. Thrown errors propagate unrecorded so the owner can retry
 * the same command id; all executed steps are themselves idempotent
 * (deterministic release keys, ledger dedupe keys).
 */
function runCommand(
  lifecycle: RevisionLifecycleStore,
  kind: RevisionCommandKind,
  bookingId: string,
  commandId: string,
  hashMaterial: unknown,
  execute: () => CommandOutcome,
): Record<string, unknown> {
  const hash = canonicalRequestHash(hashMaterial);
  const replay = lifecycle.replayOrOwn(commandId, bookingId, kind, hash);
  if (replay) return { ...replay.response, duplicate: true };
  const outcome = execute();
  lifecycle.recordCommand(commandId, bookingId, kind, hash, outcome.status, outcome.response);
  return outcome.response;
}

function rangesOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  const a = Date.parse(aStart);
  const b = Date.parse(aEnd);
  const c = Date.parse(bStart);
  const d = Date.parse(bEnd);
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c) || !Number.isFinite(d)) return true;
  return a < d && b > c;
}

interface SucceededHold {
  executionId: string;
  operationKey: string;
  holdId: string;
  calendarId: string;
  startAt: string;
  endAt: string;
  expiresAt: string;
}

/** Succeeded hold executions on an action with their provider evidence. */
function succeededHolds(store: GatherStore, actionId: string): { holds: SucceededHold[]; unverified: string[] } {
  const holds: SucceededHold[] = [];
  const unverified: string[] = [];
  for (const execution of store.listActionExecutions(actionId)) {
    if (execution.status !== "succeeded" || !execution.idempotencyKey.includes(":create-provisional-hold:")) continue;
    const result = isRecord(execution.result) ? execution.result : undefined;
    const hold = result !== undefined && isRecord(result.hold) ? result.hold : undefined;
    if (hold === undefined) {
      unverified.push(execution.id);
      continue;
    }
    const holdId = nonEmptyString(hold.holdId);
    const calendarId = nonEmptyString(hold.calendarId);
    const startAt = nonEmptyString(hold.startAt);
    const endAt = nonEmptyString(hold.endAt);
    if (holdId === undefined || calendarId === undefined || startAt === undefined || endAt === undefined) {
      unverified.push(execution.id);
      continue;
    }
    holds.push({
      executionId: execution.id,
      operationKey: execution.idempotencyKey,
      holdId,
      calendarId,
      startAt,
      endAt,
      expiresAt: nonEmptyString(hold.expiresAt) ?? endAt,
    });
  }
  return { holds, unverified };
}

function unsettledExecutions(store: GatherStore, actionId: string): string[] {
  return store
    .listActionExecutions(actionId)
    .filter((execution) => execution.status === "pending" || execution.status === "uncertain" || execution.status === "partial")
    .map((execution) => execution.id);
}

/** Re-read currency + lifecycle after an await; anything that moved aborts. */
function assertBindingAfterWait(store: GatherStore, lifecycle: RevisionLifecycleStore, bookingId: string, actionId: string, cancelState: BookingLifecycle["cancelState"] | null): void {
  const current = store.getCurrentProposalAction(bookingId);
  if (!current || current.id !== actionId) {
    throw new ServiceError("STALE_PROPOSAL", "The current proposal changed while the command was in flight; rebind and retry", true);
  }
  if (cancelState !== null && lifecycle.getLifecycle(bookingId).cancelState !== cancelState) {
    throw new ServiceError("CONFLICT", "The booking lifecycle changed while the command was in flight; retry", true);
  }
}

// ---------- Revision ----------

export async function requestRevision(deps: RevisionsDeps, request: RevisionRequest): Promise<RevisionResponse> {
  const { store } = deps;
  const lifecycle = new RevisionLifecycleStore(store);
  const binding = request.binding;
  const hashMaterial = { kind: "revision", binding, inquiry: request.inquiry, calendarId: request.calendarId, email: request.email, expiresAt: request.expiresAt };
  const hash = canonicalRequestHash(hashMaterial);
  const replay = lifecycle.replayOrOwn(binding.commandId, binding.bookingId, "revision", hash);
  if (replay) return { ...(replay.response as unknown as RevisionResponse), duplicate: true } as RevisionResponse;
  const { booking, action } = requireRevisionBinding(store, binding);
  requireBookingWritable(store, booking.id);
  const op = operatorDeps(deps);

  const newStart = nonEmptyString((request.inquiry as Record<string, unknown>).startAt);
  const newEnd = nonEmptyString((request.inquiry as Record<string, unknown>).endAt);
  const newCalendar = nonEmptyString(request.calendarId);

  // Never persist new terms while an obsolete hold on the current action is
  // still out and conflicting: the new hold could never execute, and the
  // old terms must be released first. Released holds and non-overlapping
  // windows pass; holds without readable provider evidence fail closed.
  const { holds, unverified } = succeededHolds(store, action.id);
  const blocked: BlockedCondition[] = [];
  if (unverified.length > 0) {
    blocked.push({
      code: "obsolete_hold_unverified",
      detail: `Executions ${unverified.join(", ")} report a succeeded hold without readable provider evidence; reconcile or release before revising.`,
    });
  }
  for (const hold of holds) {
    const released = lifecycle.getRelease(hold.operationKey);
    if (released?.status === "released") continue;
    if (newCalendar !== undefined && newStart !== undefined && newEnd !== undefined) {
      if (hold.calendarId !== newCalendar || !rangesOverlap(hold.startAt, hold.endAt, newStart, newEnd)) continue;
    }
    blocked.push({
      code: "obsolete_hold_unreleased",
      detail: `Hold ${hold.holdId} on ${hold.calendarId} (${hold.startAt} to ${hold.endAt}) is still out under the current proposal; release it before new terms can execute.`,
    });
  }
  if (blocked.length > 0) {
    const response: RevisionResponse = {
      commandId: binding.commandId, status: "blocked", booking: store.getBooking(booking.id), blocked,
      note: "Revision refused: the obsolete hold would conflict with the new terms. Nothing was persisted and no approval changed.",
    };
    lifecycle.recordCommand(binding.commandId, booking.id, "revision",
      hash,
      "blocked", response as unknown as Record<string, unknown>);
    return response;
  }

  const built = await buildBookingOffer(op, { bookingId: booking.id, inquiry: request.inquiry, calendarId: request.calendarId } as never);
  // The world may have moved across the availability await: rebind before
  // persisting so a superseded binding can never publish.
  requireRevisionBinding(store, binding);
  requireBookingWritable(store, booking.id);
  const persisted = persistPreparedProposal(op, built, { email: request.email, expiresAt: request.expiresAt });
  if ("missing" in persisted) {
    const missing: BlockedCondition[] = [
      { code: "offer_not_feasible", detail: "The revised offer is not feasible under current evidence; nothing was persisted." },
      ...persisted.missing.map((item) => ({ code: "offer_not_feasible" as const, detail: `${item.code}: ${item.detail}` })),
    ];
    const response: RevisionResponse = {
      commandId: binding.commandId, status: "blocked", booking: store.getBooking(booking.id), blocked: missing,
      note: "Revision refused: the revised offer cannot persist under current evidence. Audit and receipts are untouched.",
    };
    lifecycle.recordCommand(binding.commandId, booking.id, "revision",
      hash,
      "blocked", response as unknown as Record<string, unknown>);
    return response;
  }
  const preview = previewConsequences(persisted.action.payload, {});
  if (preview.consequences === null) {
    throw new ServiceError("INVALID_REQUEST", preview.consequencesError ?? "Revised proposal window is not executable", false);
  }
  const response: RevisionResponse = {
    commandId: binding.commandId,
    status: "revised",
    booking: store.getBooking(booking.id),
    action: persisted.action,
    supersedesActionId: action.id,
    ...(persisted.reused ? { reused: true as const } : {}),
    note: persisted.reused
      ? "Identical terms re-persisted idempotently; the current proposal is unchanged and a new owner approval is still required for any changed terms."
      : "Revised proposal published as the new current proposal through the existing prepare path; the old action is superseded, its approval invalidated, and a new owner approval is required. Nothing was sent and no hold was created.",
  };
  lifecycle.recordCommand(binding.commandId, booking.id, "revision",
    hash,
    "succeeded", response as unknown as Record<string, unknown>);
  return response;
}

// ---------- Cancellation: request (local) vs verify (external) ----------

export function requestCancellation(
  deps: RevisionsDeps,
  binding: RevisionBinding,
  note?: string,
): CancellationRequestResponse {
  const { store } = deps;
  const lifecycle = new RevisionLifecycleStore(store);
  const { booking } = requireRevisionBinding(store, binding);
  if (booking.status === "cancelled" || lifecycle.getLifecycle(booking.id).cancelState === "verified") {
    return {
      commandId: binding.commandId, status: "already_verified", booking: store.getBooking(booking.id),
      cancelState: "verified", invalidatedApprovals: 0,
      note: "Cancellation is already externally verified; the booking stays cancelled.",
    };
  }
  const outcome = runCommand(lifecycle, "cancellation_request", booking.id, binding.commandId,
    { kind: "cancellation_request", binding, note },
    () => {
      const state = lifecycle.getLifecycle(booking.id);
      if (state.cancelState !== "none") {
        // A later command id on an already-requested booking is a
        // read-only acknowledgement, never a duplicate invalidation.
        const response: CancellationRequestResponse = {
          commandId: binding.commandId, status: "already_requested", booking: store.getBooking(booking.id),
          cancelState: state.cancelState, invalidatedApprovals: 0,
          note: "Cancellation was already requested; no further authority was invalidated and due work stays stopped.",
        };
        return { status: "succeeded", response: response as unknown as Record<string, unknown> };
      }
      // Authority dies at request time: lifecycle first, then approvals,
      // then due work — each step idempotent so a crash between them replays
      // safely under the same command id. The booking status is deliberately
      // NOT set here: requested is local, verified is external.
      lifecycle.setCancelState(booking.id, "requested", binding.commandId);
      const invalidated = store.invalidateApprovalsForBooking(booking.id);
      const ledgerResult = ledgerOf(deps).applyOwnerControl({
        dedupeKey: binding.commandId, kind: "cancel", bookingId: booking.id, attestedBy: deps.ownerId,
        ...(note === undefined ? {} : { note }),
      });
      void ledgerResult;
      const response: CancellationRequestResponse = {
        commandId: binding.commandId, status: "request_received", booking: store.getBooking(booking.id),
        cancelState: "requested", invalidatedApprovals: invalidated,
        note: "Local cancellation request recorded: obsolete authority invalidated and due work stopped. The booking is NOT cancelled until every hold release, settled action, and refund condition is externally verified.",
      };
      return { status: "succeeded", response: response as unknown as Record<string, unknown> };
    });
  return outcome as unknown as CancellationRequestResponse;
}

export interface CancellationVerifyRequest {
  binding: RevisionBinding;
  /**
   * Scoped approved waiver of the refund obligation. Honored only when a
   * booking-scoped, owner-approved allow-exception naming `policyId` exists
   * in domain knowledge for this booking; unknown or missing obligations
   * are never waived automatically.
   */
  waiver?: { policyId: string };
}

export async function verifyCancellation(deps: RevisionsDeps, request: CancellationVerifyRequest): Promise<CancellationVerifyResponse> {
  const { store } = deps;
  const lifecycle = new RevisionLifecycleStore(store);
  const binding = request.binding;
  const hash = canonicalRequestHash({ kind: "cancellation_verify", binding, waiver: request.waiver });
  const replay = lifecycle.replayOrOwn(binding.commandId, binding.bookingId, "cancellation_verify", hash);
  if (replay) return { ...(replay.response as unknown as CancellationVerifyResponse), duplicate: true } as CancellationVerifyResponse;
  const current = store.getCurrentProposalAction(binding.bookingId);
  if (!current) {
    throw new ServiceError("NOT_FOUND", `No proposed action exists for booking ${binding.bookingId}; nothing can be verified`, false);
  }
  // Verification always binds the CURRENT action: a request bound to an
  // action that has since been superseded is stale.
  if (current.id !== binding.proposedActionId) {
    throw new ServiceError(
      "STALE_PROPOSAL",
      `Cancellation binding is stale: the current proposal is ${current.id} — rebind the verify command to it`,
      false,
    );
  }
  const { booking, action } = requireRevisionBinding(store, binding);
  if (booking.status === "cancelled" && lifecycle.getLifecycle(booking.id).cancelState === "verified") {
    return {
      commandId: binding.commandId, status: "verified", booking,
      cancellationScope: "external_verified",
      note: "Cancellation already verified; replay returns the recorded outcome.",
    };
  }
  const state = lifecycle.getLifecycle(booking.id);
  if (state.cancelState === "none") {
    throw new ServiceError("INVALID_REQUEST", "No cancellation was requested for this booking; request cancellation before verifying", false);
  }
  if (lifecycle.isPaused(booking.id)) {
    throw new ServiceError("BOOKING_PAUSED", "Booking is paused; resume before verifying cancellation", true);
  }

  // Attempt releases first (when a port is wired), then evaluate every
  // condition in one pass so the blocked response names the full set.
  const { holds, unverified } = succeededHolds(store, action.id);
  if (deps.holdRelease !== undefined) {
    for (const hold of holds) {
      if (lifecycle.getRelease(hold.operationKey)?.status === "released") continue;
      await releaseOneHold(deps, lifecycle, booking, action, hold);
      assertBindingAfterWait(store, lifecycle, booking.id, action.id, "requested");
    }
  }
  const blocked: BlockedCondition[] = [];
  const unsettled = unsettledExecutions(store, action.id);
  if (unsettled.length > 0) {
    blocked.push({
      code: "actions_not_settled",
      detail: `Executions ${unsettled.join(", ")} on the current proposal are still pending/uncertain/partial; reconcile them before cancellation can verify.`,
    });
  }
  if (unverified.length > 0) {
    blocked.push({
      code: "obsolete_hold_unverified",
      detail: `Executions ${unverified.join(", ")} report a succeeded hold without readable provider evidence; reconcile before cancellation can verify.`,
    });
  }
  const stillOut = holds.filter((hold) => lifecycle.getRelease(hold.operationKey)?.status !== "released");
  for (const hold of stillOut) {
    const record = lifecycle.getRelease(hold.operationKey);
    blocked.push(record?.status === "uncertain"
      ? {
        code: "release_uncertain",
        detail: `Release of hold ${hold.holdId} is uncertain (the delete may have applied); reconcile the release before cancellation can verify — never retry blindly.`,
      }
      : {
        code: "release_unverified",
        detail: deps.holdRelease === undefined
          ? `Holds ${stillOut.map((item) => item.holdId).join(", ")} have no verified release and no hold-release port is wired; cancellation stays requested, never verified.`
          : `Hold ${hold.holdId} is not yet verified released; cancellation stays requested.`,
      });
  }
  // Deposit/refund: with no payment provider, a deposit implicated by a
  // sent offer (configured deposit + any executed step) can only clear via
  // an approved booking-scoped waiver — never automatically.
  const offer = isRecord(action.payload.offer) ? action.payload.offer : undefined;
  const depositCents = offer !== undefined && typeof offer.depositCents === "number" ? offer.depositCents : null;
  const anySucceeded = store.listActionExecutions(action.id).some((execution) => execution.status === "succeeded");
  let waivedPolicy: string | undefined;
  if (depositCents !== null && anySucceeded) {
    waivedPolicy = findRefundWaiver(store, booking.businessId, booking.id, request.waiver?.policyId);
    if (waivedPolicy === undefined) {
      blocked.push({
        code: "refund_unverified",
        detail: "The sent offer configures a deposit and steps executed, but no payment provider exists to verify a refund; provide a booking-scoped approved waiver citing the permitting domain policy, or leave cancellation requested.",
      });
    }
  }
  if (blocked.length > 0) {
    const response: CancellationVerifyResponse = {
      commandId: binding.commandId, status: "blocked", booking: store.getBooking(booking.id),
      cancellationScope: "local_request", blocked,
      note: "Cancellation verified as NOT complete: the booking stays in requested state with its prior status — never force-set to cancelled.",
    };
    lifecycle.recordCommand(binding.commandId, booking.id, "cancellation_verify",
      hash,
      "blocked", response as unknown as Record<string, unknown>);
    return response;
  }
  store.updateBookingStatus(booking.id, "cancelled");
  lifecycle.setCancelState(booking.id, "verified", binding.commandId);
  const response: CancellationVerifyResponse = {
    commandId: binding.commandId, status: "verified", booking: store.getBooking(booking.id),
    cancellationScope: "external_verified",
    note: "Cancellation externally verified: every hold released, every action settled, and refund obligations cleared or waived. The booking is now cancelled.",
  };
  lifecycle.recordCommand(binding.commandId, booking.id, "cancellation_verify",
    canonicalRequestHash({ kind: "cancellation_verify", binding, waiver: request.waiver }),
    "succeeded", response as unknown as Record<string, unknown>);
  return response;
}

/**
 * Booking-scoped approved waiver lookup through domain knowledge. Returns
 * the permitting policy id only when an active booking-scoped exception
 * with effect allow names the requested policy for this booking.
 */
function findRefundWaiver(store: GatherStore, businessId: string, bookingId: string, policyId: string | undefined): string | undefined {
  if (policyId === undefined) return undefined;
  const svc = new KnowledgeService(store);
  for (const fact of svc.listFacts(businessId)) {
    if (fact.key !== "scoped_exception") continue;
    if (fact.scope !== "booking" || fact.scopeId !== bookingId) continue;
    const value = isRecord(fact.value) ? fact.value : undefined;
    if (value?.effect !== "allow" || value?.policyId !== policyId) continue;
    return policyId;
  }
  return undefined;
}

/**
 * Release one obsolete hold through the injected port (or heal an
 * uncertain record via reconcile). Returns true when a release is now
 * durably recorded. Never fakes: definitive failures and missing ports
 * stay explicit and unverified.
 */
async function releaseOneHold(
  deps: RevisionsDeps,
  lifecycle: RevisionLifecycleStore,
  booking: Booking,
  action: ProposedAction,
  hold: { executionId: string; operationKey: string; holdId: string; calendarId: string; startAt: string; endAt: string; expiresAt: string },
): Promise<boolean> {
  const port = deps.holdRelease;
  if (!port) return false;
  const existing = lifecycle.getRelease(hold.operationKey);
  const releaseKey = releaseHoldOperationKey({ bookingId: booking.id, holdId: hold.holdId, originalHoldOperationKey: hold.operationKey });
  if (existing?.status === "uncertain") {
    const reconciled = await port.reconcileReleasedHold({ operationKey: releaseKey });
    assertBindingAfterWait(deps.store, lifecycle, booking.id, action.id, "requested");
    if (reconciled.status === "succeeded") {
      lifecycle.recordRelease(hold.operationKey, releaseKey, booking.id, "released", {
        ...reconciled.data,
        proof: releaseProofOf(reconciled.metadata, reconciled.data.provenance),
      });
      return true;
    }
    return false;
  }
  const outcome = await port.releaseProvisionalHold({
    operationKey: releaseKey,
    bookingId: booking.id,
    calendarId: hold.calendarId,
    holdId: hold.holdId,
    originalHoldOperationKey: hold.operationKey,
    startAt: hold.startAt,
    endAt: hold.endAt,
    expiresAt: hold.expiresAt,
  });
  assertBindingAfterWait(deps.store, lifecycle, booking.id, action.id, "requested");
  if (outcome.status === "succeeded") {
    lifecycle.recordRelease(hold.operationKey, releaseKey, booking.id, "released", {
      ...outcome.data,
      proof: releaseProofOf(outcome.metadata, outcome.data.provenance),
    });
    return true;
  }
  if (outcome.status === "uncertain") {
    lifecycle.recordRelease(hold.operationKey, releaseKey, booking.id, "uncertain", { error: outcome.error.message });
    return false;
  }
  return false;
}

// ---------- Pause / resume (actual ledger controls) ----------

export function pauseBooking(deps: RevisionsDeps, binding: RevisionBinding, note?: string): PauseResponse {
  const { store } = deps;
  const lifecycle = new RevisionLifecycleStore(store);
  const { booking } = requireRevisionBinding(store, binding);
  if (booking.status === "cancelled") {
    throw new ServiceError("INVALID_REQUEST", "Booking is cancelled (terminal); pausing a cancelled booking is refused", false);
  }
  const outcome = runCommand(lifecycle, "pause", booking.id, binding.commandId,
    { kind: "pause", binding, note },
    () => {
      // Ledger first (stops due work), then the local flag (blocks new
      // writes): a crash between them replays safely under the same command
      // id, and already-executed receipts are never rewritten.
      ledgerOf(deps).applyOwnerControl({
        dedupeKey: binding.commandId, kind: "pause", bookingId: booking.id, attestedBy: deps.ownerId,
        ...(note === undefined ? {} : { note }),
      });
      lifecycle.setPaused(booking.id, true);
      const response: PauseResponse = {
        commandId: binding.commandId, status: "paused", booking: store.getBooking(booking.id), paused: true,
        note: "Booking paused: due work stopped and new writes refused. Already-executed steps keep their exact receipts.",
      };
      return { status: "succeeded", response: response as unknown as Record<string, unknown> };
    });
  return outcome as unknown as PauseResponse;
}

export function resumeBooking(deps: RevisionsDeps, binding: RevisionBinding, note?: string): PauseResponse {
  const { store } = deps;
  const lifecycle = new RevisionLifecycleStore(store);
  const { booking } = requireRevisionBinding(store, binding);
  if (booking.status === "cancelled" || lifecycle.getLifecycle(booking.id).cancelState !== "none") {
    throw new ServiceError("INVALID_REQUEST", "Booking cancellation is terminal; resume is refused", false);
  }
  const outcome = runCommand(lifecycle, "resume", booking.id, binding.commandId,
    { kind: "resume", binding, note },
    () => {
      ledgerOf(deps).applyOwnerControl({
        dedupeKey: binding.commandId, kind: "resume", bookingId: booking.id, attestedBy: deps.ownerId,
        ...(note === undefined ? {} : { note }),
      });
      lifecycle.setPaused(booking.id, false);
      const response: PauseResponse = {
        commandId: binding.commandId, status: "resumed", booking: store.getBooking(booking.id), paused: false,
        note: "Booking resumed: new writes accepted again. Nothing executed while paused is retroactively applied.",
      };
      return { status: "succeeded", response: response as unknown as Record<string, unknown> };
    });
  return outcome as unknown as PauseResponse;
}

export type { BookingLifecycle };
