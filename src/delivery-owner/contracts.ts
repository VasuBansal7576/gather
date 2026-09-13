/**
 * Delivery owner UI boundary types (PRD G12/G13). Every shape crossing the
 * network is validated strictly — unknown JSON is rejected, never coerced.
 * No tokens, no provider SDK types, no fabricated proofs: evidence shown
 * here is exactly what the server evaluated.
 */

export type Provenance = "live" | "demo" | "mixed" | "none";
export type ConditionStatus = "verified" | "missing" | "stale" | "conflicting";
export type HandoffState = "ready" | "preliminary" | "blocked";

export interface SourceRef {
  kind: string;
  locator: string;
  label?: string;
  fictional?: boolean;
}

export interface ConditionResult {
  kind: string;
  required: boolean;
  status: ConditionStatus;
  detail: string;
  evidence: SourceRef[];
  waived: boolean;
}

export interface ReadinessBinding {
  businessId: string;
  bookingId: string;
  proposalVersion: number;
  proposalFingerprint: string;
}

export interface ReadinessDecision {
  binding: ReadinessBinding;
  evaluatedAt: string;
  conditions: ConditionResult[];
  ready: boolean;
  liveReady: boolean;
  provenance: Provenance;
  blockedBy: string[];
  ignoredRawSignals: number;
  rejectedEvidence: string[];
}

export interface ReadinessResponse {
  demo: boolean;
  booking: BookingLite;
  binding: ReadinessBinding;
  decision: ReadinessDecision;
}

export interface BookingLite {
  id: string;
  businessId: string;
  status: string;
  eventName: string;
  startAt?: string;
  endAt?: string;
  guestCount?: number;
}

export interface HandoffEvent {
  name: string;
  startAt?: string;
  endAt?: string;
  guestCount?: number;
}

export interface HandoffService {
  name: string;
  detail?: string;
  source: SourceRef[];
}

export interface HandoffResponsibility {
  party: string;
  task: string;
  source: SourceRef[];
}

export interface HandoffResource {
  resourceId: string;
  status: ConditionStatus;
  responsible?: string;
  source: SourceRef[];
}

export interface OperationalHandoff {
  binding: ReadinessBinding;
  provenance: Provenance;
  event: HandoffEvent;
  services: HandoffService[];
  responsibilities: HandoffResponsibility[];
  resources: HandoffResource[];
  outstanding: string[];
  ready: boolean;
}

export interface HandoffResponse {
  demo: boolean;
  booking: BookingLite;
  revision: number | null;
  state: HandoffState;
  reason?: string;
  handoff: OperationalHandoff | null;
}

export interface ConfirmResponse {
  demo: boolean;
  command: { confirmKey: string; status: "confirmed" | "blocked" | "failed" };
  booking: BookingLite;
  decision: ReadinessDecision | null;
  confirmedBooking: boolean;
  note: string;
}

export interface StepReceipt {
  id: string;
  step: "hold" | "email";
  status: string;
  startedAt: string;
  completedAt?: string;
  error?: string;
}

export interface ProposalIdentity {
  proposedActionId: string;
  proposalVersion: number;
  proposalFingerprint: string;
  kind: string;
}

export interface ApiError {
  code: string;
  message: string;
  retryable: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optStr(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

const STATUSES: readonly string[] = ["verified", "missing", "stale", "conflicting"];
const PROVENANCE: readonly string[] = ["live", "demo", "mixed", "none"];

function parseSourceRef(value: unknown): SourceRef | undefined {
  if (!isRecord(value)) return undefined;
  const kind = str(value.kind);
  const locator = str(value.locator);
  if (!kind || !locator) return undefined;
  return {
    kind,
    locator,
    ...(optStr(value.label) === undefined ? {} : { label: optStr(value.label) as string }),
    ...(value.fictional === true ? { fictional: true as const } : {}),
  };
}

function parseSources(value: unknown): SourceRef[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: SourceRef[] = [];
  for (const item of value) {
    const ref = parseSourceRef(item);
    if (!ref) return undefined;
    out.push(ref);
  }
  return out;
}

function parseCondition(value: unknown): ConditionResult | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.status !== "string" || !STATUSES.includes(value.status)) return undefined;
  const kind = str(value.kind);
  const required = bool(value.required);
  const detail = str(value.detail);
  const evidence = parseSources(value.evidence);
  const waived = bool(value.waived);
  if (!kind || required === undefined || !detail || !evidence || waived === undefined) return undefined;
  return { kind, required, status: value.status as ConditionStatus, detail, evidence, waived };
}

function parseBinding(value: unknown): ReadinessBinding | undefined {
  if (!isRecord(value)) return undefined;
  const businessId = str(value.businessId);
  const bookingId = str(value.bookingId);
  const proposalVersion = num(value.proposalVersion);
  const proposalFingerprint = str(value.proposalFingerprint);
  if (!businessId || !bookingId || proposalVersion === undefined || !proposalFingerprint) return undefined;
  return { businessId, bookingId, proposalVersion, proposalFingerprint };
}

function parseDecision(value: unknown): ReadinessDecision | undefined {
  if (!isRecord(value)) return undefined;
  const binding = parseBinding(value.binding);
  const evaluatedAt = str(value.evaluatedAt);
  if (!binding || !evaluatedAt || !Array.isArray(value.conditions)) return undefined;
  const conditions: ConditionResult[] = [];
  for (const item of value.conditions) {
    const condition = parseCondition(item);
    if (!condition) return undefined;
    conditions.push(condition);
  }
  const ready = bool(value.ready);
  const liveReady = bool(value.liveReady);
  if (ready === undefined || liveReady === undefined) return undefined;
  if (typeof value.provenance !== "string" || !PROVENANCE.includes(value.provenance)) return undefined;
  if (!Array.isArray(value.blockedBy) || !value.blockedBy.every((b) => typeof b === "string")) return undefined;
  if (!Array.isArray(value.rejectedEvidence) || !value.rejectedEvidence.every((b) => typeof b === "string")) return undefined;
  const ignored = num(value.ignoredRawSignals);
  if (ignored === undefined) return undefined;
  return {
    binding, evaluatedAt, conditions, ready, liveReady,
    provenance: value.provenance as Provenance,
    blockedBy: value.blockedBy as string[],
    ignoredRawSignals: ignored,
    rejectedEvidence: value.rejectedEvidence as string[],
  };
}

function parseBooking(value: unknown): BookingLite | undefined {
  if (!isRecord(value)) return undefined;
  const id = str(value.id);
  const businessId = str(value.businessId);
  const status = str(value.status);
  const eventName = str(value.eventName);
  if (!id || !businessId || !status || !eventName) return undefined;
  return {
    id, businessId, status, eventName,
    ...(optStr(value.startAt) === undefined ? {} : { startAt: value.startAt as string }),
    ...(optStr(value.endAt) === undefined ? {} : { endAt: value.endAt as string }),
    ...(num(value.guestCount) === undefined ? {} : { guestCount: value.guestCount as number }),
  };
}

/** Strict parse of GET readiness. Returns undefined on any shape violation. */
export function parseReadinessResponse(value: unknown): ReadinessResponse | undefined {
  if (!isRecord(value)) return undefined;
  const demo = bool(value.demo);
  const booking = parseBooking(value.booking);
  const binding = parseBinding(value.binding);
  const decision = parseDecision(value.decision);
  if (demo === undefined || !booking || !binding || !decision) return undefined;
  return { demo, booking, binding, decision };
}

function parseHandoff(value: unknown): OperationalHandoff | undefined {
  if (!isRecord(value)) return undefined;
  const binding = parseBinding(value.binding);
  if (!binding) return undefined;
  if (typeof value.provenance !== "string" || !PROVENANCE.includes(value.provenance)) return undefined;
  if (!isRecord(value.event) || !str(value.event.name)) return undefined;
  if (!Array.isArray(value.services) || !Array.isArray(value.responsibilities) || !Array.isArray(value.resources)) return undefined;
  if (!Array.isArray(value.outstanding) || !value.outstanding.every((o) => typeof o === "string")) return undefined;
  const ready = bool(value.ready);
  if (ready === undefined) return undefined;
  return value as unknown as OperationalHandoff;
}

/** Strict parse of GET/POST handoff. Extra server fields are ignored, never required. */
export function parseHandoffResponse(value: unknown): HandoffResponse | undefined {
  if (!isRecord(value)) return undefined;
  const demo = bool(value.demo);
  const booking = parseBooking(value.booking);
  if (demo === undefined || !booking) return undefined;
  const revision = value.revision === null ? null : num(value.revision);
  if (revision === undefined) return undefined;
  if (value.state !== "ready" && value.state !== "preliminary" && value.state !== "blocked") return undefined;
  const handoff = value.handoff === null ? null : parseHandoff(value.handoff);
  if (handoff === undefined) return undefined;
  return {
    demo, booking, revision, state: value.state,
    ...(optStr(value.reason) === undefined ? {} : { reason: value.reason as string }),
    handoff,
  };
}

/** Strict parse of POST confirm. */
export function parseConfirmResponse(value: unknown): ConfirmResponse | undefined {
  if (!isRecord(value)) return undefined;
  const demo = bool(value.demo);
  const booking = parseBooking(value.booking);
  const confirmedBooking = bool(value.confirmedBooking);
  const note = str(value.note);
  if (demo === undefined || !booking || confirmedBooking === undefined || !note) return undefined;
  if (!isRecord(value.command) || !str(value.command.confirmKey)) return undefined;
  const status = value.command.status;
  if (status !== "confirmed" && status !== "blocked" && status !== "failed") return undefined;
  const decision = value.decision === null ? null : parseDecision(value.decision);
  if (decision === undefined) return undefined;
  return {
    demo, booking, confirmedBooking, note,
    command: { confirmKey: value.command.confirmKey as string, status },
    decision,
  };
}

/** Strict parse of a server error body. */
export function parseApiError(value: unknown, httpStatus: number): ApiError {
  if (isRecord(value)) {
    return {
      code: str(value.code) ?? `HTTP_${httpStatus}`,
      message: str(value.message) ?? "The request did not complete.",
      retryable: value.retryable === true,
    };
  }
  return { code: `HTTP_${httpStatus}`, message: "The request did not complete.", retryable: false };
}
