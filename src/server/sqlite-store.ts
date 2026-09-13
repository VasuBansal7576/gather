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

/** Default ownership lease for a reserved pending step execution. */
export const DEFAULT_CLAIM_LEASE_MS = 120_000;

export interface StepReservationOptions {
  claimToken?: string;
  leaseMs?: number;
  /** Injectable clock (epoch millis) for deterministic crash-recovery tests. */
  nowMs?: number;
}

export interface StepReservation {
  execution: ActionExecution;
  /** True when this call created the pending row and owns its claim. */
  created: boolean;
  /** True when a crashed/leaked pending row was reclaimed; caller owns the new claim. */
  reclaimed: boolean;
}

export type ProviderReceiptKind = "hold" | "email";

export interface ProviderReceipt {
  kind: ProviderReceiptKind;
  operationKey: string;
  receipt: Record<string, unknown>;
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
      CREATE TABLE IF NOT EXISTS provider_receipts (
        operation_key TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('hold', 'email')),
        receipt_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS provider_hold_intents (
        operation_key TEXT PRIMARY KEY,
        calendar_id TEXT NOT NULL,
        start_at TEXT NOT NULL,
        end_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    // Migrations for databases created before these columns/tables existed.
    this.ensureColumn("action_executions", "claim_token", "TEXT");
    this.ensureColumn("action_executions", "claim_expires_at", "TEXT");
    this.ensureColumn("provider_receipts", "calendar_id", "TEXT");
    this.ensureColumn("provider_receipts", "start_at", "TEXT");
    this.ensureColumn("provider_receipts", "end_at", "TEXT");
  }

  private ensureColumn(table: string, column: string, ddl: string): void {
    const info = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!info.some((col) => col.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    }
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

  /**
   * Complete a pending execution. When a claim token is supplied, the update
   * is conditional on still holding that claim: an expired in-flight call and
   * a new owner can never both commit the same row. Without a token (legacy
   * sync path) the update applies to any pending row.
   */
  completeActionExecution(executionId: string, outcome: ActionOutcome, opts: { claimToken?: string } = {}): ActionExecution {
    const timestamp = now();
    if (opts.claimToken === undefined) {
      this.db.prepare(`UPDATE action_executions SET status = $status, result_json = $result,
        error = $error, completed_at = $timestamp WHERE id = $id AND status = 'pending'`).run({
        $status: outcome.status, $result: outcome.result === undefined ? null : JSON.stringify(outcome.result),
        $error: outcome.error ?? null, $timestamp: timestamp, $id: executionId,
      });
      return this.getActionExecution(executionId);
    }
    const updated = this.db.prepare(`UPDATE action_executions SET status = $status, result_json = $result,
      error = $error, completed_at = $timestamp
      WHERE id = $id AND status = 'pending' AND claim_token = $claim`).run({
      $status: outcome.status, $result: outcome.result === undefined ? null : JSON.stringify(outcome.result),
      $error: outcome.error ?? null, $timestamp: timestamp, $id: executionId, $claim: opts.claimToken,
    });
    if (updated.changes === 0) {
      throw new Error("Step claim is no longer held: another owner completed, reclaimed, or reconciled this execution");
    }
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
   *
   * Atomically inserts a pending step execution for a stable idempotency key
   * BEFORE any provider side effect, and grants the caller a time-boxed claim
   * (claim token + expiry) on that pending row. Callers may execute the
   * provider side effect ONLY when the returned reservation is newly created
   * or reclaimed after an expired claim. An existing pending row with a live
   * claim belongs to another in-flight attempt (possibly on a separate store
   * connection after a crash or under concurrency) and is refused with an
   * in-progress error instead of being blindly replayed.
   *
   * Requires exact-version approval. Never performs I/O itself.
   */
  reserveStepExecution(
    proposedActionId: string,
    proposalVersion: number,
    idempotencyKey: string,
    opts: StepReservationOptions = {},
  ): StepReservation {
    const action = this.getProposedAction(proposedActionId);
    if (action.proposalVersion !== proposalVersion) {
      throw new Error("Stale proposal version: approval refers to a different version");
    }
    const approval = this.db.prepare(`SELECT id FROM approvals WHERE proposed_action_id = $actionId
      AND proposal_version = $version AND proposal_fingerprint = $fingerprint AND status = 'approved' LIMIT 1`).get({
      $actionId: proposedActionId, $version: action.proposalVersion, $fingerprint: action.proposalFingerprint,
    });
    if (!approval) throw new Error("Action requires approval for its exact current proposal version");
    const claimToken = opts.claimToken ?? randomUUID();
    const nowMs = opts.nowMs ?? Date.now();
    const leaseMs = opts.leaseMs ?? DEFAULT_CLAIM_LEASE_MS;
    const existing = this.getExecutionByIdempotencyKey(idempotencyKey);
    if (existing) {
      if (existing.proposedActionId !== proposedActionId || existing.proposalVersion !== proposalVersion) {
        throw new Error("Idempotency key is bound to a different approved action");
      }
      if (existing.status !== "pending") {
        return { execution: existing, created: false, reclaimed: false };
      }
      return this.reclaimOrRejectPending(existing, claimToken, nowMs, leaseMs);
    }
    const latest = this.db.prepare(`SELECT attempt FROM action_executions WHERE proposed_action_id = $actionId
      AND proposal_version = $version ORDER BY attempt DESC LIMIT 1`).get({ $actionId: proposedActionId, $version: proposalVersion });
    const attempt = latest ? Number(row(latest).attempt) + 1 : 1;
    const timestamp = now();
    const id = randomUUID();
    const expiresAt = new Date(nowMs + leaseMs).toISOString();
    const inserted = this.db.prepare(`INSERT INTO action_executions (id, proposed_action_id, proposal_version, idempotency_key,
      attempt, status, started_at, claim_token, claim_expires_at)
      VALUES ($id, $actionId, $version, $key, $attempt, 'pending', $timestamp, $claim, $expires)
      ON CONFLICT(idempotency_key) DO NOTHING`).run({
      $id: id, $actionId: proposedActionId, $version: proposalVersion, $key: idempotencyKey, $attempt: attempt,
      $timestamp: timestamp, $claim: claimToken, $expires: expiresAt,
    });
    if (inserted.changes === 0) {
      // Lost a race with a concurrent reserver on another connection: resolve
      // against the winner instead of executing twice.
      const winner = this.getExecutionByIdempotencyKey(idempotencyKey);
      if (!winner) throw new Error("Step reservation raced but no winner row is visible");
      if (winner.proposedActionId !== proposedActionId || winner.proposalVersion !== proposalVersion) {
        throw new Error("Idempotency key is bound to a different approved action");
      }
      if (winner.status !== "pending") return { execution: winner, created: false, reclaimed: false };
      return this.reclaimOrRejectPending(winner, claimToken, nowMs, leaseMs);
    }
    return { execution: this.getActionExecution(id), created: true, reclaimed: false };
  }

  /**
   * Decide ownership of an existing pending row. A live claim means another
   * attempt is in flight: refuse. An expired (or absent) claim means the
   * previous owner crashed or leaked: reclaim atomically so only one caller
   * proceeds.
   */
  private reclaimOrRejectPending(
    pending: ActionExecution,
    claimToken: string,
    nowMs: number,
    leaseMs: number,
  ): StepReservation {
    const expiryMs = pending.claimExpiresAt ? Date.parse(pending.claimExpiresAt) : Number.NaN;
    if (Number.isFinite(expiryMs) && expiryMs > nowMs) {
      throw new Error("Step execution is already in progress for this idempotency key");
    }
    const expiresAt = new Date(nowMs + leaseMs).toISOString();
    const timestamp = now();
    const claimed = this.db.prepare(`UPDATE action_executions SET claim_token = $claim, claim_expires_at = $expires,
      attempt = attempt + 1, started_at = $timestamp
      WHERE id = $id AND status = 'pending' AND (claim_expires_at IS NULL OR claim_expires_at <= $nowIso)`).run({
      $claim: claimToken, $expires: expiresAt, $timestamp: timestamp, $id: pending.id, $nowIso: new Date(nowMs).toISOString(),
    });
    if (claimed.changes === 0) {
      const current = this.getActionExecution(pending.id);
      if (current.status !== "pending") return { execution: current, created: false, reclaimed: false };
      throw new Error("Step execution is already in progress for this idempotency key");
    }
    return { execution: this.getActionExecution(pending.id), created: false, reclaimed: true };
  }

  /**
   * Reopen a terminally failed step for retry while keeping the SAME stable
   * idempotency key, granting the caller a fresh claim. The connector dedupes
   * by that key, so a real provider never double-applies. Succeeded/
   * uncertain/partial rows are never reopened here (uncertain must reconcile
   * first).
   */
  reopenFailedStep(executionId: string, opts: StepReservationOptions = {}): ActionExecution {
    const current = this.getActionExecution(executionId);
    if (current.status !== "failed") throw new Error("Only failed executions can be retried; reconcile uncertain ones first");
    const timestamp = now();
    const nowMs = opts.nowMs ?? Date.now();
    const leaseMs = opts.leaseMs ?? DEFAULT_CLAIM_LEASE_MS;
    this.db.prepare(`UPDATE action_executions SET status = 'pending', attempt = attempt + 1,
      error = NULL, started_at = $timestamp, completed_at = NULL,
      claim_token = $claim, claim_expires_at = $expires WHERE id = $id`).run({
      $timestamp: timestamp, $claim: opts.claimToken ?? randomUUID(),
      $expires: new Date(nowMs + leaseMs).toISOString(), $id: executionId,
    });
    return this.getActionExecution(executionId);
  }

  /**
   * Persist uncertainty durably BEFORE any retry is allowed. Callable for
   * pending OR already-terminal-uncertain rows; succeeding rows are never
   * overwritten to uncertain.
   */
  /**
   * Record uncertainty for an owned pending/uncertain execution. Terminal
   * failed, partial, and succeeded rows are never rewritten: a failure
   * verdict and provider evidence must not be reclassified as uncertainty,
   * and uncertainty must not mask them.
   */
  markExecutionUncertain(executionId: string, message: string, opts: { claimToken?: string } = {}): ActionExecution {
    const current = this.getActionExecution(executionId);
    if (current.status !== "pending" && current.status !== "uncertain") {
      throw new Error(`Only pending or uncertain executions can be marked uncertain (row is ${current.status})`);
    }
    const timestamp = now();
    if (opts.claimToken === undefined) {
      this.db.prepare(`UPDATE action_executions SET status = 'uncertain', error = $error,
        completed_at = COALESCE(completed_at, $timestamp)
        WHERE id = $id AND status IN ('pending', 'uncertain')`).run({ $error: message, $timestamp: timestamp, $id: executionId });
      return this.getActionExecution(executionId);
    }
    const updated = this.db.prepare(`UPDATE action_executions SET status = 'uncertain', error = $error,
      completed_at = COALESCE(completed_at, $timestamp)
      WHERE id = $id AND status IN ('pending', 'uncertain') AND claim_token = $claim`).run({
      $error: message, $timestamp: timestamp, $id: executionId, $claim: opts.claimToken,
    });
    if (updated.changes === 0) {
      throw new Error("Step claim is no longer held: another owner completed, reclaimed, or reconciled this execution");
    }
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

  /**
   * Durable provider-side receipt log. Demo adapters persist every completed
   * provider write here (including writes whose response was lost), so
   * reconciliation after a restart or adapter rebuild reads SQLite instead of
   * relying on volatile adapter memory. First write wins per operation key.
   */
  saveProviderReceipt(kind: ProviderReceiptKind, operationKey: string, receipt: Record<string, unknown>): void {
    const hold = kind === "hold" ? ((receipt.hold ?? {}) as Record<string, unknown>) : {};
    const calendarId = typeof hold.calendarId === "string" ? hold.calendarId : undefined;
    const startAt = typeof hold.startAt === "string" ? hold.startAt : undefined;
    const endAt = typeof hold.endAt === "string" ? hold.endAt : undefined;
    this.db.prepare(`INSERT INTO provider_receipts (operation_key, kind, receipt_json, created_at, calendar_id, start_at, end_at)
      VALUES ($key, $kind, $receipt, $timestamp, $calendar, $start, $end) ON CONFLICT(operation_key) DO NOTHING`).run({
      $key: operationKey, $kind: kind, $receipt: JSON.stringify(receipt), $timestamp: now(),
      $calendar: calendarId ?? null, $start: startAt ?? null, $end: endAt ?? null,
    });
  }

  getProviderReceipt(operationKey: string): ProviderReceipt | undefined {
    const found = this.db.prepare("SELECT * FROM provider_receipts WHERE operation_key = $key").get({ $key: operationKey });
    if (!found) return undefined;
    const value = row(found);
    return {
      kind: value.kind as ProviderReceiptKind,
      operationKey: String(value.operation_key),
      receipt: parseJson(value.receipt_json, {}) as Record<string, unknown>,
    };
  }

  /**
   * Atomically claim a hold window for one stable operation key (C4).
   *
   * Inside a single IMMEDIATE transaction this records the caller's intent
   * and checks it against every other intent and unexpired durable receipt
   * for the same calendar. Concurrent connections serialize on the write
   * lock, so a fresh (restarted, memory-empty) adapter and a second booking
   * action both observe the same durable conflict set — a different booking
   * can never take an overlapping window on the same calendar. Own retries
   * (same key) always pass.
   *
   * Pending intents are NEVER purged by lease or clock: an intent records a
   * provider effect of unknown outcome, and expiring it could release a
   * window whose hold actually exists. An intent leaves the conflict set
   * only through evidence — a durable receipt for its key, an explicit
   * release after a definitive provider failure, or reconciliation. Receipts
   * whose hold has expired no longer deny the window, but the receipt rows
   * themselves are preserved as history.
   */
  claimHoldSlot(
    operationKey: string,
    calendarId: string,
    startAt: string,
    endAt: string,
    opts: { nowMs?: number; intentLeaseMs?: number } = {},
  ): { ok: true } | { ok: false; conflictingKey: string } {
    const nowMs = opts.nowMs ?? Date.now();
    const timestamp = now();
    const expiresAt = new Date(nowMs + (opts.intentLeaseMs ?? DEFAULT_CLAIM_LEASE_MS)).toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`INSERT INTO provider_hold_intents (operation_key, calendar_id, start_at, end_at, expires_at, created_at)
        VALUES ($key, $calendar, $start, $end, $expires, $timestamp) ON CONFLICT(operation_key) DO NOTHING`).run({
        $key: operationKey, $calendar: calendarId, $start: startAt, $end: endAt, $expires: expiresAt, $timestamp: timestamp,
      });
      const conflict = this.findOverlappingHold(calendarId, startAt, endAt, operationKey, nowMs);
      if (conflict) {
        this.db.exec("ROLLBACK");
        return { ok: false, conflictingKey: conflict };
      }
      this.db.exec("COMMIT");
      return { ok: true };
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Already rolled back; surface the original failure.
      }
      throw error;
    }
  }

  /**
   * Read-only durable conflict check over the same conflict set that
   * claimHoldSlot enforces, so availability and create paths agree. Returns
   * the conflicting operation key, if any. Unknown pending intents always
   * block (fail-closed until evidence); receipts block only while their
   * hold is unexpired. The caller's own operation key is always excluded.
   */
  findHoldConflict(
    calendarId: string,
    startAt: string,
    endAt: string,
    opts: { excludeOperationKey?: string; nowMs?: number } = {},
  ): string | undefined {
    return this.findOverlappingHold(calendarId, startAt, endAt, opts.excludeOperationKey, opts.nowMs ?? Date.now());
  }

  private findOverlappingHold(
    calendarId: string,
    startAt: string,
    endAt: string,
    excludeOperationKey: string | undefined,
    nowMs: number,
  ): string | undefined {
    const startMs = Date.parse(startAt);
    const endMs = Date.parse(endAt);
    const receiptsByKey = new Map<string, Record<string, unknown>>();
    const receipts = this.db.prepare("SELECT operation_key, receipt_json, start_at, end_at FROM provider_receipts WHERE kind = 'hold' AND (calendar_id = $calendar OR calendar_id IS NULL)").all({ $calendar: calendarId });
    for (const item of receipts) {
      receiptsByKey.set(String(row(item).operation_key), item as Record<string, unknown>);
    }
    const intents = this.db.prepare("SELECT operation_key, start_at, end_at FROM provider_hold_intents WHERE calendar_id = $calendar").all({ $calendar: calendarId });
    for (const item of intents) {
      const candidate = row(item);
      if (excludeOperationKey !== undefined && String(candidate.operation_key) === excludeOperationKey) continue;
      // An intent with a durable receipt is no longer unknown: the receipt
      // below governs (including its expiry). Only receipt-less intents —
      // effects whose outcome is genuinely unproven — stay fail-closed.
      // This also heals a crash between receipt write and intent release.
      if (receiptsByKey.has(String(candidate.operation_key))) continue;
      if (Date.parse(String(candidate.start_at)) < endMs && Date.parse(String(candidate.end_at)) > startMs) {
        return String(candidate.operation_key);
      }
    }
    for (const item of receiptsByKey.values()) {
      const candidate = item;
      if (excludeOperationKey !== undefined && String(candidate.operation_key) === excludeOperationKey) continue;
      const hold = ((parseJson(candidate.receipt_json, {}) as Record<string, unknown>).hold ?? {}) as Record<string, unknown>;
      const receiptCalendar = typeof hold.calendarId === "string" ? hold.calendarId : undefined;
      if (receiptCalendar !== undefined && receiptCalendar !== calendarId) continue;
      const receiptStart = candidate.start_at ? String(candidate.start_at) : typeof hold.startAt === "string" ? hold.startAt : undefined;
      const receiptEnd = candidate.end_at ? String(candidate.end_at) : typeof hold.endAt === "string" ? hold.endAt : undefined;
      if (!receiptStart || !receiptEnd) continue;
      // An expired hold no longer denies its window; rows without a readable
      // expiry stay fail-closed. History rows are never deleted here.
      const expiryMs = typeof hold.expiresAt === "string" ? Date.parse(hold.expiresAt) : Number.NaN;
      if (Number.isFinite(expiryMs) && expiryMs <= nowMs) continue;
      if (Date.parse(receiptStart) < endMs && Date.parse(receiptEnd) > startMs) {
        return String(candidate.operation_key);
      }
    }
    return undefined;
  }

  /** Release a hold intent after a definitive provider failure (no effect). */
  releaseHoldSlot(operationKey: string): void {
    this.db.prepare("DELETE FROM provider_hold_intents WHERE operation_key = $key").run({ $key: operationKey });
  }

  private toActionExecution(value: SqlRow): ActionExecution {
    return { id: String(value.id), proposedActionId: String(value.proposed_action_id), proposalVersion: Number(value.proposal_version),
      idempotencyKey: String(value.idempotency_key), attempt: Number(value.attempt), status: value.status as ActionExecutionStatus,
      result: value.result_json === null ? undefined : parseJson(value.result_json, undefined), error: value.error ? String(value.error) : undefined,
      startedAt: String(value.started_at), completedAt: value.completed_at ? String(value.completed_at) : undefined,
      reconciledAt: value.reconciled_at ? String(value.reconciled_at) : undefined,
      claimToken: value.claim_token ? String(value.claim_token) : undefined,
      claimExpiresAt: value.claim_expires_at ? String(value.claim_expires_at) : undefined };
  }
}
