import type {
  ActionReceipt,
  BookingStatus,
  BookingSummary,
  Connection,
  ConnectionProvider,
  OfferView,
  ProposalSource,
} from "../components/gather/types.ts";
import type { OfferCandidate, OfferLine, PricingBasis } from "../offers/types.ts";
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

/**
 * The booking's displayed proposal: the server's durable current pointer,
 * selected by exact action id. This is the same pointer approve, retry,
 * reconcile, and confirmation bind to — the adapter never re-derives
 * "latest" from per-action versions, wall-clock timestamps, or UUID order,
 * so it cannot disagree with the backend (e.g. showing an old v2 while the
 * backend confirms a newer v1, or ordering equal timestamps by UUID).
 *
 * When the pointer is absent (pre-pointer payloads in tests/fixtures) the
 * legacy version-then-createdAt ordering applies as backcompat; when the
 * pointer names no listed proposal, nothing is displayed rather than a
 * wrong proposal.
 */
function currentProposal(item: WorkspaceBookingDTO): WorkspaceProposalDTO | undefined {
  if (item.currentProposedActionId !== undefined) {
    return item.proposals.find((proposal) => proposal.action.id === item.currentProposedActionId);
  }
  return [...item.proposals].sort((left, right) => {
    if (right.action.proposalVersion !== left.action.proposalVersion) {
      return right.action.proposalVersion - left.action.proposalVersion;
    }
    if (right.action.createdAt !== left.action.createdAt) {
      return right.action.createdAt < left.action.createdAt ? -1 : 1;
    }
    return right.action.id < left.action.id ? -1 : 1;
  })[0];
}

function stepOf(key: string): "hold" | "email" {
  return key.includes(":send:") ? "email" : "hold";
}

const STEP_LABEL: Record<"hold" | "email", string> = {
  hold: "Provisional hold",
  email: "Offer email",
};

/**
 * Executable steps a proposal kind must complete before the approval can read
 * as done. This is the authoritative step contract — derived from the
 * ProposedAction kind, matching the steps approveAndExecute runs — never from
 * consequence prose or whatever receipts happen to exist. An unknown kind
 * maps to no steps, so its proposals can never show a completed state.
 */
const REQUIRED_STEPS_BY_ACTION_KIND: Record<string, ("hold" | "email")[]> = {
  create_provisional_hold: ["hold", "email"],
};

/**
 * Display-side mirror of the server's live-proof rule: a succeeded receipt
 * reads as a provider receipt only on positive proof (live mode, not
 * simulated, non-empty non-fictional provenance). Missing proof, simulated
 * results, and fixture refs fail closed to simulated — a fixture receipt is
 * never upgraded to live at display.
 */
const LIVE_PROOF_SOURCE_KINDS = new Set(["connected_account", "document", "email", "calendar", "manual"]);

function isLiveProof(proof: ExecutionDTO["proof"]): boolean {
  if (proof === undefined) return false;
  if (proof.mode !== "live" || proof.simulated !== false) return false;
  if (proof.provenance.length === 0) return false;
  // Positive validation matching the service rule: every ref must be a
  // supported non-fixture kind with a non-empty locator — malformed or
  // fictional entries never qualify as live evidence.
  return proof.provenance.every(
    (ref) => LIVE_PROOF_SOURCE_KINDS.has(ref.kind) && ref.locator.trim().length > 0 && ref.fictional !== true,
  );
}

/**
 * Read the step proof from either execution shape: parsed client DTOs carry
 * it as top-level `proof` (validated at the DTO boundary), while
 * server-shape executions passed straight through carry it embedded in
 * `result.proof`. Both are validated the same strict way; anything
 * malformed yields undefined so display fails closed to simulated.
 */
function executionProof(execution: ExecutionDTO): ExecutionDTO["proof"] {
  if (execution.proof !== undefined) return execution.proof;
  const result = (execution as unknown as { result?: unknown }).result;
  if (typeof result !== "object" || result === null) return undefined;
  const proof = (result as { proof?: unknown }).proof;
  if (typeof proof !== "object" || proof === null) return undefined;
  const candidate = proof as { mode?: unknown; simulated?: unknown; provenance?: unknown };
  if ((candidate.mode !== "demo" && candidate.mode !== "live") || typeof candidate.simulated !== "boolean") return undefined;
  if (!Array.isArray(candidate.provenance)) return undefined;
  const provenance: { kind: string; locator: string; label?: string; fictional?: boolean }[] = [];
  for (const ref of candidate.provenance) {
    if (typeof ref !== "object" || ref === null) return undefined;
    const item = ref as { kind?: unknown; locator?: unknown; label?: unknown; fictional?: unknown };
    if (typeof item.kind !== "string" || typeof item.locator !== "string") return undefined;
    if (item.label !== undefined && typeof item.label !== "string") return undefined;
    provenance.push({
      kind: item.kind,
      locator: item.locator,
      ...(typeof item.label === "string" ? { label: item.label } : {}),
      ...(item.fictional === true ? { fictional: true as const } : {}),
    });
  }
  return { mode: candidate.mode, simulated: candidate.simulated, provenance };
}

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
  if (execution.status === "succeeded") {
    const proof = executionProof(execution);
    receipt.detail = proof === undefined
      ? "Done — provider receipt unverified"
      : isLiveProof(proof)
        ? "Done — provider receipt recorded"
        : "Done — simulated provider receipt";
  }
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

// ---------- Authoritative offer snapshot (payload.offer) ----------

const PRICING_BASES: readonly PricingBasis[] = ["per_event", "per_guest", "per_hour"];
const PRICING_BASIS_LABEL: Record<PricingBasis, string> = {
  per_event: "per event",
  per_guest: "per guest",
  per_hour: "per hour",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isCents(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNullableCents(value: unknown): value is number | null {
  return value === null || isCents(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

/** Display money in proper currency units; never amountCents glued to a code. */
function formatMoney(amountCents: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amountCents / 100);
  } catch {
    return `${(amountCents / 100).toFixed(2)} ${currency}`;
  }
}

function parseOfferLine(value: unknown): OfferLine | null {
  if (!isRecord(value)) return null;
  if (!isNonEmptyString(value.lineId) || !isNonEmptyString(value.label)) return null;
  if (typeof value.pricingBasis !== "string" || !PRICING_BASES.includes(value.pricingBasis as PricingBasis)) return null;
  if (typeof value.quantity !== "number" || !Number.isFinite(value.quantity) || value.quantity <= 0) return null;
  if (!isNullableCents(value.unitCents) || !isNullableCents(value.lineTotalCents)) return null;
  if (value.unknownUnit !== true && value.unknownUnit !== false) return null;
  // Consistency: a known unit price can never carry the unknown marker.
  if (value.unknownUnit && value.unitCents !== null) return null;
  return {
    lineId: value.lineId,
    label: value.label,
    pricingBasis: value.pricingBasis as PricingBasis,
    quantity: value.quantity,
    unitCents: value.unitCents,
    lineTotalCents: value.lineTotalCents,
    unknownUnit: value.unknownUnit,
  };
}

type ParsedOffer =
  | { kind: "absent" }
  | { kind: "invalid"; reason: string }
  | { kind: "valid"; offer: OfferCandidate };

/**
 * Strict boundary validation of the complete immutable OfferCandidate
 * persisted on `action.payload.offer`. Any malformed field, non-finite or
 * out-of-range amount, bad currency, empty required list, or internal
 * contradiction marks the offer invalid — it can never render as priced.
 * The snapshot fingerprint and `payload.offerPreparationFingerprint` are
 * validated as separate non-empty hashes, never compared: binding the exact
 * version is the canonical action.proposalFingerprint's job, enforced at
 * approval, not the adapter's.
 */
function parseOfferSnapshot(payload: Record<string, unknown>): ParsedOffer {
  const raw = payload.offer;
  if (raw === undefined || raw === null) return { kind: "absent" };
  const invalid = (reason: string): ParsedOffer => ({ kind: "invalid", reason });
  if (!isRecord(raw)) return invalid("offer is not an object");
  if (!isNonEmptyString(raw.offerId)) return invalid("offerId missing");
  if (typeof raw.version !== "number" || !Number.isInteger(raw.version) || raw.version < 1) return invalid("version malformed");
  if (raw.rank !== "primary" && raw.rank !== "alternative") return invalid("rank malformed");
  if (!isIso(raw.startAt) || !isIso(raw.endAt)) return invalid("window malformed");
  if (!isNonEmptyString(raw.spaceId) || !isNonEmptyString(raw.spaceName)) return invalid("space missing");
  if (typeof raw.guestCount !== "number" || !Number.isSafeInteger(raw.guestCount) || raw.guestCount < 0) return invalid("guestCount malformed");
  if (typeof raw.currency !== "string" || !/^[A-Z]{3}$/.test(raw.currency)) return invalid("currency malformed");
  if (!Array.isArray(raw.lines) || raw.lines.length === 0) return invalid("lines missing or empty");
  const lines: OfferLine[] = [];
  for (const entry of raw.lines) {
    const line = parseOfferLine(entry);
    if (!line) return invalid("a priced line is malformed");
    lines.push(line);
  }
  if (!isNullableCents(raw.totalCents) || !isNullableCents(raw.depositCents)) return invalid("amounts malformed");
  if (raw.totalKnown !== true && raw.totalKnown !== false) return invalid("totalKnown missing");
  // A claimed-known total can never be null, and a stored total can never
  // carry the not-known flag.
  if (raw.totalKnown !== (raw.totalCents !== null)) return invalid("total/totalKnown contradiction");
  if (!isStringArray(raw.unknownCostIds) || !isStringArray(raw.unknownPriceIds)) return invalid("unknown id lists malformed");
  if (raw.profitabilityClaimed !== true && raw.profitabilityClaimed !== false) return invalid("profitabilityClaimed missing");
  // Unknown costs or prices can never carry a profitability claim.
  if (raw.profitabilityClaimed && (raw.unknownCostIds.length > 0 || raw.unknownPriceIds.length > 0)) {
    return invalid("profitability claimed with unknown costs or prices");
  }
  if (!isStringArray(raw.consequences) || raw.consequences.length === 0) return invalid("consequences malformed or empty");
  if (!Array.isArray(raw.sources) || raw.sources.length === 0 || !raw.sources.every((ref) => isRecord(ref) && isNonEmptyString(ref.kind) && isNonEmptyString(ref.locator))) {
    return invalid("sources malformed or empty");
  }
  if (!isNonEmptyString(raw.fingerprint)) return invalid("fingerprint missing");
  if (raw.supersedesFingerprint !== undefined && !isNonEmptyString(raw.supersedesFingerprint)) return invalid("supersedesFingerprint malformed");
  if (raw.note !== undefined && typeof raw.note !== "string") return invalid("note malformed");
  // The snapshot fingerprint and the result-level preparation fingerprint
  // are separate hashes validated independently below — never equated. The
  // canonical action.proposalFingerprint already binds the entire payload,
  // and approval binds that exact version, so no cross-digest comparison
  // can add authority here.
  const preparationFingerprint = payload.offerPreparationFingerprint;
  if (preparationFingerprint !== undefined && !isNonEmptyString(preparationFingerprint)) {
    return invalid("preparation fingerprint malformed");
  }
  return { kind: "valid", offer: raw as unknown as OfferCandidate };
}

function offerViewFor(offer: OfferCandidate, payload: Record<string, unknown>): OfferView {
  return {
    spaceName: offer.spaceName,
    guestCount: offer.guestCount,
    currency: offer.currency,
    terms: offer.consequences,
    unknownCosts: offer.unknownCostIds,
    unknownPrices: offer.unknownPriceIds,
    profitabilityClaimed: offer.profitabilityClaimed,
    preparationFingerprint: isNonEmptyString(payload.offerPreparationFingerprint) ? payload.offerPreparationFingerprint : undefined,
    note: offer.note,
  };
}

function proposalFor(item: WorkspaceProposalDTO, timezone: string | undefined): BookingSummary["detail"]["proposal"] {
  const { action, consequences, consequencesError } = item;
  const parsedOffer = parseOfferSnapshot(action.payload);
  const offer = parsedOffer.kind === "valid" ? parsedOffer.offer : undefined;
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
    requiredSteps: REQUIRED_STEPS_BY_ACTION_KIND[action.kind] ?? [],
    total: offer
      ? offer.totalCents !== null
        ? formatMoney(offer.totalCents, offer.currency)
        : "Total unknown"
      : "Not priced",
    deposit: offer
      ? offer.depositCents !== null
        ? `Deposit ${formatMoney(offer.depositCents, offer.currency)}`
        : "Deposit not specified"
      : "Not priced",
    validUntil: consequences ? `Hold would expire ${formatTimestamp(consequences.expiresAt, timezone)}` : "Not specified",
    offer: offer ? offerViewFor(offer, action.payload) : undefined,
    offerInvalid: parsedOffer.kind === "invalid" || undefined,
    consequences: consequenceSteps,
    lines: offer
      ? offer.lines.map((line) => ({
          label: line.label,
          detail: `${line.quantity} × ${line.unitCents !== null ? formatMoney(line.unitCents, offer.currency) : "unit price unknown"} ${PRICING_BASIS_LABEL[line.pricingBasis]}`,
          amount: line.lineTotalCents !== null ? formatMoney(line.lineTotalCents, offer.currency) : "Unknown",
        }))
      : consequences
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
  const proposal = currentProposal(item);
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
    const proposal = currentProposal(item);
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
    // Only a positive live marker renders live; "unknown" evidence fails
    // closed to the demo presentation rather than implying live data.
    dataMode: workspace.mode.kind === "live" ? "live" : "demo",
    pendingApprovals: [...pendingApprovals],
    approvalIdentity: workspace.approvalIdentity,
    notice: workspace.notice,
  };
}
