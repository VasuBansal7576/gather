/**
 * Owner knowledge-review client boundary types (PRD G03/G06/G14).
 *
 * Shapes mirror the knowledge API responses (read, never imported: this
 * client package validates everything crossing the network boundary).
 * Unknown JSON is rejected — no `any`, no silent coercion.
 *
 * Confidence is displayed exactly as stored (`probable` / `uncertain`):
 * extraction labels are never converted into calibrated probabilities.
 */

export type CandidateConfidence = "probable" | "uncertain";

export type CandidateStatus = "pending" | "confirmed" | "rejected" | "stale";

export type FactScope = "global" | "booking" | "customer";

export type DecisionKind = "confirm" | "correct" | "reject" | "exception";

export interface KnowledgeBusiness {
  id: string;
  name: string;
  timezone: string;
}

export interface KnowledgeSourceReference {
  kind: string;
  locator: string;
  label?: string;
  fictional?: boolean;
}

export interface KnowledgeCandidate {
  id: string;
  businessId: string;
  key: string;
  subjectId: string;
  value: Record<string, unknown>;
  confidence: CandidateConfidence;
  sourceReferences: KnowledgeSourceReference[];
  sourceRevision?: string;
  observedAt: string;
  ingestedAt: string;
  status: CandidateStatus;
  confirmedFactId?: string;
  note?: string;
  conflictsWith: string[];
}

export interface KnowledgeFact {
  id: string;
  businessId: string;
  key: string;
  value: Record<string, unknown>;
  confidence: string;
  sourceReferences: KnowledgeSourceReference[];
  observedAt: string;
}

export interface WithheldFact {
  factId: string;
  key: string;
  subjectId: string;
  reason: string;
}

export interface KnowledgeSnapshot {
  businessId: string;
  timezone: string;
  generatedAt: string;
  facts: KnowledgeFact[];
  reviewFactIds: string[];
  withheld: WithheldFact[];
  scopedFactCount: number;
}

export interface DeploymentMode {
  kind: "demo";
  label: string;
  fictional: boolean;
  simulated: boolean;
}

export interface CandidatesResponse {
  mode: DeploymentMode;
  candidates: KnowledgeCandidate[];
}

export interface SnapshotResponse {
  mode: DeploymentMode;
  snapshot: KnowledgeSnapshot;
}

export interface DecisionResponse {
  mode: DeploymentMode;
  kind: DecisionKind;
  result: Record<string, unknown>;
}

/** Active confirmed fact with versioning/scope metadata (facts read). */
export interface KnowledgeConfirmedFact extends KnowledgeFact {
  revision: number;
  subjectId: string;
  scope: string;
  scopeId?: string;
  reviewState: "none" | "review";
}

export interface FactsResponse {
  mode: DeploymentMode;
  facts: KnowledgeConfirmedFact[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function parseSource(value: unknown): KnowledgeSourceReference | undefined {
  if (!isRecord(value)) return undefined;
  const kind = nonEmptyString(value.kind);
  const locator = nonEmptyString(value.locator);
  if (!kind || !locator) return undefined;
  const out: KnowledgeSourceReference = { kind, locator };
  if (typeof value.label === "string") out.label = value.label;
  if (typeof value.fictional === "boolean") out.fictional = value.fictional;
  return out;
}

function parseSources(value: unknown): KnowledgeSourceReference[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const out: KnowledgeSourceReference[] = [];
  for (const entry of value) {
    const parsed = parseSource(entry);
    if (!parsed) return undefined;
    out.push(parsed);
  }
  return out;
}

const CONFIDENCES: readonly string[] = ["probable", "uncertain"];
const STATUSES: readonly string[] = ["pending", "confirmed", "rejected", "stale"];

export function parseCandidate(value: unknown): KnowledgeCandidate | undefined {
  if (!isRecord(value)) return undefined;
  const id = nonEmptyString(value.id);
  const businessId = nonEmptyString(value.businessId);
  const key = nonEmptyString(value.key);
  if (!id || !businessId || !key) return undefined;
  if (!isRecord(value.value)) return undefined;
  if (typeof value.confidence !== "string" || !CONFIDENCES.includes(value.confidence)) return undefined;
  if (typeof value.status !== "string" || !STATUSES.includes(value.status)) return undefined;
  const sourceReferences = parseSources(value.sourceReferences);
  if (!sourceReferences) return undefined;
  const observedAt = nonEmptyString(value.observedAt);
  const ingestedAt = nonEmptyString(value.ingestedAt);
  if (!observedAt || !ingestedAt) return undefined;
  const conflictsWith = Array.isArray(value.conflictsWith)
    ? value.conflictsWith.filter((entry): entry is string => typeof entry === "string")
    : [];
  return {
    id,
    businessId,
    key,
    subjectId: typeof value.subjectId === "string" ? value.subjectId : "",
    value: value.value,
    confidence: value.confidence as CandidateConfidence,
    sourceReferences,
    ...(typeof value.sourceRevision === "string" ? { sourceRevision: value.sourceRevision } : {}),
    observedAt,
    ingestedAt,
    status: value.status as CandidateStatus,
    ...(typeof value.confirmedFactId === "string" ? { confirmedFactId: value.confirmedFactId } : {}),
    ...(typeof value.note === "string" ? { note: value.note } : {}),
    conflictsWith,
  };
}

export function parseCandidatesResponse(value: unknown): CandidatesResponse | undefined {
  if (!isRecord(value)) return undefined;
  const mode = parseMode(value.mode);
  if (!mode || !Array.isArray(value.candidates)) return undefined;
  const candidates: KnowledgeCandidate[] = [];
  for (const entry of value.candidates) {
    const parsed = parseCandidate(entry);
    if (!parsed) return undefined;
    candidates.push(parsed);
  }
  return { mode, candidates };
}

function parseFact(value: unknown): KnowledgeFact | undefined {
  if (!isRecord(value)) return undefined;
  const id = nonEmptyString(value.id);
  const businessId = nonEmptyString(value.businessId);
  const key = nonEmptyString(value.key);
  if (!id || !businessId || !key) return undefined;
  if (!isRecord(value.value)) return undefined;
  if (typeof value.confidence !== "string") return undefined;
  const sourceReferences = parseSources(value.sourceReferences);
  if (!sourceReferences) return undefined;
  const observedAt = nonEmptyString(value.observedAt);
  if (!observedAt) return undefined;
  return { id, businessId, key, value: value.value, confidence: value.confidence, sourceReferences, observedAt };
}

function parseWithheld(value: unknown): WithheldFact | undefined {
  if (!isRecord(value)) return undefined;
  const factId = nonEmptyString(value.factId);
  const key = nonEmptyString(value.key);
  const subjectId = typeof value.subjectId === "string" ? value.subjectId : undefined;
  const reason = nonEmptyString(value.reason);
  if (!factId || !key || subjectId === undefined || !reason) return undefined;
  return { factId, key, subjectId, reason };
}

export function parseSnapshotResponse(value: unknown): SnapshotResponse | undefined {
  if (!isRecord(value)) return undefined;
  const mode = parseMode(value.mode);
  if (!mode || !isRecord(value.snapshot)) return undefined;
  const raw = value.snapshot;
  const businessId = nonEmptyString(raw.businessId);
  const timezone = nonEmptyString(raw.timezone);
  const generatedAt = nonEmptyString(raw.generatedAt);
  if (!businessId || !timezone || !generatedAt) return undefined;
  if (!Array.isArray(raw.facts) || !Array.isArray(raw.withheld)) return undefined;
  const facts: KnowledgeFact[] = [];
  for (const entry of raw.facts) {
    const parsed = parseFact(entry);
    if (!parsed) return undefined;
    facts.push(parsed);
  }
  const withheld: WithheldFact[] = [];
  for (const entry of raw.withheld) {
    const parsed = parseWithheld(entry);
    if (!parsed) return undefined;
    withheld.push(parsed);
  }
  const reviewFactIds = Array.isArray(raw.reviewFactIds)
    ? raw.reviewFactIds.filter((entry): entry is string => typeof entry === "string")
    : [];
  return {
    mode,
    snapshot: {
      businessId,
      timezone,
      generatedAt,
      facts,
      reviewFactIds,
      withheld,
      scopedFactCount: typeof raw.scopedFactCount === "number" ? raw.scopedFactCount : 0,
    },
  };
}

const DECISION_KINDS: readonly string[] = ["confirm", "correct", "reject", "exception"];

export function parseDecisionResponse(value: unknown): DecisionResponse | undefined {
  if (!isRecord(value)) return undefined;
  const mode = parseMode(value.mode);
  if (!mode) return undefined;
  if (typeof value.kind !== "string" || !DECISION_KINDS.includes(value.kind)) return undefined;
  if (!isRecord(value.result)) return undefined;
  return { mode, kind: value.kind as DecisionKind, result: value.result };
}

export function parseConfirmedFact(value: unknown): KnowledgeConfirmedFact | undefined {
  const base = parseFact(value);
  if (!base || !isRecord(value)) return undefined;
  if (typeof value.revision !== "number" || !Number.isInteger(value.revision) || value.revision < 1) return undefined;
  if (typeof value.subjectId !== "string") return undefined;
  if (typeof value.scope !== "string") return undefined;
  if (value.reviewState !== "none" && value.reviewState !== "review") return undefined;
  return {
    ...base,
    revision: value.revision,
    subjectId: value.subjectId,
    scope: value.scope,
    ...(typeof value.scopeId === "string" ? { scopeId: value.scopeId } : {}),
    reviewState: value.reviewState,
  };
}

export function parseFactsResponse(value: unknown): FactsResponse | undefined {
  if (!isRecord(value)) return undefined;
  const mode = parseMode(value.mode);
  if (!mode || !Array.isArray(value.facts)) return undefined;
  const facts: KnowledgeConfirmedFact[] = [];
  for (const entry of value.facts) {
    const parsed = parseConfirmedFact(entry);
    if (!parsed) return undefined;
    facts.push(parsed);
  }
  return { mode, facts };
}

function parseMode(value: unknown): DeploymentMode | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind !== "demo") return undefined;
  if (typeof value.label !== "string") return undefined;
  if (typeof value.fictional !== "boolean" || typeof value.simulated !== "boolean") return undefined;
  return { kind: "demo", label: value.label, fictional: value.fictional, simulated: value.simulated };
}

export function parseBusiness(value: unknown): KnowledgeBusiness | undefined {
  if (!isRecord(value)) return undefined;
  const id = nonEmptyString(value.id);
  const name = nonEmptyString(value.name);
  const timezone = nonEmptyString(value.timezone);
  if (!id || !name || !timezone) return undefined;
  return { id, name, timezone };
}

export function parseSetupBusinesses(value: unknown): KnowledgeBusiness[] | undefined {
  if (!isRecord(value)) return undefined;
  const raw = value.businesses;
  if (!Array.isArray(raw)) return undefined;
  const out: KnowledgeBusiness[] = [];
  for (const entry of raw) {
    const parsed = parseBusiness(entry);
    if (!parsed) return undefined;
    out.push(parsed);
  }
  return out;
}
