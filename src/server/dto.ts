import type {
  ActionExecution,
  Approval,
  Booking,
  Business,
  ConnectedAccount,
  ProposedAction,
  SourceReference,
} from "../domain/contracts.ts";

/** Payload marker for fixture/simulated evidence. Never render as live. */
export interface DemoModeMarker {
  kind: "demo";
  label: "DEMO ONLY";
  fictional: true;
  simulated: true;
}

/** Payload marker for evidence carrying positive live provider proof. */
export interface LiveModeMarker {
  kind: "live";
  label: "LIVE";
  fictional: false;
  simulated: false;
}

/** Payload marker for real records whose provider evidence is not positively proven. */
export interface UnknownModeMarker {
  kind: "unknown";
  label: "EVIDENCE UNVERIFIED";
  fictional: false;
  simulated: false;
}

export type EvidenceModeMarker = DemoModeMarker | LiveModeMarker | UnknownModeMarker;

export const DEMO_MARKER: DemoModeMarker = {
  kind: "demo",
  label: "DEMO ONLY",
  fictional: true,
  simulated: true,
};

export const LIVE_MARKER: LiveModeMarker = {
  kind: "live",
  label: "LIVE",
  fictional: false,
  simulated: false,
};

export const UNKNOWN_MARKER: UnknownModeMarker = {
  kind: "unknown",
  label: "EVIDENCE UNVERIFIED",
  fictional: false,
  simulated: false,
};

export interface WorkspaceBookingDTO {
  booking: Booking;
  proposals: WorkspaceProposalDTO[];
  approvals: Approval[];
  executions: ActionExecution[];
  /**
   * Durable current-proposal pointer: id of the booking's single displayed /
   * approvable / confirmable action. The adapter selects exactly this
   * proposal and never re-derives "latest" from versions or timestamps.
   */
  currentProposedActionId?: string;
}

export interface WorkspaceDTO {
  mode: EvidenceModeMarker;
  demo: boolean;
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
  /**
   * True unless the step's stored result carries positive live connector
   * proof (live mode, not simulated, non-empty non-fictional provenance).
   * Unknown, simulated, or fixture proofs fail closed to true — a fixture
   * receipt is never upgraded to live.
   */
  demo: boolean;
}

export interface ApproveResponseDTO {
  demo: boolean;
  mode: EvidenceModeMarker;
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
  demo: boolean;
  mode: EvidenceModeMarker;
  booking: Booking;
  hold: StepReceiptDTO;
  email: StepReceiptDTO | null;
  resentSucceededStep: false;
  note: string;
}

export interface ReconcileResponseDTO {
  demo: boolean;
  mode: EvidenceModeMarker;
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
