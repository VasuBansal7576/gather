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
  ConnectedAccount,
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
      CREATE TABLE IF NOT EXISTS connected_accounts (
        id TEXT PRIMARY KEY,
        business_id TEXT NOT NULL REFERENCES businesses(id),
        provider TEXT NOT NULL,
        display_name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('connected', 'revoked', 'error')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bookings_meta (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
      );
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

  getBooking(id: string): Booking {
    const found = this.db.prepare("SELECT * FROM bookings WHERE id = $id").get({ $id: id });
    if (!found) throw new Error(`Booking not found: ${id}`);
    return this.toBooking(row(found));
  }

  listBookings(businessId?: string): Booking[] {
    const rows = businessId === undefined
      ? this.db.prepare("SELECT * FROM bookings ORDER BY created_at").all()
      : this.db.prepare("SELECT * FROM bookings WHERE business_id = $businessId ORDER BY created_at").all({ $businessId: businessId });
    return rows.map((value) => this.toBooking(row(value)));
  }

  updateBookingStatus(id: string, status: Booking["status"]): Booking {
    const timestamp = now();
    const result = this.db.prepare("UPDATE bookings SET status = $status, updated_at = $timestamp WHERE id = $id").run({ $status: status, $timestamp: timestamp, $id: id });
    if (result.changes === 0) throw new Error(`Booking not found: ${id}`);
    return this.getBooking(id);
  }

  getBusiness(id: string): Business {
    const found = this.db.prepare("SELECT * FROM businesses WHERE id = $id").get({ $id: id });
    if (!found) throw new Error(`Business not found: ${id}`);
    const value = row(found);
    return { id: String(value.id), name: String(value.name), timezone: String(value.timezone),
      status: value.status as Business["status"], createdAt: String(value.created_at), updatedAt: String(value.updated_at) };
  }

  listBusinesses(): Business[] {
    const rows = this.db.prepare("SELECT * FROM businesses ORDER BY created_at").all();
    return rows.map((value) => this.getBusiness(String(row(value).id)));
  }

  listProposedActionsForBooking(bookingId: string): ProposedAction[] {
    const rows = this.db.prepare("SELECT id FROM proposed_actions WHERE booking_id = $bookingId ORDER BY created_at").all({ $bookingId: bookingId });
    return rows.map((value) => this.getProposedAction(String(row(value).id)));
  }

  listAllProposedActions(): ProposedAction[] {
    const rows = this.db.prepare("SELECT id FROM proposed_actions ORDER BY created_at").all();
    return rows.map((value) => this.getProposedAction(String(row(value).id)));
  }

  listBusinessFacts(businessId: string): BusinessFact[] {
    const rows = this.db.prepare("SELECT * FROM business_facts WHERE business_id = $businessId ORDER BY observed_at").all({ $businessId: businessId });
    return rows.map((value) => {
      const item = row(value);
      return { id: String(item.id), businessId: String(item.business_id), key: String(item.key),
        value: parseJson(item.value_json, undefined) as BusinessFact["value"],
        confidence: item.confidence as BusinessFact["confidence"],
        sourceReferences: parseJson(item.source_references_json, []) as SourceReference[],
        observedAt: String(item.observed_at) };
    });
  }

  upsertConnectedAccount(input: { id: string; businessId: string; provider: ConnectedAccount["provider"]; displayName: string; status: ConnectedAccount["status"] }): ConnectedAccount {
    const timestamp = now();
    this.db.prepare(`INSERT INTO connected_accounts (id, business_id, provider, display_name, status, created_at, updated_at)
      VALUES ($id, $businessId, $provider, $displayName, $status, $createdAt, $updatedAt)
      ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, status = excluded.status, updated_at = excluded.updated_at`).run({
      $id: input.id, $businessId: input.businessId, $provider: input.provider, $displayName: input.displayName,
      $status: input.status, $createdAt: timestamp, $updatedAt: timestamp,
    });
    return this.getConnectedAccount(input.id);
  }

  getConnectedAccount(id: string): ConnectedAccount {
    const found = this.db.prepare("SELECT * FROM connected_accounts WHERE id = $id").get({ $id: id });
    if (!found) throw new Error(`Connected account not found: ${id}`);
    const value = row(found);
    return { id: String(value.id), businessId: String(value.business_id), provider: value.provider as ConnectedAccount["provider"],
      displayName: String(value.display_name), status: value.status as ConnectedAccount["status"],
      createdAt: String(value.created_at), updatedAt: String(value.updated_at) };
  }

  listConnectedAccounts(businessId?: string): ConnectedAccount[] {
    const rows = businessId === undefined
      ? this.db.prepare("SELECT id FROM connected_accounts ORDER BY created_at").all()
      : this.db.prepare("SELECT id FROM connected_accounts WHERE business_id = $businessId ORDER BY created_at").all({ $businessId: businessId });
    return rows.map((value) => this.getConnectedAccount(String(row(value).id)));
  }

  setConnectedAccountStatus(id: string, status: ConnectedAccount["status"]): ConnectedAccount {
    const timestamp = now();
    const result = this.db.prepare("UPDATE connected_accounts SET status = $status, updated_at = $timestamp WHERE id = $id").run({ $status: status, $timestamp: timestamp, $id: id });
    if (result.changes === 0) throw new Error(`Connected account not found: ${id}`);
    return this.getConnectedAccount(id);
  }

  listActionExecutions(actionId: string): ActionExecution[] {
    const rows = this.db.prepare("SELECT * FROM action_executions WHERE proposed_action_id = $actionId ORDER BY attempt").all({ $actionId: actionId });
    return rows.map((value) => this.toActionExecution(row(value)));
  }

  listAllActionExecutions(): ActionExecution[] {
    const rows = this.db.prepare("SELECT * FROM action_executions ORDER BY started_at").all();
    return rows.map((value) => this.toActionExecution(row(value)));
  }

  getExecutionByIdempotencyKey(key: string): ActionExecution | undefined {
    const found = this.db.prepare("SELECT * FROM action_executions WHERE idempotency_key = $key").get({ $key: key });
    return found ? this.toActionExecution(row(found)) : undefined;
  }

  /**
   * Async-safe reservation boundary for real connector interfaces.
   * Atomically inserts a pending step execution for a stable idempotency key
   * BEFORE any provider side effect, or returns the existing durable row for
   * that key. Requires exact-version approval. Never performs I/O itself.
   */
  reserveStepExecution(proposedActionId: string, proposalVersion: number, idempotencyKey: string): ActionExecution {
    const action = this.getProposedAction(proposedActionId);
    if (action.proposalVersion !== proposalVersion) {
      throw new Error("Stale proposal version: approval refers to a different version");
    }
    const approval = this.db.prepare(`SELECT id FROM approvals WHERE proposed_action_id = $actionId
      AND proposal_version = $version AND proposal_fingerprint = $fingerprint AND status = 'approved' LIMIT 1`).get({
      $actionId: proposedActionId, $version: action.proposalVersion, $fingerprint: action.proposalFingerprint,
    });
    if (!approval) throw new Error("Action requires approval for its exact current proposal version");
    const existing = this.getExecutionByIdempotencyKey(idempotencyKey);
    if (existing) {
      if (existing.proposedActionId !== proposedActionId || existing.proposalVersion !== proposalVersion) {
        throw new Error("Idempotency key is bound to a different approved action");
      }
      return existing;
    }
    const latest = this.db.prepare(`SELECT attempt FROM action_executions WHERE proposed_action_id = $actionId
      AND proposal_version = $version ORDER BY attempt DESC LIMIT 1`).get({ $actionId: proposedActionId, $version: proposalVersion });
    const attempt = latest ? Number(row(latest).attempt) + 1 : 1;
    const timestamp = now();
    const id = randomUUID();
    try {
      this.db.prepare(`INSERT INTO action_executions (id, proposed_action_id, proposal_version, idempotency_key,
        attempt, status, started_at) VALUES ($id, $actionId, $version, $key, $attempt, 'pending', $timestamp)`).run({
        $id: id, $actionId: proposedActionId, $version: proposalVersion, $key: idempotencyKey, $attempt: attempt, $timestamp: timestamp,
      });
    } catch (error) {
      // Lost a race with a concurrent reserver for the same stable key: return the winner.
      const winner = this.getExecutionByIdempotencyKey(idempotencyKey);
      if (winner) return winner;
      throw error;
    }
    return this.getActionExecution(id);
  }

  /**
   * Reopen a terminally failed step for retry while keeping the SAME stable
   * idempotency key. The connector dedupes by that key, so a real provider
   * never double-applies. Succeeded/uncertain/partial rows are never reopened
   * here (uncertain must reconcile first).
   */
  reopenFailedStep(executionId: string): ActionExecution {
    const current = this.getActionExecution(executionId);
    if (current.status !== "failed") throw new Error("Only failed executions can be retried; reconcile uncertain ones first");
    const timestamp = now();
    this.db.prepare(`UPDATE action_executions SET status = 'pending', attempt = attempt + 1,
      error = NULL, started_at = $timestamp, completed_at = NULL WHERE id = $id`).run({ $timestamp: timestamp, $id: executionId });
    return this.getActionExecution(executionId);
  }

  /**
   * Persist uncertainty durably BEFORE any retry is allowed. Callable for
   * pending OR already-terminal-uncertain rows; succeeding rows are never
   * overwritten to uncertain.
   */
  markExecutionUncertain(executionId: string, message: string): ActionExecution {
    const current = this.getActionExecution(executionId);
    if (current.status === "succeeded") throw new Error("A succeeded step must never be rewritten to uncertain");
    const timestamp = now();
    this.db.prepare(`UPDATE action_executions SET status = 'uncertain', error = $error,
      completed_at = COALESCE(completed_at, $timestamp) WHERE id = $id`).run({ $error: message, $timestamp: timestamp, $id: executionId });
    return this.getActionExecution(executionId);
  }

  private toBooking(value: SqlRow): Booking {
    return { id: String(value.id), businessId: String(value.business_id), status: value.status as Booking["status"],
      eventName: String(value.event_name), startAt: value.start_at ? String(value.start_at) : undefined,
      endAt: value.end_at ? String(value.end_at) : undefined,
      guestCount: value.guest_count === null ? undefined : Number(value.guest_count),
      notes: value.notes ? String(value.notes) : undefined,
      sourceReferences: parseJson(value.source_references_json, []) as SourceReference[],
      createdAt: String(value.created_at), updatedAt: String(value.updated_at) };
  }

  private toActionExecution(value: SqlRow): ActionExecution {
    return { id: String(value.id), proposedActionId: String(value.proposed_action_id), proposalVersion: Number(value.proposal_version),
      idempotencyKey: String(value.idempotency_key), attempt: Number(value.attempt), status: value.status as ActionExecutionStatus,
      result: value.result_json === null ? undefined : parseJson(value.result_json, undefined), error: value.error ? String(value.error) : undefined,
      startedAt: String(value.started_at), completedAt: value.completed_at ? String(value.completed_at) : undefined,
      reconciledAt: value.reconciled_at ? String(value.reconciled_at) : undefined };
  }
}
