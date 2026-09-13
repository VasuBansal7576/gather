export type WorkspaceView = 'today' | 'bookings' | 'connections';

/**
 * `hold-pending` is kept as a deprecated alias for `waiting` so existing hosts
 * do not break; new hosts should prefer `waiting`.
 * `provisional-hold` means a hold exists — it is NOT a confirmed booking.
 */
export type BookingStatus =
  | 'needs-review'
  | 'proposal-ready'
  | 'waiting'
  | 'hold-pending'
  | 'provisional-hold'
  | 'confirmed'
  | 'failed'
  | 'uncertain'
  | 'partial';

export type ConnectionProvider = 'gmail' | 'drive' | 'calendar';

export interface BookingSummary {
  id: string;
  clientName: string;
  eventType: string;
  eventDate: string;
  eventTime: string;
  guestCount: number;
  venue: string;
  budget: string;
  status: BookingStatus;
  statusLabel: string;
  nextAction: string;
  clientInitials: string;
  clientTone: 'coral' | 'blue' | 'sage' | 'plum';
  detail: BookingDetail;
}

export interface BookingDetail {
  receivedAt: string;
  source: string;
  requestSummary: string;
  packageName: string;
  packageDescription: string;
  proposal: Proposal;
  activity: ActivityItem[];
  /**
   * Evidence-backed reason this booking is waiting, supplied by the host.
   * When absent the workspace shows a neutral waiting notice from nextAction
   * and never invents a cause such as a revoked connection.
   */
  waitingReason?: {
    title: string;
    description: string;
    /** Label for the host retry action, when recovery is available. */
    actionLabel?: string;
    /** Show a "Review connections" link — only set when the evidence points at a connection. */
    connectionsRelated?: boolean;
  };
  /**
   * Individual receipts for each consequential step the host has attempted.
   * Rendered honestly — a succeeded hold is never presented as a confirmed booking.
   */
  receipts?: ActionReceipt[];
}

export interface Proposal {
  /** Maps to the host's ProposedAction id. */
  id: string;
  /** Exact numeric version the approval callback must carry back. */
  version: number;
  /** Display label, e.g. "Version 2 · prepared today". */
  versionLabel: string;
  /** Content fingerprint of the exact proposal being approved. */
  fingerprint: string;
  total: string;
  deposit: string;
  validUntil: string;
  /**
   * Exact consequences the owner reviews before approving — each step the host
   * will attempt (recheck, provisional hold, offer send). Never claim an effect
   * is already done here.
   */
  consequences: string[];
  lines: ProposalLine[];
  sources: ProposalSource[];
}

export interface ProposalLine {
  label: string;
  detail: string;
  amount: string;
}

export interface ProposalSource {
  title: string;
  detail: string;
  kind: 'drive' | 'calendar' | 'email';
}

export interface ActivityItem {
  id: string;
  label: string;
  detail: string;
  timestamp: string;
  kind: 'inquiry' | 'source' | 'proposal' | 'warning';
}

export type ActionReceiptStatus = 'pending' | 'succeeded' | 'failed' | 'partial' | 'uncertain';

export interface ActionReceipt {
  id: string;
  /** Host ProposedAction id — passed to onRetryAction. */
  actionId: string;
  /** Host ActionExecution id — passed to onReconcileExecution when set. */
  executionId?: string;
  label: string;
  detail?: string;
  status: ActionReceiptStatus;
  timestamp?: string;
  /**
   * Label for the recovery control. Rendered when a safe recovery path exists
   * and the matching host callback is connected.
   */
  recoveryLabel?: string;
  /**
   * Explicit safe recovery declared by the host. `'retry'` is only honored
   * for `failed`/`partial` receipts — a `partial` retry means the host knows
   * the definitive failed step — while `uncertain` outcomes always reconcile
   * first. Defaults: `failed` retries, `partial`/`uncertain` reconcile
   * (requiring `executionId`); an aggregate partial never infers a definitive
   * failed step.
   */
  recovery?: 'retry' | 'reconcile';
}

/** The exact displayed proposal identity — carried verbatim to the host. */
export interface ProposalIdentity {
  bookingId: string;
  proposedActionId: string;
  proposalVersion: number;
  proposalFingerprint: string;
}

export interface ActionRetryRequest {
  bookingId: string;
  actionId: string;
}

export interface ExecutionReconcileRequest {
  bookingId: string;
  executionId: string;
}

export interface Connection {
  provider: ConnectionProvider;
  name: string;
  description: string;
  detail: string;
  connected: boolean;
  lastSynced?: string;
  recommended?: boolean;
}

export interface BlockedState {
  title: string;
  description: string;
  actionLabel?: string;
}

export interface GatherWorkspaceProps {
  bookings?: BookingSummary[];
  connections?: Connection[];
  loading?: boolean;
  blockedState?: BlockedState;
  initialView?: WorkspaceView;
  /**
   * Marks whether the data shown is simulated. Defaults to `'demo'` when the
   * local fixtures are in use and `'live'` when the host supplies both
   * bookings and connections — pass `'demo'` explicitly whenever custom data
   * is still simulated so the label is never hidden.
   */
  dataMode?: 'demo' | 'live';
  /**
   * Proposal fingerprints with an approval request currently in flight.
   * Matching approve controls stay disabled so the same version cannot be
   * approved twice while the host is working.
   */
  pendingApprovals?: readonly string[];
  onNavigate?: (view: WorkspaceView) => void;
  onSelectBooking?: (bookingId: string) => void;
  /**
   * Receives the exact displayed proposal identity — never just "the latest".
   * May return a promise: resolution hands pending display to the host's
   * props, and rejection surfaces an observable send failure with a retry
   * control. Duplicate clicks while sending are always ignored.
   */
  onApproveProposal?: (proposal: ProposalIdentity) => void | PromiseLike<void>;
  onEditProposal?: (proposal: ProposalIdentity) => void;
  onConnect?: (provider: ConnectionProvider) => void;
  /** Host-controlled retry for the workspace-level blocked banner. */
  onRetryBlockedAction?: () => void;
  /** Retry a failed or partially completed action (POST /actions/:actionId/retry). */
  onRetryAction?: (request: ActionRetryRequest) => void;
  /** Reconcile an uncertain execution before any retry (POST /executions/:executionId/reconcile). */
  onReconcileExecution?: (request: ExecutionReconcileRequest) => void;
}
