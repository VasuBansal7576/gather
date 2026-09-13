import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { proposalFingerprint } from "../domain/proposals.ts";
import type {
  ActionExecution,
  ActionExecutionStatus,
  ActionKind,
  ActionOutcome,
  Approval,
  Booking,
  Business,
  BusinessFact,
  ProposedAction,
  SourceReference,
} from "../domain/contracts.ts";

type SqlRow = Record<string, unknown>;

function row<T extends SqlRow>(value: unknown): T {
  if (!value || typeof value !== "object") throw new Error("Expected a SQLite row");
  return value as T;
}

function now(): string {
  return new Date().toISOString();
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  return JSON.parse(value) as T;
}

function ensureParent(path: string): void {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
}

export interface ProposedActionInput {
  id?: string;
  bookingId: string;
  kind: ActionKind;
  payload: Record<string, unknown>;
  sourceReferences: SourceReference[];
}

export interface BookingInput {
  id?: string;
  businessId: string;
  eventName: string;
  status?: Booking["status"];
  startAt?: string;
  endAt?: string;
  guestCount?: number;
  notes?: string;
  sourceReferences?: SourceReference[];
}

/**
 * Small local persistence boundary using Node's built-in synchronous SQLite API.
 * It deliberately stays server-only and has no credentials or external side effects.
 */
export class GatherStore {
  readonly db: DatabaseSync;

  constructor(path = process.env.GATHER_DATABASE_PATH ?? "data/gather.sqlite") {
    ensureParent(path);
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS businesses (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        timezone TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'paused')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bookings (
        id TEXT PRIMARY KEY,
        business_id TEXT NOT NULL REFERENCES businesses(id),
        status TEXT NOT NULL,
        event_name TEXT NOT NULL,
        start_at TEXT,
        end_at TEXT,
        guest_count INTEGER,
        notes TEXT,
        source_references_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS business_facts (
        id TEXT PRIMARY KEY,
        business_id TEXT NOT NULL REFERENCES businesses(id),
        key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        confidence TEXT NOT NULL,
        source_references_json TEXT NOT NULL,
        observed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS proposed_actions (
        id TEXT PRIMARY KEY,
        booking_id TEXT NOT NULL REFERENCES bookings(id),
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        proposal_version INTEGER NOT NULL,
        proposal_fingerprint TEXT NOT NULL,
        source_references_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        proposed_action_id TEXT NOT NULL REFERENCES proposed_actions(id),
        proposal_version INTEGER NOT NULL,
        proposal_fingerprint TEXT NOT NULL,
        approved_by TEXT NOT NULL,
        status TEXT NOT NULL,
        approved_at TEXT NOT NULL,
        invalidated_at TEXT,
        reason TEXT
      );
      CREATE TABLE IF NOT EXISTS action_executions (
        id TEXT PRIMARY KEY,
        proposed_action_id TEXT NOT NULL REFERENCES proposed_actions(id),
        proposal_version INTEGER NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        attempt INTEGER NOT NULL,
        status TEXT NOT NULL,
        result_json TEXT,
        error TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        reconciled_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_approvals_action ON approvals(proposed_action_id);
      CREATE INDEX IF NOT EXISTS idx_executions_action_version ON action_executions(proposed_action_id, proposal_version);
    `);
  }

  close(): void {
    this.db.close();
  }

  createBusiness(input: Pick<Business, "name" | "timezone"> & { id?: string }): Business {
    const id = input.id ?? randomUUID();
    const timestamp = now();
    this.db.prepare(`INSERT INTO businesses (id, name, timezone, status, created_at, updated_at)
      VALUES ($id, $name, $timezone, 'active', $timestamp, $timestamp)`).run({
      $id: id, $name: input.name, $timezone: input.timezone, $timestamp: timestamp,
    });
    return { id, name: input.name, timezone: input.timezone, status: "active", createdAt: timestamp, updatedAt: timestamp };
  }

  createBooking(input: BookingInput): Booking {
    const id = input.id ?? randomUUID();
    const timestamp = now();
    const refs = input.sourceReferences ?? [];
    this.db.prepare(`INSERT INTO bookings
      (id, business_id, status, event_name, start_at, end_at, guest_count, notes, source_references_json, created_at, updated_at)
      VALUES ($id, $businessId, $status, $eventName, $startAt, $endAt, $guestCount, $notes, $refs, $createdAt, $updatedAt)`).run({
      $id: id, $businessId: input.businessId, $status: input.status ?? "inquiry", $eventName: input.eventName,
      $startAt: input.startAt ?? null, $endAt: input.endAt ?? null, $guestCount: input.guestCount ?? null,
      $notes: input.notes ?? null, $refs: JSON.stringify(refs), $createdAt: timestamp, $updatedAt: timestamp,
    });
    return { id, businessId: input.businessId, status: input.status ?? "inquiry", eventName: input.eventName,
      startAt: input.startAt, endAt: input.endAt, guestCount: input.guestCount, notes: input.notes,
      sourceReferences: refs, createdAt: timestamp, updatedAt: timestamp };
  }

  addBusinessFact(input: Omit<BusinessFact, "id" | "observedAt"> & { id?: string; observedAt?: string }): BusinessFact {
    const id = input.id ?? randomUUID();
    const observedAt = input.observedAt ?? now();
    this.db.prepare(`INSERT INTO business_facts
      (id, business_id, key, value_json, confidence, source_references_json, observed_at)
      VALUES ($id, $businessId, $key, $value, $confidence, $refs, $observedAt)`).run({
      $id: id, $businessId: input.businessId, $key: input.key, $value: JSON.stringify(input.value),
      $confidence: input.confidence, $refs: JSON.stringify(input.sourceReferences), $observedAt: observedAt,
    });
    return { ...input, id, observedAt };
  }

  createProposedAction(input: ProposedActionInput): ProposedAction {
    const id = input.id ?? randomUUID();
    const timestamp = now();
    const fingerprint = proposalFingerprint(input);
    this.db.prepare(`INSERT INTO proposed_actions
      (id, booking_id, kind, payload_json, proposal_version, proposal_fingerprint, source_references_json, status, created_at, updated_at)
      VALUES ($id, $bookingId, $kind, $payload, 1, $fingerprint, $refs, 'pending_approval', $timestamp, $timestamp)`).run({
      $id: id, $bookingId: input.bookingId, $kind: input.kind, $payload: JSON.stringify(input.payload),
      $fingerprint: fingerprint, $refs: JSON.stringify(input.sourceReferences), $timestamp: timestamp,
    });
    return this.getProposedAction(id);
  }

  replaceProposedAction(id: string, input: Omit<ProposedActionInput, "id" | "bookingId">): ProposedAction {
    const current = this.getProposedAction(id);
    const timestamp = now();
    const fingerprint = proposalFingerprint({ bookingId: current.bookingId, ...input });
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`UPDATE approvals SET status = 'invalidated', invalidated_at = $timestamp
        WHERE proposed_action_id = $id AND status = 'approved'`).run({ $timestamp: timestamp, $id: id });
      this.db.prepare(`UPDATE proposed_actions SET kind = $kind, payload_json = $payload,
        proposal_version = proposal_version + 1, proposal_fingerprint = $fingerprint,
        source_references_json = $refs, status = 'pending_approval', updated_at = $timestamp WHERE id = $id`).run({
        $kind: input.kind, $payload: JSON.stringify(input.payload), $fingerprint: fingerprint,
        $refs: JSON.stringify(input.sourceReferences), $timestamp: timestamp, $id: id,
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getProposedAction(id);
  }

  getProposedAction(id: string): ProposedAction {
    const found = this.db.prepare("SELECT * FROM proposed_actions WHERE id = $id").get({ $id: id });
    if (!found) throw new Error(`Proposed action not found: ${id}`);
    const value = row(found);
    return {
      id: String(value.id), bookingId: String(value.booking_id), kind: value.kind as ActionKind,
      payload: parseJson(value.payload_json, {}), proposalVersion: Number(value.proposal_version),
      proposalFingerprint: String(value.proposal_fingerprint), sourceReferences: parseJson(value.source_references_json, []),
      status: value.status as ProposedAction["status"], createdAt: String(value.created_at), updatedAt: String(value.updated_at),
    };
  }

  approveProposedAction(actionId: string, approvedBy: string, reason?: string): Approval {
    const action = this.getProposedAction(actionId);
    const existing = this.db.prepare(`SELECT * FROM approvals WHERE proposed_action_id = $actionId
      AND proposal_version = $version AND proposal_fingerprint = $fingerprint AND status = 'approved'
      ORDER BY approved_at DESC LIMIT 1`).get({ $actionId: actionId, $version: action.proposalVersion, $fingerprint: action.proposalFingerprint });
    if (existing) return this.getApproval(row(existing).id as string);
    const timestamp = now();
    const id = randomUUID();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`UPDATE approvals SET status = 'invalidated', invalidated_at = $timestamp
        WHERE proposed_action_id = $actionId AND status = 'approved'`).run({ $timestamp: timestamp, $actionId: actionId });
      this.db.prepare(`INSERT INTO approvals (id, proposed_action_id, proposal_version, proposal_fingerprint,
        approved_by, status, approved_at, reason) VALUES ($id, $actionId, $version, $fingerprint, $approvedBy, 'approved', $timestamp, $reason)`).run({
        $id: id, $actionId: actionId, $version: action.proposalVersion, $fingerprint: action.proposalFingerprint,
        $approvedBy: approvedBy, $timestamp: timestamp, $reason: reason ?? null,
      });
      this.db.prepare("UPDATE proposed_actions SET status = 'approved', updated_at = $timestamp WHERE id = $actionId").run({ $timestamp: timestamp, $actionId: actionId });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getApproval(id);
  }

  getApproval(id: string): Approval {
    const found = this.db.prepare("SELECT * FROM approvals WHERE id = $id").get({ $id: id });
    if (!found) throw new Error(`Approval not found: ${id}`);
    const value = row(found);
    return { id: String(value.id), proposedActionId: String(value.proposed_action_id), proposalVersion: Number(value.proposal_version),
      proposalFingerprint: String(value.proposal_fingerprint), approvedBy: String(value.approved_by), status: value.status as Approval["status"],
      approvedAt: String(value.approved_at), invalidatedAt: value.invalidated_at ? String(value.invalidated_at) : undefined,
      reason: value.reason ? String(value.reason) : undefined };
  }

  listApprovals(actionId: string): Approval[] {
    const rows = this.db.prepare("SELECT id FROM approvals WHERE proposed_action_id = $actionId ORDER BY approved_at").all({ $actionId: actionId });
    return rows.map((value) => this.getApproval(String(row(value).id)));
  }

  executeApprovedAction(actionId: string, perform: () => ActionOutcome): ActionExecution {
    const action = this.getProposedAction(actionId);
    const approval = this.db.prepare(`SELECT id FROM approvals WHERE proposed_action_id = $actionId
      AND proposal_version = $version AND proposal_fingerprint = $fingerprint AND status = 'approved'
      LIMIT 1`).get({ $actionId: actionId, $version: action.proposalVersion, $fingerprint: action.proposalFingerprint });
    if (!approval) throw new Error("Action requires approval for its exact current proposal version");

    const latest = this.db.prepare(`SELECT * FROM action_executions WHERE proposed_action_id = $actionId
      AND proposal_version = $version ORDER BY attempt DESC LIMIT 1`).get({ $actionId: actionId, $version: action.proposalVersion });
    if (latest) {
      const existing = this.toActionExecution(row(latest));
      if (existing.status !== "failed") return existing;
    }

    const attempt = latest ? Number(row(latest).attempt) + 1 : 1;
    const executionId = randomUUID();
    const timestamp = now();
    const idempotencyKey = `${actionId}:v${action.proposalVersion}:a${attempt}`;
    this.db.prepare(`INSERT INTO action_executions (id, proposed_action_id, proposal_version, idempotency_key,
      attempt, status, started_at) VALUES ($id, $actionId, $version, $key, $attempt, 'pending', $timestamp)`).run({
      $id: executionId, $actionId: actionId, $version: action.proposalVersion, $key: idempotencyKey, $attempt: attempt, $timestamp: timestamp,
    });
    let outcome: ActionOutcome;
    try {
      outcome = perform();
    } catch (error) {
      outcome = { status: "uncertain", error: error instanceof Error ? error.message : "Execution outcome was not received" };
    }
    this.completeActionExecution(executionId, outcome);
    return this.getActionExecution(executionId);
  }

  completeActionExecution(executionId: string, outcome: ActionOutcome): ActionExecution {
    const timestamp = now();
    this.db.prepare(`UPDATE action_executions SET status = $status, result_json = $result,
      error = $error, completed_at = $timestamp WHERE id = $id AND status = 'pending'`).run({
      $status: outcome.status, $result: outcome.result === undefined ? null : JSON.stringify(outcome.result),
      $error: outcome.error ?? null, $timestamp: timestamp, $id: executionId,
    });
    return this.getActionExecution(executionId);
  }

  reconcileActionExecution(executionId: string, outcome: ActionOutcome): ActionExecution {
    const current = this.getActionExecution(executionId);
    if (current.status !== "uncertain" && current.status !== "partial") throw new Error("Only uncertain or partial executions require reconciliation");
    const timestamp = now();
    this.db.prepare(`UPDATE action_executions SET status = $status, result_json = $result, error = $error,
      reconciled_at = $timestamp, completed_at = COALESCE(completed_at, $timestamp) WHERE id = $id`).run({
      $status: outcome.status, $result: outcome.result === undefined ? null : JSON.stringify(outcome.result),
      $error: outcome.error ?? null, $timestamp: timestamp, $id: executionId,
    });
    return this.getActionExecution(executionId);
  }

  getActionExecution(id: string): ActionExecution {
    const found = this.db.prepare("SELECT * FROM action_executions WHERE id = $id").get({ $id: id });
    if (!found) throw new Error(`Action execution not found: ${id}`);
    return this.toActionExecution(row(found));
  }

  private toActionExecution(value: SqlRow): ActionExecution {
    return { id: String(value.id), proposedActionId: String(value.proposed_action_id), proposalVersion: Number(value.proposal_version),
      idempotencyKey: String(value.idempotency_key), attempt: Number(value.attempt), status: value.status as ActionExecutionStatus,
      result: value.result_json === null ? undefined : parseJson(value.result_json, undefined), error: value.error ? String(value.error) : undefined,
      startedAt: String(value.started_at), completedAt: value.completed_at ? String(value.completed_at) : undefined,
      reconciledAt: value.reconciled_at ? String(value.reconciled_at) : undefined };
  }
}
