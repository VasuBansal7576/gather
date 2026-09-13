/**
 * Booking-specific coordination contracts.
 *
 * External events are evidence with source IDs and observed timestamps.
 * They are never authority: message text alone never verifies payment,
 * availability, or approval. The ledger only produces ready work/decisions
 * for guarded Gather services; it never sends externally or approves.
 */

export type CoordinationEventKind =
  | "inquiry"
  | "reply"
  | "change"
  | "payment_signal"
  | "resource_signal"
  | "pause"
  | "resume"
  | "cancel";

export type WaitingKind =
  | "followup"
  | "deposit_check"
  | "resource_check"
  | "change_review";

export type WaitingStatus =
  | "pending"
  | "claimed"
  | "done"
  | "suppressed"
  | "invalidated"
  | "paused";

export interface CoordinationEventInput {
  dedupeKey: string;
  kind: CoordinationEventKind;
  bookingId: string;
  /** Stable provider/source identifier (message id, thread id, doc revision, ...). */
  sourceId: string;
  /** Provider/source family, e.g. "email", "calendar", "payment", "manual". */
  sourceKind: string;
  /** When the source observed the event (ISO-8601). */
  observedAt: string;
  /** Optional per-booking revision for ordered changes. */
  revision?: number;
  /** Evidence payload. Never treated as authority. */
  payload?: Record<string, unknown>;
}

export interface CoordinationEventRecord {
  id: string;
  dedupeKey: string;
  kind: CoordinationEventKind;
  bookingId: string;
  sourceId: string;
  sourceKind: string;
  observedAt: string;
  receivedAt: string;
  revision?: number;
  payload: Record<string, unknown>;
  stale: boolean;
}

export type RecommendedAction =
  | "draft_followup_for_approval"
  | "verify_deposit_against_authoritative_receipt"
  | "verify_resource_commitment"
  | "review_booking_change_and_reapprove";

export interface WaitingItem {
  id: string;
  bookingId: string;
  kind: WaitingKind;
  status: WaitingStatus;
  dueAt: string;
  detail: Record<string, unknown>;
  sourceEventId: string;
  revision?: number;
  claimedBy?: string;
  claimedAt?: string;
  /** Opaque fencing token issued at claim time; required to resolve claimed work. */
  claimToken?: string;
  /** Lease expiry for the claim; stale claims can be released back to pending. */
  claimExpiresAt?: string;
  resolutionNote?: string;
  createdAt: string;
  updatedAt: string;
  /** What a guarded Gather service should do next. Never an executed send. */
  recommendedAction: RecommendedAction;
  /** All waiting work that contacts a customer or mutates state needs approval. */
  requiresApproval: boolean;
  /** Time-sensitive facts must be refetched fresh before acting. */
  requiresFreshCheck: boolean;
}

export interface IngestResult {
  duplicate: boolean;
  stale: boolean;
  eventId: string;
  /**
   * Always false from ingestEvent: intake records control requests as owner
   * decisions and honors nothing, no matter what sourceKind or payload it
   * carries. Honored control flows only through applyOwnerControl, which
   * reports controlHonored: true with host attestation.
   */
  controlHonored?: boolean;
  createdWaiting: WaitingItem[];
  suppressedWaitingIds: string[];
  invalidatedWaitingIds: string[];
  pausedWaitingIds: string[];
  resumedWaitingIds: string[];
}

export interface ListDueWorkInput {
  nowIso: string;
  limit?: number;
  bookingId?: string;
}

export interface ClaimDueWorkInput {
  ids: string[];
  claimedBy: string;
  nowIso: string;
  /** Claim lease in ms (default 300000). Expired claims can be released. */
  leaseMs?: number;
}

export interface ClaimDueWorkResult {
  claimed: WaitingItem[];
  skippedIds: string[];
  /** Pending followups suppressed by a reply found during claim-time recheck. */
  suppressedIds: string[];
  /** Stale change reviews invalidated during claim-time recheck. */
  invalidatedIds: string[];
}

export interface ResolveWaitingInput {
  id: string;
  resolution: "done" | "suppressed" | "invalidated";
  note?: string;
  /** Must match the claim token when resolving claimed work (stale-worker fencing). */
  claimToken?: string;
}

export interface ReleaseStaleClaimsInput {
  nowIso: string;
}

/**
 * Trusted owner control intake. Authority comes ONLY from calling this
 * host-owned method with an explicit owner attestation — never from raw
 * event fields. `ingestEvent` can never honor pause/resume/cancel no matter
 * what sourceKind or payload it carries, so provider bodies cannot forge
 * control by choosing sourceKind "manual"/"owner" or an authorizedBy value.
 */
export type OwnerControlKind = "pause" | "resume" | "cancel";

export interface OwnerControlInput {
  /** Stable idempotency key for safe retry (host-assigned). */
  dedupeKey: string;
  kind: OwnerControlKind;
  bookingId: string;
  /** Owner identity attested by the host (e.g. the approving owner id). */
  attestedBy: string;
  note?: string;
  /** When the owner issued the control (ISO-8601, defaults to intake time). */
  observedAt?: string;
}

export interface OwnerControlResult {
  duplicate: boolean;
  eventId: string;
  controlHonored: true;
  pausedWaitingIds: string[];
  resumedWaitingIds: string[];
  invalidatedWaitingIds: string[];
}

/**
 * Authoritative receipt recording. Only this host-attested call — naming an
 * explicit trusted verifier and receipt locator — retires deposit followups.
 * Raw `verifiedReceipt` booleans inside provider payloads never retire
 * anything; `ingestEvent` payment signals are evidence only.
 */
export interface VerifiedReceiptInput {
  /** Stable idempotency key for safe retry (host-assigned). */
  dedupeKey: string;
  bookingId: string;
  /** Authoritative receipt locator (provider receipt id, ledger entry, ...). */
  receiptLocator: string;
  /** Trusted verifier identity attested by the host (never provider text). */
  verifiedBy: string;
  note?: string;
  /** When the receipt was verified (ISO-8601, defaults to intake time). */
  observedAt?: string;
}

export interface VerifiedReceiptResult {
  duplicate: boolean;
  eventId: string;
  suppressedWaitingIds: string[];
  depositCheck: WaitingItem;
}

export type ControlState = "active" | "paused" | "cancelled";

/**
 * How the ledger treats the shared Gather tables (bookings/businesses).
 * - "auto" (default): read them when present; ignore when absent
 *   (standalone contract); any other query failure is rethrown (fail-closed).
 * - "required": the tables must exist; absence throws (integration guard).
 * - "off": never read shared state; only the ledger's own control table
 *   governs pause/cancel.
 */
export interface LedgerOptions {
  sharedTables?: "auto" | "required" | "off";
  /** Trusted clock for lease-expiry enforcement (defaults to wall clock). Must return ISO-8601. */
  clock?: () => string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoDateTime(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

const EVENT_KINDS: ReadonlySet<string> = new Set([
  "inquiry",
  "reply",
  "change",
  "payment_signal",
  "resource_signal",
  "pause",
  "resume",
  "cancel",
]);

export function assertValidEventInput(value: unknown): asserts value is CoordinationEventInput {
  if (!isRecord(value)) throw new Error("Event input must be an object");
  if (!isNonEmptyString(value.dedupeKey)) throw new Error("dedupeKey must be a non-empty string");
  if (!isRecord(value) || typeof value.kind !== "string" || !EVENT_KINDS.has(value.kind)) {
    throw new Error("kind must be one of inquiry|reply|change|payment_signal|resource_signal|pause|resume|cancel");
  }
  if (!isNonEmptyString(value.bookingId)) throw new Error("bookingId must be a non-empty string");
  if (!isNonEmptyString(value.sourceId)) throw new Error("sourceId must be a non-empty string");
  if (!isNonEmptyString(value.sourceKind)) throw new Error("sourceKind must be a non-empty string");
  if (!isIsoDateTime(value.observedAt)) throw new Error("observedAt must be an ISO-8601 timestamp");
  if (value.revision !== undefined) {
    if (typeof value.revision !== "number" || !Number.isInteger(value.revision) || value.revision < 0) {
      throw new Error("revision must be a non-negative integer when present");
    }
  }
  if (value.payload !== undefined && !isRecord(value.payload)) {
    throw new Error("payload must be an object when present");
  }
}

export function assertValidListDueWorkInput(value: unknown): asserts value is ListDueWorkInput {
  if (!isRecord(value)) throw new Error("listDueWork input must be an object");
  if (!isIsoDateTime(value.nowIso)) throw new Error("nowIso must be an ISO-8601 timestamp");
  if (value.limit !== undefined && (typeof value.limit !== "number" || !Number.isInteger(value.limit) || value.limit <= 0 || value.limit > 500)) {
    throw new Error("limit must be an integer between 1 and 500 when present");
  }
  if (value.bookingId !== undefined && !isNonEmptyString(value.bookingId)) {
    throw new Error("bookingId must be a non-empty string when present");
  }
}

export function assertValidClaimInput(value: unknown): asserts value is ClaimDueWorkInput {
  if (!isRecord(value)) throw new Error("claim input must be an object");
  if (!Array.isArray(value.ids) || value.ids.length === 0 || value.ids.length > 100) {
    throw new Error("ids must be a non-empty array of at most 100 waiting ids");
  }
  for (const id of value.ids) {
    if (!isNonEmptyString(id)) throw new Error("every waiting id must be a non-empty string");
  }
  if (!isNonEmptyString(value.claimedBy)) throw new Error("claimedBy must be a non-empty string");
  if (!isIsoDateTime(value.nowIso)) throw new Error("nowIso must be an ISO-8601 timestamp");
  if (
    value.leaseMs !== undefined &&
    (typeof value.leaseMs !== "number" || !Number.isInteger(value.leaseMs) || value.leaseMs < 1000 || value.leaseMs > 86_400_000)
  ) {
    throw new Error("leaseMs must be an integer between 1000 and 86400000 when present");
  }
}

export function assertValidResolveInput(value: unknown): asserts value is ResolveWaitingInput {
  if (!isRecord(value)) throw new Error("resolve input must be an object");
  if (!isNonEmptyString(value.id)) throw new Error("id must be a non-empty string");
  if (value.resolution !== "done" && value.resolution !== "suppressed" && value.resolution !== "invalidated") {
    throw new Error("resolution must be done|suppressed|invalidated");
  }
  if (value.note !== undefined && typeof value.note !== "string") throw new Error("note must be a string when present");
  if (value.claimToken !== undefined && !isNonEmptyString(value.claimToken)) {
    throw new Error("claimToken must be a non-empty string when present");
  }
}

export function assertValidReleaseInput(value: unknown): asserts value is ReleaseStaleClaimsInput {
  if (!isRecord(value)) throw new Error("release input must be an object");
  if (!isIsoDateTime(value.nowIso)) throw new Error("nowIso must be an ISO-8601 timestamp");
}

const OWNER_CONTROL_KINDS: ReadonlySet<string> = new Set(["pause", "resume", "cancel"]);

export function assertValidOwnerControlInput(value: unknown): asserts value is OwnerControlInput {
  if (!isRecord(value)) throw new Error("owner control input must be an object");
  if (!isNonEmptyString(value.dedupeKey)) throw new Error("dedupeKey must be a non-empty string");
  if (typeof value.kind !== "string" || !OWNER_CONTROL_KINDS.has(value.kind)) {
    throw new Error("kind must be one of pause|resume|cancel");
  }
  if (!isNonEmptyString(value.bookingId)) throw new Error("bookingId must be a non-empty string");
  if (!isNonEmptyString(value.attestedBy)) throw new Error("attestedBy must be a non-empty owner identity attested by the host");
  if (value.note !== undefined && typeof value.note !== "string") throw new Error("note must be a string when present");
  if (value.observedAt !== undefined && !isIsoDateTime(value.observedAt)) {
    throw new Error("observedAt must be an ISO-8601 timestamp when present");
  }
}

export function assertValidVerifiedReceiptInput(value: unknown): asserts value is VerifiedReceiptInput {
  if (!isRecord(value)) throw new Error("verified receipt input must be an object");
  if (!isNonEmptyString(value.dedupeKey)) throw new Error("dedupeKey must be a non-empty string");
  if (!isNonEmptyString(value.bookingId)) throw new Error("bookingId must be a non-empty string");
  if (!isNonEmptyString(value.receiptLocator)) throw new Error("receiptLocator must be a non-empty string");
  if (!isNonEmptyString(value.verifiedBy)) throw new Error("verifiedBy must be a non-empty trusted verifier identity attested by the host");
  if (value.note !== undefined && typeof value.note !== "string") throw new Error("note must be a string when present");
  if (value.observedAt !== undefined && !isIsoDateTime(value.observedAt)) {
    throw new Error("observedAt must be an ISO-8601 timestamp when present");
  }
}

export function assertValidLedgerOptions(value: unknown): asserts value is LedgerOptions {
  if (value === undefined) return;
  if (!isRecord(value)) throw new Error("ledger options must be an object when present");
  if (
    value.sharedTables !== undefined &&
    value.sharedTables !== "auto" &&
    value.sharedTables !== "required" &&
    value.sharedTables !== "off"
  ) {
    throw new Error('sharedTables must be one of auto|required|off when present');
  }
  if (value.clock !== undefined && typeof value.clock !== "function") {
    throw new Error("clock must be a function returning an ISO-8601 timestamp when present");
  }
}

export function recommendedFor(kind: WaitingKind): {
  recommendedAction: RecommendedAction;
  requiresApproval: boolean;
  requiresFreshCheck: boolean;
} {
  switch (kind) {
    case "followup":
      return { recommendedAction: "draft_followup_for_approval", requiresApproval: true, requiresFreshCheck: true };
    case "deposit_check":
      return { recommendedAction: "verify_deposit_against_authoritative_receipt", requiresApproval: true, requiresFreshCheck: true };
    case "resource_check":
      return { recommendedAction: "verify_resource_commitment", requiresApproval: true, requiresFreshCheck: true };
    case "change_review":
      return { recommendedAction: "review_booking_change_and_reapprove", requiresApproval: true, requiresFreshCheck: true };
  }
}
