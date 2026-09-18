import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  Business,
  BusinessFact,
  ProposedAction,
  SourceReference,
} from "../domain/contracts.ts";
import type {
  KnowledgePort,
  KnowledgeQueryScope,
} from "./port.ts";
import type {
  CandidateView,
  ConfirmResult,
  DecisionCommand,
} from "./service.ts";
import { KnowledgeError, KnowledgeService } from "./service.ts";
import type { ConfirmedFact, KnowledgeActor } from "./types.ts";

/**
 * ADR-005 owner review consumer over the ADR-008 KnowledgePort.
 *
 * This module programs against the port/service interfaces only — it never
 * reimplements storage, changes the adapter contract, or mints authority.
 * Every mutation still flows through KnowledgeService owner decisions, so
 * content/model actors can never confirm, and every command stays
 * idempotent via commandId.
 *
 * Covered flows:
 * - candidate inspection with current/historical/missing distinction,
 * - batch confirmation of an inspected document's parsed claims,
 * - no-facts vs unavailable/stale availability states,
 * - correction events to affected pending work (accepted snapshots stay
 *   immutable; scoped exceptions are never auto-promoted).
 */

/** Minimal structural store surface this module needs. GatherStore satisfies it. */
export interface ReviewStorePort {
  readonly db: DatabaseSync;
  getBusiness(id: string): Business;
  getBooking(id: string): { id: string; businessId: string };
  listAllProposedActions(): ProposedAction[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function now(): string {
  return new Date().toISOString();
}

// ---------- candidate inspection ----------

export interface InspectedCandidate extends CandidateView {
  /** Human-readable source label for the primary reference. */
  sourceLabel: string;
  /** The live confirmed fact this candidate would supersede/confirm, when any. */
  currentFact: ConfirmedFact | null;
}

export interface SourceInspection {
  businessId: string;
  sourceLocator: string;
  /** Pending candidates attributable to this source. */
  candidates: InspectedCandidate[];
  /** Currently active confirmed facts for the candidate keys (current state). */
  current: ConfirmedFact[];
  /** Fact keys with candidates but no confirmed fact yet (missing information). */
  missingKeys: string[];
  /** Provenance label of the read path (never silently live). */
  provenance: string;
}

/**
 * Inspect one document's parsed claims: pending candidates with sources and
 * uncertainty, the current confirmed counterpart for each, and keys that
 * have no confirmed fact at all. Historical revisions stay readable via
 * listFacts/listDecisions on the service; this view never rewrites them.
 */
export function inspectSourceClaims(
  service: KnowledgeService,
  input: { businessId: string; sourceLocator: string; provenance?: string },
): SourceInspection {
  const all = service.listCandidates(input.businessId);
  const pending = all.filter(
    (candidate) =>
      candidate.status === "pending" &&
      candidate.sourceReferences.some((ref) => ref.locator === input.sourceLocator),
  );
  const facts = service.listFacts(input.businessId);
  const candidates: InspectedCandidate[] = pending.map((candidate) => {
    const currentFact =
      facts.find(
        (fact) => fact.key === candidate.key && fact.subjectId === candidate.subjectId,
      ) ?? null;
    const primary: SourceReference | undefined = candidate.sourceReferences[0];
    return {
      ...candidate,
      sourceLabel:
        (primary?.label ?? primary?.locator ?? input.sourceLocator) as string,
      currentFact,
    };
  });
  const confirmedKeys = new Set(facts.map((fact) => `${fact.key}/${fact.subjectId}`));
  const missingKeys = [
    ...new Set(
      candidates
        .filter((candidate) => !confirmedKeys.has(`${candidate.key}/${candidate.subjectId}`))
        .map((candidate) => candidate.key),
    ),
  ];
  return {
    businessId: input.businessId,
    sourceLocator: input.sourceLocator,
    candidates,
    current: facts,
    missingKeys,
    provenance: input.provenance ?? "prepared",
  };
}

// ---------- batch confirmation ----------

export interface BatchConfirmInput {
  businessId: string;
  actor: KnowledgeActor;
  /** Candidate ids the owner inspected (from inspectSourceClaims). */
  candidateIds: string[];
  /** Optional idempotency prefix; each id gets `${prefix}:${candidateId}`. */
  commandPrefix?: string;
}

export interface BatchConfirmResult {
  confirmed: Array<{ candidateId: string; result: ConfirmResult }>;
  failed: Array<{ candidateId: string; code: string; message: string }>;
}

/**
 * Batch-confirm inspected candidates. Each candidate confirms independently
 * through the owner-only service path: one failure never blocks the rest,
 * and every confirm carries its own idempotency key so retries are safe.
 * Non-owner actors confirm nothing — each item fails as denied.
 */
export function batchConfirmCandidates(
  service: KnowledgeService,
  input: BatchConfirmInput,
): BatchConfirmResult {
  const confirmed: BatchConfirmResult["confirmed"] = [];
  const failed: BatchConfirmResult["failed"] = [];
  for (const candidateId of input.candidateIds) {
    const command: DecisionCommand & { candidateId: string } = {
      businessId: input.businessId,
      actor: input.actor,
      candidateId,
      ...(input.commandPrefix === undefined
        ? {}
        : { commandId: `${input.commandPrefix}:${candidateId}` }),
    };
    try {
      const result = service.confirmCandidate(command);
      confirmed.push({ candidateId, result });
    } catch (error) {
      const code = error instanceof KnowledgeError ? error.code : "unknown";
      failed.push({
        candidateId,
        code,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { confirmed, failed };
}

// ---------- availability states ----------

export type KnowledgeAvailability =
  | { status: "ready"; factCount: number; provenance: string }
  | { status: "no-facts"; detail: string; provenance: string }
  | { status: "unavailable"; detail: string; provenance: string }
  | {
      status: "stale";
      detail: string;
      provenance: string;
      blockReasons: string[];
      withheldCount: number;
    };

/**
 * Honest availability split (C04/C10): an unavailable port is never reported
 * as "no facts", and review-state/conflicted facts are reported as stale
 * with explicit reasons rather than silently dropped or served.
 */
export function describeAvailability(
  port: KnowledgePort,
  scope: KnowledgeQueryScope,
): KnowledgeAvailability {
  const health = port.health();
  if (!health.available) {
    return {
      status: "unavailable",
      detail: `Knowledge is unavailable, not empty: ${health.detail}`,
      provenance: health.provenance,
    };
  }
  const result = port.query(scope);
  if (result.blocked) {
    return {
      status: "stale",
      detail:
        "Some knowledge is stale or conflicted and withheld from consequential use; reconfirm before authorizing.",
      provenance: health.provenance,
      blockReasons: result.blockReasons,
      withheldCount: result.withheld.length,
    };
  }
  if (result.facts.length === 0) {
    return {
      status: "no-facts",
      detail: "No business information found yet for this scope.",
      provenance: health.provenance,
    };
  }
  return { status: "ready", factCount: result.facts.length, provenance: health.provenance };
}

// ---------- correction events to affected pending work ----------

export interface CorrectionEventInput {
  businessId: string;
  /** Owner identity that made the correction (audit only). */
  actor: KnowledgeActor;
  key: string;
  subjectId?: string;
  /** Active revision after the correction (for the event record). */
  revision: number;
}

export interface CorrectionEvent {
  id: string;
  businessId: string;
  key: string;
  subjectId: string;
  revision: number;
  createdBy: string;
  createdAt: string;
  /** Pending-approval proposals that must rebuild/re-verify before proceeding. */
  affectedProposalIds: string[];
  /** Approved/superseded proposals left untouched (accepted snapshots immutable). */
  retainedProposalIds: string[];
  note: string;
}

export interface CorrectAndPublishInput extends Omit<CorrectionEventInput, "revision"> {
  expectedRevision: number;
  value: Record<string, unknown>;
  sourceReferences?: SourceReference[];
  commandId?: string;
}

export interface CorrectAndPublishResult {
  confirm: ConfirmResult;
  event: CorrectionEvent;
}

function ensureCorrectionEventsTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_correction_events (
      id TEXT PRIMARY KEY,
      business_id TEXT NOT NULL,
      key TEXT NOT NULL,
      subject_id TEXT NOT NULL DEFAULT '',
      revision INTEGER NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      affected_proposal_ids_json TEXT NOT NULL,
      retained_proposal_ids_json TEXT NOT NULL,
      note TEXT NOT NULL
    );
  `);
}

/** Durable read of published correction events (audit/UX, never authority). */
export function listCorrectionEvents(
  store: ReviewStorePort,
  businessId: string,
): CorrectionEvent[] {
  ensureCorrectionEventsTable(store.db);
  const rows = store.db
    .prepare(
      "SELECT * FROM knowledge_correction_events WHERE business_id = $b ORDER BY created_at",
    )
    .all({ $b: businessId }) as Record<string, unknown>[];
  return rows.map((item) => ({
    id: String(item.id),
    businessId: String(item.business_id),
    key: String(item.key),
    subjectId: String(item.subject_id ?? ""),
    revision: Number(item.revision),
    createdBy: String(item.created_by),
    createdAt: String(item.created_at),
    affectedProposalIds: JSON.parse(String(item.affected_proposal_ids_json)) as string[],
    retainedProposalIds: JSON.parse(String(item.retained_proposal_ids_json)) as string[],
    note: String(item.note),
  }));
}

/**
 * Partition this business's proposals around a correction: pending-approval
 * proposals are flagged affected (they must rebuild and re-verify — the
 * persist path already aborts on stale revisions), while approved and
 * superseded proposals are retained untouched. Accepted commercial snapshots
 * are immutable: this function never edits, deletes, or re-prices a
 * proposal, and it never creates or promotes a scoped exception.
 */
export function publishCorrectionEvent(
  store: ReviewStorePort,
  input: CorrectionEventInput,
): CorrectionEvent {
  ensureCorrectionEventsTable(store.db);
  const subjectId = input.subjectId ?? "";
  const affectedProposalIds: string[] = [];
  const retainedProposalIds: string[] = [];
  for (const action of store.listAllProposedActions()) {
    let bookingBusiness: string | null = null;
    try {
      bookingBusiness = store.getBooking(action.bookingId).businessId;
    } catch {
      continue;
    }
    if (bookingBusiness !== input.businessId) continue;
    if (action.status === "pending_approval") affectedProposalIds.push(action.id);
    else retainedProposalIds.push(action.id);
  }
  const event: CorrectionEvent = {
    id: `kce_${randomUUID()}`,
    businessId: input.businessId,
    key: input.key,
    subjectId,
    revision: input.revision,
    createdBy: input.actor.id,
    createdAt: now(),
    affectedProposalIds,
    retainedProposalIds,
    note:
      `Changed ${input.key}/${subjectId || "(global)"} at revision ${input.revision} ` +
      `invalidates affected pending proposals; they must rebuild and re-verify before ` +
      `proceeding. Accepted snapshots are retained unchanged. No exception was promoted.`,
  };
  store.db
    .prepare(
      `INSERT INTO knowledge_correction_events
        (id, business_id, key, subject_id, revision, created_by, created_at,
         affected_proposal_ids_json, retained_proposal_ids_json, note)
       VALUES ($id, $b, $key, $subject, $revision, $by, $at, $affected, $retained, $note)`,
    )
    .run({
      $id: event.id,
      $b: event.businessId,
      $key: event.key,
      $subject: event.subjectId,
      $revision: event.revision,
      $by: event.createdBy,
      $at: event.createdAt,
      $affected: JSON.stringify(event.affectedProposalIds),
      $retained: JSON.stringify(event.retainedProposalIds),
      $note: event.note,
    });
  return event;
}

/**
 * Owner correction plus affected-pending-work event in one call. The
 * correction itself is the versioned service decision (stale expected
 * revisions reject; commandId replays are idempotent); the event only ever
 * flags pending proposals and retains accepted ones.
 */
export function correctAndPublish(
  service: KnowledgeService,
  store: ReviewStorePort,
  input: CorrectAndPublishInput,
): CorrectAndPublishResult {
  if (!isRecord(input.value)) {
    throw new KnowledgeError("invalid", "corrected value must be an object");
  }
  const confirm = service.correctFact({
    businessId: input.businessId,
    actor: input.actor,
    key: input.key,
    ...(input.subjectId === undefined ? {} : { subjectId: input.subjectId }),
    expectedRevision: input.expectedRevision,
    value: input.value,
    ...(input.sourceReferences === undefined ? {} : { sourceReferences: input.sourceReferences }),
    ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
  });
  const event = publishCorrectionEvent(store, {
    businessId: input.businessId,
    actor: input.actor,
    key: input.key,
    ...(input.subjectId === undefined ? {} : { subjectId: input.subjectId }),
    revision: confirm.revision.revision,
  });
  return { confirm, event };
}

export type { BusinessFact, ConfirmedFact, KnowledgeActor };
