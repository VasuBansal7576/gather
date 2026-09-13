import type {
  ActionExecution,
  Approval,
  Booking,
  Business,
  ConnectedAccount,
  ProposedAction,
  SourceReference,
} from "../domain/contracts.ts";

/** Every workspace payload is explicitly demo-marked. Never render as live. */
export interface DemoModeMarker {
  kind: "demo";
  label: "DEMO ONLY";
  fictional: true;
  simulated: true;
}

export const DEMO_MARKER: DemoModeMarker = {
  kind: "demo",
  label: "DEMO ONLY",
  fictional: true,
  simulated: true,
};

export interface WorkspaceBookingDTO {
  booking: Booking;
  proposals: WorkspaceProposalDTO[];
  approvals: Approval[];
  executions: ActionExecution[];
}

export interface WorkspaceDTO {
  mode: DemoModeMarker;
  demo: true;
  /** Server-derived owner identity that approvals are recorded under. */
  approvalIdentity: string;
  businesses: Business[];
  bookings: WorkspaceBookingDTO[];
  connections: ConnectedAccount[];
  notice: string;
}

export interface ApproveRequestDTO {
  bookingId: string;
  proposedActionId: string;
  proposalVersion: number;
  proposalFingerprint: string;
  /**
   * Server-derived owner identity is authoritative. Clients must NOT send
   * approvedBy: the API boundary derives it from the configured local owner
   * identity (GATHER_OWNER_ID, default "local-owner"). Any request field is ignored.
   */
}

/** Exact executable consequences of a proposal, shown in the UI before approval. */
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
  action: ProposedAction;
  /** Null when the payload does not carry every executable field explicitly. */
  consequences: ProposalConsequencesDTO | null;
  consequencesError?: string;
}

export interface StepReceiptDTO {
  execution: ActionExecution;
  step: "hold" | "email";
  demo: true;
}

export interface ApproveResponseDTO {
  demo: true;
  mode: DemoModeMarker;
  approval: Approval;
  approvedBy: string;
  booking: Booking;
  hold: StepReceiptDTO;
  email: StepReceiptDTO | null;
  availabilityFresh: true;
  /** A provisional hold is never a confirmed booking. */
  confirmedBooking: false;
  note: string;
}

export interface RetryResponseDTO {
  demo: true;
  mode: DemoModeMarker;
  booking: Booking;
  hold: StepReceiptDTO;
  email: StepReceiptDTO | null;
  resentSucceededStep: false;
  note: string;
}

export interface ReconcileResponseDTO {
  demo: true;
  mode: DemoModeMarker;
  execution: ActionExecution;
  booking: Booking;
  note: string;
}

export interface DemoInitResponseDTO {
  demo: true;
  mode: DemoModeMarker;
  businessId: string;
  bookingIds: string[];
  proposalIds: string[];
  notice: string;
}

export interface ErrorDTO {
  code:
    | "INVALID_REQUEST"
    | "NOT_FOUND"
    | "STALE_PROPOSAL"
    | "CROSS_BOOKING"
    | "SLOT_UNAVAILABLE"
    | "ACCESS_REVOKED"
    | "CONFLICT"
    | "RECONCILE_REQUIRED"
    | "RECONCILE_PENDING"
    | "CROSS_ORIGIN_DENIED"
    | "EXECUTION_FAILED"
    | "DENIED"
    | "BUSY"
    | "UNCERTAIN";
  message: string;
  retryable: boolean;
  demo: true;
}

export type { ActionExecution, Approval, Booking, Business, ConnectedAccount, ProposedAction, SourceReference };
