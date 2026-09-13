import { stableOperationKey } from "../connectors/contracts.ts";
import type {
  CalendarAvailabilityReader,
  EmailSender,
  ProvisionalHoldWriter,
} from "../connectors/contracts.ts";
import { GatherStore } from "./sqlite-store.ts";
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

export type ServiceErrorCode =
  | "NOT_FOUND"
  | "STALE_PROPOSAL"
  | "CROSS_BOOKING"
  | "SLOT_UNAVAILABLE"
  | "ACCESS_REVOKED"
  | "CONFLICT"
  | "RECONCILE_REQUIRED"
  | "EXECUTION_FAILED"
  | "UNCERTAIN"
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
  now?: () => string;
  calendarId?: string;
  /**
   * Configured local owner identity (e.g. GATHER_OWNER_ID). Approvals are
   * always recorded under this value; request-supplied identities are ignored.
   */
  ownerId?: string;
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
 */
export function resolveHoldParams(actionPayload: Record<string, unknown>): HoldParams {
  const payload = asRecord(actionPayload);
  const startAt = str(payload.startAt);
  const endAt = str(payload.endAt);
  const expiresAt = str(payload.expiresAt);
  if (!startAt || !endAt || !validRange(startAt, endAt)) {
    throw new ServiceError("INVALID_REQUEST", "Proposal payload must carry an explicit valid startAt/endAt range", false);
  }
  if (!expiresAt || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.parse(endAt)) {
    throw new ServiceError("INVALID_REQUEST", "Proposal payload must carry an explicit expiresAt after endAt", false);
  }
  const rawTo = payload.emailTo;
  const emailTo = (Array.isArray(rawTo) ? rawTo : []).filter((item): item is string => typeof item === "string" && item.length > 0);
  if (emailTo.length === 0) throw new ServiceError("INVALID_REQUEST", "Proposal payload must carry an explicit non-empty emailTo array", false);
  const emailSubject = str(payload.emailSubject);
  const emailBody = str(payload.emailBody);
  if (!emailSubject) throw new ServiceError("INVALID_REQUEST", "Proposal payload must carry an explicit emailSubject", false);
  if (!emailBody) throw new ServiceError("INVALID_REQUEST", "Proposal payload must carry an explicit emailBody", false);
  return { startAt, endAt, expiresAt, emailTo, emailSubject, emailBody };
}

/** UI preview of the exact consequences approval would execute (same resolver). */
export function previewConsequences(actionPayload: Record<string, unknown>): {
  consequences: import("./dto.ts").ProposalConsequencesDTO | null;
  consequencesError?: string;
} {
  try {
    const params = resolveHoldParams(actionPayload);
    return { consequences: { ...params, calendarId: "demo-calendar-001" } };
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

function toReceipt(execution: ActionExecution): StepReceiptDTO {
  return { execution, step: stepOf(execution.idempotencyKey), demo: true as const };
}

function availabilityKey(startAt: string, endAt: string): string {
  return stableOperationKey({ connector: "calendar", operation: "availability", identity: { endAt, startAt } });
}

/** Read-only workspace aggregation for the owner UI. */
export function getWorkspace(store: GatherStore, deps?: Pick<BookingServiceDeps, "ownerId" | "calendarId">): WorkspaceDTO {
  const businesses = store.listBusinesses();
  const connections = store.listConnectedAccounts();
  const calendarId = deps?.calendarId ?? "demo-calendar-001";
  const bookings = store.listBookings().map((booking) => {
    const actions = store.listProposedActionsForBooking(booking.id);
    return {
      booking,
      proposals: actions.map((action) => {
        const preview = previewConsequences(action.payload);
        return {
          action,
          consequences: preview.consequences ? { ...preview.consequences, calendarId } : null,
          ...(preview.consequencesError ? { consequencesError: preview.consequencesError } : {}),
        };
      }),
      approvals: actions.flatMap((action) => store.listApprovals(action.id)),
      executions: actions.flatMap((action) => store.listActionExecutions(action.id)),
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
  return action;
}

async function runHoldStep(deps: BookingServiceDeps, actionId: string, version: number, params: HoldParams): Promise<ActionExecution> {
  const { store, calendar } = deps;
  const key = holdOperationKey(actionId, version);
  let execution = store.reserveStepExecution(actionId, version, key);
  if (execution.status === "succeeded") return execution; // never resend
  if (execution.status === "failed") execution = store.reopenFailedStep(execution.id);
  if (execution.status === "uncertain" || execution.status === "partial") {
    throw new ServiceError("RECONCILE_REQUIRED", "Hold step is uncertain; reconcile before retrying", false);
  }
  // execution is now pending (freshly reserved, reopened, or recovered after crash)
  let outcome;
  try {
    outcome = await calendar.createProvisionalHold({
      operationKey: key,
      bookingId: store.getProposedAction(actionId).bookingId,
      calendarId: deps.calendarId ?? "demo-calendar-001",
      startAt: params.startAt,
      endAt: params.endAt,
      expiresAt: params.expiresAt,
    });
  } catch (error) {
    return store.markExecutionUncertain(execution.id, error instanceof Error ? error.message : "Hold outcome was not received");
  }
  if (outcome.status === "succeeded") {
    return store.completeActionExecution(execution.id, { status: "succeeded", result: { ...outcome.data, demo: true } });
  }
  if (outcome.status === "uncertain") {
    // Persist uncertainty BEFORE any retry, then attempt one reconciliation read.
    const pending = store.markExecutionUncertain(execution.id, outcome.error.message);
    const reconciled = await calendar.reconcileProvisionalHold({ operationKey: key });
    if (reconciled.status === "succeeded") {
      return store.reconcileActionExecution(pending.id, { status: "succeeded", result: { ...reconciled.data, demo: true } });
    }
    return pending;
  }
  // outcome.status === "failed"
  if (outcome.error.kind === "slot_unavailable" || outcome.error.kind === "conflict") {
    return store.completeActionExecution(execution.id, { status: "failed", error: outcome.error.message });
  }
  if (outcome.error.kind === "access_revoked" || outcome.error.kind === "authorization_denied") {
    const failed = store.completeActionExecution(execution.id, { status: "failed", error: outcome.error.message });
    throw new ServiceError("ACCESS_REVOKED", outcome.error.message, false);
  }
  return store.completeActionExecution(execution.id, { status: "failed", error: outcome.error.message });
}

async function runEmailStep(deps: BookingServiceDeps, actionId: string, version: number, params: HoldParams): Promise<ActionExecution> {
  const { store, email } = deps;
  const key = emailOperationKey(actionId, version);
  let execution = store.reserveStepExecution(actionId, version, key);
  if (execution.status === "succeeded") return execution; // never resend
  if (execution.status === "failed") execution = store.reopenFailedStep(execution.id);
  if (execution.status === "uncertain" || execution.status === "partial") {
    throw new ServiceError("RECONCILE_REQUIRED", "Email step is uncertain; reconcile before retrying", false);
  }
  let outcome;
  try {
    outcome = await email.sendEmail({
      operationKey: key,
      to: params.emailTo,
      subject: params.emailSubject,
      body: params.emailBody,
    });
  } catch (error) {
    return store.markExecutionUncertain(execution.id, error instanceof Error ? error.message : "Email outcome was not received");
  }
  if (outcome.status === "succeeded") {
    return store.completeActionExecution(execution.id, { status: "succeeded", result: { ...outcome.data, demo: true } });
  }
  if (outcome.status === "uncertain") {
    const pending = store.markExecutionUncertain(execution.id, outcome.error.message);
    const reconciled = await email.reconcileSentEmail({ operationKey: key });
    if (reconciled.status === "succeeded") {
      return store.reconcileActionExecution(pending.id, { status: "succeeded", result: { ...reconciled.data, demo: true } });
    }
    return pending;
  }
  if (outcome.error.kind === "access_revoked" || outcome.error.kind === "authorization_denied") {
    const failed = store.completeActionExecution(execution.id, { status: "failed", error: outcome.error.message });
    void failed;
    throw new ServiceError("ACCESS_REVOKED", outcome.error.message, false);
  }
  return store.completeActionExecution(execution.id, { status: "failed", error: outcome.error.message });
}

/**
 * Approve the exact displayed proposal version, then execute:
 * fresh availability -> durable provisional hold -> durable email.
 * A hold never transitions the booking to confirmed.
 */
export async function approveAndExecute(deps: BookingServiceDeps, input: ApproveRequestDTO): Promise<ApproveResponseDTO> {
  const { store, calendar } = deps;
  const action = requireExactApproval(store, input);
  const booking = store.getBooking(action.bookingId);
  const approvedBy = ownerIdentity(deps);
  const approval = store.approveProposedAction(action.id, approvedBy);
  const params = resolveHoldParams(action.payload);

  // Fresh availability immediately before the provisional hold.
  const availability = await calendar.checkAvailability({
    operationKey: availabilityKey(params.startAt, params.endAt),
    startAt: params.startAt,
    endAt: params.endAt,
  });
  if (availability.status === "failed") {
    const kind = availability.error.kind;
    if (kind === "access_revoked" || kind === "authorization_denied") {
      store.updateBookingStatus(booking.id, "uncertain");
      throw new ServiceError("ACCESS_REVOKED", availability.error.message, false);
    }
    store.updateBookingStatus(booking.id, "failed");
    throw new ServiceError("SLOT_UNAVAILABLE", availability.error.message, false);
  }
  if (availability.status === "uncertain") {
    store.updateBookingStatus(booking.id, "uncertain");
    throw new ServiceError("UNCERTAIN", "Availability check was uncertain; retry approval", true);
  }
  const coversOpen = availability.data.slots.some((slot) => slot.available);
  const blocked = availability.data.slots.some((slot) => !slot.available);
  if (!coversOpen || blocked) {
    const reason = availability.data.slots.find((slot) => !slot.available)?.reason ?? "Requested date is unavailable";
    store.updateBookingStatus(booking.id, "failed");
    throw new ServiceError("SLOT_UNAVAILABLE", reason, false);
  }

  const holdExecution = await runHoldStep(deps, action.id, action.proposalVersion, params);
  if (holdExecution.status === "failed") {
    store.updateBookingStatus(booking.id, "failed");
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
    note: "DEMO ONLY: provisional hold is not a confirmed booking. Email receipt is simulated.",
  };
}

/** Retry only failed steps; succeeded steps are never resent. */
export async function retryFailedSteps(deps: BookingServiceDeps, proposedActionId: string): Promise<RetryResponseDTO> {
  const { store } = deps;
  const action = store.getProposedAction(proposedActionId);
  store.getBooking(action.bookingId);
  const params = resolveHoldParams(action.payload);
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
  // Re-run hold only when it has not already succeeded.
  const hold = holdExisting?.status === "succeeded" ? holdExisting : await runHoldStep(deps, action.id, action.proposalVersion, params);
  if (hold.status !== "succeeded") {
    store.updateBookingStatus(action.bookingId, hold.status === "uncertain" ? "uncertain" : "failed");
    throw new ServiceError("EXECUTION_FAILED", hold.error ?? "Hold retry did not succeed", false);
  }
  store.updateBookingStatus(action.bookingId, "provisional_hold");
  const email = mailExisting?.status === "succeeded" ? mailExisting : await runEmailStep(deps, action.id, action.proposalVersion, params);
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

/** Reconcile a single uncertain/partial execution by its stable idempotency key. */
export async function reconcileExecution(deps: BookingServiceDeps, executionId: string): Promise<ReconcileResponseDTO> {
  const { store, calendar, email } = deps;
  const current = store.getActionExecution(executionId);
  if (current.status !== "uncertain" && current.status !== "partial") {
    throw new ServiceError("INVALID_REQUEST", "Only uncertain or partial executions require reconciliation", false);
  }
  const kind = stepOf(current.idempotencyKey);
  const outcome = kind === "hold"
    ? await calendar.reconcileProvisionalHold({ operationKey: current.idempotencyKey })
    : await email.reconcileSentEmail({ operationKey: current.idempotencyKey });
  if (outcome.status !== "succeeded") {
    throw new ServiceError("NOT_FOUND", "No completed provider write was found for reconciliation", false);
  }
  const execution = store.reconcileActionExecution(current.id, { status: "succeeded", result: { ...outcome.data, demo: true } });
  const action = store.getProposedAction(execution.proposedActionId);
  const booking = store.getBooking(action.bookingId);
  // After a hold reconciles to success the booking is provisional, never confirmed.
  if (kind === "hold" && booking.status !== "provisional_hold") {
    store.updateBookingStatus(booking.id, "provisional_hold");
  }
  return { demo: true, mode: DEMO_MARKER, execution, booking: store.getBooking(booking.id), note: "DEMO ONLY: reconciled against the simulated provider record." };
}
