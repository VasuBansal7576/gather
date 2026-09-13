'use client';

import { useMemo, useState } from 'react';
import type { ReactNode, SVGProps } from 'react';
import type {
  BookingSummary,
  BookingStatus,
  Connection,
  ConnectionProvider,
  GatherWorkspaceProps,
  Proposal,
  ProposalSource,
  WorkspaceView,
} from './types';
import { DEMO_BOOKINGS, DEMO_CONNECTIONS } from './demo-data';
import './GatherWorkspace.css';

type IconName =
  | 'arrow-up-right'
  | 'calendar'
  | 'check'
  | 'chevron-down'
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
  | 'plus'
  | 'refresh'
  | 'search'
  | 'settings'
  | 'sparkle'
  | 'warning';

const VIEW_LABELS: Record<WorkspaceView, string> = {
  today: 'Today',
  bookings: 'Bookings',
  connections: 'Connections',
};

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
    case 'plus':
      return <svg {...common}><path d="M12 5v14M5 12h14" /></svg>;
    case 'refresh':
      return <svg {...common}><path d="M19 8a7.5 7.5 0 1 0 1 6M19 4v4h-4" /></svg>;
    case 'search':
      return <svg {...common}><circle cx="10.8" cy="10.8" r="6.5" /><path d="m16 16 4 4" /></svg>;
    case 'settings':
      return <svg {...common}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-1.7 1.7-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.1h-2.4v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L8 17l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H6v-2.4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L7.3 8 9 6.3l.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.6V5h2.4v.1a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.1 8l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.1v2.4h-.1a1.7 1.7 0 0 0-1.6 1Z" /></svg>;
    case 'sparkle':
      return <svg {...common}><path d="m12 3 1.2 5.8L19 10l-5.8 1.2L12 17l-1.2-5.8L5 10l5.8-1.2L12 3ZM19 16l.5 2.5L22 19l-2.5.5L19 22l-.5-2.5L16 19l2.5-.5L19 16Z" /></svg>;
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
      return 'is-coral';
    case 'proposal-ready':
      return 'is-gold';
    case 'hold-pending':
      return 'is-slate';
    case 'confirmed':
      return 'is-sage';
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

function connectionIcon(provider: ConnectionProvider): IconName {
  switch (provider) {
    case 'gmail':
      return 'email';
    case 'drive':
      return 'drive';
    case 'calendar':
      return 'calendar';
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
      <span className="gather-logo-mark"><Icon name="leaf" size={19} /></span>
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
      <Icon name={icon} size={18} />
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
  return (
    <aside className="gather-sidebar">
      <div className="gather-sidebar-top">
        <Logo />
        <button className="gather-icon-button gather-mobile-menu" type="button" aria-label="Open navigation"><Icon name="menu" /></button>
      </div>
      <div className="gather-sidebar-section">
        <span className="gather-sidebar-eyebrow">Workspace</span>
        <nav className="gather-nav" aria-label="Workspace">
          <NavItem view="today" activeView={activeView} label="Today" icon="sparkle" onClick={onNavigate} />
          <NavItem view="bookings" activeView={activeView} label="Bookings" icon="inbox" count={reviewCount} onClick={onNavigate} />
        </nav>
      </div>
      <div className="gather-sidebar-section">
        <span className="gather-sidebar-eyebrow">Set up</span>
        <nav className="gather-nav" aria-label="Set up">
          <NavItem view="connections" activeView={activeView} label="Connections" icon="link" onClick={onNavigate} />
        </nav>
      </div>
      <div className="gather-sidebar-bottom">
        <div className="gather-sidebar-tip">
          <span className="gather-tip-icon"><Icon name="leaf" size={16} /></span>
          <div>
            <strong>Keep the room warm</strong>
            <p>Gather keeps decisions with you, where they belong.</p>
          </div>
        </div>
        <button type="button" className="gather-account-button">
          <span className="gather-account-avatar">TG</span>
          <span className="gather-account-copy"><strong>The Glasshouse</strong><small>Owner workspace</small></span>
          <Icon name="chevron-down" size={15} />
        </button>
      </div>
    </aside>
  );
}

function TopBar({ view, onNavigate }: { view: WorkspaceView; onNavigate: (view: WorkspaceView) => void }) {
  return (
    <header className="gather-topbar">
      <div className="gather-breadcrumb"><span>Workspace</span><Icon name="chevron-right" size={14} /><strong>{VIEW_LABELS[view]}</strong></div>
      <div className="gather-topbar-actions">
        <button type="button" className="gather-quiet-button" aria-label="Search bookings"><Icon name="search" size={18} /></button>
        <button type="button" className="gather-quiet-button" aria-label="Workspace settings"><Icon name="settings" size={18} /></button>
        <span className="gather-topbar-divider" />
        <button type="button" className="gather-help-button" onClick={() => onNavigate('connections')}>Need help?</button>
        <span className="gather-profile-dot">TG</span>
      </div>
    </header>
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
      <span className="gather-booking-row-meta"><StatusPill booking={booking} /><span>{booking.guestCount} guests</span></span>
      <Icon name="chevron-right" size={17} />
    </button>
  );
}

function SourceIcon({ kind }: { kind: ProposalSource['kind'] }) {
  return <span className={`gather-source-icon gather-source-${kind}`}><Icon name={kind} size={16} /></span>;
}

function ProposalReview({
  booking,
  onApprove,
  onEdit,
}: {
  booking: BookingSummary;
  onApprove: (booking: BookingSummary) => void;
  onEdit: (booking: BookingSummary) => void;
}) {
  const proposal: Proposal = booking.detail.proposal;
  return (
    <section className="gather-panel gather-proposal-panel" aria-labelledby="proposal-heading">
      <div className="gather-panel-heading">
        <div>
          <span className="gather-eyebrow">Prepared offer</span>
          <h2 id="proposal-heading">Review the proposal</h2>
        </div>
        <span className="gather-version-label">{proposal.version}</span>
      </div>
      <div className="gather-proposal-total">
        <div><span className="gather-total-label">Proposed total</span><strong>{proposal.total}</strong></div>
        <div className="gather-total-context"><span>{proposal.deposit}</span><span>{proposal.validUntil}</span></div>
      </div>
      <div className="gather-proposal-lines">
        {proposal.lines.map((line) => (
          <div className="gather-proposal-line" key={line.label}>
            <div><strong>{line.label}</strong><span>{line.detail}</span></div><b>{line.amount}</b>
          </div>
        ))}
      </div>
      <div className="gather-proposal-actions">
        <button type="button" className="gather-primary-button" onClick={() => onApprove(booking)}><Icon name="check" size={17} />Approve proposal</button>
        <button type="button" className="gather-secondary-button" onClick={() => onEdit(booking)}><Icon name="edit" size={16} />Edit details</button>
      </div>
      <p className="gather-action-note"><Icon name="clock" size={14} />Approval will trigger a fresh availability check before any hold is created.</p>
    </section>
  );
}

function SourcesPanel({ sources }: { sources: ProposalSource[] }) {
  return (
    <section className="gather-panel gather-sources-panel" aria-labelledby="sources-heading">
      <div className="gather-panel-heading gather-panel-heading-tight"><div><span className="gather-eyebrow">Evidence trail</span><h2 id="sources-heading">Sources used</h2></div><button className="gather-text-button" type="button">View all <Icon name="arrow-up-right" size={14} /></button></div>
      <div className="gather-source-list">
        {sources.map((source) => <button type="button" className="gather-source-row" key={source.title}><SourceIcon kind={source.kind} /><span><strong>{source.title}</strong><small>{source.detail}</small></span><Icon name="external" size={14} /></button>)}
      </div>
      <p className="gather-source-note"><Icon name="sparkle" size={14} />Every consequential detail stays linked to its source.</p>
    </section>
  );
}

function ActivityPanel({ booking }: { booking: BookingSummary }) {
  return (
    <section className="gather-panel gather-activity-panel" aria-labelledby="activity-heading">
      <div className="gather-panel-heading gather-panel-heading-tight"><div><span className="gather-eyebrow">Record</span><h2 id="activity-heading">Activity</h2></div><button className="gather-icon-button" type="button" aria-label="More activity options"><Icon name="more" /></button></div>
      <div className="gather-activity-list">
        {booking.detail.activity.map((item) => (
          <div className="gather-activity-item" key={item.id}>
            <span className={`gather-activity-marker is-${item.kind}`}><Icon name={item.kind === 'warning' ? 'warning' : item.kind === 'proposal' ? 'document' : item.kind === 'source' ? 'sparkle' : 'email'} size={13} /></span>
            <div><strong>{item.label}</strong><span>{item.detail}</span></div><time>{item.timestamp}</time>
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
  onAction,
}: {
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="gather-blocked-notice" role="status">
      <span className="gather-blocked-icon"><Icon name="warning" size={18} /></span>
      <div><strong>{title}</strong><p>{description}</p></div>
      {onAction ? <button type="button" className="gather-secondary-button gather-small-button" onClick={onAction}>{actionLabel}<Icon name="chevron-right" size={14} /></button> : null}
    </div>
  );
}

function BookingDetailPanel({
  booking,
  onApprove,
  onEdit,
  onBlockedAction,
  onBack,
}: {
  booking: BookingSummary;
  onApprove: (booking: BookingSummary) => void;
  onEdit: (booking: BookingSummary) => void;
  onBlockedAction: () => void;
  onBack?: () => void;
}) {
  const blocked = booking.status === 'hold-pending';
  return (
    <div className="gather-booking-detail">
      {onBack ? <button type="button" className="gather-back-button" onClick={onBack}><Icon name="chevron-right" size={15} />All bookings</button> : null}
      <div className="gather-detail-header">
        <div className="gather-detail-client"><Avatar initials={booking.clientInitials} tone={booking.clientTone} /><div><div className="gather-detail-title-line"><h2>{booking.clientName}</h2><StatusPill booking={booking} /></div><p>{booking.eventType} · {booking.eventDate} · {booking.guestCount} guests</p></div></div>
        <button type="button" className="gather-icon-button" aria-label="More booking options"><Icon name="more" /></button>
      </div>
      <div className="gather-detail-facts">
        <div><span className="gather-fact-icon"><Icon name="calendar" size={16} /></span><span><small>Event date</small><strong>{booking.eventDate}</strong></span></div>
        <div><span className="gather-fact-icon"><Icon name="clock" size={16} /></span><span><small>Time</small><strong>{booking.eventTime}</strong></span></div>
        <div><span className="gather-fact-icon"><Icon name="inbox" size={16} /></span><span><small>Inquiry from</small><strong>{booking.detail.source.replace(' · ', ' / ')}</strong></span></div>
      </div>
      <div className="gather-request-summary"><span className="gather-eyebrow">What they asked for</span><p>{booking.detail.requestSummary}</p><span className="gather-package-label"><Icon name="leaf" size={15} /><strong>{booking.detail.packageName}</strong><span>{booking.detail.packageDescription}</span></span></div>
      {blocked ? <BlockedNotice title="Availability check is paused" description="Reconnect Google Calendar before you approve this proposal. Gather will recheck the date before creating a provisional hold." actionLabel="Reconnect Calendar" onAction={onBlockedAction} /> : null}
      <div className="gather-detail-grid"><ProposalReview booking={booking} onApprove={onApprove} onEdit={onEdit} /><div className="gather-detail-side"><SourcesPanel sources={booking.detail.proposal.sources} /><ActivityPanel booking={booking} /></div></div>
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
        <BriefingCard eyebrow="Coming up" title={nextBooking ? nextBooking.eventDate : 'A clear horizon'} detail={nextBooking ? `${nextBooking.clientName} · ${nextBooking.eventType} · ${nextBooking.guestCount} guests` : 'No upcoming events need your attention today.'} icon="calendar" tone="sage"><span className="gather-card-detail">{nextBooking?.eventTime ?? 'You are all caught up'}</span></BriefingCard>
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
  onSelect,
  onApprove,
  onEdit,
  onBlockedAction,
}: {
  bookings: BookingSummary[];
  showDemoData: boolean;
  selectedBooking?: BookingSummary;
  onSelect: (booking: BookingSummary) => void;
  onApprove: (booking: BookingSummary) => void;
  onEdit: (booking: BookingSummary) => void;
  onBlockedAction: () => void;
}) {
  const [mobileDetail, setMobileDetail] = useState(false);
  const handleSelect = (booking: BookingSummary) => { onSelect(booking); setMobileDetail(true); };
  return (
    <>
      <PageIntro eyebrow="The whole room" title="Bookings" description="Review the moments that need your judgment, with the context close at hand.">{showDemoData ? <DemoLabel /> : null}<button type="button" className="gather-primary-button gather-small-button"><Icon name="plus" size={16} />New inquiry</button></PageIntro>
      {bookings.length === 0 ? <EmptyState title="No bookings yet" description="Connect Gmail or add an inquiry to see your next opportunity here." /> : <div className={`gather-bookings-layout ${mobileDetail ? 'is-mobile-detail' : ''}`}>
        <section className="gather-bookings-list-panel" aria-label="Bookings list"><div className="gather-list-toolbar"><div><strong>{bookings.length} active {bookings.length === 1 ? 'booking' : 'bookings'}</strong><span>Sorted by what needs you next</span></div><button className="gather-icon-button" type="button" aria-label="Filter bookings"><Icon name="settings" size={17} /></button></div>{bookings.map((booking) => <BookingRow booking={booking} selected={selectedBooking?.id === booking.id} onSelect={handleSelect} key={booking.id} />)}</section>
        {selectedBooking ? <BookingDetailPanel booking={selectedBooking} onApprove={onApprove} onEdit={onEdit} onBlockedAction={onBlockedAction} onBack={() => setMobileDetail(false)} /> : null}
      </div>}
    </>
  );
}

function ConnectionCard({ connection, onConnect }: { connection: Connection; onConnect: (provider: ConnectionProvider) => void }) {
  return <article className={`gather-connection-card ${connection.connected ? 'is-connected' : 'is-needs-attention'}`}><div className="gather-connection-top"><span className={`gather-connection-icon is-${connection.provider}`}><Icon name={connectionIcon(connection.provider)} size={21} /></span><span className={connection.connected ? 'gather-connected-label' : 'gather-attention-label'}>{connection.connected ? <><Icon name="check" size={13} />Connected</> : <><Icon name="warning" size={13} />Needs attention</>}</span></div><h2>{connection.name}</h2><p>{connection.description}</p><div className="gather-connection-footer"><span>{connection.connected ? connection.lastSynced : connection.detail}</span>{connection.connected ? <button type="button" className="gather-text-button">Manage <Icon name="chevron-right" size={14} /></button> : <button type="button" className="gather-primary-button gather-small-button" onClick={() => onConnect(connection.provider)}><Icon name="refresh" size={15} />Reconnect</button>}</div></article>;
}

function ConnectionsView({ connections, showDemoData, onConnect }: { connections: Connection[]; showDemoData: boolean; onConnect: (provider: ConnectionProvider) => void }) {
  const connectedCount = connections.filter((connection) => connection.connected).length;
  return <>
    <PageIntro eyebrow="Business context" title="Connections" description="Gather works from the tools you already use. Choose what it can read, and keep authority in your hands.">{showDemoData ? <DemoLabel /> : null}<button type="button" className="gather-secondary-button"><Icon name="plus" size={16} />Add connection</button></PageIntro>
    <div className="gather-connection-banner"><span className="gather-banner-icon"><Icon name="sparkle" size={19} /></span><div><strong>{connectedCount} of {connections.length} sources are ready</strong><p>Connect your calendar to unlock reliable availability checks for every proposal.</p></div><span className="gather-banner-progress" aria-label={`${connectedCount} of ${connections.length} connected`}><span style={{ width: `${connections.length ? (connectedCount / connections.length) * 100 : 0}%` }} /></span></div>
    <div className="gather-section-heading gather-connections-heading"><div><span className="gather-eyebrow">Connected tools</span><h2>Keep your context close</h2></div><span className="gather-muted-label">Your data stays yours</span></div>
    <div className="gather-connections-grid">{connections.map((connection) => <ConnectionCard key={connection.provider} connection={connection} onConnect={onConnect} />)}</div>
    <div className="gather-privacy-note"><span><Icon name="settings" size={17} /></span><p><strong>You define the boundaries.</strong> Gather only uses connected sources to prepare work for your review. It never treats a prepared offer as a booking until you approve it.</p></div>
  </>;
}

export function GatherWorkspace({
  bookings: bookingsProp,
  connections: connectionsProp,
  loading = false,
  blockedState,
  initialView = 'today',
  onNavigate,
  onSelectBooking,
  onApproveProposal,
  onEditProposal,
  onConnect,
  onRetryBlockedAction,
}: GatherWorkspaceProps) {
  const bookings = bookingsProp ?? DEMO_BOOKINGS;
  const connections = connectionsProp ?? DEMO_CONNECTIONS;
  const isDemoData = bookingsProp === undefined || connectionsProp === undefined;
  const [activeView, setActiveView] = useState<WorkspaceView>(initialView);
  const [selectedBookingId, setSelectedBookingId] = useState(bookings[0]?.id);
  const selectedBooking = useMemo(() => bookings.find((booking) => booking.id === selectedBookingId) ?? bookings[0], [bookings, selectedBookingId]);
  const reviewCount = bookings.filter((booking) => booking.status === 'needs-review' || booking.status === 'proposal-ready').length;

  const navigate = (view: WorkspaceView) => { setActiveView(view); onNavigate?.(view); };
  const selectBooking = (booking: BookingSummary) => { setSelectedBookingId(booking.id); onSelectBooking?.(booking.id); };
  const approveProposal = (booking: BookingSummary) => { onApproveProposal?.(booking.id, booking.detail.proposal.id); };
  const editProposal = (booking: BookingSummary) => { onEditProposal?.(booking.id, booking.detail.proposal.id); };
  const connect = (provider: ConnectionProvider) => { onConnect?.(provider); };

  return <div className="gather-app-shell">
    <Sidebar activeView={activeView} reviewCount={reviewCount} onNavigate={navigate} />
    <div className="gather-main-column"><TopBar view={activeView} onNavigate={navigate} /><main className="gather-main-content">
      {blockedState ? <BlockedNotice title={blockedState.title} description={blockedState.description} actionLabel={blockedState.actionLabel} onAction={onRetryBlockedAction} /> : null}
      {loading ? <LoadingState /> : <>
        {isDemoData ? <div className="gather-demo-ribbon"><DemoLabel /><span>Local interface fixtures are shown here. Connect your sources to replace them with workspace data.</span></div> : null}
        {activeView === 'today' ? <TodayView bookings={bookings} connectedSourceCount={connections.filter((connection) => connection.connected).length} showDemoData={isDemoData} selectedBooking={selectedBooking} onSelect={selectBooking} onNavigate={navigate} /> : null}
        {activeView === 'bookings' ? <BookingsView bookings={bookings} showDemoData={isDemoData} selectedBooking={selectedBooking} onSelect={selectBooking} onApprove={approveProposal} onEdit={editProposal} onBlockedAction={() => navigate('connections')} /> : null}
        {activeView === 'connections' ? <ConnectionsView connections={connections} showDemoData={isDemoData} onConnect={connect} /> : null}
      </>}
    </main></div>
  </div>;
}

export default GatherWorkspace;
