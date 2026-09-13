import type {
  ActionReceipt,
  BookingStatus,
  BookingSummary,
  Connection,
  ConnectionProvider,
  ProposalSource,
} from "../components/gather/types.ts";
import type {
  ApprovalDTO,
  BusinessDTO,
  ConnectedAccountDTO,
  ExecutionDTO,
  WorkspaceBookingDTO,
  WorkspaceDTO,
  WorkspaceProposalDTO,
} from "./dto.ts";

/** Deterministic avatar tone per booking index — never random per render. */
const TONES: BookingSummary["clientTone"][] = ["coral", "blue", "sage", "plum"];

const STATUS_LABEL: Record<string, { status: BookingStatus; label: string; nextAction: string }> = {
  inquiry: { status: "needs-review", label: "New inquiry", nextAction: "Review the inquiry" },
  proposed: { status: "needs-review", label: "Needs your review", nextAction: "Review the proposal" },
  pending_approval: { status: "proposal-ready", label: "Ready to approve", nextAction: "Review and approve the proposal" },
  provisional_hold: { status: "provisional-hold", label: "Provisional hold", nextAction: "Hold is provisional — not a confirmed booking" },
  confirmed: { status: "confirmed", label: "Confirmed", nextAction: "Confirmed by the booking record" },
  failed: { status: "failed", label: "Failed", nextAction: "A step failed — review the receipts" },
  uncertain: { status: "uncertain", label: "Outcome uncertain", nextAction: "Reconcile the uncertain step before retrying" },
  cancelled: { status: "failed", label: "Cancelled", nextAction: "This booking was cancelled" },
};

function statusFor(raw: string): { status: BookingStatus; label: string; nextAction: string } {
  return STATUS_LABEL[raw] ?? { status: "needs-review", label: raw, nextAction: "Review this booking" };
}

/**
 * Date/time formatting is always anchored to the booking's own business
 * timezone (validated as an IANA name), and every rendered timestamp carries
 * the timezone abbreviation — an owner must never guess which clock an
 * expiry or slot is on.
 */
function tzOpts(timezone: string | undefined): Intl.DateTimeFormatOptions {
  return timezone ? { timeZone: timezone, timeZoneName: "short" } : { timeZoneName: "short" };
}

function formatDate(iso: string | undefined, timezone: string | undefined): string {
  if (!iso) return "Not specified";
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso;
  return new Intl.DateTimeFormat("en-US", { weekday: "short", day: "2-digit", month: "short", ...tzOpts(timezone) }).format(new Date(parsed));
}

function formatTime(startIso: string | undefined, endIso: string | undefined, timezone: string | undefined): string {
  const time = (iso: string) =>
    new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", ...tzOpts(timezone) }).format(new Date(iso));
  const start = startIso && Number.isFinite(Date.parse(startIso)) ? time(startIso) : undefined;
  const end = endIso && Number.isFinite(Date.parse(endIso)) ? time(endIso) : undefined;
  if (start && end) return `${start} – ${end}`;
  return start ?? end ?? "Not specified";
}

function formatTimestamp(iso: string | undefined, timezone: string | undefined): string {
  if (!iso) return "";
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso;
  return new Intl.DateTimeFormat("en-US", { day: "2-digit", month: "short", hour: "numeric", minute: "2-digit", ...tzOpts(timezone) }).format(new Date(parsed));
}

function initialsOf(name: string): string {
  const letters = name.replace(/\(.*?\)/g, "").replace(/[^a-zA-Z ]/g, " ").trim().split(/\s+/).filter(Boolean);
  const first = letters[0]?.[0] ?? "B";
  const second = letters[1]?.[0] ?? letters[0]?.[1] ?? "K";
  return (first + second).toUpperCase();
}

/** Latest proposal by numeric version — the one displayed and approvable. */
function latestProposal(proposals: WorkspaceProposalDTO[]): WorkspaceProposalDTO | undefined {
  return [...proposals].sort((left, right) => right.action.proposalVersion - left.action.proposalVersion)[0];
}

function stepOf(key: string): "hold" | "email" {
  return key.includes(":send:") ? "email" : "hold";
}

const STEP_LABEL: Record<"hold" | "email", string> = {
  hold: "Provisional hold",
  email: "Offer email",
};

function receiptOf(execution: ExecutionDTO, timezone: string | undefined): ActionReceipt {
  const step = stepOf(execution.idempotencyKey);
  const receipt: ActionReceipt = {
    id: execution.id,
    actionId: execution.proposedActionId,
    executionId: execution.id,
    proposalVersion: execution.proposalVersion,
    step,
    label: STEP_LABEL[step],
    status: execution.status as ActionReceipt["status"],
    timestamp: formatTimestamp(execution.completedAt ?? execution.reconciledAt ?? execution.startedAt, timezone),
  };
  if (execution.error) receipt.detail = execution.error;
  if (execution.status === "succeeded") receipt.detail = "Done — simulated provider receipt";
  // Recovery is only ever offered for non-terminal states; pending and
  // succeeded never get a control.
  if (execution.status === "failed") receipt.recoveryLabel = "Retry failed steps";
  if (execution.status === "uncertain" || execution.status === "partial") receipt.recoveryLabel = "Reconcile outcome";
  return receipt;
}

function sourceKind(kind: string): ProposalSource["kind"] {
  if (kind === "email") return "email";
  if (kind === "calendar") return "calendar";
  if (kind === "document") return "drive";
  // connected_account, manual, fixture, or anything new: render honestly as
  // unsupported rather than dressing it up as a known source type.
  return "unsupported";
}

function proposalFor(item: WorkspaceProposalDTO, timezone: string | undefined): BookingSummary["detail"]["proposal"] {
  const { action, consequences, consequencesError } = item;
  const consequenceSteps = consequences
    ? [
        `Recheck availability on ${consequences.calendarId} for ${formatDate(consequences.startAt, timezone)} ${formatTime(consequences.startAt, consequences.endAt, timezone)}`,
        `Create a provisional hold that expires ${formatTimestamp(consequences.expiresAt, timezone)} — not a confirmed booking`,
        `Send "${consequences.emailSubject}" to ${consequences.emailTo.join(", ")}`,
      ]
    : consequencesError
      ? [`Proposal details are incomplete: ${consequencesError}`]
      : ["Proposal payload could not be previewed"];
  return {
    id: action.id,
    version: action.proposalVersion,
    versionLabel: `Version ${action.proposalVersion} · prepared ${formatTimestamp(action.createdAt, timezone)}`,
    fingerprint: action.proposalFingerprint,
    total: "Not priced",
    deposit: "Not priced",
    validUntil: consequences ? `Hold would expire ${formatTimestamp(consequences.expiresAt, timezone)}` : "Not specified",
    consequences: consequenceSteps,
    lines: consequences
      ? [
          { label: "Provisional hold", detail: `${formatTime(consequences.startAt, consequences.endAt, timezone)} on ${consequences.calendarId}`, amount: "—" },
          { label: "Offer email", detail: `to ${consequences.emailTo.join(", ")}`, amount: "—" },
        ]
      : [],
    sources: action.sourceReferences.map((source) => ({
      title: source.label ?? source.locator,
      detail: source.kind === "fixture" ? `${source.locator} (fixture source)` : source.locator,
      kind: sourceKind(source.kind),
    })),
    emailPreview: consequences
      ? { to: consequences.emailTo.join(", "), subject: consequences.emailSubject, body: consequences.emailBody }
      : undefined,
  };
}

function activityFor(item: WorkspaceBookingDTO, timezone: string | undefined): BookingSummary["detail"]["activity"] {
  const items: BookingSummary["detail"]["activity"] = [
    {
      id: `${item.booking.id}-created`,
      label: "Inquiry received",
      detail: item.booking.sourceReferences.map((source) => source.label ?? source.locator).join(" · ") || "Recorded by the workspace",
      timestamp: formatTimestamp(item.booking.createdAt, timezone),
      kind: "inquiry",
    },
  ];
  for (const proposal of item.proposals) {
    items.push({
      id: `${proposal.action.id}-proposed`,
      label: `Proposal v${proposal.action.proposalVersion} prepared`,
      detail: proposal.action.status,
      timestamp: formatTimestamp(proposal.action.createdAt, timezone),
      kind: "proposal",
    });
  }
  for (const approval of item.approvals) {
    items.push({
      id: approval.id,
      label: approval.status === "approved" ? "Approval recorded" : "Approval invalidated",
      detail: `v${approval.proposalVersion} by ${approval.approvedBy}`,
      timestamp: formatTimestamp(approval.approvedAt, timezone),
      kind: "proposal",
    });
  }
  for (const execution of item.executions) {
    const step = stepOf(execution.idempotencyKey);
    items.push({
      id: `${execution.id}-event`,
      label: `${STEP_LABEL[step]} ${execution.status}`,
      detail: execution.error ?? `proposal v${execution.proposalVersion}`,
      timestamp: formatTimestamp(execution.completedAt ?? execution.startedAt, timezone),
      kind: execution.status === "failed" || execution.status === "uncertain" || execution.status === "partial" ? "warning" : "source",
    });
  }
  return items;
}

function waitingReasonFor(
  status: BookingStatus,
  receipts: ActionReceipt[],
): BookingSummary["detail"]["waitingReason"] {
  if (status === "uncertain") {
    const uncertain = receipts.find((receipt) => receipt.status === "uncertain" || receipt.status === "partial");
    return {
      title: "A step finished with an unclear outcome",
      description: uncertain?.detail ?? "The workspace does not know whether this step took effect. Reconcile it before retrying anything.",
      actionLabel: "Reconcile outcome",
      connectionsRelated: /revoked|access|authoriz/i.test(uncertain?.detail ?? "") || undefined,
    };
  }
  if (status === "failed") {
    const failed = receipts.find((receipt) => receipt.status === "failed");
    return {
      title: "A step failed",
      description: failed?.detail ?? "One of the proposal steps failed. Review the receipts and retry when ready.",
      actionLabel: "Retry failed steps",
      connectionsRelated: /revoked|access|authoriz/i.test(failed?.detail ?? "") || undefined,
    };
  }
  return undefined;
}

function bookingFor(item: WorkspaceBookingDTO, index: number, business: BusinessDTO | undefined): BookingSummary {
  const { booking } = item;
  const timezone = business?.timezone;
  const venue = business?.name ?? "Venue not specified";
  const mapped = statusFor(booking.status);
  const proposal = latestProposal(item.proposals);
  const receipts = item.executions.map((execution) => receiptOf(execution, timezone));
  // A pending step on the CURRENT proposal version means an approval
  // execution is in flight — show waiting, never claim a completed hold.
  const inFlight = proposal !== undefined && receipts.length > 0 && item.executions.some(
    (execution) =>
      execution.status === "pending" &&
      execution.proposedActionId === proposal.action.id &&
      execution.proposalVersion === proposal.action.proposalVersion,
  );
  const status = inFlight && (booking.status === "pending_approval" || booking.status === "proposed")
    ? { status: "waiting" as BookingStatus, label: "Approval in progress", nextAction: "Waiting for the approval outcome" }
    : mapped;
  const summary: BookingSummary = {
    id: booking.id,
    clientName: booking.eventName,
    eventType: "Private event",
    eventDate: formatDate(booking.startAt, timezone),
    eventTime: formatTime(booking.startAt, booking.endAt, timezone),
    venue,
    budget: "Not specified",
    status: status.status,
    statusLabel: status.label,
    nextAction: status.nextAction,
    clientInitials: initialsOf(booking.eventName),
    clientTone: TONES[index % TONES.length],
    detail: {
      receivedAt: formatTimestamp(booking.createdAt, timezone),
      source: booking.sourceReferences.map((source) => source.label ?? source.locator).join(" · ") || "Workspace record",
      requestSummary: booking.notes ?? "No request summary was recorded.",
      packageName: proposal ? `Proposal v${proposal.action.proposalVersion}` : "No proposal yet",
      packageDescription: proposal
        ? proposal.consequencesError ?? "Provisional hold and offer email plan"
        : "The workspace has not prepared a proposal for this booking.",
      proposal: proposal
        ? proposalFor(proposal, timezone)
        : {
            id: "none",
            version: 0,
            versionLabel: "No proposal",
            fingerprint: "",
            total: "—",
            deposit: "—",
            validUntil: "—",
            consequences: ["No proposal has been prepared yet"],
            lines: [],
            sources: [],
          },
      activity: activityFor(item, timezone),
      waitingReason: waitingReasonFor(status.status, receipts),
      receipts,
    },
  };
  if (booking.guestCount !== undefined) summary.guestCount = booking.guestCount;
  return summary;
}

const PROVIDER_MAP: Record<string, ConnectionProvider> = {
  gmail: "gmail",
  google_calendar: "calendar",
  google_drive: "drive",
};

function connectionFor(account: ConnectedAccountDTO): Connection {
  const provider = PROVIDER_MAP[account.provider];
  if (provider === undefined) {
    return {
      provider: "unsupported",
      name: account.displayName,
      description: `${account.provider} account`,
      detail: "Unsupported provider — this workspace does not manage it",
      connected: false,
      lastSynced: `Updated ${formatTimestamp(account.updatedAt, undefined)}`,
    };
  }
  const connected = account.status === "connected";
  return {
    provider,
    name: account.displayName,
    description: `${account.provider} account`,
    detail: connected ? "Connected" : `Status: ${account.status}`,
    connected,
    lastSynced: `Updated ${formatTimestamp(account.updatedAt, undefined)}`,
  };
}

export interface AdaptedWorkspace {
  bookings: BookingSummary[];
  connections: Connection[];
  dataMode: "demo" | "live";
  /** Fingerprints with a step execution still pending — approvals in flight. */
  pendingApprovals: string[];
  approvalIdentity: string;
  notice: string;
}

export function adaptWorkspace(workspace: WorkspaceDTO): AdaptedWorkspace {
  const pendingApprovals = new Set<string>();
  for (const item of workspace.bookings) {
    const proposal = latestProposal(item.proposals);
    if (!proposal) continue;
    // Scope pending to the exact displayed action + version: a pending
    // execution on an older version must not block the new proposal.
    const pending = item.executions.some(
      (execution) =>
        execution.status === "pending" &&
        execution.proposedActionId === proposal.action.id &&
        execution.proposalVersion === proposal.action.proposalVersion,
    );
    if (pending) pendingApprovals.add(proposal.action.proposalFingerprint);
  }
  return {
    bookings: workspace.bookings.map((item, index) =>
      bookingFor(item, index, workspace.businesses.find((business) => business.id === item.booking.businessId) ?? workspace.businesses[0]),
    ),
    connections: workspace.connections.map(connectionFor),
    dataMode: workspace.mode.kind === "demo" ? "demo" : "live",
    pendingApprovals: [...pendingApprovals],
    approvalIdentity: workspace.approvalIdentity,
    notice: workspace.notice,
  };
}
