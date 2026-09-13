/**
 * Client-side mirror of the server DTO contract with `unknown` boundary
 * validation. Every field the UI consumes is checked before it is trusted —
 * a malformed payload fails loudly instead of rendering garbage.
 */

export class DtoValidationError extends Error {
  readonly code = "INVALID_DTO" as const;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function req(record: Record<string, unknown>, field: string): unknown {
  if (!(field in record)) throw new DtoValidationError(`Missing required field: ${field}`);
  return record[field];
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new DtoValidationError(`${field} must be a string`);
  return value;
}

function asNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new DtoValidationError(`${field} must be a number`);
  return value;
}

function asOptString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return asString(value, field);
}

function asRecordOf(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new DtoValidationError(`${field} must be an object`);
  return value;
}

function asArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new DtoValidationError(`${field} must be an array`);
  return value;
}

function asEnum<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  const text = asString(value, field);
  if (!allowed.includes(text as T)) {
    throw new DtoValidationError(`${field} must be one of ${allowed.join("/")}, got "${text}"`);
  }
  return text as T;
}

const BOOKING_STATUSES = [
  "inquiry",
  "proposed",
  "pending_approval",
  "provisional_hold",
  "confirmed",
  "failed",
  "uncertain",
  "cancelled",
] as const;

const EXECUTION_STATUSES = ["pending", "succeeded", "failed", "partial", "uncertain"] as const;

const MODE_KINDS = ["demo", "live"] as const;

export interface SourceRefDTO {
  kind: string;
  locator: string;
  label?: string;
  fictional?: boolean;
}

export interface BookingDTO {
  id: string;
  businessId: string;
  status: string;
  eventName: string;
  startAt?: string;
  endAt?: string;
  guestCount?: number;
  notes?: string;
  sourceReferences: SourceRefDTO[];
  createdAt: string;
  updatedAt: string;
}

export interface ProposedActionDTO {
  id: string;
  bookingId: string;
  kind: string;
  payload: Record<string, unknown>;
  proposalVersion: number;
  proposalFingerprint: string;
  sourceReferences: SourceRefDTO[];
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApprovalDTO {
  id: string;
  proposedActionId: string;
  proposalVersion: number;
  proposalFingerprint: string;
  approvedBy: string;
  status: string;
  approvedAt: string;
  reason?: string;
}

export interface ExecutionDTO {
  id: string;
  proposedActionId: string;
  proposalVersion: number;
  idempotencyKey: string;
  status: string;
  error?: string;
  startedAt: string;
  completedAt?: string;
  reconciledAt?: string;
}

export interface ProposalConsequencesDTO {
  startAt: string;
  endAt: string;
  expiresAt: string;
  calendarId: string;
  emailTo: string[];
  emailSubject: string;
  emailBody: string;
}

export interface WorkspaceProposalDTO {
  action: ProposedActionDTO;
  consequences: ProposalConsequencesDTO | null;
  consequencesError?: string;
}

export interface WorkspaceBookingDTO {
  booking: BookingDTO;
  proposals: WorkspaceProposalDTO[];
  approvals: ApprovalDTO[];
  executions: ExecutionDTO[];
}

export interface ConnectedAccountDTO {
  id: string;
  provider: string;
  displayName: string;
  status: string;
  updatedAt: string;
}

export interface BusinessDTO {
  id: string;
  name: string;
  timezone: string;
}

export interface WorkspaceDTO {
  mode: { kind: string; label: string };
  demo: boolean;
  approvalIdentity: string;
  businesses: BusinessDTO[];
  bookings: WorkspaceBookingDTO[];
  connections: ConnectedAccountDTO[];
  notice: string;
}

export interface ErrorDTO {
  code: string;
  message: string;
  retryable: boolean;
}

function parseSourceRef(value: unknown, field: string): SourceRefDTO {
  const record = asRecordOf(value, field);
  return {
    kind: asString(req(record, "kind"), `${field}.kind`),
    locator: asString(req(record, "locator"), `${field}.locator`),
    label: asOptString(record.label, `${field}.label`),
    fictional: record.fictional === true ? true : undefined,
  };
}

function parseSourceRefs(value: unknown, field: string): SourceRefDTO[] {
  return asArray(value, field).map((item, index) => parseSourceRef(item, `${field}[${index}]`));
}

function parseBooking(value: unknown): BookingDTO {
  const record = asRecordOf(value, "booking");
  const parsed: BookingDTO = {
    id: asString(req(record, "id"), "booking.id"),
    businessId: asString(req(record, "businessId"), "booking.businessId"),
    status: asEnum(req(record, "status"), "booking.status", BOOKING_STATUSES),
    eventName: asString(req(record, "eventName"), "booking.eventName"),
    sourceReferences: parseSourceRefs(record.sourceReferences ?? [], "booking.sourceReferences"),
    createdAt: asString(req(record, "createdAt"), "booking.createdAt"),
    updatedAt: asString(req(record, "updatedAt"), "booking.updatedAt"),
  };
  if (record.startAt !== undefined) parsed.startAt = asString(record.startAt, "booking.startAt");
  if (record.endAt !== undefined) parsed.endAt = asString(record.endAt, "booking.endAt");
  if (record.guestCount !== undefined) parsed.guestCount = asNumber(record.guestCount, "booking.guestCount");
  if (record.notes !== undefined) parsed.notes = asString(record.notes, "booking.notes");
  return parsed;
}

function parseAction(value: unknown): ProposedActionDTO {
  const record = asRecordOf(value, "action");
  return {
    id: asString(req(record, "id"), "action.id"),
    bookingId: asString(req(record, "bookingId"), "action.bookingId"),
    kind: asString(req(record, "kind"), "action.kind"),
    payload: asRecordOf(record.payload ?? {}, "action.payload"),
    proposalVersion: asNumber(req(record, "proposalVersion"), "action.proposalVersion"),
    proposalFingerprint: asString(req(record, "proposalFingerprint"), "action.proposalFingerprint"),
    sourceReferences: parseSourceRefs(record.sourceReferences ?? [], "action.sourceReferences"),
    status: asString(req(record, "status"), "action.status"),
    createdAt: asString(req(record, "createdAt"), "action.createdAt"),
    updatedAt: asString(req(record, "updatedAt"), "action.updatedAt"),
  };
}

function parseConsequences(value: unknown): ProposalConsequencesDTO | null {
  if (value === null || value === undefined) return null;
  const record = asRecordOf(value, "consequences");
  return {
    startAt: asString(req(record, "startAt"), "consequences.startAt"),
    endAt: asString(req(record, "endAt"), "consequences.endAt"),
    expiresAt: asString(req(record, "expiresAt"), "consequences.expiresAt"),
    calendarId: asString(req(record, "calendarId"), "consequences.calendarId"),
    emailTo: asArray(req(record, "emailTo"), "consequences.emailTo").map((item, index) =>
      asString(item, `consequences.emailTo[${index}]`),
    ),
    emailSubject: asString(req(record, "emailSubject"), "consequences.emailSubject"),
    emailBody: asString(req(record, "emailBody"), "consequences.emailBody"),
  };
}

function parseProposal(value: unknown): WorkspaceProposalDTO {
  const record = asRecordOf(value, "proposal");
  return {
    action: parseAction(req(record, "action")),
    consequences: parseConsequences(record.consequences),
    consequencesError: asOptString(record.consequencesError, "proposal.consequencesError"),
  };
}

function parseApproval(value: unknown): ApprovalDTO {
  const record = asRecordOf(value, "approval");
  return {
    id: asString(req(record, "id"), "approval.id"),
    proposedActionId: asString(req(record, "proposedActionId"), "approval.proposedActionId"),
    proposalVersion: asNumber(req(record, "proposalVersion"), "approval.proposalVersion"),
    proposalFingerprint: asString(req(record, "proposalFingerprint"), "approval.proposalFingerprint"),
    approvedBy: asString(req(record, "approvedBy"), "approval.approvedBy"),
    status: asString(req(record, "status"), "approval.status"),
    approvedAt: asString(req(record, "approvedAt"), "approval.approvedAt"),
    reason: asOptString(record.reason, "approval.reason"),
  };
}

function parseExecution(value: unknown): ExecutionDTO {
  const record = asRecordOf(value, "execution");
  return {
    id: asString(req(record, "id"), "execution.id"),
    proposedActionId: asString(req(record, "proposedActionId"), "execution.proposedActionId"),
    proposalVersion: asNumber(req(record, "proposalVersion"), "execution.proposalVersion"),
    idempotencyKey: asString(req(record, "idempotencyKey"), "execution.idempotencyKey"),
    status: asEnum(req(record, "status"), "execution.status", EXECUTION_STATUSES),
    error: asOptString(record.error, "execution.error"),
    startedAt: asString(req(record, "startedAt"), "execution.startedAt"),
    completedAt: asOptString(record.completedAt, "execution.completedAt"),
    reconciledAt: asOptString(record.reconciledAt, "execution.reconciledAt"),
  };
}

function parseWorkspaceBooking(value: unknown): WorkspaceBookingDTO {
  const record = asRecordOf(value, "bookings[]");
  return {
    booking: parseBooking(req(record, "booking")),
    proposals: asArray(record.proposals ?? [], "proposals").map(parseProposal),
    approvals: asArray(record.approvals ?? [], "approvals").map(parseApproval),
    executions: asArray(record.executions ?? [], "executions").map(parseExecution),
  };
}

function parseConnection(value: unknown): ConnectedAccountDTO {
  const record = asRecordOf(value, "connection");
  return {
    id: asString(req(record, "id"), "connection.id"),
    provider: asString(req(record, "provider"), "connection.provider"),
    displayName: asString(req(record, "displayName"), "connection.displayName"),
    status: asString(req(record, "status"), "connection.status"),
    updatedAt: asString(req(record, "updatedAt"), "connection.updatedAt"),
  };
}

export function parseWorkspaceDTO(value: unknown): WorkspaceDTO {
  const record = asRecordOf(value, "workspace");
  const mode = asRecordOf(req(record, "mode"), "workspace.mode");
  const kind = asEnum(req(mode, "kind"), "mode.kind", MODE_KINDS);
  const demo = record.demo === true;
  // Correlated semantics: a "demo" mode must be flagged demo, and a live
  // workspace may never claim the demo marker — anything else is corrupt.
  if (kind === "demo" && !demo) {
    throw new DtoValidationError('mode.kind is "demo" but workspace.demo is not true');
  }
  if (kind === "live" && demo) {
    throw new DtoValidationError('mode.kind is "live" but workspace.demo is true');
  }
  return {
    mode: { kind, label: asString(req(mode, "label"), "mode.label") },
    demo,
    approvalIdentity: asString(req(record, "approvalIdentity"), "approvalIdentity"),
    businesses: asArray(record.businesses ?? [], "businesses").map((item) => {
      const business = asRecordOf(item, "business");
      return {
        id: asString(req(business, "id"), "business.id"),
        name: asString(req(business, "name"), "business.name"),
        timezone: asString(req(business, "timezone"), "business.timezone"),
      };
    }),
    bookings: asArray(record.bookings ?? [], "bookings").map(parseWorkspaceBooking),
    connections: asArray(record.connections ?? [], "connections").map(parseConnection),
    notice: asString(record.notice ?? "", "notice"),
  };
}

/** Parses an ErrorDTO body; returns undefined when the body is not one. */
export function parseErrorDTO(value: unknown): ErrorDTO | undefined {
  if (!isRecord(value) || typeof value.code !== "string" || typeof value.message !== "string") return undefined;
  return { code: value.code, message: value.message, retryable: value.retryable === true };
}
