import { randomUUID } from "node:crypto";
import { availabilityOperationKey, stableOperationKey } from "../connectors/contracts.ts";
import type {
  CalendarAvailabilityReader,
  ConnectorMetadata,
  EmailSender,
  ProvisionalHoldWriter,
  SourceReference,
} from "../connectors/contracts.ts";
import { GatherStore } from "./sqlite-store.ts";
import type { StepReservation } from "./sqlite-store.ts";

export type { StepReservation };
import type {
  ApproveRequestDTO,
  ApproveResponseDTO,
  ReconcileResponseDTO,
  RetryResponseDTO,
  StepReceiptDTO,
  WorkspaceDTO,
} from "./dto.ts";
import { DEMO_MARKER } from "./dto.ts";
import type { ActionExecution, Booking } from "../domain/contracts.ts";
import { RevisionLifecycleStore } from "./booking-revisions/lifecycle-store.ts";

export type ServiceErrorCode =
  | "NOT_FOUND"
  | "STALE_PROPOSAL"
  | "CROSS_BOOKING"
  | "SLOT_UNAVAILABLE"
  | "ACCESS_REVOKED"
  | "CONFLICT"
  | "RECONCILE_REQUIRED"
  | "RECONCILE_PENDING"
  | "EXECUTION_FAILED"
  | "UNCERTAIN"
  | "BOOKING_PAUSED"
  | "CANCELLATION_REQUESTED"
  | "INVALID_REQUEST";

export class ServiceError extends Error {
  readonly code: ServiceErrorCode;
  readonly retryable: boolean;
  constructor(code: ServiceErrorCode, message: string, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

export interface BookingServiceDeps {
  store: GatherStore;
  calendar: CalendarAvailabilityReader & ProvisionalHoldWriter;
  email: EmailSender;
  /** Injectable clock (ISO timestamp). Used for provisional-hold expiry checks. */
  now?: () => string;
  /**
   * Configured local owner identity (e.g. GATHER_OWNER_ID). Approvals are
   * always recorded under this value; request-supplied identities are ignored.
   */
  ownerId?: string;
}

/** Claimed-step lease: a crashed pending attempt becomes reclaimable after this. */
export const STEP_CLAIM_LEASE_MS = 120_000;

function clockMs(deps: BookingServiceDeps): number {
  if (!deps.now) return Date.now();
  const parsed = Date.parse(deps.now());
  return Number.isFinite(parsed) ? parsed : Date.now();
}

export function ownerIdentity(deps: BookingServiceDeps): string {
  const identity = deps.ownerId ?? process.env.GATHER_OWNER_ID ?? "local-owner";
  if (identity.trim().length === 0) return "local-owner";
  return identity;
}

export interface HoldParams {
  startAt: string;
  endAt: string;
  expiresAt: string;
  calendarId: string;
  emailTo: string[];
  emailSubject: string;
  emailBody: string;
}

function validRange(startAt: string, endAt: string): boolean {
  const start = Date.parse(startAt);
  const end = Date.parse(endAt);
  return Number.isFinite(start) && Number.isFinite(end) && start < end;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/**
 * Extract executable hold/email params. EVERY consequential field must be
 * present explicitly in the proposal payload, because the displayed
 * proposalFingerprint covers exactly { bookingId, kind, payload,
 * sourceReferences }. Derived defaults would execute fields the fingerprint
 * never covered, so they are rejected instead of defaulted.
 *
 * expiresAt is a provisional-hold expiry: it must be a valid timestamp in the
 * future relative to the injected clock. It is deliberately NOT required to
 * be after the event end — a hold commonly expires before the event starts
 * (e.g. an offer held until next week for an October event).
 */
export function resolveHoldParams(actionPayload: Record<string, unknown>, opts: { nowMs?: number } = {}): HoldParams {
  const payload = asRecord(actionPayload);
  const startAt = str(payload.startAt);
  const endAt = str(payload.endAt);
  const expiresAt = str(payload.expiresAt);
  const calendarId = str(payload.calendarId);
  if (!startAt || !endAt || !validRange(startAt, endAt)) {
    throw new ServiceError("INVALID_REQUEST", "Proposal payload must carry an explicit valid startAt/endAt range", false);
  }
  if (!calendarId) {
    throw new ServiceError("INVALID_REQUEST", "Proposal payload must carry an explicit calendarId (it is part of the approved fingerprint)", false);
  }
  const nowMs = opts.nowMs ?? Date.now();
  const startMs = Date.parse(startAt);
  const endMs = Date.parse(endAt);
  if (endMs <= nowMs) {
    throw new ServiceError("INVALID_REQUEST", "Proposal event window has already ended; past windows cannot be approved", false);
  }
  if (startMs <= nowMs) {
    throw new ServiceError("INVALID_REQUEST", "Proposal event window has already started; past or current startAt values cannot be approved", false);
  }
  const expiryMs = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  if (!expiresAt || !Number.isFinite(expiryMs)) {
    throw new ServiceError("INVALID_REQUEST", "Proposal payload must carry an explicit valid expiresAt", false);
  }
  if (expiryMs <= nowMs) {
    throw new ServiceError("INVALID_REQUEST", "Proposal payload expiresAt must be in the future (the hold has already expired)", false);
  }
  const rawTo = payload.emailTo;
  if (!Array.isArray(rawTo) || rawTo.length === 0) {
    throw new ServiceError("INVALID_REQUEST", "Proposal payload must carry an explicit non-empty emailTo array", false);
  }
  // Every recipient must be reviewable exactly as executed: malformed
  // elements are rejected rather than silently filtered, so the approved
  // fingerprint covers precisely the executed recipient set.
  const emailTo: string[] = rawTo.map((item, index) => {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new ServiceError("INVALID_REQUEST", `Proposal payload emailTo[${index}] must be a non-empty email address; malformed recipients are rejected, not filtered`, false);
    }
    return item;
  });
  const emailSubject = str(payload.emailSubject);
  const emailBody = str(payload.emailBody);
  if (!emailSubject) throw new ServiceError("INVALID_REQUEST", "Proposal payload must carry an explicit emailSubject", false);
  if (!emailBody) throw new ServiceError("INVALID_REQUEST", "Proposal payload must carry an explicit emailBody", false);
  return { startAt, endAt, expiresAt, calendarId, emailTo, emailSubject, emailBody };
}

/** UI preview of the exact consequences approval would execute (same resolver). */
export function previewConsequences(
  actionPayload: Record<string, unknown>,
  opts: { nowMs?: number } = {},
): {
  consequences: import("./dto.ts").ProposalConsequencesDTO | null;
  consequencesError?: string;
} {
  try {
    const params = resolveHoldParams(actionPayload, opts);
    return { consequences: { ...params } };
  } catch (error) {
    return { consequences: null, consequencesError: error instanceof Error ? error.message : "Incomplete proposal payload" };
  }
}

export function holdOperationKey(proposedActionId: string, proposalVersion: number): string {
  return stableOperationKey({
    connector: "calendar",
    operation: "create-provisional-hold",
    identity: { proposedActionId, proposalVersion: String(proposalVersion) },
  });
}

export function emailOperationKey(proposedActionId: string, proposalVersion: number): string {
  return stableOperationKey({
    connector: "email",
    operation: "send",
    identity: { proposedActionId, proposalVersion: String(proposalVersion) },
  });
}

function stepOf(key: string): "hold" | "email" {
  return key.includes(":send:") ? "email" : "hold";
}

/**
 * Trusted connector proof preserved on every completed step execution
 * result. The proof carries the connector's own mode/simulated declaration
 * plus the response provenance — it is read back (never re-derived) when
 * rendering receipts, so a simulated fixture can never be displayed as a
 * live provider effect.
 */
export interface StepProof {
  mode: "demo" | "live";
  simulated: boolean;
  provenance: SourceReference[];
}

function proofOf(metadata: ConnectorMetadata, provenance: unknown): StepProof {
  const refs = Array.isArray(provenance) ? provenance : [];
  return {
    mode: metadata.mode.mode,
    simulated: metadata.simulated,
    provenance: refs.map((ref) => ({ ...(ref as SourceReference) })),
  };
}

/** Attach the connector's proof to a succeeded step result. */
function provenResult(outcome: { metadata: ConnectorMetadata; data: { provenance?: unknown } }): Record<string, unknown> {
  return { ...(outcome.data as Record<string, unknown>), proof: proofOf(outcome.metadata, outcome.data.provenance) };
}

/**
 * A receipt reads as live only on positive proof: live mode, explicitly not
 * simulated, non-empty provenance, and zero fictional refs. Everything else
 * — missing/malformed proof (legacy rows, unknown connectors), simulated
 * results, empty provenance, or any fictional fixture ref — fails closed to
 * demo. Fixture receipts are therefore never upgraded to live.
 */
export function isLiveStepProof(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return false;
  const proof = (result as { proof?: unknown }).proof;
  if (typeof proof !== "object" || proof === null) return false;
  const candidate = proof as { mode?: unknown; simulated?: unknown; provenance?: unknown };
  if (candidate.mode !== "live" || candidate.simulated !== false) return false;
  if (!Array.isArray(candidate.provenance) || candidate.provenance.length === 0) return false;
  return !candidate.provenance.some(
    (ref) => typeof ref === "object" && ref !== null && (ref as { fictional?: unknown }).fictional === true,
  );
}

/** Honest per-receipt wording derived from the stored proof, never assumed. */
export function stepReceiptDetail(execution: ActionExecution): string {
  if (execution.status !== "succeeded") return execution.error ?? execution.status;
  return isLiveStepProof(execution.result) ? "Done — provider receipt recorded" : "Done — simulated provider receipt";
}

function toReceipt(execution: ActionExecution): StepReceiptDTO {
  return { execution, step: stepOf(execution.idempotencyKey), demo: !isLiveStepProof(execution.result) };
}

function availabilityKey(calendarId: string, startAt: string, endAt: string): string {
  return availabilityOperationKey({ calendarId, startAt, endAt });
}

/**
 * Action kinds the approval pipeline is allowed to execute (C6). The
 * pipeline always runs a provisional-hold + email plan, so any other kind —
 * including `custom` with a hold-shaped payload — is rejected at the
 * approval/retry boundary before any approval row or side effect.
 */
const SUPPORTED_APPROVAL_KINDS = ["create_provisional_hold"] as const;

function requireSupportedKind(kind: string): void {
  if (!(SUPPORTED_APPROVAL_KINDS as readonly string[]).includes(kind)) {
    throw new ServiceError(
      "INVALID_REQUEST",
      `Unsupported proposal kind "${kind}": the approval pipeline executes only a provisional-hold + email plan (kind "create_provisional_hold")`,
      false,
    );
  }
}

/** Read-only workspace aggregation for the owner UI. */
export function getWorkspace(store: GatherStore, deps?: Pick<BookingServiceDeps, "ownerId" | "now">): WorkspaceDTO {
  const businesses = store.listBusinesses();
  const connections = store.listConnectedAccounts();
  const nowMs = deps?.now ? Date.parse(deps.now()) : Date.now();
  const bookings = store.listBookings().map((booking) => {
    const actions = store.listProposedActionsForBooking(booking.id);
    const current = store.getCurrentProposalAction(booking.id);
    return {
      booking,
      proposals: actions.map((action) => {
        const preview = previewConsequences(action.payload, { nowMs });
        return {
          action,
          consequences: preview.consequences,
          ...(preview.consequencesError ? { consequencesError: preview.consequencesError } : {}),
        };
      }),
      approvals: actions.flatMap((action) => store.listApprovals(action.id)),
      executions: actions.flatMap((action) => store.listActionExecutions(action.id)),
      ...(current ? { currentProposedActionId: current.id } : {}),
    };
  });
  return {
    mode: DEMO_MARKER,
    demo: true,
    approvalIdentity: deps?.ownerId ?? process.env.GATHER_OWNER_ID ?? "local-owner",
    businesses,
    bookings,
    connections,
    notice: "DEMO ONLY: all records and receipts are local fixtures/simulated integrations, not live provider state.",
  };
}

/**
 * Narrow G11 writability gate (shared hook owned by booking-revisions
 * lifecycle state). Paused bookings refuse new writes but keep every
 * already-executed receipt and status exactly as observed; cancellation
 * requested/verified bookings refuse new writes because their authority
 * was invalidated at request time. Read-only paths and uncertainty
 * resolution (reconcile) are never gated here.
 */
export function requireBookingWritable(store: GatherStore, bookingId: string): void {
  const lifecycle = new RevisionLifecycleStore(store).getLifecycle(bookingId);
  if (lifecycle.paused) {
    throw new ServiceError("BOOKING_PAUSED", "Booking is paused by owner control; resume before approving, retrying, preparing, or confirming", true);
  }
  if (lifecycle.cancelState !== "none") {
    throw new ServiceError(
      "CANCELLATION_REQUESTED",
      lifecycle.cancelState === "verified"
        ? "Booking cancellation is verified terminal; no new proposals, approvals, or confirmations are accepted"
        : "Booking cancellation was requested and its authority invalidated; verify cancellation instead of writing new proposals",
      false,
    );
  }
}

/** Exact-version approval gate shared by approve + retry paths. */
function requireExactApproval(store: GatherStore, input: ApproveRequestDTO) {
  let action;
  try {
    action = store.getProposedAction(input.proposedActionId);
  } catch {
    throw new ServiceError("NOT_FOUND", `Proposed action not found: ${input.proposedActionId}`, false);
  }
  if (action.bookingId !== input.bookingId) {
    throw new ServiceError("CROSS_BOOKING", "Proposed action belongs to a different booking; cross-booking approval is denied", false);
  }
  if (action.proposalVersion !== input.proposalVersion || action.proposalFingerprint !== input.proposalFingerprint) {
    throw new ServiceError(
      "STALE_PROPOSAL",
      `Stale proposal: expected v${action.proposalVersion}/${action.proposalFingerprint.slice(0, 12)}..., refusing approval`,
      false,
    );
  }
  requireCurrentBinding(store, action.id);
  return action;
}

/**
 * Durable current-proposal gate: only the booking's single current proposal
 * (explicit pointer, never version/timestamp/UUID ordering) can be
 * approved, retried, or reconciled. A superseded action — even with a
 * higher in-row version or a matching fingerprint — is stale by definition.
 */
function requireCurrentBinding(store: GatherStore, actionId: string): void {
  if (!store.isCurrentProposalAction(actionId)) {
    throw new ServiceError(
      "STALE_PROPOSAL",
      "This proposal is no longer current: a newer proposal superseded it — re-approve the displayed proposal",
      false,
    );
  }
}

/**
 * Reserve a step for execution, mapping store-level ownership races to typed
 * service errors. The returned reservation carries the caller's claim token;
 * provider side effects and completion writes must present that token, so an
 * expired in-flight call and a new owner can never both commit.
 */
function reserveStep(
  deps: BookingServiceDeps,
  actionId: string,
  version: number,
  key: string,
  step: "hold" | "email",
): { reservation: StepReservation; claimToken: string } {
  const claimToken = randomUUID();
  try {
    const reservation = deps.store.reserveStepExecution(actionId, version, key, {
      claimToken,
      leaseMs: STEP_CLAIM_LEASE_MS,
      nowMs: clockMs(deps),
    });
    return { reservation, claimToken };
  } catch (error) {
    if (error instanceof Error && /already in progress/.test(error.message)) {
      throw new ServiceError("CONFLICT", `${step === "hold" ? "Hold" : "Email"} step is already in progress for this approved proposal; wait or reconcile`, true);
    }
    if (error instanceof Error && /exact current proposal version|Stale proposal version/.test(error.message)) {
      throw new ServiceError("STALE_PROPOSAL", "The proposal changed while the request was in flight; re-approve the displayed proposal", false);
    }
    throw error;
  }
}

function hasLiveApproval(store: GatherStore, actionId: string): boolean {
  if (!store.isCurrentProposalAction(actionId)) return false;
  const action = store.getProposedAction(actionId);
  return store.listApprovals(actionId).some(
    (approval) =>
      approval.status === "approved" &&
      approval.proposalVersion === action.proposalVersion &&
      approval.proposalFingerprint === action.proposalFingerprint,
  );
}

function isStale(store: GatherStore, actionId: string, version: number): boolean {
  const action = store.getProposedAction(actionId);
  return action.proposalVersion !== version || !store.isCurrentProposalAction(actionId) || !hasLiveApproval(store, actionId);
}

/**
 * Re-verify a live exact-version approval after an async wait. A proposal
 * edited (or superseded) while a provider call was outstanding must not keep
 * executing as if approved: the booking is parked as uncertain and the
 * pipeline halts with STALE_PROPOSAL.
 */
function assertLiveApprovalAfterWait(store: GatherStore, actionId: string, version: number): void {
  const action = store.getProposedAction(actionId);
  if (action.proposalVersion === version && store.isCurrentProposalAction(actionId) && hasLiveApproval(store, actionId)) return;
  try {
    store.updateBookingStatus(action.bookingId, "uncertain");
  } catch {
    // Booking already gone; the STALE error below still carries the signal.
  }
  throw new ServiceError("STALE_PROPOSAL", "The proposal changed while the request was in flight; re-approve the displayed proposal", false);
}

/**
 * Recover a reclaimed (crashed/leaked) pending attempt. A lease expiry proves
 * nothing about the external effect, so reconcile by stable operation key
 * BEFORE any further write. A found write heals to succeeded; an absent one
 * stays uncertain — it must never be replayed blindly.
 */
async function recoverReclaimedHold(
  deps: BookingServiceDeps,
  execution: ActionExecution,
  key: string,
  claimToken: string,
): Promise<ActionExecution> {
  const { store, calendar } = deps;
  const reconciled = await calendar.reconcileProvisionalHold({ operationKey: key });
  if (reconciled.status === "succeeded") {
    // The pending row must pass through uncertain (claim-guarded) before it
    // can record the reconciled outcome.
    const pending = store.markExecutionUncertain(
      execution.id,
      "Recovered pending hold matched provider evidence on reconcile",
      { claimToken },
    );
    const healed = store.reconcileActionExecution(pending.id, { status: "succeeded", result: { ...provenResult(reconciled) } });
    assertLiveApprovalAfterWait(store, execution.proposedActionId, execution.proposalVersion);
    return healed;
  }
  const pending = store.markExecutionUncertain(
    execution.id,
    "Recovered pending hold could not be reconciled against the provider; it remains uncertain until provider evidence appears",
    { claimToken },
  );
  assertLiveApprovalAfterWait(store, execution.proposedActionId, execution.proposalVersion);
  return pending;
}

async function recoverReclaimedEmail(
  deps: BookingServiceDeps,
  execution: ActionExecution,
  key: string,
  claimToken: string,
): Promise<ActionExecution> {
  const { store, email } = deps;
  const reconciled = await email.reconcileSentEmail({ operationKey: key });
  if (reconciled.status === "succeeded") {
    const pending = store.markExecutionUncertain(
      execution.id,
      "Recovered pending email matched provider evidence on reconcile",
      { claimToken },
    );
    const healed = store.reconcileActionExecution(pending.id, { status: "succeeded", result: { ...provenResult(reconciled) } });
    assertLiveApprovalAfterWait(store, execution.proposedActionId, execution.proposalVersion);
    return healed;
  }
  const pending = store.markExecutionUncertain(
    execution.id,
    "Recovered pending email could not be reconciled against the provider; it remains uncertain until provider evidence appears",
    { claimToken },
  );
  assertLiveApprovalAfterWait(store, execution.proposedActionId, execution.proposalVersion);
  return pending;
}

async function runHoldStep(deps: BookingServiceDeps, actionId: string, version: number, params: HoldParams): Promise<ActionExecution> {
  const { store, calendar } = deps;
  const key = holdOperationKey(actionId, version);
  const { reservation, claimToken } = reserveStep(deps, actionId, version, key, "hold");
  let execution = reservation.execution;
  if (execution.status === "succeeded") return execution; // never resend
  if (execution.status === "failed") {
    execution = store.reopenFailedStep(execution.id, { claimToken, leaseMs: STEP_CLAIM_LEASE_MS, nowMs: clockMs(deps) });
  } else if (execution.status === "uncertain" || execution.status === "partial") {
    throw new ServiceError("RECONCILE_REQUIRED", "Hold step is uncertain; reconcile before retrying", false);
  } else if (reservation.reclaimed) {
    return recoverReclaimedHold(deps, execution, key, claimToken);
  } else if (!reservation.created) {
    // Defensive: the store never returns a foreign pending row without throwing,
    // but never execute without claim ownership.
    throw new ServiceError("CONFLICT", "Hold step is already in progress for this approved proposal; wait or reconcile", true);
  }
  // execution is now pending under our claim: only our token can complete it.
  const claim = { claimToken };
  const bookingId = store.getProposedAction(actionId).bookingId;
  /** Halt when the proposal moved on across an async wait. A still-pending
   *  row is preserved as uncertain (never silently dropped); observed
   *  provider evidence in terminal rows is kept as versioned history. */
  const haltIfStale = (): void => {
    if (!isStale(store, actionId, version)) return;
    const current = store.getActionExecution(execution.id);
    if (current.status === "pending") {
      store.markExecutionUncertain(execution.id, "Proposal changed while the provider call was outstanding; outcome left uncertain for reconciliation", claim);
    }
    assertLiveApprovalAfterWait(store, actionId, version);
  };
  let outcome;
  try {
    outcome = await calendar.createProvisionalHold({
      operationKey: key,
      bookingId,
      calendarId: params.calendarId,
      startAt: params.startAt,
      endAt: params.endAt,
      expiresAt: params.expiresAt,
    });
  } catch (error) {
    const pending = store.markExecutionUncertain(execution.id, error instanceof Error ? error.message : "Hold outcome was not received", claim);
    haltIfStale();
    return pending;
  }
  if (outcome.status === "succeeded") {
    const done = store.completeActionExecution(execution.id, { status: "succeeded", result: { ...provenResult(outcome) } }, claim);
    haltIfStale();
    return done;
  }
  if (outcome.status === "uncertain") {
    // Persist uncertainty BEFORE any retry, then attempt one reconciliation read.
    const pending = store.markExecutionUncertain(execution.id, outcome.error.message, claim);
    const reconciled = await calendar.reconcileProvisionalHold({ operationKey: key });
    if (reconciled.status === "succeeded") {
      const healed = store.reconcileActionExecution(pending.id, { status: "succeeded", result: { ...provenResult(reconciled) } });
      haltIfStale();
      return healed;
    }
    haltIfStale();
    return pending;
  }
  // outcome.status === "failed"
  if (outcome.error.kind === "slot_unavailable" || outcome.error.kind === "conflict") {
    return store.completeActionExecution(execution.id, { status: "failed", error: outcome.error.message }, claim);
  }
  if (outcome.error.kind === "access_revoked" || outcome.error.kind === "authorization_denied") {
    const failed = store.completeActionExecution(execution.id, { status: "failed", error: outcome.error.message }, claim);
    void failed;
    throw new ServiceError("ACCESS_REVOKED", outcome.error.message, false);
  }
  return store.completeActionExecution(execution.id, { status: "failed", error: outcome.error.message }, claim);
}

async function runEmailStep(deps: BookingServiceDeps, actionId: string, version: number, params: HoldParams): Promise<ActionExecution> {
  const { store, email } = deps;
  const key = emailOperationKey(actionId, version);
  const { reservation, claimToken } = reserveStep(deps, actionId, version, key, "email");
  let execution = reservation.execution;
  if (execution.status === "succeeded") return execution; // never resend
  if (execution.status === "failed") {
    execution = store.reopenFailedStep(execution.id, { claimToken, leaseMs: STEP_CLAIM_LEASE_MS, nowMs: clockMs(deps) });
  } else if (execution.status === "uncertain" || execution.status === "partial") {
    throw new ServiceError("RECONCILE_REQUIRED", "Email step is uncertain; reconcile before retrying", false);
  } else if (reservation.reclaimed) {
    return recoverReclaimedEmail(deps, execution, key, claimToken);
  } else if (!reservation.created) {
    throw new ServiceError("CONFLICT", "Email step is already in progress for this approved proposal; wait or reconcile", true);
  }
  const claim = { claimToken };
  const haltIfStale = (): void => {
    if (!isStale(store, actionId, version)) return;
    const current = store.getActionExecution(execution.id);
    if (current.status === "pending") {
      store.markExecutionUncertain(execution.id, "Proposal changed while the provider call was outstanding; outcome left uncertain for reconciliation", claim);
    }
    assertLiveApprovalAfterWait(store, actionId, version);
  };
  let outcome;
  try {
    outcome = await email.sendEmail({
      operationKey: key,
      to: params.emailTo,
      subject: params.emailSubject,
      body: params.emailBody,
    });
  } catch (error) {
    const pending = store.markExecutionUncertain(execution.id, error instanceof Error ? error.message : "Email outcome was not received", claim);
    haltIfStale();
    return pending;
  }
  if (outcome.status === "succeeded") {
    const done = store.completeActionExecution(execution.id, { status: "succeeded", result: { ...provenResult(outcome) } }, claim);
    haltIfStale();
    return done;
  }
  if (outcome.status === "uncertain") {
    const pending = store.markExecutionUncertain(execution.id, outcome.error.message, claim);
    const reconciled = await email.reconcileSentEmail({ operationKey: key });
    if (reconciled.status === "succeeded") {
      const healed = store.reconcileActionExecution(pending.id, { status: "succeeded", result: { ...provenResult(reconciled) } });
      haltIfStale();
      return healed;
    }
    haltIfStale();
    return pending;
  }
  if (outcome.error.kind === "access_revoked" || outcome.error.kind === "authorization_denied") {
    const failed = store.completeActionExecution(execution.id, { status: "failed", error: outcome.error.message }, claim);
    void failed;
    throw new ServiceError("ACCESS_REVOKED", outcome.error.message, false);
  }
  return store.completeActionExecution(execution.id, { status: "failed", error: outcome.error.message }, claim);
}

/**
 * Approve the exact displayed proposal version, then execute:
 * fresh availability -> durable provisional hold -> durable email.
 * A hold never transitions the booking to confirmed.
 */
/**
 * Verify that the action still carries a live exact-version approval. Retry
 * and reconcile paths must not serve stale receipts after the proposal moved
 * on: returning an old succeeded step without this check would bypass the
 * exact-approval gate.
 */
function requireLiveApproval(store: GatherStore, actionId: string): void {
  requireCurrentBinding(store, actionId);
  const action = store.getProposedAction(actionId);
  if (!hasLiveApproval(store, actionId)) {
    throw new ServiceError(
      "STALE_PROPOSAL",
      `No live approval for the current proposal version (v${action.proposalVersion}); re-approve the displayed proposal first`,
      false,
    );
  }
}

/**
 * Fresh availability immediately before any (new or retried) hold write.
 * The requested range must be FULLY covered by available slots: a single
 * partially overlapping open slot is not sufficient. Any overlapping
 * unavailable slot blocks the hold.
 *
 * After the provider read, the same durable conflict set that the create
 * path enforces is consulted (excluding the caller's own operation key),
 * so availability and create agree in the same process and across restarts:
 * a window durably held by another booking refuses here with the same
 * actionable SLOT_UNAVAILABLE instead of failing later at create time.
 */
async function requireFreshAvailability(
  deps: BookingServiceDeps,
  bookingId: string,
  params: HoldParams,
  ownOperationKey: string,
): Promise<void> {
  const { store, calendar } = deps;
  const availability = await calendar.checkAvailability({
    operationKey: availabilityKey(params.calendarId, params.startAt, params.endAt),
    calendarId: params.calendarId,
    startAt: params.startAt,
    endAt: params.endAt,
  });
  if (availability.status === "failed") {
    const kind = availability.error.kind;
    if (kind === "access_revoked" || kind === "authorization_denied") {
      store.updateBookingStatus(bookingId, "uncertain");
      throw new ServiceError("ACCESS_REVOKED", availability.error.message, false);
    }
    store.updateBookingStatus(bookingId, "failed");
    throw new ServiceError("SLOT_UNAVAILABLE", availability.error.message, false);
  }
  if (availability.status === "uncertain") {
    store.updateBookingStatus(bookingId, "uncertain");
    throw new ServiceError("UNCERTAIN", "Availability check was uncertain; retry approval", true);
  }
  const startMs = Date.parse(params.startAt);
  const endMs = Date.parse(params.endAt);
  const blocked = availability.data.slots.find((slot) => !slot.available);
  if (blocked) {
    store.updateBookingStatus(bookingId, "failed");
    throw new ServiceError("SLOT_UNAVAILABLE", blocked.reason ?? "Requested date is unavailable", false);
  }
  const fullyCovered = availability.data.slots.some(
    (slot) => slot.available && Date.parse(slot.startAt) <= startMs && Date.parse(slot.endAt) >= endMs,
  );
  if (!fullyCovered) {
    store.updateBookingStatus(bookingId, "failed");
    throw new ServiceError("SLOT_UNAVAILABLE", "No available slot fully covers the requested range", false);
  }
  const durableConflict = store.findHoldConflict(params.calendarId, params.startAt, params.endAt, {
    excludeOperationKey: ownOperationKey,
    nowMs: clockMs(deps),
  });
  if (durableConflict) {
    store.updateBookingStatus(bookingId, "failed");
    throw new ServiceError("SLOT_UNAVAILABLE", durableWindowMessage(durableConflict), false);
  }
}

/**
 * Actionable mapping for the demonstrated durable-window conflict only.
 * Other conflict kinds (e.g. an operation key rebound to a different
 * payload) keep their EXECUTION_FAILED path so they are never masked as
 * availability.
 */
function isDurableWindowConflict(message: string | undefined): boolean {
  return message !== undefined && message.includes("already held (durable record");
}

function durableWindowMessage(conflictingKey: string): string {
  return `Demo calendar window is already held (durable record ${conflictingKey}); choose another window or reconcile the conflicting record`;
}

export async function approveAndExecute(deps: BookingServiceDeps, input: ApproveRequestDTO): Promise<ApproveResponseDTO> {
  const { store } = deps;
  const action = requireExactApproval(store, input);
  requireBookingWritable(store, action.bookingId);
  const booking = store.getBooking(action.bookingId);
  requireSupportedKind(action.kind);
  // Validate the executable consequences BEFORE recording an approval: an
  // invalid (or past) proposal must never gain an approval row.
  const params = resolveHoldParams(action.payload, { nowMs: clockMs(deps) });
  const approvedBy = ownerIdentity(deps);
  const approval = store.approveProposedAction(action.id, approvedBy);

  // A repeated approval whose own hold already succeeded reuses receipts: no
  // new write can occur, so a fresh availability read must not fail it.
  const ownHold = store.getExecutionByIdempotencyKey(holdOperationKey(action.id, action.proposalVersion));
  if (ownHold?.status !== "succeeded") {
    await requireFreshAvailability(deps, booking.id, params, holdOperationKey(action.id, action.proposalVersion));
    assertLiveApprovalAfterWait(store, action.id, action.proposalVersion);
  }

  const holdExecution = await runHoldStep(deps, action.id, action.proposalVersion, params);
  if (holdExecution.status === "failed") {
    store.updateBookingStatus(booking.id, "failed");
    if (isDurableWindowConflict(holdExecution.error)) {
      throw new ServiceError("SLOT_UNAVAILABLE", holdExecution.error as string, false);
    }
    throw new ServiceError("EXECUTION_FAILED", holdExecution.error ?? "Provisional hold failed", false);
  }
  // Hold exists (or its outcome is still uncertain): booking is provisional at best.
  store.updateBookingStatus(booking.id, holdExecution.status === "uncertain" ? "uncertain" : "provisional_hold");
  if (holdExecution.status === "uncertain") {
    const current = store.getBooking(booking.id);
    return {
      demo: true,
      mode: DEMO_MARKER,
      approval,
      approvedBy,
      booking: current,
      hold: toReceipt(holdExecution),
      email: null,
      availabilityFresh: true as const,
      confirmedBooking: false as const,
      note: "DEMO ONLY: hold outcome is uncertain; reconcile before retrying. A hold is never a confirmed booking.",
    };
  }

  const emailExecution = await runEmailStep(deps, action.id, action.proposalVersion, params);
  // Aggregate uncertainty: a hold with an uncertain email is not cleanly
  // provisional — the booking must show uncertainty until reconciled.
  if (emailExecution.status === "uncertain") {
    store.updateBookingStatus(booking.id, "uncertain");
  }
  const current = store.getBooking(booking.id);
  return {
    demo: true,
    mode: DEMO_MARKER,
    approval,
    approvedBy,
    booking: current,
    hold: toReceipt(holdExecution),
    email: toReceipt(emailExecution),
    availabilityFresh: true as const,
    confirmedBooking: false as const,
    note: emailExecution.status === "uncertain"
      ? "DEMO ONLY: email outcome is uncertain; reconcile before retrying. A hold is never a confirmed booking."
      : completionNote(holdExecution, emailExecution),
  };
}

/**
 * Completion wording derived from the stored step proofs: steps with
 * positive live proof are reported as provider receipts, all others as
 * simulated. Never blanket-claims simulated when a live-shaped connector
 * actually served the step, and never claims live without proof.
 */
function completionNote(hold: ActionExecution, email: ActionExecution): string {
  const liveHold = isLiveStepProof(hold.result);
  const liveEmail = isLiveStepProof(email.result);
  const base = "Provisional hold is not a confirmed booking.";
  if (liveHold && liveEmail) return `${base} Provider receipts recorded for each step.`;
  if (liveHold) return `DEMO ONLY: ${base} Hold receipt recorded by the provider; email receipt is simulated.`;
  if (liveEmail) return `DEMO ONLY: ${base} Email receipt recorded by the provider; hold receipt is simulated.`;
  return `DEMO ONLY: ${base} Email receipt is simulated.`;
}

/** Retry only failed steps; succeeded steps are never resent. */
export async function retryFailedSteps(deps: BookingServiceDeps, proposedActionId: string): Promise<RetryResponseDTO> {
  const { store } = deps;
  const action = store.getProposedAction(proposedActionId);
  store.getBooking(action.bookingId);
  requireBookingWritable(store, action.bookingId);
  // Even when every step already succeeded, retry must verify the current
  // proposal still carries a live exact-version approval.
  requireLiveApproval(store, action.id);
  requireSupportedKind(action.kind);
  const params = resolveHoldParams(action.payload, { nowMs: clockMs(deps) });
  const holdKey = holdOperationKey(action.id, action.proposalVersion);
  const mailKey = emailOperationKey(action.id, action.proposalVersion);
  const holdExisting = store.getExecutionByIdempotencyKey(holdKey);
  const mailExisting = store.getExecutionByIdempotencyKey(mailKey);
  if (holdExisting?.status === "uncertain" || holdExisting?.status === "partial" || mailExisting?.status === "uncertain" || mailExisting?.status === "partial") {
    throw new ServiceError("RECONCILE_REQUIRED", "An uncertain step must be reconciled before retry", false);
  }
  if (holdExisting && holdExisting.status !== "succeeded" && holdExisting.status !== "failed" && holdExisting.status !== "pending") {
    throw new ServiceError("INVALID_REQUEST", "Hold step is not in a retryable state", false);
  }
  // Fresh availability before any new hold write (skipped only when the hold
  // already succeeded and no write can occur).
  if (holdExisting?.status !== "succeeded") {
    await requireFreshAvailability(deps, action.bookingId, params, holdKey);
  }
  // Re-run hold only when it has not already succeeded.
  const hold = holdExisting?.status === "succeeded" ? holdExisting : await runHoldStep(deps, action.id, action.proposalVersion, params);
  if (hold.status === "uncertain") {
    store.updateBookingStatus(action.bookingId, "uncertain");
    throw new ServiceError("RECONCILE_REQUIRED", hold.error ?? "Hold retry is uncertain; reconcile before retrying", false);
  }
  if (hold.status !== "succeeded") {
    store.updateBookingStatus(action.bookingId, "failed");
    if (isDurableWindowConflict(hold.error)) {
      throw new ServiceError("SLOT_UNAVAILABLE", hold.error as string, false);
    }
    throw new ServiceError("EXECUTION_FAILED", hold.error ?? "Hold retry did not succeed", false);
  }
  store.updateBookingStatus(action.bookingId, "provisional_hold");
  const email = mailExisting?.status === "succeeded" ? mailExisting : await runEmailStep(deps, action.id, action.proposalVersion, params);
  if (email.status === "uncertain") {
    store.updateBookingStatus(action.bookingId, "uncertain");
    throw new ServiceError("RECONCILE_REQUIRED", email.error ?? "Email retry is uncertain; reconcile before retrying", false);
  }
  return {
    demo: true,
    mode: DEMO_MARKER,
    booking: store.getBooking(action.bookingId),
    hold: toReceipt(hold),
    email: toReceipt(email),
    resentSucceededStep: false as const,
    note: "DEMO ONLY: retry reused succeeded receipts; no successful provider step was resent.",
  };
}

/**
 * Reconcile a single uncertain/partial execution by its stable idempotency
 * key. Reconcile failures preserve uncertainty and are reported honestly:
 * a missing record means "no provider evidence yet" (retryable), never
 * proof of non-execution, so no new write is permitted on that basis.
 */
export async function reconcileExecution(deps: BookingServiceDeps, executionId: string): Promise<ReconcileResponseDTO> {
  const { store, calendar, email } = deps;
  const current = store.getActionExecution(executionId);
  if (current.status !== "uncertain" && current.status !== "partial") {
    throw new ServiceError("INVALID_REQUEST", "Only uncertain or partial executions require reconciliation", false);
  }
  // Reconciliation binds to the current proposal too: an uncertain step on a
  // superseded action (or one whose approval died with supersession) must
  // not heal into history as if it were the displayed proposal's outcome.
  // The owner re-approves the current proposal and its own steps run there.
  requireLiveApproval(store, current.proposedActionId);
  const kind = stepOf(current.idempotencyKey);
  const outcome = kind === "hold"
    ? await calendar.reconcileProvisionalHold({ operationKey: current.idempotencyKey })
    : await email.reconcileSentEmail({ operationKey: current.idempotencyKey });
  if (outcome.status !== "succeeded") {
    const errKind = outcome.error.kind;
    if (errKind === "access_revoked" || errKind === "authorization_denied") {
      throw new ServiceError("ACCESS_REVOKED", `Reconciliation blocked: ${outcome.error.message}`, false);
    }
    if (errKind === "invalid_request") {
      throw new ServiceError("INVALID_REQUEST", outcome.error.message, false);
    }
    // not_found, rate_limited, transport_error, timeout_after_success, or any
    // other ambiguous outcome: the execution stays uncertain and the caller
    // may retry reconciliation later. This is not a failure verdict.
    throw new ServiceError(
      "RECONCILE_PENDING",
      `No provider evidence yet for ${current.idempotencyKey}: ${outcome.error.message}. Execution remains uncertain; retry reconciliation later.`,
      true,
    );
  }
  const execution = store.reconcileActionExecution(current.id, { status: "succeeded", result: { ...provenResult(outcome) } });
  const action = store.getProposedAction(execution.proposedActionId);
  const booking = store.getBooking(action.bookingId);
  // After a hold reconciles to success the booking is provisional, never confirmed.
  if (kind === "hold" && booking.status !== "provisional_hold") {
    store.updateBookingStatus(booking.id, "provisional_hold");
  }
  refreshBookingAggregate(store, booking.id);
  return {
    demo: true,
    mode: DEMO_MARKER,
    execution,
    booking: store.getBooking(booking.id),
    note: isLiveStepProof(execution.result)
      ? "Reconciled against the provider record."
      : "DEMO ONLY: reconciled against the simulated provider record.",
  };
}

/**
 * Recompute the aggregate booking state from its step executions. Any
 * outstanding uncertain/partial step keeps the booking uncertain; once no
 * uncertainty remains and a hold succeeded, an uncertain booking returns to
 * provisional_hold (never confirmed). Failed steps leave the last explicit
 * state untouched.
 */
function refreshBookingAggregate(store: GatherStore, bookingId: string): void {
  const booking = store.getBooking(bookingId);
  const executions = store.listProposedActionsForBooking(bookingId).flatMap((action) => store.listActionExecutions(action.id));
  if (executions.some((item) => item.status === "uncertain" || item.status === "partial")) {
    if (booking.status !== "uncertain") store.updateBookingStatus(bookingId, "uncertain");
    return;
  }
  const holdSucceeded = executions.some((item) => item.status === "succeeded" && stepOf(item.idempotencyKey) === "hold");
  if (holdSucceeded && booking.status === "uncertain") {
    store.updateBookingStatus(bookingId, "provisional_hold");
  }
}
