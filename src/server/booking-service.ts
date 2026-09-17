import { randomUUID } from "node:crypto";
import {
  availabilityOperationKey,
  stableOperationKey,
} from "../connectors/contracts.ts";
import type {
  CalendarAvailabilityReader,
  ConnectorMetadata,
  EmailSender,
  ProvisionalHoldWriter,
  SourceReference,
} from "../connectors/contracts.ts";
import { GatherStore } from "./sqlite-store.ts";
import type { StepReservation } from "./sqlite-store.ts";
import {
  DEMO_MARKER,
  LIVE_MARKER,
  UNKNOWN_MARKER,
  type EvidenceModeMarker,
} from "./dto.ts";

export type { StepReservation };
import type {
  ApproveRequestDTO,
  ApproveResponseDTO,
  ReconcileResponseDTO,
  RetryResponseDTO,
  StepReceiptDTO,
  WorkspaceDTO,
} from "./dto.ts";
import type { ActionExecution, Booking } from "../domain/contracts.ts";

export type ServiceErrorCode =
  | "NOT_FOUND"
  | "STALE_PROPOSAL"
  | "CROSS_BOOKING"
  | "SLOT_UNAVAILABLE"
  | "ACCESS_REVOKED"
  | "CONFLICT"
  | "RECONCILE_REQUIRED"
  | "RECONCILE_PENDING"
  | "EXECUTION_FAILED"
  | "UNCERTAIN"
  | "DENIED"
  | "INVALID_REQUEST";

export class ServiceError extends Error {
  readonly code: ServiceErrorCode;
  readonly retryable: boolean;
  constructor(code: ServiceErrorCode, message: string, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

export interface BookingServiceDeps {
  store: GatherStore;
  calendar: CalendarAvailabilityReader & ProvisionalHoldWriter;
  email: EmailSender;
  /** Injectable clock (ISO timestamp). Used for provisional-hold expiry checks. */
  now?: () => string;
  /**
   * Configured local owner identity (e.g. GATHER_OWNER_ID). Approvals are
   * always recorded under this value; request-supplied identities are ignored.
   */
  ownerId?: string;
}

/** Claimed-step lease: a crashed pending attempt becomes reclaimable after this. */
export const STEP_CLAIM_LEASE_MS = 120_000;

function clockMs(deps: BookingServiceDeps): number {
  if (!deps.now) return Date.now();
  const parsed = Date.parse(deps.now());
  return Number.isFinite(parsed) ? parsed : Date.now();
}

export function ownerIdentity(deps: BookingServiceDeps): string {
  const identity = deps.ownerId ?? process.env.GATHER_OWNER_ID ?? "local-owner";
  if (identity.trim().length === 0) return "local-owner";
  return identity;
}

export interface HoldParams {
  startAt: string;
  endAt: string;
  expiresAt: string;
  calendarId: string;
  emailTo: string[];
  emailSubject: string;
  emailBody: string;
}

function validRange(startAt: string, endAt: string): boolean {
  const start = Date.parse(startAt);
  const end = Date.parse(endAt);
  return Number.isFinite(start) && Number.isFinite(end) && start < end;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/**
 * Extract executable hold/email params. EVERY consequential field must be
 * present explicitly in the proposal payload, because the displayed
 * proposalFingerprint covers exactly { bookingId, kind, payload,
 * sourceReferences }. Derived defaults would execute fields the fingerprint
 * never covered, so they are rejected instead of defaulted.
 *
 * expiresAt is a provisional-hold expiry: it must be a valid timestamp in the
 * future relative to the injected clock. It is deliberately NOT required to
 * be after the event end — a hold commonly expires before the event starts
 * (e.g. an offer held until next week for an October event).
 */
export function resolveHoldParams(actionPayload: Record<string, unknown>, opts: { nowMs?: number } = {}): HoldParams {
  const payload = asRecord(actionPayload);
  const startAt = str(payload.startAt);
  const endAt = str(payload.endAt);
  const expiresAt = str(payload.expiresAt);
  const calendarId = str(payload.calendarId);
  if (!startAt || !endAt || !validRange(startAt, endAt)) {
    throw new ServiceError("INVALID_REQUEST", "Proposal payload must carry an explicit valid startAt/endAt range", false);
  }
  if (!calendarId) {
    throw new ServiceError("INVALID_REQUEST", "Proposal payload must carry an explicit calendarId (it is part of the approved fingerprint)", false);
  }
  const nowMs = opts.nowMs ?? Date.now();
  const startMs = Date.parse(startAt);
  const endMs = Date.parse(endAt);
  if (endMs <= nowMs) {
    throw new ServiceError("INVALID_REQUEST", "Proposal event window has already ended; past windows cannot be approved", false);
  }
  if (startMs <= nowMs) {
    throw new ServiceError("INVALID_REQUEST", "Proposal event window has already started; past or current startAt values cannot be approved", false);
  }
  const expiryMs = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  if (!expiresAt || !Number.isFinite(expiryMs)) {
    throw new ServiceError("INVALID_REQUEST", "Proposal payload must carry an explicit valid expiresAt", false);
  }
  if (expiryMs <= nowMs) {
    throw new ServiceError("INVALID_REQUEST", "Proposal payload expiresAt must be in the future (the hold has already expired)", false);
  }
  const rawTo = payload.emailTo;
  if (!Array.isArray(rawTo) || rawTo.length === 0) {
    throw new ServiceError("INVALID_REQUEST", "Proposal payload must carry an explicit non-empty emailTo array", false);
  }
  // Every recipient must be reviewable exactly as executed: malformed
  // elements are rejected rather than silently filtered, so the approved
  // fingerprint covers precisely the executed recipient set.
  const emailTo: string[] = rawTo.map((item, index) => {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new ServiceError("INVALID_REQUEST", `Proposal payload emailTo[${index}] must be a non-empty email address; malformed recipients are rejected, not filtered`, false);
    }
    return item;
  });
  const emailSubject = str(payload.emailSubject);
  const emailBody = str(payload.emailBody);
  if (!emailSubject) throw new ServiceError("INVALID_REQUEST", "Proposal payload must carry an explicit emailSubject", false);
  if (!emailBody) throw new ServiceError("INVALID_REQUEST", "Proposal payload must carry an explicit emailBody", false);
  return { startAt, endAt, expiresAt, calendarId, emailTo, emailSubject, emailBody };
}

/** UI preview of the exact consequences approval would execute (same resolver). */
export function previewConsequences(
  actionPayload: Record<string, unknown>,
  opts: { nowMs?: number } = {},
): {
  consequences: import("./dto.ts").ProposalConsequencesDTO | null;
  consequencesError?: string;
} {
  try {
    const params = resolveHoldParams(actionPayload, opts);
    return { consequences: { ...params } };
  } catch (error) {
    return { consequences: null, consequencesError: error instanceof Error ? error.message : "Incomplete proposal payload" };
  }
}

/* ------------------------------------------------------------------ *
 * ADR-003 deterministic server-side commercial authority.               *
 *                                                                      *
 * The proposal payload is model/customer-influenced text. It can never   *
 * self-authorize a concession, a recipient, a price, or an expiry:       *
 * every concession entry must bind to an owner-confirmed                 *
 * `policy.concessions` business fact (by fact id), the policy must       *
 * allow concessions now and in this scope, and the cumulative reduction  *
 * across the whole booking must stay inside the policy cap and the       *
 * commercial floor. Facts with confidence below "verified" (or absent    *
 * entirely) are never authority. Approval itself is separately enforced  *
 * by requireExactApproval/requireLiveApproval; this check covers the     *
 * payload fields the fingerprint alone cannot police.                    *
 * ------------------------------------------------------------------ */

/** A single concession entry inside a proposal payload. */
export interface PayloadConcession {
  label: string;
  amountMinor?: number;
  percentBps?: number;
  /** Id of the owner-confirmed policy.concessions fact the entry binds to. */
  policyId?: string;
  scope?: ConcessionScope;
}

export interface ConcessionScope {
  eventDates?: string[];
  packages?: string[];
  customerIds?: string[];
}

export interface ConcessionPolicy {
  allowed: boolean;
  maxCumulativeReductionMinor?: number;
  maxReductionBps?: number;
  floorMinor?: number;
  scope?: ConcessionScope;
  expiresAt?: string;
}

function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function cleanStringList(value: unknown, max: number): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim().length === 0) return undefined;
    out.push(entry);
    if (out.length > max) return undefined;
  }
  return out;
}

function parseScope(value: unknown): ConcessionScope | undefined {
  if (value === undefined) return {};
  if (!isRecord(value)) return undefined;
  const scope: ConcessionScope = {};
  for (const key of ["eventDates", "packages", "customerIds"] as const) {
    if (value[key] === undefined) continue;
    const list = cleanStringList(value[key], 50);
    if (list === undefined) return undefined;
    scope[key] = list;
  }
  return scope;
}

function scopeAllows(scope: ConcessionScope | undefined, context: { eventDate?: string; packageId?: string; customerId?: string }): string | undefined {
  if (scope === undefined) return undefined;
  if (scope.eventDates !== undefined && scope.eventDates.length > 0) {
    if (context.eventDate === undefined || !scope.eventDates.includes(context.eventDate)) {
      return `event date ${context.eventDate ?? "(none)"} is outside the concession policy scope`;
    }
  }
  if (scope.packages !== undefined && scope.packages.length > 0) {
    if (context.packageId === undefined || !scope.packages.includes(context.packageId)) {
      return `package ${context.packageId ?? "(none)"} is outside the concession policy scope`;
    }
  }
  if (scope.customerIds !== undefined && scope.customerIds.length > 0) {
    if (context.customerId === undefined || !scope.customerIds.includes(context.customerId)) {
      return "the customer is outside the concession policy scope";
    }
  }
  return undefined;
}

/** Strictly parse a verified policy.concessions fact value. Malformed policy values are never authority. */
function parseConcessionPolicy(value: unknown): ConcessionPolicy | undefined {
  if (!isRecord(value)) return undefined;
  if (value.allowed !== true && value.allowed !== false) return undefined;
  const scope = parseScope(value.scope);
  if (value.scope !== undefined && scope === undefined) return undefined;
  const policy: ConcessionPolicy = { allowed: value.allowed, ...(scope ? { scope } : {}) };
  for (const key of ["maxCumulativeReductionMinor", "maxReductionBps", "floorMinor"] as const) {
    if (value[key] === undefined) continue;
    const num = nonNegativeInt(value[key]);
    if (num === undefined) return undefined;
    policy[key] = num;
  }
  if (value.expiresAt !== undefined) {
    if (typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt))) return undefined;
    policy.expiresAt = value.expiresAt;
  }
  return policy;
}

function parseConcessions(raw: unknown): PayloadConcession[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new ServiceError("DENIED", "Proposal payload concessions must be an array of entries bound to an owner-confirmed policy", false);
  }
  return raw.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new ServiceError("DENIED", `Concession entry ${index} is malformed; concessions are structured records, not free text`, false);
    }
    const label = str(entry.label);
    if (label === undefined) {
      throw new ServiceError("DENIED", `Concession entry ${index} has no label`, false);
    }
    const amountMinor = nonNegativeInt(entry.amountMinor);
    const percentBps = nonNegativeInt(entry.percentBps);
    if (amountMinor === undefined && percentBps === undefined) {
      throw new ServiceError("DENIED", `Concession "${label}" carries no verifiable amount (amountMinor or percentBps required)`, false);
    }
    if (percentBps !== undefined && percentBps > 10_000) {
      throw new ServiceError("DENIED", `Concession "${label}" percentBps exceeds 100%`, false);
    }
    const scope = parseScope(entry.scope);
    if (entry.scope !== undefined && scope === undefined) {
      throw new ServiceError("DENIED", `Concession "${label}" carries a malformed scope`, false);
    }
    const policyId = entry.policyId;
    return {
      label,
      ...(amountMinor !== undefined ? { amountMinor } : {}),
      ...(percentBps !== undefined ? { percentBps } : {}),
      ...(typeof policyId === "string" && policyId.trim().length > 0 ? { policyId } : {}),
      ...(scope !== undefined ? { scope } : {}),
    };
  });
}

/** The newest owner-confirmed policy.concessions fact, if any. Only verified confidence counts. */
function confirmedConcessionPolicy(store: GatherStore, businessId: string): { factId: string; policy: ConcessionPolicy } | undefined {
  const facts = store
    .listBusinessFacts(businessId)
    .filter((fact) => fact.key === "policy.concessions" && fact.confidence === "verified")
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt));
  for (const fact of facts) {
    const policy = parseConcessionPolicy(fact.value);
    if (policy !== undefined) return { factId: fact.id, policy };
  }
  return undefined;
}

/** Commercial floor from owner-confirmed facts: explicit bounds first, then the package minimum. */
function confirmedFloorMinor(store: GatherStore, businessId: string): number | undefined {
  const verified = store.listBusinessFacts(businessId).filter((fact) => fact.confidence === "verified");
  const bounds = verified
    .filter((fact) => fact.key === "pricing_bounds")
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt));
  for (const fact of bounds) {
    if (isRecord(fact.value)) {
      const floor = nonNegativeInt(fact.value.floorMinor) ?? nonNegativeInt(fact.value.floorCents);
      if (floor !== undefined) return floor;
    }
  }
  const packages = verified
    .filter((fact) => fact.key === "pricing.package")
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt));
  for (const fact of packages) {
    if (isRecord(fact.value)) {
      const floor = nonNegativeInt(fact.value.minimumTotalMinor);
      if (floor !== undefined) return floor;
    }
  }
  return undefined;
}

/** The proposal's declared base total in minor units, from explicit payload fields only. */
function payloadBaseTotalMinor(payload: Record<string, unknown>): number | undefined {
  const offer = isRecord(payload.offer) ? payload.offer : undefined;
  const direct = nonNegativeInt(payload.totalMinor)
    ?? nonNegativeInt(offer?.totalCents)
    ?? nonNegativeInt(payload.totalCents);
  if (direct !== undefined) return direct;
  const gbp = typeof payload.totalGbp === "number" && Number.isFinite(payload.totalGbp) && payload.totalGbp >= 0
    ? payload.totalGbp
    : undefined;
  return gbp === undefined ? undefined : Math.round(gbp * 100);
}

function concessionAmount(entry: PayloadConcession, baseMinor: number | undefined): number {
  if (entry.amountMinor !== undefined) return entry.amountMinor;
  if (baseMinor === undefined) {
    throw new ServiceError("DENIED", `Concession "${entry.label}" is percentage-based but the proposal declares no base total to verify it against`, false);
  }
  return Math.round((entry.percentBps! * baseMinor) / 10_000);
}

/**
 * Deterministic payload-authority check, applied identically at proposal
 * creation and before execution (approve AND retry paths):
 *
 * - Recipients: when the payload declares a server-bound controlledRecipient
 *   or authorizedRecipients list, every emailTo must be inside it. (The
 *   fingerprint already covers emailTo as-displayed; this narrows it to the
 *   server-designated set, additional-only.)
 * - Concessions/floors: every concession entry must bind by fact id to an
 *   owner-confirmed, currently-valid, in-scope concession policy; the
 *   booking-cumulative reduction must stay inside the policy cap and the
 *   confirmed floor. A discount claimed in customer text, a guessed policy
 *   id, an expired or scoped-out policy, or a cumulative total past the cap
 *   is a DENIED refusal with a displayable reason — never an approval.
 *
 * `excludeActionId` excludes the candidate action itself when the check
 * runs against a persisted proposal (its own concessions are summed from
 * `payload`, not double-counted from the row).
 */
export function checkProposalAuthority(
  store: GatherStore,
  input: {
    bookingId: string;
    payload: Record<string, unknown>;
    nowMs: number;
    excludeActionId?: string;
  },
): void {
  const payload = asRecord(input.payload);
  const booking = store.getBooking(input.bookingId);

  // --- Recipient narrowing (server-bound fields only; never widened) ---
  const emailTo = Array.isArray(payload.emailTo)
    ? payload.emailTo.filter((item): item is string => typeof item === "string")
    : [];
  const controlled = str(payload.controlledRecipient);
  if (controlled !== undefined && emailTo.some((recipient) => recipient !== controlled)) {
    throw new ServiceError(
      "DENIED",
      `Proposal recipient is outside the server-controlled recipient ${controlled}; the payload cannot redirect the offer email`,
      false,
    );
  }
  const authorized = Array.isArray(payload.authorizedRecipients)
    ? payload.authorizedRecipients.filter((item): item is string => typeof item === "string")
    : undefined;
  if (authorized !== undefined && authorized.length > 0 && emailTo.some((recipient) => !authorized.includes(recipient))) {
    throw new ServiceError(
      "DENIED",
      "Proposal recipient is outside the server-authorized recipient set; the payload cannot widen it",
      false,
    );
  }

  // --- Concessions and commercial floors ---
  const concessions = parseConcessions(payload.concessions);
  if (concessions.length === 0) return;

  const confirmed = confirmedConcessionPolicy(store, booking.businessId);
  if (confirmed === undefined) {
    throw new ServiceError(
      "DENIED",
      "No owner-confirmed concession policy exists for this business; a concession can never self-authorize from proposal or customer text",
      false,
    );
  }
  const { policy, factId } = confirmed;
  if (!policy.allowed) {
    throw new ServiceError("DENIED", "The owner-confirmed concession policy does not allow concessions", false);
  }
  if (policy.expiresAt !== undefined && Date.parse(policy.expiresAt) <= input.nowMs) {
    throw new ServiceError("DENIED", "The owner-confirmed concession policy has expired", false);
  }
  const eventDate = (str(payload.startAt) ?? booking.startAt ?? "").slice(0, 10) || undefined;
  const scopeContext = {
    eventDate,
    packageId: str(payload.packageId),
    customerId: str(payload.customerId),
  };
  const scopeDenial = scopeAllows(policy.scope, scopeContext);
  if (scopeDenial !== undefined) {
    throw new ServiceError("DENIED", `Concession denied: ${scopeDenial}`, false);
  }
  const baseMinor = payloadBaseTotalMinor(payload);
  let cumulative = 0;
  for (const entry of concessions) {
    if (entry.policyId !== factId) {
      throw new ServiceError(
        "DENIED",
        `Concession "${entry.label}" is not bound to the owner-confirmed concession policy (${factId}); unbound or guessed policy references never authorize a reduction`,
        false,
      );
    }
    const entryDenial = scopeAllows(entry.scope, scopeContext);
    if (entryDenial !== undefined) {
      throw new ServiceError("DENIED", `Concession "${entry.label}" denied: ${entryDenial}`, false);
    }
    cumulative += concessionAmount(entry, baseMinor);
  }
  // Cumulative across the booking: a proposal's concessions keep counting
  // while it is live OR once it ever carried an approval (its reduction was
  // authorized even if the proposal was later superseded), so splitting a
  // discount across sequential proposals cannot launder past the ceiling.
  // A superseded-never-approved proposal's concessions never took effect
  // and do not count.
  for (const other of store.listProposedActionsForBooking(booking.id)) {
    if (other.id === input.excludeActionId) continue;
    if (other.status === "superseded" && store.listApprovals(other.id).length === 0) continue;
    for (const entry of parseConcessions(other.payload.concessions)) {
      cumulative += concessionAmount(entry, payloadBaseTotalMinor(other.payload) ?? baseMinor);
    }
  }
  if (policy.maxCumulativeReductionMinor !== undefined && cumulative > policy.maxCumulativeReductionMinor) {
    throw new ServiceError(
      "DENIED",
      `Cumulative concessions ${cumulative} exceed the confirmed policy cap of ${policy.maxCumulativeReductionMinor} minor units for this booking`,
      false,
    );
  }
  if (policy.maxReductionBps !== undefined) {
    if (baseMinor === undefined) {
      throw new ServiceError("DENIED", "The concession policy is percentage-capped but the proposal declares no base total to verify it against", false);
    }
    if (cumulative > Math.round((policy.maxReductionBps * baseMinor) / 10_000)) {
      throw new ServiceError(
        "DENIED",
        `Cumulative concessions ${cumulative} exceed the confirmed percentage cap (${policy.maxReductionBps} bps of ${baseMinor}) for this booking`,
        false,
      );
    }
  }
  const floor = confirmedFloorMinor(store, booking.businessId);
  if (floor !== undefined) {
    if (baseMinor === undefined) {
      throw new ServiceError("DENIED", "A commercial floor is confirmed but the proposal declares no base total to verify it against", false);
    }
    if (baseMinor - cumulative < floor) {
      throw new ServiceError(
        "DENIED",
        `Concessions would take the booking total to ${baseMinor - cumulative}, below the confirmed commercial floor of ${floor} minor units`,
        false,
      );
    }
  }
}

export function holdOperationKey(proposedActionId: string, proposalVersion: number): string {
  return stableOperationKey({
    connector: "calendar",
    operation: "create-provisional-hold",
    identity: { proposedActionId, proposalVersion: String(proposalVersion) },
  });
}

export function emailOperationKey(proposedActionId: string, proposalVersion: number): string {
  return stableOperationKey({
    connector: "email",
    operation: "send",
    identity: { proposedActionId, proposalVersion: String(proposalVersion) },
  });
}

function stepOf(key: string): "hold" | "email" {
  return key.includes(":send:") ? "email" : "hold";
}

/**
 * Trusted connector proof preserved on every completed step execution
 * result. The proof carries the connector's own mode/simulated declaration
 * plus the response provenance — it is read back (never re-derived) when
 * rendering receipts, so a simulated fixture can never be displayed as a
 * live provider effect.
 */
export interface StepProof {
  mode: "demo" | "live";
  simulated: boolean;
  provenance: SourceReference[];
}

function proofOf(metadata: ConnectorMetadata, provenance: unknown): StepProof {
  const refs = Array.isArray(provenance) ? provenance : [];
  return {
    mode: metadata.mode.mode,
    simulated: metadata.simulated,
    provenance: refs.map((ref) => ({ ...(ref as SourceReference) })),
  };
}

/** Attach the connector's proof to a succeeded step result. */
function provenResult(outcome: { metadata: ConnectorMetadata; data: { provenance?: unknown } }): Record<string, unknown> {
  return { ...(outcome.data as Record<string, unknown>), proof: proofOf(outcome.metadata, outcome.data.provenance) };
}

/** Source kinds a live provider receipt may attest — fixture is never live proof. */
const LIVE_PROOF_SOURCE_KINDS: ReadonlySet<string> = new Set([
  "connected_account",
  "document",
  "email",
  "calendar",
  "manual",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Positive structural check for one provenance ref: a supported non-fixture
 * source kind plus a non-empty locator (and a string label when present).
 * Anything else — null, strings, missing kind/locator, fictional flags — is
 * not live evidence.
 */
function isValidLiveProvenanceRef(ref: unknown): boolean {
  if (!isRecord(ref)) return false;
  if (!LIVE_PROOF_SOURCE_KINDS.has(ref.kind as string)) return false;
  if (typeof ref.locator !== "string" || ref.locator.trim().length === 0) return false;
  if (ref.label !== undefined && typeof ref.label !== "string") return false;
  if (ref.fictional === true) return false;
  return true;
}

/**
 * A receipt reads as live only on positive proof: live mode, explicitly not
 * simulated, and a non-empty provenance list whose EVERY entry is a valid
 * non-fixture source reference. Everything else — missing/malformed proof
 * (legacy rows, unknown connectors), simulated results, empty provenance,
 * or any fictional/malformed ref — fails closed to non-live. Fixture
 * receipts are therefore never upgraded to live.
 */
export function isLiveStepProof(result: unknown): boolean {
  if (!isRecord(result)) return false;
  const proof = result.proof;
  if (!isRecord(proof)) return false;
  if (proof.mode !== "live" || proof.simulated !== false) return false;
  if (!Array.isArray(proof.provenance) || proof.provenance.length === 0) return false;
  return proof.provenance.every(isValidLiveProvenanceRef);
}

/**
 * Positive simulated/fixture proof: the envelope explicitly says demo (or
 * simulated), or every provenance entry is explicitly fictional. Anything
 * else with a proof object — empty, unknown-mode, mixed, or malformed —
 * is NOT simulation evidence and must read as unverified, never simulated.
 */
export function isSimulatedStepProof(result: unknown): boolean {
  if (!isRecord(result)) return false;
  const proof: unknown = result.proof;
  if (!isRecord(proof)) return false;
  if (proof.mode === "demo" || proof.simulated === true) return true;
  if (!Array.isArray(proof.provenance) || proof.provenance.length === 0) return false;
  return proof.provenance.every((ref) => isRecord(ref) && ref.fictional === true);
}

/** Honest per-receipt wording derived from the stored proof, never assumed. */
export function stepReceiptDetail(execution: ActionExecution): string {
  if (execution.status !== "succeeded") return execution.error ?? execution.status;
  if (isLiveStepProof(execution.result)) return "Done — provider receipt recorded";
  if (isSimulatedStepProof(execution.result)) return "Done — simulated provider receipt";
  return "Done — provider receipt unverified";
}

/** A booking is a fixture only when every source reference is explicitly fictional. */
function isFixtureBooking(booking: Booking): boolean {
  const refs = booking.sourceReferences;
  return refs.length > 0 && refs.every((ref) => ref.fictional === true);
}

/**
 * Derive the response marker from actual evidence, never a hardcoded demo
 * claim: fixture bookings are demo; real bookings are live only when every
 * succeeded step carries positive live proof; any other real evidence —
 * simulated, absent, or malformed proof — is honestly "unverified".
 */
function evidenceMarkerFor(booking: Booking, executions: ActionExecution[]): { demo: boolean; mode: EvidenceModeMarker } {
  if (isFixtureBooking(booking)) return { demo: true, mode: DEMO_MARKER };
  const succeeded = executions.filter((execution) => execution.status === "succeeded");
  if (succeeded.length > 0 && succeeded.every((execution) => isLiveStepProof(execution.result))) {
    return { demo: false, mode: LIVE_MARKER };
  }
  return { demo: false, mode: UNKNOWN_MARKER };
}

function toReceipt(execution: ActionExecution): StepReceiptDTO {
  return { execution, step: stepOf(execution.idempotencyKey), demo: !isLiveStepProof(execution.result) };
}

function availabilityKey(calendarId: string, startAt: string, endAt: string): string {
  return availabilityOperationKey({ calendarId, startAt, endAt });
}

/**
 * Action kinds the approval pipeline is allowed to execute (C6). The
 * pipeline always runs a provisional-hold + email plan, so any other kind —
 * including `custom` with a hold-shaped payload — is rejected at the
 * approval/retry boundary before any approval row or side effect.
 */
const SUPPORTED_APPROVAL_KINDS = ["create_provisional_hold"] as const;

function requireSupportedKind(kind: string): void {
  if (!(SUPPORTED_APPROVAL_KINDS as readonly string[]).includes(kind)) {
    throw new ServiceError(
      "INVALID_REQUEST",
      `Unsupported proposal kind "${kind}": the approval pipeline executes only a provisional-hold + email plan (kind "create_provisional_hold")`,
      false,
    );
  }
}

/** Read-only workspace aggregation for the owner UI. */
export function getWorkspace(store: GatherStore, deps?: Pick<BookingServiceDeps, "ownerId" | "now">): WorkspaceDTO {
  const businesses = store.listBusinesses();
  const connections = store.listConnectedAccounts();
  const nowMs = deps?.now ? Date.parse(deps.now()) : Date.now();
  const bookings = store.listBookings().map((booking) => {
    const actions = store.listProposedActionsForBooking(booking.id);
    const current = store.getCurrentProposalAction(booking.id);
    return {
      booking,
      proposals: actions.map((action) => {
        const preview = previewConsequences(action.payload, { nowMs });
        return {
          action,
          consequences: preview.consequences,
          ...(preview.consequencesError ? { consequencesError: preview.consequencesError } : {}),
        };
      }),
      approvals: actions.flatMap((action) => store.listApprovals(action.id)),
      executions: actions.flatMap((action) => store.listActionExecutions(action.id)),
      ...(current ? { currentProposedActionId: current.id } : {}),
    };
  });
  // The workspace marker reflects what the payload actually contains: demo
  // only when there IS at least one booking and every booking is an explicit
  // fixture (an empty list would vacuously satisfy `.every` and falsely mark
  // a connected-but-empty workspace as simulated); a workspace containing
  // real bookings can never claim the fictional/simulated marker, and it
  // claims live only when every succeeded step carries positive live proof.
  const everyBookingFixture = bookings.length > 0 && bookings.every((item) => isFixtureBooking(item.booking));
  const allExecutions = bookings.flatMap((item) => item.executions);
  const workspaceMarker = everyBookingFixture
    ? { demo: true as const, mode: DEMO_MARKER }
    : {
        demo: false as const,
        mode: allExecutions.some((execution) => execution.status === "succeeded") &&
          allExecutions.every((execution) => execution.status !== "succeeded" || isLiveStepProof(execution.result))
          ? LIVE_MARKER
          : UNKNOWN_MARKER,
      };
  return {
    mode: workspaceMarker.mode,
    demo: workspaceMarker.demo,
    approvalIdentity: deps?.ownerId ?? process.env.GATHER_OWNER_ID ?? "local-owner",
    businesses,
    bookings,
    connections,
    notice: everyBookingFixture
      ? "DEMO ONLY: all records and receipts are local fixtures/simulated integrations, not live provider state."
      : bookings.length === 0
        ? "No bookings yet — nothing shown is provider-verified; connected sources report in as inquiries arrive."
        : workspaceMarker.mode === LIVE_MARKER
          ? "Contains real bookings with provider receipts; holds are provisional, never confirmed bookings."
          : "Contains real bookings; provider evidence is unverified unless a receipt shows live proof.",
  };
}

/** Cancellation revokes permission for new booking execution, even after awaits. */
function requireActiveBooking(store: GatherStore, bookingId: string): void {
  if (store.getBooking(bookingId).status === "cancelled") {
    throw new ServiceError("CONFLICT", "This booking was cancelled; no further booking actions are permitted", false);
  }
}

/** Execution progress cannot undo cancellation or proof-gated confirmation. */
function updateExecutionStatus(store: GatherStore, bookingId: string, status: Booking["status"]): void {
  const current = store.getBooking(bookingId).status;
  if (current === "cancelled" || (current === "confirmed" && status === "provisional_hold")) return;
  store.updateBookingStatus(bookingId, status);
}

/** Exact-version approval gate shared by approve + retry paths. */
function requireExactApproval(store: GatherStore, input: ApproveRequestDTO) {
  let action;
  try {
    action = store.getProposedAction(input.proposedActionId);
  } catch {
    throw new ServiceError("NOT_FOUND", `Proposed action not found: ${input.proposedActionId}`, false);
  }
  if (action.bookingId !== input.bookingId) {
    throw new ServiceError("CROSS_BOOKING", "Proposed action belongs to a different booking; cross-booking approval is denied", false);
  }
  if (action.proposalVersion !== input.proposalVersion || action.proposalFingerprint !== input.proposalFingerprint) {
    throw new ServiceError(
      "STALE_PROPOSAL",
      `Stale proposal: expected v${action.proposalVersion}/${action.proposalFingerprint.slice(0, 12)}..., refusing approval`,
      false,
    );
  }
  requireCurrentBinding(store, action.id);
  requireActiveBooking(store, action.bookingId);
  return action;
}

/**
 * Durable current-proposal gate: only the booking's single current proposal
 * (explicit pointer, never version/timestamp/UUID ordering) can be
 * approved, retried, or reconciled. A superseded action — even with a
 * higher in-row version or a matching fingerprint — is stale by definition.
 */
function requireCurrentBinding(store: GatherStore, actionId: string): void {
  if (!store.isCurrentProposalAction(actionId)) {
    throw new ServiceError(
      "STALE_PROPOSAL",
      "This proposal is no longer current: a newer proposal superseded it — re-approve the displayed proposal",
      false,
    );
  }
}

/**
 * Reserve a step for execution, mapping store-level ownership races to typed
 * service errors. The returned reservation carries the caller's claim token;
 * provider side effects and completion writes must present that token, so an
 * expired in-flight call and a new owner can never both commit.
 */
function reserveStep(
  deps: BookingServiceDeps,
  actionId: string,
  version: number,
  key: string,
  step: "hold" | "email",
): { reservation: StepReservation; claimToken: string } {
  requireActiveBooking(deps.store, deps.store.getProposedAction(actionId).bookingId);
  const claimToken = randomUUID();
  try {
    const reservation = deps.store.reserveStepExecution(actionId, version, key, {
      claimToken,
      leaseMs: STEP_CLAIM_LEASE_MS,
      nowMs: clockMs(deps),
    });
    return { reservation, claimToken };
  } catch (error) {
    if (error instanceof Error && /already in progress/.test(error.message)) {
      throw new ServiceError("CONFLICT", `${step === "hold" ? "Hold" : "Email"} step is already in progress for this approved proposal; wait or reconcile`, true);
    }
    if (error instanceof Error && /exact current proposal version|Stale proposal version/.test(error.message)) {
      throw new ServiceError("STALE_PROPOSAL", "The proposal changed while the request was in flight; re-approve the displayed proposal", false);
    }
    throw error;
  }
}

function hasLiveApproval(store: GatherStore, actionId: string): boolean {
  if (!store.isCurrentProposalAction(actionId)) return false;
  const action = store.getProposedAction(actionId);
  return store.listApprovals(actionId).some(
    (approval) =>
      approval.status === "approved" &&
      approval.proposalVersion === action.proposalVersion &&
      approval.proposalFingerprint === action.proposalFingerprint,
  );
}

function isStale(store: GatherStore, actionId: string, version: number): boolean {
  const action = store.getProposedAction(actionId);
  return store.getBooking(action.bookingId).status === "cancelled" || action.proposalVersion !== version || !store.isCurrentProposalAction(actionId) || !hasLiveApproval(store, actionId);
}

/**
 * Re-verify a live exact-version approval after an async wait. A proposal
 * edited (or superseded) while a provider call was outstanding must not keep
 * executing as if approved: the booking is parked as uncertain and the
 * pipeline halts with STALE_PROPOSAL.
 */
function assertLiveApprovalAfterWait(store: GatherStore, actionId: string, version: number): void {
  const action = store.getProposedAction(actionId);
  requireActiveBooking(store, action.bookingId);
  if (action.proposalVersion === version && store.isCurrentProposalAction(actionId) && hasLiveApproval(store, actionId)) return;
  try {
    updateExecutionStatus(store, action.bookingId, "uncertain");
  } catch {
    // Booking already gone; the STALE error below still carries the signal.
  }
  throw new ServiceError("STALE_PROPOSAL", "The proposal changed while the request was in flight; re-approve the displayed proposal", false);
}

/**
 * Recover a reclaimed (crashed/leaked) pending attempt. A lease expiry proves
 * nothing about the external effect, so reconcile by stable operation key
 * BEFORE any further write. A found write heals to succeeded; an absent one
 * stays uncertain — it must never be replayed blindly.
 */
async function recoverReclaimedHold(
  deps: BookingServiceDeps,
  execution: ActionExecution,
  key: string,
  claimToken: string,
): Promise<ActionExecution> {
  const { store, calendar } = deps;
  const reconciled = await calendar.reconcileProvisionalHold({ operationKey: key });
  if (reconciled.status === "succeeded") {
    // The pending row must pass through uncertain (claim-guarded) before it
    // can record the reconciled outcome.
    const pending = store.markExecutionUncertain(
      execution.id,
      "Recovered pending hold matched provider evidence on reconcile",
      { claimToken },
    );
    const healed = store.reconcileActionExecution(pending.id, { status: "succeeded", result: { ...provenResult(reconciled) } });
    assertLiveApprovalAfterWait(store, execution.proposedActionId, execution.proposalVersion);
    return healed;
  }
  const pending = store.markExecutionUncertain(
    execution.id,
    "Recovered pending hold could not be reconciled against the provider; it remains uncertain until provider evidence appears",
    { claimToken },
  );
  assertLiveApprovalAfterWait(store, execution.proposedActionId, execution.proposalVersion);
  return pending;
}

async function recoverReclaimedEmail(
  deps: BookingServiceDeps,
  execution: ActionExecution,
  key: string,
  claimToken: string,
): Promise<ActionExecution> {
  const { store, email } = deps;
  const reconciled = await email.reconcileSentEmail({ operationKey: key });
  if (reconciled.status === "succeeded") {
    const pending = store.markExecutionUncertain(
      execution.id,
      "Recovered pending email matched provider evidence on reconcile",
      { claimToken },
    );
    const healed = store.reconcileActionExecution(pending.id, { status: "succeeded", result: { ...provenResult(reconciled) } });
    assertLiveApprovalAfterWait(store, execution.proposedActionId, execution.proposalVersion);
    return healed;
  }
  const pending = store.markExecutionUncertain(
    execution.id,
    "Recovered pending email could not be reconciled against the provider; it remains uncertain until provider evidence appears",
    { claimToken },
  );
  assertLiveApprovalAfterWait(store, execution.proposedActionId, execution.proposalVersion);
  return pending;
}

async function runHoldStep(deps: BookingServiceDeps, actionId: string, version: number, params: HoldParams): Promise<ActionExecution> {
  const { store, calendar } = deps;
  const key = holdOperationKey(actionId, version);
  const { reservation, claimToken } = reserveStep(deps, actionId, version, key, "hold");
  let execution = reservation.execution;
  if (execution.status === "succeeded") return execution; // never resend
  if (execution.status === "failed") {
    execution = store.reopenFailedStep(execution.id, { claimToken, leaseMs: STEP_CLAIM_LEASE_MS, nowMs: clockMs(deps) });
  } else if (execution.status === "uncertain" || execution.status === "partial") {
    throw new ServiceError("RECONCILE_REQUIRED", "Hold step is uncertain; reconcile before retrying", false);
  } else if (reservation.reclaimed) {
    return recoverReclaimedHold(deps, execution, key, claimToken);
  } else if (!reservation.created) {
    // Defensive: the store never returns a foreign pending row without throwing,
    // but never execute without claim ownership.
    throw new ServiceError("CONFLICT", "Hold step is already in progress for this approved proposal; wait or reconcile", true);
  }
  // execution is now pending under our claim: only our token can complete it.
  const claim = { claimToken };
  const bookingId = store.getProposedAction(actionId).bookingId;
  /** Halt when the proposal moved on across an async wait. A still-pending
   *  row is preserved as uncertain (never silently dropped); observed
   *  provider evidence in terminal rows is kept as versioned history. */
  const haltIfStale = (): void => {
    if (!isStale(store, actionId, version)) return;
    const current = store.getActionExecution(execution.id);
    if (current.status === "pending") {
      store.markExecutionUncertain(execution.id, "Proposal changed while the provider call was outstanding; outcome left uncertain for reconciliation", claim);
    }
    assertLiveApprovalAfterWait(store, actionId, version);
  };
  let outcome;
  try {
    outcome = await calendar.createProvisionalHold({
      operationKey: key,
      bookingId,
      calendarId: params.calendarId,
      startAt: params.startAt,
      endAt: params.endAt,
      expiresAt: params.expiresAt,
    });
  } catch (error) {
    const pending = store.markExecutionUncertain(execution.id, error instanceof Error ? error.message : "Hold outcome was not received", claim);
    haltIfStale();
    return pending;
  }
  if (outcome.status === "succeeded") {
    const done = store.completeActionExecution(execution.id, { status: "succeeded", result: { ...provenResult(outcome) } }, claim);
    haltIfStale();
    return done;
  }
  if (outcome.status === "uncertain") {
    // Persist uncertainty BEFORE any retry, then attempt one reconciliation read.
    const pending = store.markExecutionUncertain(execution.id, outcome.error.message, claim);
    const reconciled = await calendar.reconcileProvisionalHold({ operationKey: key });
    if (reconciled.status === "succeeded") {
      const healed = store.reconcileActionExecution(pending.id, { status: "succeeded", result: { ...provenResult(reconciled) } });
      haltIfStale();
      return healed;
    }
    haltIfStale();
    return pending;
  }
  // outcome.status === "failed"
  if (outcome.error.kind === "slot_unavailable" || outcome.error.kind === "conflict") {
    return store.completeActionExecution(execution.id, { status: "failed", error: outcome.error.message }, claim);
  }
  if (outcome.error.kind === "access_revoked" || outcome.error.kind === "authorization_denied") {
    const failed = store.completeActionExecution(execution.id, { status: "failed", error: outcome.error.message }, claim);
    void failed;
    throw new ServiceError("ACCESS_REVOKED", outcome.error.message, false);
  }
  return store.completeActionExecution(execution.id, { status: "failed", error: outcome.error.message }, claim);
}

async function runEmailStep(deps: BookingServiceDeps, actionId: string, version: number, params: HoldParams): Promise<ActionExecution> {
  const { store, email } = deps;
  const key = emailOperationKey(actionId, version);
  const { reservation, claimToken } = reserveStep(deps, actionId, version, key, "email");
  let execution = reservation.execution;
  if (execution.status === "succeeded") return execution; // never resend
  if (execution.status === "failed") {
    execution = store.reopenFailedStep(execution.id, { claimToken, leaseMs: STEP_CLAIM_LEASE_MS, nowMs: clockMs(deps) });
  } else if (execution.status === "uncertain" || execution.status === "partial") {
    throw new ServiceError("RECONCILE_REQUIRED", "Email step is uncertain; reconcile before retrying", false);
  } else if (reservation.reclaimed) {
    return recoverReclaimedEmail(deps, execution, key, claimToken);
  } else if (!reservation.created) {
    throw new ServiceError("CONFLICT", "Email step is already in progress for this approved proposal; wait or reconcile", true);
  }
  const claim = { claimToken };
  const haltIfStale = (): void => {
    if (!isStale(store, actionId, version)) return;
    const current = store.getActionExecution(execution.id);
    if (current.status === "pending") {
      store.markExecutionUncertain(execution.id, "Proposal changed while the provider call was outstanding; outcome left uncertain for reconciliation", claim);
    }
    assertLiveApprovalAfterWait(store, actionId, version);
  };
  let outcome;
  try {
    outcome = await email.sendEmail({
      operationKey: key,
      to: params.emailTo,
      subject: params.emailSubject,
      body: params.emailBody,
    });
  } catch (error) {
    const pending = store.markExecutionUncertain(execution.id, error instanceof Error ? error.message : "Email outcome was not received", claim);
    haltIfStale();
    return pending;
  }
  if (outcome.status === "succeeded") {
    const done = store.completeActionExecution(execution.id, { status: "succeeded", result: { ...provenResult(outcome) } }, claim);
    haltIfStale();
    return done;
  }
  if (outcome.status === "uncertain") {
    const pending = store.markExecutionUncertain(execution.id, outcome.error.message, claim);
    const reconciled = await email.reconcileSentEmail({ operationKey: key });
    if (reconciled.status === "succeeded") {
      const healed = store.reconcileActionExecution(pending.id, { status: "succeeded", result: { ...provenResult(reconciled) } });
      haltIfStale();
      return healed;
    }
    haltIfStale();
    return pending;
  }
  if (outcome.error.kind === "access_revoked" || outcome.error.kind === "authorization_denied") {
    const failed = store.completeActionExecution(execution.id, { status: "failed", error: outcome.error.message }, claim);
    void failed;
    throw new ServiceError("ACCESS_REVOKED", outcome.error.message, false);
  }
  return store.completeActionExecution(execution.id, { status: "failed", error: outcome.error.message }, claim);
}

/**
 * Approve the exact displayed proposal version, then execute:
 * fresh availability -> durable provisional hold -> durable email.
 * A hold never transitions the booking to confirmed.
 */
/**
 * Verify that the action still carries a live exact-version approval. Retry
 * and reconcile paths must not serve stale receipts after the proposal moved
 * on: returning an old succeeded step without this check would bypass the
 * exact-approval gate.
 */
function requireLiveApproval(store: GatherStore, actionId: string): void {
  requireCurrentBinding(store, actionId);
  const action = store.getProposedAction(actionId);
  if (!hasLiveApproval(store, actionId)) {
    throw new ServiceError(
      "STALE_PROPOSAL",
      `No live approval for the current proposal version (v${action.proposalVersion}); re-approve the displayed proposal first`,
      false,
    );
  }
}

/**
 * Fresh availability immediately before any (new or retried) hold write.
 * The requested range must be FULLY covered by available slots: a single
 * partially overlapping open slot is not sufficient. Any overlapping
 * unavailable slot blocks the hold.
 *
 * After the provider read, the same durable conflict set that the create
 * path enforces is consulted (excluding the caller's own operation key),
 * so availability and create agree in the same process and across restarts:
 * a window durably held by another booking refuses here with the same
 * actionable SLOT_UNAVAILABLE instead of failing later at create time.
 */
async function requireFreshAvailability(
  deps: BookingServiceDeps,
  bookingId: string,
  params: HoldParams,
  ownOperationKey: string,
): Promise<void> {
  const { store, calendar } = deps;
  const availability = await calendar.checkAvailability({
    operationKey: availabilityKey(params.calendarId, params.startAt, params.endAt),
    calendarId: params.calendarId,
    startAt: params.startAt,
    endAt: params.endAt,
  });
  requireActiveBooking(store, bookingId);
  if (availability.status === "failed") {
    const kind = availability.error.kind;
    if (kind === "access_revoked" || kind === "authorization_denied") {
      updateExecutionStatus(store, bookingId, "uncertain");
      throw new ServiceError("ACCESS_REVOKED", availability.error.message, false);
    }
    updateExecutionStatus(store, bookingId, "failed");
    throw new ServiceError("SLOT_UNAVAILABLE", availability.error.message, false);
  }
  if (availability.status === "uncertain") {
    updateExecutionStatus(store, bookingId, "uncertain");
    throw new ServiceError("UNCERTAIN", "Availability check was uncertain; retry approval", true);
  }
  const startMs = Date.parse(params.startAt);
  const endMs = Date.parse(params.endAt);
  const blocked = availability.data.slots.find((slot) => !slot.available);
  if (blocked) {
    updateExecutionStatus(store, bookingId, "failed");
    throw new ServiceError("SLOT_UNAVAILABLE", blocked.reason ?? "Requested date is unavailable", false);
  }
  const fullyCovered = availability.data.slots.some(
    (slot) => slot.available && Date.parse(slot.startAt) <= startMs && Date.parse(slot.endAt) >= endMs,
  );
  if (!fullyCovered) {
    updateExecutionStatus(store, bookingId, "failed");
    throw new ServiceError("SLOT_UNAVAILABLE", "No available slot fully covers the requested range", false);
  }
  const durableConflict = store.findHoldConflict(params.calendarId, params.startAt, params.endAt, {
    excludeOperationKey: ownOperationKey,
    nowMs: clockMs(deps),
  });
  if (durableConflict) {
    updateExecutionStatus(store, bookingId, "failed");
    throw new ServiceError("SLOT_UNAVAILABLE", durableWindowMessage(durableConflict), false);
  }
}

/**
 * Actionable mapping for the demonstrated durable-window conflict only.
 * Other conflict kinds (e.g. an operation key rebound to a different
 * payload) keep their EXECUTION_FAILED path so they are never masked as
 * availability.
 */
function isDurableWindowConflict(message: string | undefined): boolean {
  return message !== undefined && message.includes("already held (durable record");
}

function durableWindowMessage(conflictingKey: string): string {
  return `Demo calendar window is already held (durable record ${conflictingKey}); choose another window or reconcile the conflicting record`;
}

export async function approveAndExecute(deps: BookingServiceDeps, input: ApproveRequestDTO): Promise<ApproveResponseDTO> {
  const { store } = deps;
  const action = requireExactApproval(store, input);
  const booking = store.getBooking(action.bookingId);
  requireActiveBooking(store, booking.id);
  requireSupportedKind(action.kind);
  // Validate the executable consequences BEFORE recording an approval: an
  // invalid (or past) proposal must never gain an approval row.
  const params = resolveHoldParams(action.payload, { nowMs: clockMs(deps) });
  // ADR-003 deterministic commercial authority: recipient narrowing plus
  // owner-confirmed concession/floor checks, re-verified at approval so a
  // payload can never smuggle a reduction the owner policy did not allow.
  checkProposalAuthority(store, { bookingId: action.bookingId, payload: action.payload, nowMs: clockMs(deps), excludeActionId: action.id });
  const approvedBy = ownerIdentity(deps);
  const approval = store.approveProposedAction(action.id, approvedBy);

  // A repeated approval whose own hold already succeeded reuses receipts: no
  // new write can occur, so a fresh availability read must not fail it.
  const ownHold = store.getExecutionByIdempotencyKey(holdOperationKey(action.id, action.proposalVersion));
  if (ownHold?.status !== "succeeded") {
    await requireFreshAvailability(deps, booking.id, params, holdOperationKey(action.id, action.proposalVersion));
    assertLiveApprovalAfterWait(store, action.id, action.proposalVersion);
  }

  const holdExecution = await runHoldStep(deps, action.id, action.proposalVersion, params);
  if (holdExecution.status === "failed") {
    updateExecutionStatus(store, booking.id, "failed");
    if (isDurableWindowConflict(holdExecution.error)) {
      throw new ServiceError("SLOT_UNAVAILABLE", holdExecution.error as string, false);
    }
    throw new ServiceError("EXECUTION_FAILED", holdExecution.error ?? "Provisional hold failed", false);
  }
  // Hold exists (or its outcome is still uncertain): booking is provisional at best.
  updateExecutionStatus(store, booking.id, holdExecution.status === "uncertain" ? "uncertain" : "provisional_hold");
  if (holdExecution.status === "uncertain") {
    const current = store.getBooking(booking.id);
    return {
      ...evidenceMarkerFor(booking, [holdExecution]),
      approval,
      approvedBy,
      booking: current,
      hold: toReceipt(holdExecution),
      email: null,
      availabilityFresh: true as const,
      confirmedBooking: false as const,
      note: "Hold outcome is uncertain; reconcile before retrying. A hold is never a confirmed booking.",
    };
  }

  const emailExecution = await runEmailStep(deps, action.id, action.proposalVersion, params);
  // Aggregate uncertainty: a hold with an uncertain email is not cleanly
  // provisional — the booking must show uncertainty until reconciled.
  if (emailExecution.status === "uncertain") {
    updateExecutionStatus(store, booking.id, "uncertain");
  }
  const current = store.getBooking(booking.id);
  return {
    ...evidenceMarkerFor(booking, [holdExecution, emailExecution]),
    approval,
    approvedBy,
    booking: current,
    hold: toReceipt(holdExecution),
    email: toReceipt(emailExecution),
    availabilityFresh: true as const,
    confirmedBooking: false as const,
    note: emailExecution.status === "uncertain"
      ? "Email outcome is uncertain; reconcile before retrying. A hold is never a confirmed booking."
      : completionNote(holdExecution, emailExecution),
  };
}

/**
 * Completion wording derived from the stored step proofs: steps with
 * positive live proof are reported as provider receipts, steps with
 * positive simulated/fixture proof as simulated, and anything else as
 * unverified. Never blanket-claims simulated when a live-shaped connector
 * actually served the step, never claims live without proof, and never
 * labels malformed proof simulated without simulation evidence.
 */
function completionNote(hold: ActionExecution, email: ActionExecution): string {
  const base = "Provisional hold is not a confirmed booking.";
  const wording = (execution: ActionExecution): string =>
    isLiveStepProof(execution.result)
      ? "provider receipt"
      : isSimulatedStepProof(execution.result)
        ? "simulated receipt"
        : "unverified receipt";
  const liveHold = isLiveStepProof(hold.result);
  const liveEmail = isLiveStepProof(email.result);
  if (liveHold && liveEmail) return `${base} Provider receipts recorded for each step.`;
  return `${base} Hold: ${wording(hold)}; email: ${wording(email)}.`;
}

/** Retry only failed steps; succeeded steps are never resent. */
export async function retryFailedSteps(deps: BookingServiceDeps, proposedActionId: string): Promise<RetryResponseDTO> {
  const { store } = deps;
  const action = store.getProposedAction(proposedActionId);
  requireActiveBooking(store, action.bookingId);
  // Even when every step already succeeded, retry must verify the current
  // proposal still carries a live exact-version approval.
  requireLiveApproval(store, action.id);
  requireSupportedKind(action.kind);
  const params = resolveHoldParams(action.payload, { nowMs: clockMs(deps) });
  // ADR-003: the same commercial authority gate re-runs before retry —
  // a policy tightened after approval (or a cumulative cap now exceeded)
  // must stop the retried write, not just the original approval.
  checkProposalAuthority(store, { bookingId: action.bookingId, payload: action.payload, nowMs: clockMs(deps), excludeActionId: action.id });
  const holdKey = holdOperationKey(action.id, action.proposalVersion);
  const mailKey = emailOperationKey(action.id, action.proposalVersion);
  const holdExisting = store.getExecutionByIdempotencyKey(holdKey);
  const mailExisting = store.getExecutionByIdempotencyKey(mailKey);
  if (holdExisting?.status === "uncertain" || holdExisting?.status === "partial" || mailExisting?.status === "uncertain" || mailExisting?.status === "partial") {
    throw new ServiceError("RECONCILE_REQUIRED", "An uncertain step must be reconciled before retry", false);
  }
  if (holdExisting && holdExisting.status !== "succeeded" && holdExisting.status !== "failed" && holdExisting.status !== "pending") {
    throw new ServiceError("INVALID_REQUEST", "Hold step is not in a retryable state", false);
  }
  // Fresh availability before any new hold write (skipped only when the hold
  // already succeeded and no write can occur).
  if (holdExisting?.status !== "succeeded") {
    await requireFreshAvailability(deps, action.bookingId, params, holdKey);
  }
  // Re-run hold only when it has not already succeeded.
  const hold = holdExisting?.status === "succeeded" ? holdExisting : await runHoldStep(deps, action.id, action.proposalVersion, params);
  if (hold.status === "uncertain") {
    updateExecutionStatus(store, action.bookingId, "uncertain");
    throw new ServiceError("RECONCILE_REQUIRED", hold.error ?? "Hold retry is uncertain; reconcile before retrying", false);
  }
  if (hold.status !== "succeeded") {
    updateExecutionStatus(store, action.bookingId, "failed");
    if (isDurableWindowConflict(hold.error)) {
      throw new ServiceError("SLOT_UNAVAILABLE", hold.error as string, false);
    }
    throw new ServiceError("EXECUTION_FAILED", hold.error ?? "Hold retry did not succeed", false);
  }
  updateExecutionStatus(store, action.bookingId, "provisional_hold");
  const email = mailExisting?.status === "succeeded" ? mailExisting : await runEmailStep(deps, action.id, action.proposalVersion, params);
  if (email.status === "uncertain") {
    updateExecutionStatus(store, action.bookingId, "uncertain");
    throw new ServiceError("RECONCILE_REQUIRED", email.error ?? "Email retry is uncertain; reconcile before retrying", false);
  }
  return {
    ...evidenceMarkerFor(store.getBooking(action.bookingId), [hold, email]),
    booking: store.getBooking(action.bookingId),
    hold: toReceipt(hold),
    email: toReceipt(email),
    resentSucceededStep: false as const,
    note: "Retry reused succeeded receipts; no successful provider step was resent.",
  };
}

/**
 * Reconcile a single uncertain/partial execution by its stable idempotency
 * key. Reconcile failures preserve uncertainty and are reported honestly:
 * a missing record means "no provider evidence yet" (retryable), never
 * proof of non-execution, so no new write is permitted on that basis.
 */
export async function reconcileExecution(deps: BookingServiceDeps, executionId: string): Promise<ReconcileResponseDTO> {
  const { store, calendar, email } = deps;
  const current = store.getActionExecution(executionId);
  if (current.status !== "uncertain" && current.status !== "partial") {
    throw new ServiceError("INVALID_REQUEST", "Only uncertain or partial executions require reconciliation", false);
  }
  // Reconciliation binds to the current proposal too: an uncertain step on a
  // superseded action (or one whose approval died with supersession) must
  // not heal into history as if it were the displayed proposal's outcome.
  // The owner re-approves the current proposal and its own steps run there.
  requireLiveApproval(store, current.proposedActionId);
  const kind = stepOf(current.idempotencyKey);
  const outcome = kind === "hold"
    ? await calendar.reconcileProvisionalHold({ operationKey: current.idempotencyKey })
    : await email.reconcileSentEmail({ operationKey: current.idempotencyKey });
  if (outcome.status !== "succeeded") {
    const errKind = outcome.error.kind;
    if (errKind === "access_revoked" || errKind === "authorization_denied") {
      throw new ServiceError("ACCESS_REVOKED", `Reconciliation blocked: ${outcome.error.message}`, false);
    }
    if (errKind === "invalid_request") {
      throw new ServiceError("INVALID_REQUEST", outcome.error.message, false);
    }
    // not_found, rate_limited, transport_error, timeout_after_success, or any
    // other ambiguous outcome: the execution stays uncertain and the caller
    // may retry reconciliation later. This is not a failure verdict.
    throw new ServiceError(
      "RECONCILE_PENDING",
      `No provider evidence yet for ${current.idempotencyKey}: ${outcome.error.message}. Execution remains uncertain; retry reconciliation later.`,
      true,
    );
  }
  // Post-await authority re-check: a proposal superseded while the provider
  // call was in flight must not have its stale execution healed into
  // history nor move the booking's status. Throws STALE/UNCERTAIN and marks
  // the booking uncertain instead of mutating state.
  assertLiveApprovalAfterWait(store, current.proposedActionId, current.proposalVersion);
  const execution = store.reconcileActionExecution(current.id, { status: "succeeded", result: { ...provenResult(outcome) } });
  const action = store.getProposedAction(execution.proposedActionId);
  const booking = store.getBooking(action.bookingId);
  // After a hold reconciles to success the booking is provisional, never confirmed.
  if (kind === "hold" && booking.status !== "provisional_hold") {
    updateExecutionStatus(store, booking.id, "provisional_hold");
  }
  refreshBookingAggregate(store, booking.id);
  return {
    ...evidenceMarkerFor(booking, [execution]),
    execution,
    booking: store.getBooking(booking.id),
    note: isLiveStepProof(execution.result)
      ? "Reconciled against the provider record."
      : isSimulatedStepProof(execution.result)
        ? "DEMO ONLY: reconciled against the simulated provider record."
        : "Reconciled, but the stored receipt carries no provider proof; evidence is unverified.",
  };
}

/**
 * Recompute the aggregate booking state from its step executions. Any
 * outstanding uncertain/partial step keeps the booking uncertain; once no
 * uncertainty remains and a hold succeeded, an uncertain booking returns to
 * provisional_hold (never confirmed). Failed steps leave the last explicit
 * state untouched.
 */
function refreshBookingAggregate(store: GatherStore, bookingId: string): void {
  const booking = store.getBooking(bookingId);
  const executions = store.listProposedActionsForBooking(bookingId).flatMap((action) => store.listActionExecutions(action.id));
  if (executions.some((item) => item.status === "uncertain" || item.status === "partial")) {
    if (booking.status !== "uncertain") updateExecutionStatus(store, bookingId, "uncertain");
    return;
  }
  const holdSucceeded = executions.some((item) => item.status === "succeeded" && stepOf(item.idempotencyKey) === "hold");
  if (holdSucceeded && booking.status === "uncertain") {
    updateExecutionStatus(store, bookingId, "provisional_hold");
  }
}
