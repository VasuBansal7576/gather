export type WorkspaceView = 'today' | 'bookings' | 'connections';

export type BookingStatus =
  | 'needs-review'
  | 'proposal-ready'
  | 'hold-pending'
  | 'confirmed';

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
}

export interface Proposal {
  id: string;
  version: string;
  total: string;
  deposit: string;
  validUntil: string;
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
  onNavigate?: (view: WorkspaceView) => void;
  onSelectBooking?: (bookingId: string) => void;
  onApproveProposal?: (bookingId: string, proposalId: string) => void;
  onEditProposal?: (bookingId: string, proposalId: string) => void;
  onConnect?: (provider: ConnectionProvider) => void;
  onRetryBlockedAction?: () => void;
}
