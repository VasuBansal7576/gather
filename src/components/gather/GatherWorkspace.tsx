'use client';

import { useEffect, useState } from 'react';
import type { ReactNode, SVGProps } from 'react';
import type {
  ActionReceipt,
  ActionReceiptStatus,
  BookingSummary,
  BookingStatus,
  Connection,
  ConnectionProvider,
  GatherWorkspaceProps,
  Proposal,
  ProposalIdentity,
  ProposalSource,
  WorkspaceView,
} from './types';
import { isApprovalInFlight, receiptRecoveryKind, resolveSelectedBookingId } from './state';
import { DEMO_BOOKINGS, DEMO_CONNECTIONS } from './demo-data';
import './GatherWorkspace.css';

type IconName =
  | 'arrow-up-right'
  | 'calendar'
  | 'check'
  | 'chevron-down'
  | 'chevron-left'
  | 'chevron-right'
  | 'clock'
  | 'close'
  | 'document'
  | 'drive'
  | 'edit'
  | 'email'
  | 'external'
  | 'inbox'
  | 'leaf'
  | 'link'
  | 'menu'
  | 'more'
  | 'pin'
  | 'plus'
  | 'refresh'
  | 'search'
  | 'send'
  | 'settings'
  | 'sparkle'
  | 'users'
  | 'warning';


function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const common: SVGProps<SVGSVGElement> = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
  };

  switch (name) {
    case 'arrow-up-right':
      return <svg {...common}><path d="M7 17 17 7M8 7h9v9" /></svg>;
    case 'calendar':
      return <svg {...common}><rect x="3.5" y="5" width="17" height="16" rx="2" /><path d="M7.5 3v4M16.5 3v4M3.5 9.5h17" /><path d="M8 13h.01M12 13h.01M16 13h.01M8 17h.01M12 17h.01" /></svg>;
    case 'check':
      return <svg {...common}><path d="m5 12 4.3 4.3L19 6.8" /></svg>;
    case 'chevron-down':
      return <svg {...common}><path d="m6 9 6 6 6-6" /></svg>;
    case 'chevron-left':
      return <svg {...common}><path d="m15 6-6 6 6 6" /></svg>;
    case 'chevron-right':
      return <svg {...common}><path d="m9 6 6 6-6 6" /></svg>;
    case 'clock':
      return <svg {...common}><circle cx="12" cy="12" r="8.5" /><path d="M12 7v5l3.5 2" /></svg>;
    case 'close':
      return <svg {...common}><path d="m6 6 12 12M18 6 6 18" /></svg>;
    case 'document':
      return <svg {...common}><path d="M7 3.5h7l4 4v13H7z" /><path d="M14 3.5v4h4M10 12h5M10 15.5h5" /></svg>;
    case 'drive':
      return <svg {...common}><path d="m9 4 3.2 0 7 12H16L9 4Z" /><path d="m9 4-7 12h6.2l7-12H9Z" /><path d="m2 16 3.1 4h13.8l-2.4-4H2Z" /></svg>;
    case 'edit':
      return <svg {...common}><path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3ZM14.5 7.5l2 2" /></svg>;
    case 'email':
      return <svg {...common}><rect x="3" y="5.5" width="18" height="13" rx="2" /><path d="m4.5 7 7.5 6 7.5-6" /></svg>;
    case 'external':
      return <svg {...common}><path d="M14 4h6v6M20 4l-9 9" /><path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" /></svg>;
    case 'inbox':
      return <svg {...common}><path d="M4 5.5h16v13H4z" /><path d="M4 14h4l1.5 2h5L16 14h4" /></svg>;
    case 'leaf':
      return <svg {...common}><path d="M19 4C11 4 5 7.5 5 13.5A5.5 5.5 0 0 0 10.5 19C16.5 19 20 13 20 5v-.5c0-.3-.2-.5-.5-.5Z" /><path d="M4 20c3.5-5 7-7.5 11.5-9" /></svg>;
    case 'link':
      return <svg {...common}><path d="M10 13.5a4 4 0 0 0 5.7.1l2.2-2.2a4 4 0 0 0-5.7-5.7l-1.3 1.2" /><path d="M14 10.5a4 4 0 0 0-5.7-.1l-2.2 2.2a4 4 0 0 0 5.7 5.7l1.3-1.2" /></svg>;
    case 'menu':
      return <svg {...common}><path d="M4 7h16M4 12h16M4 17h16" /></svg>;
    case 'more':
      return <svg {...common}><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" /></svg>;
    case 'pin':
      return <svg {...common}><path d="M12 21s-7-5.3-7-11a7 7 0 0 1 14 0c0 5.7-7 11-7 11Z" /><circle cx="12" cy="10" r="2.5" /></svg>;
    case 'plus':
      return <svg {...common}><path d="M12 5v14M5 12h14" /></svg>;
    case 'refresh':
      return <svg {...common}><path d="M19 8a7.5 7.5 0 1 0 1 6M19 4v4h-4" /></svg>;
    case 'search':
      return <svg {...common}><circle cx="10.8" cy="10.8" r="6.5" /><path d="m16 16 4 4" /></svg>;
    case 'send':
      return <svg {...common}><path d="m4 11 16-7-6 16-2.5-6.5L4 11Z" /><path d="M11.5 13.5 20 4" /></svg>;
    case 'settings':
      return <svg {...common}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-1.7 1.7-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.1h-2.4v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L8 17l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H6v-2.4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L7.3 8 9 6.3l.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.6V5h2.4v.1a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.1 8l-.1.1a1.7 1.7 0 0 0 1.6 1h.1v2.4h-.1a1.7 1.7 0 0 0-1.6 1Z" /></svg>;
    case 'sparkle':
      return <svg {...common}><path d="m12 3 1.2 5.8L19 10l-5.8 1.2L12 17l-1.2-5.8L5 10l5.8-1.2L12 3ZM19 16l.5 2.5L22 19l-2.5.5L19 22l-.5-2.5L16 19l2.5-.5L19 16Z" /></svg>;
    case 'users':
      return <svg {...common}><path d="M16 19v-1.5a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4V19" /><circle cx="9.5" cy="7.5" r="3.5" /><path d="M21 19v-1.5a4 4 0 0 0-2.5-3.7M15 4.2a3.5 3.5 0 0 1 0 6.6" /></svg>;
    case 'warning':
      return <svg {...common}><path d="m12 4 8.3 15H3.7L12 4Z" /><path d="M12 9v4M12 16h.01" /></svg>;
    default: {
      const exhaustive: never = name;
      return exhaustive;
    }
  }
}

function statusClass(status: BookingStatus) {
  switch (status) {
    case 'needs-review':
    case 'failed':
      return 'is-coral';
    case 'proposal-ready':
    case 'provisional-hold':
    case 'partial':
      return 'is-gold';
    case 'waiting':
    case 'hold-pending':
    case 'uncertain':
      return 'is-slate';
    case 'confirmed':
      return 'is-sage';
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

const RECEIPT_STATUS_META: Record<ActionReceiptStatus, { label: string; className: string; icon: IconName }> = {
  pending: { label: 'In progress', className: 'is-slate', icon: 'clock' },
  succeeded: { label: 'Done', className: 'is-sage', icon: 'check' },
  failed: { label: 'Failed', className: 'is-coral', icon: 'warning' },
  partial: { label: 'Partially done', className: 'is-gold', icon: 'warning' },
  uncertain: { label: 'Outcome uncertain', className: 'is-slate', icon: 'clock' },
};

function guestsLabel(booking: BookingSummary): string {
  return booking.guestCount === undefined ? 'Guests not specified' : `${booking.guestCount} guests`;
}

function proposalIdentityOf(booking: BookingSummary): ProposalIdentity {
  const proposal = booking.detail.proposal;
  return {
    bookingId: booking.id,
    proposedActionId: proposal.id,
    proposalVersion: proposal.version,
    proposalFingerprint: proposal.fingerprint,
  };
}

function connectionIcon(provider: ConnectionProvider): IconName {
  switch (provider) {
    case 'gmail':
      return 'email';
    case 'drive':
      return 'drive';
    case 'calendar':
      return 'calendar';
    case 'unsupported':
      return 'warning';
    default: {
      const exhaustive: never = provider;
      return exhaustive;
    }
  }
}

function formatToday() {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(new Date());
}

function DemoLabel() {
  return <span className="gather-demo-label"><span className="gather-demo-dot" />Demo data</span>;
}

function Logo() {
  return (
    <div className="gather-logo" aria-label="Gather">
      <span className="gather-logo-mark"><Icon name="leaf" size={17} /></span>
      <span>Gather</span>
    </div>
  );
}

function Avatar({ initials, tone }: { initials: BookingSummary['clientInitials']; tone: BookingSummary['clientTone'] }) {
  return <span className={`gather-avatar gather-avatar-${tone}`} aria-hidden="true">{initials}</span>;
}

function StatusPill({ booking }: { booking: BookingSummary }) {
  return <span className={`gather-status-pill ${statusClass(booking.status)}`}><span />{booking.statusLabel}</span>;
}

function NavItem({
  view,
  activeView,
  label,
  icon,
  count,
  onClick,
}: {
  view: WorkspaceView;
  activeView: WorkspaceView;
  label: string;
  icon: IconName;
  count?: number;
  onClick: (view: WorkspaceView) => void;
}) {
  return (
    <button
      type="button"
      className={`gather-nav-item ${activeView === view ? 'is-active' : ''}`}
      aria-current={activeView === view ? 'page' : undefined}
      onClick={() => onClick(view)}
    >
      <Icon name={icon} size={17} />
      <span>{label}</span>
      {count ? <span className="gather-nav-count">{count}</span> : null}
    </button>
  );
}

function Sidebar({
  activeView,
  reviewCount,
  onNavigate,
}: {
  activeView: WorkspaceView;
  reviewCount: number;
  onNavigate: (view: WorkspaceView) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const handleNavigate = (view: WorkspaceView) => { onNavigate(view); setMenuOpen(false); };
  return (
    <aside className={`gather-sidebar ${menuOpen ? 'is-open' : ''}`}>
      <div className="gather-sidebar-top">
        <Logo />
        <button
          className="gather-icon-button gather-mobile-menu"
          type="button"
          aria-label={menuOpen ? 'Close navigation' : 'Open navigation'}
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        ><Icon name={menuOpen ? 'close' : 'menu'} /></button>
      </div>
      <button type="button" className="gather-search-box" disabled aria-disabled="true" title="Search is not available yet">
        <Icon name="search" size={15} /><span>Search</span><kbd>⌘ K</kbd>
      </button>
      <div className="gather-sidebar-section">
        <nav className="gather-nav" aria-label="Workspace">
          <NavItem view="today" activeView={activeView} label="Today" icon="inbox" onClick={handleNavigate} />
        </nav>
      </div>
      <div className="gather-sidebar-section">
        <span className="gather-sidebar-eyebrow">Venue</span>
        <nav className="gather-nav" aria-label="Venue">
          <NavItem view="bookings" activeView={activeView} label="Bookings" icon="email" count={reviewCount} onClick={handleNavigate} />
          <NavItem view="connections" activeView={activeView} label="Connections" icon="link" onClick={handleNavigate} />
        </nav>
      </div>
      <div className="gather-sidebar-bottom">
        <button type="button" className="gather-account-button" disabled aria-disabled="true" title="Account settings are not available yet">
          <span className="gather-account-avatar">G</span>
          <span className="gather-account-copy"><strong>Gather Venue</strong><small>Owner workspace</small></span>
          <Icon name="chevron-right" size={14} />
        </button>
        <button type="button" className="gather-nav-item" disabled aria-disabled="true" title="Settings are not available yet">
          <Icon name="settings" size={17} /><span>Settings</span>
        </button>
      </div>
    </aside>
  );
}

function PageIntro({
  title,
  eyebrow,
  description,
  children,
}: {
  title: string;
  eyebrow: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="gather-page-intro">
      <div>
        <span className="gather-eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {children ? <div className="gather-page-intro-actions">{children}</div> : null}
    </div>
  );
}

function BriefingCard({
  eyebrow,
  title,
  detail,
  icon,
  tone,
  children,
}: {
  eyebrow: string;
  title: string;
  detail: string;
  icon: IconName;
  tone: 'coral' | 'sage' | 'gold';
  children?: ReactNode;
}) {
  return (
    <article className={`gather-briefing-card gather-briefing-${tone}`}>
      <div className="gather-briefing-card-top"><span className="gather-briefing-icon"><Icon name={icon} size={18} /></span><span className="gather-card-kicker">{eyebrow}</span></div>
      <h2>{title}</h2>
      <p>{detail}</p>
      {children}
    </article>
  );
}

function TriageRow({
  booking,
  selected,
  onSelect,
}: {
  booking: BookingSummary;
  selected: boolean;
  onSelect: (booking: BookingSummary) => void;
}) {
  return (
    <button type="button" className={`gather-triage-row ${selected ? 'is-selected' : ''}`} onClick={() => onSelect(booking)} aria-current={selected ? 'true' : undefined}>
      <span className="gather-triage-row-top">
        <span className={`gather-triage-dot ${statusClass(booking.status)}`} />
        <span className="gather-triage-row-name">{booking.clientName}</span>
        <time>{booking.eventDate}</time>
      </span>
      <span className="gather-triage-row-sub">{booking.statusLabel}</span>
      <span className="gather-triage-row-meta">{booking.eventType} · {booking.eventDate} · {guestsLabel(booking)}</span>
    </button>
  );
}

function BookingRow({
  booking,
  selected,
  onSelect,
}: {
  booking: BookingSummary;
  selected: boolean;
  onSelect: (booking: BookingSummary) => void;
}) {
  return (
    <button type="button" className={`gather-booking-row ${selected ? 'is-selected' : ''}`} onClick={() => onSelect(booking)} aria-current={selected ? 'true' : undefined}>
      <Avatar initials={booking.clientInitials} tone={booking.clientTone} />
      <span className="gather-booking-row-copy">
        <span className="gather-booking-row-name">{booking.clientName}</span>
        <span className="gather-booking-row-event">{booking.eventType} · {booking.eventDate}</span>
      </span>
      <span className="gather-booking-row-meta"><StatusPill booking={booking} /><span>{guestsLabel(booking)}</span></span>
      <Icon name="chevron-right" size={17} />
    </button>
  );
}

function SourceIcon({ kind }: { kind: ProposalSource['kind'] }) {
  return <span className={`gather-source-icon gather-source-${kind}`}><Icon name={kind === 'unsupported' ? 'warning' : kind} size={15} /></span>;
}

function ProposalPanel({
  proposal,
}: {
  proposal: Proposal;
}) {
  return (
    <section className="gather-review-block" aria-labelledby="proposal-heading">
      <div className="gather-block-heading">
        <div>
          <span className="gather-eyebrow">Prepared offer</span>
          <h2 id="proposal-heading">Quote breakdown</h2>
        </div>
        <span className="gather-version-label">{proposal.versionLabel}</span>
      </div>
      <div className="gather-proposal-lines">
        {proposal.lines.map((line) => (
          <div className="gather-proposal-line" key={line.label}>
            <div><strong>{line.label}</strong><span>{line.detail}</span></div><b>{line.amount}</b>
          </div>
        ))}
      </div>
      <div className="gather-proposal-total">
        <div><span className="gather-total-label">Total</span><strong>{proposal.total}</strong></div>
        <div className="gather-total-context"><span>{proposal.deposit}</span><span>{proposal.validUntil}</span></div>
      </div>
      <div className="gather-proposal-scope">
        <span className="gather-scope-label">Exactly what approval will do</span>
        <ul className="gather-scope-list">
          {proposal.consequences.map((consequence) => <li key={consequence}>{consequence}</li>)}
        </ul>
        <p className="gather-scope-identity">
          Approves proposal <strong>{proposal.id}</strong> · version <strong>{proposal.version}</strong> · fingerprint <code>{proposal.fingerprint}</code>
        </p>
      </div>
      {proposal.emailPreview ? (
        <div className="gather-email-preview">
          <span className="gather-scope-label">The exact email this would send</span>
          <div className="gather-email-preview-head">
            <span><small>To</small>{proposal.emailPreview.to}</span>
            <span><small>Subject</small>{proposal.emailPreview.subject}</span>
          </div>
          <p className="gather-email-preview-body">{proposal.emailPreview.body}</p>
        </div>
      ) : null}
    </section>
  );
}

function ApprovalFooter({
  approvalPending,
  approvalFailed,
  canApprove,
  canEdit,
  onApprove,
  onEdit,
}: {
  approvalPending: boolean;
  approvalFailed: boolean;
  canApprove: boolean;
  canEdit: boolean;
  onApprove: () => void;
  onEdit: () => void;
}) {
  const approveDisabled = approvalPending || !canApprove;
  return (
    <div className="gather-review-footer">
      <div className="gather-review-actions">
        <button
          type="button"
          className="gather-approve-button"
          disabled={approveDisabled}
          aria-disabled={approveDisabled}
          title={canApprove ? undefined : 'Approval is not available in this workspace yet'}
          onClick={onApprove}
        >
          <Icon name={approvalPending ? 'clock' : approvalFailed ? 'refresh' : 'send'} size={16} />{approvalPending ? 'Approval sent — waiting' : approvalFailed ? 'Try approval again' : 'Approve proposal'}
        </button>
        <button type="button" className="gather-secondary-button" disabled={!canEdit} aria-disabled={!canEdit} title={canEdit ? undefined : 'Editing is not available in this workspace yet'} onClick={onEdit}><Icon name="edit" size={15} />Edit offer</button>
      </div>
      <p className={`gather-action-note ${approvalFailed ? 'is-error' : ''}`} role={approvalFailed ? 'alert' : 'status'}>
        {approvalFailed
          ? 'The approval request did not go through. Nothing was sent — you can try again.'
          : approvalPending
            ? 'The approval request is on its way. This is not confirmed.'
            : canApprove
              ? 'A sent request is not a hold, and a hold is not a confirmed booking.'
              : 'Approval and editing are not available in this workspace yet.'}
      </p>
    </div>
  );
}

function ReceiptsPanel({
  booking,
  onRetryAction,
  onReconcileExecution,
}: {
  booking: BookingSummary;
  onRetryAction?: (bookingId: string, actionId: string) => void;
  onReconcileExecution?: (bookingId: string, executionId: string) => void;
}) {
  const receipts = booking.detail.receipts ?? [];
  if (receipts.length === 0) return null;
  return (
    <section className="gather-review-block gather-receipts-panel" aria-labelledby="receipts-heading">
      <div className="gather-block-heading gather-block-heading-tight">
        <div><span className="gather-eyebrow">Outcomes</span><h2 id="receipts-heading">Action receipts</h2></div>
      </div>
      <div className="gather-receipt-list" role="status" aria-live="polite">
        {receipts.map((receipt) => {
          const meta = RECEIPT_STATUS_META[receipt.status];
          const recoveryKind = receiptRecoveryKind(receipt);
          const canRecover =
            recoveryKind === 'retry' ? onRetryAction !== undefined :
            recoveryKind === 'reconcile' ? onReconcileExecution !== undefined :
            false;
          const handleRecover = () => {
            if (recoveryKind === 'retry') onRetryAction?.(booking.id, receipt.actionId);
            else if (recoveryKind === 'reconcile' && receipt.executionId) onReconcileExecution?.(booking.id, receipt.executionId);
          };
          return (
            <div className="gather-receipt-item" key={receipt.id}>
              <span className={`gather-receipt-marker ${meta.className}`}><Icon name={meta.icon} size={13} /></span>
              <div className="gather-receipt-copy">
                <div className="gather-receipt-title-line"><strong>{receipt.label}</strong><span className={`gather-status-pill ${meta.className}`}><span />{meta.label}</span></div>
                {receipt.detail ? <span className="gather-receipt-detail">{receipt.detail}</span> : null}
                {recoveryKind && !canRecover ? <span className="gather-receipt-hint">Recovery is not available in this workspace yet.</span> : null}
              </div>
              <div className="gather-receipt-side">
                {receipt.timestamp ? <time>{receipt.timestamp}</time> : null}
                {recoveryKind ? (
                  <button
                    type="button"
                    className="gather-text-button gather-recovery-button"
                    disabled={!canRecover}
                    aria-disabled={!canRecover}
                    onClick={handleRecover}
                  >
                    <Icon name="refresh" size={12} />{receipt.recoveryLabel}
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function SourcesPanel({ sources }: { sources: ProposalSource[] }) {
  return (
    <section className="gather-review-block gather-sources-panel" aria-labelledby="sources-heading">
      <div className="gather-block-heading gather-block-heading-tight"><div><span className="gather-eyebrow">Evidence trail</span><h2 id="sources-heading">Sources used</h2></div></div>
      <div className="gather-source-list">
        {sources.map((source) => <div className="gather-source-row" key={source.title}><SourceIcon kind={source.kind} /><span><strong>{source.title}</strong><small>{source.detail}</small></span></div>)}
      </div>
      <p className="gather-source-note"><Icon name="sparkle" size={14} />Every consequential detail stays linked to its source.</p>
    </section>
  );
}

function ActivityPanel({ booking }: { booking: BookingSummary }) {
  return (
    <section className="gather-review-block gather-activity-panel" aria-labelledby="activity-heading">
      <div className="gather-block-heading gather-block-heading-tight"><div><span className="gather-eyebrow">Record</span><h2 id="activity-heading">Activity</h2></div><button className="gather-icon-button" type="button" aria-label="More activity options" disabled aria-disabled="true" title="More options are not available yet"><Icon name="more" /></button></div>
      <div className="gather-activity-list">
        {booking.detail.activity.map((item) => (
          <div className="gather-activity-item" key={item.id}>
            <span className={`gather-activity-marker is-${item.kind}`} />
            <div><strong>{item.label}</strong></div><time>{item.timestamp}</time>
          </div>
        ))}
      </div>
    </section>
  );
}

function BlockedNotice({
  title,
  description,
  actionLabel = 'Review connections',
  secondaryActionLabel,
  onAction,
  onSecondaryAction,
}: {
  title: string;
  description: string;
  actionLabel?: string;
  secondaryActionLabel?: string;
  onAction?: () => void;
  onSecondaryAction?: () => void;
}) {
  return (
    <div className="gather-blocked-notice" role="status">
      <span className="gather-blocked-icon"><Icon name="warning" size={18} /></span>
      <div><strong>{title}</strong><p>{description}</p></div>
      <div className="gather-blocked-actions">
        {onAction ? <button type="button" className="gather-secondary-button gather-small-button" onClick={onAction}>{actionLabel}<Icon name="chevron-right" size={14} /></button> : null}
        {onSecondaryAction && secondaryActionLabel ? <button type="button" className="gather-text-button" onClick={onSecondaryAction}>{secondaryActionLabel}<Icon name="chevron-right" size={13} /></button> : null}
      </div>
    </div>
  );
}

function MetaRow({ label, icon, value, sub }: { label: string; icon?: IconName; value: ReactNode; sub?: string }) {
  return (
    <div className="gather-meta-row">
      <span className="gather-meta-label">{label}</span>
      <span className="gather-meta-value">{icon ? <Icon name={icon} size={14} /> : null}<strong>{value}</strong></span>
      {sub ? <span className="gather-meta-sub">{sub}</span> : null}
    </div>
  );
}

function BookingMeta({ booking }: { booking: BookingSummary }) {
  const proposal = booking.detail.proposal;
  return (
    <aside className="gather-triage-meta" aria-label="Booking details">
      <MetaRow label="Customer" value={booking.customerName ?? 'Not recorded'} sub={booking.detail.source} />
      <MetaRow label="Event date" icon="calendar" value={booking.eventDate} />
      <MetaRow label="Venue" icon="pin" value={booking.venue} />
      <MetaRow label="Attendance" icon="users" value={guestsLabel(booking)} />
      <MetaRow label="Budget" value={booking.budget} />
      <div className="gather-meta-row">
        <span className="gather-meta-label">Status</span>
        <span className="gather-meta-value"><StatusPill booking={booking} /></span>
        <span className="gather-meta-sub">{booking.nextAction}</span>
      </div>
      <MetaRow label="Deposit" icon="document" value={proposal.deposit} sub={proposal.validUntil} />
      <div className="gather-meta-group">
        <span className="gather-meta-label">Proposal</span>
        <div className="gather-meta-related">
          <span><Icon name="document" size={14} />{proposal.id}</span>
          <span><Icon name="refresh" size={13} />Version {proposal.version}</span>
        </div>
      </div>
      <div className="gather-meta-group">
        <span className="gather-meta-label">Notes</span>
        <button type="button" className="gather-meta-note-button" disabled aria-disabled="true" title="Notes are not available yet">
          <Icon name="edit" size={14} />Add note
        </button>
      </div>
    </aside>
  );
}

function BookingDetailPanel({
  booking,
  position,
  approvalPending,
  approvalFailed,
  canApprove,
  canEdit,
  onApprove,
  onEdit,
  onBlockedAction,
  onReviewConnections,
  onRetryAction,
  onReconcileExecution,
  onPrev,
  onNext,
  onBack,
}: {
  booking: BookingSummary;
  position: string;
  approvalPending: boolean;
  approvalFailed: boolean;
  canApprove: boolean;
  canEdit: boolean;
  onApprove: (booking: BookingSummary) => void;
  onEdit: (booking: BookingSummary) => void;
  onBlockedAction?: () => void;
  onReviewConnections: () => void;
  onRetryAction?: (bookingId: string, actionId: string) => void;
  onReconcileExecution?: (bookingId: string, executionId: string) => void;
  onPrev?: () => void;
  onNext?: () => void;
  onBack?: () => void;
}) {
  const waiting = booking.status === 'waiting' || booking.status === 'hold-pending';
  const waitingReason = booking.detail.waitingReason;
  const proposal = booking.detail.proposal;
  return (
    <div className="gather-booking-detail">
      <div className="gather-review-top">
        {onBack ? <button type="button" className="gather-back-button" onClick={onBack}><Icon name="chevron-left" size={15} />All bookings</button> : null}
        <div className="gather-review-crumbs"><span>Bookings</span><Icon name="chevron-right" size={12} /><strong>{booking.id}</strong></div>
        <div className="gather-review-pager">
          <span>{position}</span>
          <button type="button" className="gather-icon-button" aria-label="Previous booking" disabled={!onPrev} aria-disabled={!onPrev} title={onPrev ? undefined : 'This is the first booking'} onClick={onPrev}><Icon name="chevron-left" size={15} /></button>
          <button type="button" className="gather-icon-button" aria-label="Next booking" disabled={!onNext} aria-disabled={!onNext} title={onNext ? undefined : 'This is the last booking'} onClick={onNext}><Icon name="chevron-right" size={15} /></button>
        </div>
      </div>
      <div className="gather-review-scroll">
        <h2 className="gather-review-title">{booking.clientName}</h2>
        <div className="gather-review-chips">
          <span><Icon name="users" size={14} />{guestsLabel(booking)}</span>
          <span><Icon name="calendar" size={14} />{booking.eventDate}</span>
          <span><Icon name="pin" size={14} />{booking.venue}</span>
        </div>
        <div className="gather-review-summary">
          <h3>{booking.detail.packageName}</h3>
          <p>{booking.detail.packageDescription}</p>
        </div>
        {waiting ? (
          <BlockedNotice
            title={waitingReason?.title ?? 'This booking is waiting'}
            description={waitingReason?.description ?? booking.nextAction}
            actionLabel={waitingReason?.actionLabel ?? 'Try again'}
            secondaryActionLabel={waitingReason?.connectionsRelated ? 'Review connections' : undefined}
            onAction={onBlockedAction}
            onSecondaryAction={waitingReason?.connectionsRelated ? onReviewConnections : undefined}
          />
        ) : null}
        <ProposalPanel proposal={proposal} />
        <div className="gather-message-card">
          <Avatar initials={booking.clientInitials} tone={booking.clientTone} />
          <div>
            <div className="gather-message-head"><strong>{booking.clientName}</strong><span>{booking.detail.source}</span><time>{booking.detail.receivedAt}</time></div>
            <p>{booking.detail.requestSummary}</p>
          </div>
        </div>
        <ReceiptsPanel booking={booking} onRetryAction={onRetryAction} onReconcileExecution={onReconcileExecution} />
        <SourcesPanel sources={proposal.sources} />
        <ActivityPanel booking={booking} />
      </div>
      <ApprovalFooter
        approvalPending={approvalPending}
        approvalFailed={approvalFailed}
        canApprove={canApprove}
        canEdit={canEdit}
        onApprove={() => onApprove(booking)}
        onEdit={() => onEdit(booking)}
      />
    </div>
  );
}

function TodayView({
  bookings,
  connectedSourceCount,
  showDemoData,
  selectedBooking,
  onSelect,
  onNavigate,
}: {
  bookings: BookingSummary[];
  connectedSourceCount: number;
  showDemoData: boolean;
  selectedBooking?: BookingSummary;
  onSelect: (booking: BookingSummary) => void;
  onNavigate: (view: WorkspaceView) => void;
}) {
  const reviewCount = bookings.filter((booking) => booking.status === 'needs-review' || booking.status === 'proposal-ready').length;
  const nextBooking = bookings.find((booking) => booking.status === 'needs-review' || booking.status === 'proposal-ready');
  return (
    <>
      <PageIntro eyebrow="Your day, your way" title="Good morning, Taylor" description={`${formatToday()} · a little room to breathe before the next service.`}>
        {showDemoData ? <DemoLabel /> : null}
      </PageIntro>
      <div className="gather-briefing-grid">
        <BriefingCard eyebrow="Needs your eye" title={`${reviewCount} ${reviewCount === 1 ? 'proposal' : 'proposals'} to review`} detail="The details are assembled. You decide what feels right for your room." icon="sparkle" tone="coral"><button type="button" className="gather-card-link" onClick={() => onNavigate('bookings')}>Open review queue <Icon name="arrow-up-right" size={14} /></button></BriefingCard>
        <BriefingCard eyebrow="Coming up" title={nextBooking ? nextBooking.eventDate : 'A clear horizon'} detail={nextBooking ? `${nextBooking.clientName} · ${nextBooking.eventType} · ${guestsLabel(nextBooking)}` : 'No upcoming events need your attention today.'} icon="calendar" tone="sage"><span className="gather-card-detail">{nextBooking?.eventTime ?? 'You are all caught up'}</span></BriefingCard>
        <BriefingCard eyebrow="Business context" title={`${connectedSourceCount} ${connectedSourceCount === 1 ? 'source' : 'sources'} connected`} detail="Gather can draw from your inbox, your files, and your calendar." icon="link" tone="gold"><button type="button" className="gather-card-link" onClick={() => onNavigate('connections')}>Manage connections <Icon name="arrow-up-right" size={14} /></button></BriefingCard>
      </div>
      <div className="gather-section-heading"><div><span className="gather-eyebrow">Your queue</span><h2>Bookings worth a look</h2></div><button type="button" className="gather-text-button" onClick={() => onNavigate('bookings')}>View all <Icon name="arrow-up-right" size={14} /></button></div>
      <div className="gather-home-bookings">
        {bookings.slice(0, 3).map((booking) => <BookingRow booking={booking} selected={selectedBooking?.id === booking.id} onSelect={onSelect} key={booking.id} />)}
        {bookings.length === 0 ? <EmptyState title="Your queue is quiet" description="New inquiries and proposals will appear here when your connected sources have something for you." actionLabel="Review connections" onAction={() => onNavigate('connections')} /> : null}
      </div>
      <div className="gather-quiet-note"><Icon name="leaf" size={16} /><span><strong>Gather is keeping the details warm.</strong> You stay in charge of every consequential step.</span></div>
    </>
  );
}

function EmptyState({ title, description, actionLabel, onAction }: { title: string; description: string; actionLabel?: string; onAction?: () => void }) {
  return <div className="gather-empty-state"><span className="gather-empty-icon"><Icon name="inbox" size={22} /></span><h2>{title}</h2><p>{description}</p>{onAction && actionLabel ? <button type="button" className="gather-secondary-button" onClick={onAction}>{actionLabel}<Icon name="chevron-right" size={14} /></button> : null}</div>;
}

function LoadingState() {
  return <div className="gather-loading-state" role="status" aria-label="Loading workspace"><span className="gather-skeleton gather-skeleton-large" /><span className="gather-skeleton gather-skeleton-medium" /><div className="gather-skeleton-card-grid"><span className="gather-skeleton gather-skeleton-card" /><span className="gather-skeleton gather-skeleton-card" /><span className="gather-skeleton gather-skeleton-card" /></div><span className="gather-skeleton gather-skeleton-list" /><span className="gather-skeleton gather-skeleton-list" /></div>;
}

function BookingsView({
  bookings,
  showDemoData,
  selectedBooking,
  approvalPending,
  approvalFailed,
  canApprove,
  canEdit,
  canRetryBlocked,
  onSelect,
  onApprove,
  onEdit,
  onBlockedAction,
  onReviewConnections,
  onRetryAction,
  onReconcileExecution,
}: {
  bookings: BookingSummary[];
  showDemoData: boolean;
  selectedBooking?: BookingSummary;
  approvalPending: boolean;
  approvalFailed: boolean;
  canApprove: boolean;
  canEdit: boolean;
  canRetryBlocked: boolean;
  onSelect: (booking: BookingSummary) => void;
  onApprove: (booking: BookingSummary) => void;
  onEdit: (booking: BookingSummary) => void;
  onBlockedAction: (booking: BookingSummary) => void;
  onReviewConnections: () => void;
  onRetryAction?: (bookingId: string, actionId: string) => void;
  onReconcileExecution?: (bookingId: string, executionId: string) => void;
}) {
  const [mobileDetail, setMobileDetail] = useState(false);
  const handleSelect = (booking: BookingSummary) => { onSelect(booking); setMobileDetail(true); };
  const selectedIndex = selectedBooking ? bookings.findIndex((booking) => booking.id === selectedBooking.id) : -1;
  const step = (offset: number) => {
    const next = bookings[selectedIndex + offset];
    if (next) onSelect(next);
  };
  return (
    <div className={`gather-triage ${mobileDetail ? 'is-mobile-detail' : ''}`}>
      <section className="gather-triage-list" aria-label="Bookings list">
        <div className="gather-triage-list-head">
          <h2>Bookings <span>{bookings.length}</span></h2>
          <div className="gather-triage-list-actions">
            {showDemoData ? <DemoLabel /> : null}
            <button className="gather-icon-button" type="button" aria-label="Filter bookings" disabled aria-disabled="true" title="Filtering is not available yet"><Icon name="settings" size={15} /></button>
          </div>
        </div>
        {bookings.length === 0 ? <EmptyState title="No bookings yet" description="Connect Gmail or add an inquiry to see your next opportunity here." /> : bookings.map((booking) => <TriageRow booking={booking} selected={selectedBooking?.id === booking.id} onSelect={handleSelect} key={booking.id} />)}
      </section>
      {selectedBooking ? (
        <>
          <BookingDetailPanel
            booking={selectedBooking}
            position={`${selectedIndex + 1} of ${bookings.length}`}
            approvalPending={approvalPending}
            approvalFailed={approvalFailed}
            canApprove={canApprove}
            canEdit={canEdit}
            onApprove={onApprove}
            onEdit={onEdit}
            onBlockedAction={canRetryBlocked ? () => onBlockedAction(selectedBooking) : undefined}
            onReviewConnections={onReviewConnections}
            onRetryAction={onRetryAction}
            onReconcileExecution={onReconcileExecution}
            onPrev={selectedIndex > 0 ? () => step(-1) : undefined}
            onNext={selectedIndex >= 0 && selectedIndex < bookings.length - 1 ? () => step(1) : undefined}
            onBack={() => setMobileDetail(false)}
          />
          <BookingMeta booking={selectedBooking} />
        </>
      ) : (
        <div className="gather-triage-empty"><EmptyState title="Nothing selected" description="Choose a booking from the list to review its proposal." /></div>
      )}
    </div>
  );
}

function ConnectionCard({ connection, hostWired, onConnect }: { connection: Connection; hostWired: boolean; onConnect: (provider: ConnectionProvider) => void }) {
  return <article className={`gather-connection-card ${connection.connected ? 'is-connected' : 'is-needs-attention'}`}><div className="gather-connection-top"><span className={`gather-connection-icon is-${connection.provider}`}><Icon name={connectionIcon(connection.provider)} size={21} /></span><span className={connection.connected ? 'gather-connected-label' : 'gather-attention-label'}>{connection.connected ? <><Icon name="check" size={13} />Connected</> : <><Icon name="warning" size={13} />Needs attention</>}</span></div><h2>{connection.name}</h2><p>{connection.description}</p><div className="gather-connection-footer"><span>{connection.connected ? connection.lastSynced : connection.detail}</span>{connection.connected ? <button type="button" className="gather-text-button" disabled aria-disabled="true" title="Managing connections is not available yet">Manage <Icon name="chevron-right" size={14} /></button> : <button type="button" className="gather-approve-button gather-small-button" disabled={!hostWired} aria-disabled={!hostWired} title={hostWired ? `Reconnect ${connection.name}` : 'Reconnecting is not available in this workspace yet'} onClick={() => onConnect(connection.provider)}><Icon name="refresh" size={15} />Reconnect</button>}</div>{!connection.connected && !hostWired ? <p className="gather-connection-note">Reconnecting is not available in this demo workspace — the button stays off instead of pretending to work.</p> : null}</article>;
}

function ConnectionsView({ connections, showDemoData, hostWired, onConnect }: { connections: Connection[]; showDemoData: boolean; hostWired: boolean; onConnect: (provider: ConnectionProvider) => void }) {
  const connectedCount = connections.filter((connection) => connection.connected).length;
  return <>
    <PageIntro eyebrow="Business context" title="Connections" description="Gather works from the tools you already use. Choose what it can read, and keep authority in your hands.">{showDemoData ? <DemoLabel /> : null}<button type="button" className="gather-secondary-button" disabled aria-disabled="true" title="Adding a connection is not available yet"><Icon name="plus" size={16} />Add connection</button></PageIntro>
    <div className="gather-connection-banner"><span className="gather-banner-icon"><Icon name="sparkle" size={19} /></span><div><strong>{connectedCount} of {connections.length} sources are ready</strong><p>Connect your calendar to unlock reliable availability checks for every proposal.</p></div><span className="gather-banner-progress" aria-label={`${connectedCount} of ${connections.length} connected`}><span style={{ width: `${connections.length ? (connectedCount / connections.length) * 100 : 0}%` }} /></span></div>
    <div className="gather-section-heading gather-connections-heading"><div><span className="gather-eyebrow">Connected tools</span><h2>Keep your context close</h2></div><span className="gather-muted-label">Your data stays yours</span></div>
    <div className="gather-connections-grid">{connections.map((connection) => <ConnectionCard key={connection.provider} connection={connection} hostWired={hostWired} onConnect={onConnect} />)}</div>
    <div className="gather-privacy-note"><span><Icon name="settings" size={17} /></span><p><strong>You define the boundaries.</strong> Gather only uses connected sources to prepare work for your review. It never treats a prepared offer as a booking until you approve it.</p></div>
  </>;
}

export function GatherWorkspace({
  bookings: bookingsProp,
  connections: connectionsProp,
  loading = false,
  blockedState,
  initialView = 'today',
  dataMode,
  pendingApprovals,
  onNavigate,
  onSelectBooking,
  onApproveProposal,
  onEditProposal,
  onConnect,
  onRetryBlockedAction,
  onRetryAction,
  onReconcileExecution,
}: GatherWorkspaceProps) {
  const bookings = bookingsProp ?? DEMO_BOOKINGS;
  const connections = connectionsProp ?? DEMO_CONNECTIONS;
  const isDemoData = dataMode !== undefined
    ? dataMode === 'demo'
    : bookingsProp === undefined || connectionsProp === undefined;
  const [activeView, setActiveView] = useState<WorkspaceView>(initialView);
  const [selectedBookingId, setSelectedBookingId] = useState<string>();
  // Local approval lifecycle per proposal fingerprint: 'sending' is a
  // synchronous duplicate-click guard that lasts until the host acknowledges
  // the request through its props; 'send-failed' is an observable error the
  // owner can retry. Neither can outlive the host's own reported state.
  const [localApprovals, setLocalApprovals] = useState<Record<string, 'sending' | 'send-failed'>>({});

  // Prune local approval state once the host's props reflect the outcome:
  // the fingerprint shows up in pendingApprovals (host owns the pending
  // display), a non-pending receipt reports a terminal outcome, or the
  // proposal was superseded and no booking carries the fingerprint anymore.
  useEffect(() => {
    setLocalApprovals((previous) => {
      let changed = false;
      const next: typeof previous = {};
      for (const [fingerprint, phase] of Object.entries(previous)) {
        const booking = bookings.find((candidate) => candidate.detail.proposal.fingerprint === fingerprint);
        if (!booking || pendingApprovals?.includes(fingerprint)) { changed = true; continue; }
        const receipts = booking.detail.receipts ?? [];
        if (phase === 'sending' && receipts.some((receipt) => receipt.status !== 'pending')) { changed = true; continue; }
        next[fingerprint] = phase;
      }
      return changed ? next : previous;
    });
  }, [bookings, pendingApprovals]);

  // Recovers correctly when the bookings list changes: keeps the selection
  // while its id still exists, falls back to the first booking when it is
  // gone, and stays undefined when the list is empty.
  const resolvedBookingId = resolveSelectedBookingId(bookings, selectedBookingId);
  const selectedBooking = bookings.find((booking) => booking.id === resolvedBookingId);
  const reviewCount = bookings.filter((booking) => booking.status === 'needs-review' || booking.status === 'proposal-ready').length;
  const sendingFingerprints = Object.keys(localApprovals).filter((fingerprint) => localApprovals[fingerprint] === 'sending');
  const approvalPending = selectedBooking
    ? isApprovalInFlight(selectedBooking.detail.proposal, [...(pendingApprovals ?? []), ...sendingFingerprints], selectedBooking.detail.receipts)
    : false;
  const approvalFailed = selectedBooking !== undefined && localApprovals[selectedBooking.detail.proposal.fingerprint] === 'send-failed';

  const navigate = (view: WorkspaceView) => { setActiveView(view); onNavigate?.(view); };
  const selectBooking = (booking: BookingSummary) => { setSelectedBookingId(booking.id); onSelectBooking?.(booking.id); };
  const approveProposal = (booking: BookingSummary) => {
    const identity = proposalIdentityOf(booking);
    const fingerprint = identity.proposalFingerprint;
    if (localApprovals[fingerprint] === 'sending' || approvalPending) return;
    setLocalApprovals((previous) => ({ ...previous, [fingerprint]: 'sending' }));
    let outcome: void | PromiseLike<void>;
    try {
      outcome = onApproveProposal?.(identity);
    } catch {
      setLocalApprovals((previous) => ({ ...previous, [fingerprint]: 'send-failed' }));
      return;
    }
    if (outcome && typeof outcome.then === 'function') {
      Promise.resolve(outcome).then(
        () => setLocalApprovals((previous) => {
          if (previous[fingerprint] !== 'sending') return previous;
          const next = { ...previous };
          delete next[fingerprint];
          return next;
        }),
        () => setLocalApprovals((previous) => ({ ...previous, [fingerprint]: 'send-failed' })),
      );
    }
  };
  const editProposal = (booking: BookingSummary) => { onEditProposal?.(proposalIdentityOf(booking)); };
  const connect = (provider: ConnectionProvider) => { onConnect?.(provider); };
  const retryAction = onRetryAction ? (bookingId: string, actionId: string) => onRetryAction({ bookingId, actionId }) : undefined;
  const reconcileExecution = onReconcileExecution ? (bookingId: string, executionId: string) => onReconcileExecution({ bookingId, executionId }) : undefined;
  const canRetryBlocked = onRetryAction !== undefined || onReconcileExecution !== undefined || onRetryBlockedAction !== undefined;
  const retryBlocked = (booking: BookingSummary) => {
    const recoverable = (booking.detail.receipts ?? []).find((receipt) => receiptRecoveryKind(receipt) !== undefined);
    if (recoverable) {
      const kind = receiptRecoveryKind(recoverable);
      if (kind === 'retry' && onRetryAction) onRetryAction({ bookingId: booking.id, actionId: recoverable.actionId });
      else if (kind === 'reconcile' && recoverable.executionId && onReconcileExecution) onReconcileExecution({ bookingId: booking.id, executionId: recoverable.executionId });
      else onRetryBlockedAction?.();
      return;
    }
    onRetryBlockedAction?.();
  };

  return <div className="gather-app-shell">
    <Sidebar activeView={activeView} reviewCount={reviewCount} onNavigate={navigate} />
    <main className="gather-main">
      {blockedState ? <BlockedNotice title={blockedState.title} description={blockedState.description} actionLabel={blockedState.actionLabel} onAction={onRetryBlockedAction} /> : null}
      {loading ? <LoadingState /> : <>
        {isDemoData && activeView !== 'bookings' ? <div className="gather-demo-ribbon"><DemoLabel /><span>Simulated records are shown here — nothing shown is real or confirmed.</span></div> : null}
        {activeView === 'today' ? <TodayView bookings={bookings} connectedSourceCount={connections.filter((connection) => connection.connected).length} showDemoData={isDemoData} selectedBooking={selectedBooking} onSelect={selectBooking} onNavigate={navigate} /> : null}
        {activeView === 'bookings' ? <BookingsView bookings={bookings} showDemoData={isDemoData} selectedBooking={selectedBooking} approvalPending={approvalPending} approvalFailed={approvalFailed} canApprove={onApproveProposal !== undefined} canEdit={onEditProposal !== undefined} canRetryBlocked={canRetryBlocked} onSelect={selectBooking} onApprove={approveProposal} onEdit={editProposal} onBlockedAction={retryBlocked} onReviewConnections={() => navigate('connections')} onRetryAction={retryAction} onReconcileExecution={reconcileExecution} /> : null}
        {activeView === 'connections' ? <ConnectionsView connections={connections} showDemoData={isDemoData} hostWired={onConnect !== undefined} onConnect={connect} /> : null}
      </>}
    </main>
  </div>;
}
