export type ISODateTime = string;

export type EntityId = string;

export type SourceKind =
  | "connected_account"
  | "document"
  | "email"
  | "calendar"
  | "manual"
  | "fixture";

export interface SourceReference {
  kind: SourceKind;
  locator: string;
  label?: string;
  /** True for local fictional data. Fixtures must never look like verified integrations. */
  fictional?: boolean;
}

export interface Business {
  id: EntityId;
  name: string;
  timezone: string;
  status: "active" | "paused";
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface ConnectedAccount {
  id: EntityId;
  businessId: EntityId;
  provider: "gmail" | "google_drive" | "google_calendar" | "other";
  displayName: string;
  status: "connected" | "revoked" | "error";
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export type BookingStatus =
  | "inquiry"
  | "proposed"
  | "pending_approval"
  | "provisional_hold"
  | "confirmed"
  | "cancelled"
  | "failed"
  | "uncertain";

export interface Booking {
  id: EntityId;
  businessId: EntityId;
  status: BookingStatus;
  eventName: string;
  startAt?: ISODateTime;
  endAt?: ISODateTime;
  guestCount?: number;
  notes?: string;
  sourceReferences: SourceReference[];
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export type FactConfidence = "verified" | "probable" | "uncertain";

export interface BusinessFact {
  id: EntityId;
  businessId: EntityId;
  key: string;
  value: unknown;
  confidence: FactConfidence;
  sourceReferences: SourceReference[];
  observedAt: ISODateTime;
}

export type ActionKind =
  | "create_provisional_hold"
  | "send_offer"
  | "update_booking"
  | "custom";

export type ProposalStatus = "pending_approval" | "approved" | "superseded";

export interface ProposedAction {
  id: EntityId;
  bookingId: EntityId;
  kind: ActionKind;
  payload: Record<string, unknown>;
  proposalVersion: number;
  proposalFingerprint: string;
  sourceReferences: SourceReference[];
  status: ProposalStatus;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  /**
   * Durable per-booking publication order, assigned atomically at insert.
   * Unlike wall-clock createdAt (which can tie) or random UUIDs (which carry
   * no order), the sequence establishes newest-first without ambiguity.
   * proposalVersion keeps its existing meaning: the in-place revision count
   * within this action row.
   */
  proposalSeq: number;
  /** True only for the booking's single durable current proposal. */
  isCurrent: boolean;
}

export type ApprovalStatus = "approved" | "invalidated";

export interface Approval {
  id: EntityId;
  proposedActionId: EntityId;
  proposalVersion: number;
  proposalFingerprint: string;
  approvedBy: string;
  status: ApprovalStatus;
  approvedAt: ISODateTime;
  invalidatedAt?: ISODateTime;
  reason?: string;
}

export type ActionExecutionStatus =
  | "pending"
  | "succeeded"
  | "failed"
  | "partial"
  | "uncertain";

export interface ActionExecution {
  id: EntityId;
  proposedActionId: EntityId;
  proposalVersion: number;
  idempotencyKey: string;
  attempt: number;
  status: ActionExecutionStatus;
  result?: unknown;
  error?: string;
  startedAt: ISODateTime;
  completedAt?: ISODateTime;
  reconciledAt?: ISODateTime;
  /** Ownership claim on a pending row: only the claim holder may execute. */
  claimToken?: string;
  claimExpiresAt?: ISODateTime;
}

export interface ActionOutcome {
  status: Exclude<ActionExecutionStatus, "pending">;
  result?: unknown;
  error?: string;
}
