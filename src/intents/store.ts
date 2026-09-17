import { randomUUID } from "node:crypto";
import type { GatherStore } from "../server/sqlite-store.ts";
import type { IntentKind, IntentLease, IntentRecord, IntentState, IntentStep } from "./types.ts";

/**
 * SQL boundary for the durable intent envelope. The `intents` table itself is
 * created additively by GatherStore (ADR-002 owns that schema); this store
 * owns every read and fenced write against it. Fencing discipline: writes
 * that record progress are conditional on the caller's `{runId,
 * fencingToken}` pair, so a reclaimed or cancelled intent can never be
 * mutated by a stale claim.
 */

type SqlRow = Record<string, unknown>;

function row<T extends SqlRow>(value: unknown): T {
  if (!value || typeof value !== "object") throw new Error("Expected a SQLite row");
  return value as T;
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  return JSON.parse(value) as T;
}

export interface NewIntent {
  commandKey: string;
  kind: IntentKind;
  payload: Record<string, unknown>;
  payloadHash: string;
  mode: string;
  businessId?: string;
  bookingId?: string;
  proposedActionId?: string;
  proposalVersion?: number;
  steps: IntentStep[];
  deadlineAt?: string;
  nowIso: string;
}

export interface IntentFilter {
  businessId?: string;
  bookingId?: string;
  state?: IntentState;
  limit?: number;
}

const TERMINAL: ReadonlySet<IntentState> = new Set(["completed", "cancelled"]);

export class IntentStore {
  private readonly store: GatherStore;

  constructor(store: GatherStore) {
    this.store = store;
  }

  private get db() {
    return this.store.db;
  }

  /** Insert a queued intent. Returns undefined when the command key already exists. */
  insertIntent(input: NewIntent): IntentRecord | undefined {
    const id = randomUUID();
    const inserted = this.db
      .prepare(
        `INSERT INTO intents
          (id, command_key, kind, payload_json, payload_hash, mode, business_id, booking_id,
           proposed_action_id, proposal_version, state, steps_json, deadline_at, attempts,
           created_at, updated_at)
         VALUES ($id, $key, $kind, $payload, $hash, $mode, $business, $booking,
           $action, $version, 'queued', $steps, $deadline, 0, $now, $now)
         ON CONFLICT(command_key) DO NOTHING`,
      )
      .run({
        $id: id,
        $key: input.commandKey,
        $kind: input.kind,
        $payload: JSON.stringify(input.payload),
        $hash: input.payloadHash,
        $mode: input.mode,
        $business: input.businessId ?? null,
        $booking: input.bookingId ?? null,
        $action: input.proposedActionId ?? null,
        $version: input.proposalVersion ?? null,
        $steps: JSON.stringify(input.steps),
        $deadline: input.deadlineAt ?? null,
        $now: input.nowIso,
      });
    if (inserted.changes === 0) return undefined;
    return this.getIntent(id);
  }

  getIntent(id: string): IntentRecord {
    const found = this.db.prepare("SELECT * FROM intents WHERE id = $id").get({ $id: id });
    if (!found) throw new Error(`Intent not found: ${id}`);
    return this.toIntent(row(found));
  }

  getByCommandKey(commandKey: string): IntentRecord | undefined {
    const found = this.db.prepare("SELECT * FROM intents WHERE command_key = $key").get({ $key: commandKey });
    return found ? this.toIntent(row(found)) : undefined;
  }

  listIntents(filter: IntentFilter = {}): IntentRecord[] {
    const clauses: string[] = [];
    const params: Record<string, string> = {};
    if (filter.businessId !== undefined) {
      clauses.push("business_id = $business");
      params.$business = filter.businessId;
    }
    if (filter.bookingId !== undefined) {
      clauses.push("booking_id = $booking");
      params.$booking = filter.bookingId;
    }
    if (filter.state !== undefined) {
      clauses.push("state = $state");
      params.$state = filter.state;
    }
    const limit = filter.limit ?? 200;
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM intents ${where} ORDER BY created_at, rowid LIMIT ${Math.trunc(Math.max(1, Math.min(1000, limit)))}`)
      .all(params) as unknown[];
    return rows.map((value) => this.toIntent(row(value)));
  }

  /**
   * Runnable candidates for one drain pass: queued/retryable/uncertain work,
   * plus `running` rows whose lease expired (their owner crashed or leaked).
   * Deadline-expired rows are excluded — they are marked blocked instead of
   * claimed.
   */
  listRunnable(nowIso: string, businessId?: string): IntentRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM intents
         WHERE (
           state IN ('queued', 'retryable', 'uncertain')
           OR (state = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= $now)
         )
         AND (deadline_at IS NULL OR deadline_at > $now)
         ${businessId === undefined ? "" : "AND business_id = $business"}
         ORDER BY created_at, rowid`,
      )
      .all(businessId === undefined ? { $now: nowIso } : { $now: nowIso, $business: businessId }) as unknown[];
    return rows.map((value) => this.toIntent(row(value)));
  }

  /** Non-terminal intents whose deadline already passed; claimDue marks them blocked. */
  listDeadlineExpired(nowIso: string): IntentRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM intents
         WHERE state NOT IN ('completed', 'cancelled', 'blocked')
           AND deadline_at IS NOT NULL AND deadline_at <= $now
         ORDER BY created_at, rowid`,
      )
      .all({ $now: nowIso }) as unknown[];
    return rows.map((value) => this.toIntent(row(value)));
  }

  /** All `running` rows — the boot-recovery candidate set (prior owners are dead). */
  listRunning(): IntentRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM intents WHERE state = 'running' ORDER BY created_at, rowid")
      .all() as unknown[];
    return rows.map((value) => this.toIntent(row(value)));
  }

  /**
   * Atomically claim one runnable intent for `owner`. The conditional UPDATE
   * both excludes live leases and bumps the fencing token, so exactly one of
   * several concurrent claimants wins and every earlier claim is fenced out
   * the moment the winner commits.
   */
  claim(intentId: string, owner: string, nowIso: string, leaseMs: number, opts: { includeBlocked?: boolean } = {}): IntentLease | undefined {
    const runId = randomUUID();
    const expiresAt = new Date(Date.parse(nowIso) + leaseMs).toISOString();
    const claimable = opts.includeBlocked ? "'queued', 'retryable', 'uncertain', 'blocked'" : "'queued', 'retryable', 'uncertain'";
    const claimed = this.db
      .prepare(
        `UPDATE intents
         SET state = 'running', lease_owner = $owner, run_id = $run,
             fencing_token = fencing_token + 1, lease_expires_at = $expires,
             attempts = attempts + 1, updated_at = $now
         WHERE id = $id
           AND (
             state IN (${claimable})
             OR (state = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= $now)
           )
           AND (deadline_at IS NULL OR deadline_at > $now)`,
      )
      .run({ $owner: owner, $run: runId, $expires: expiresAt, $now: nowIso, $id: intentId });
    if (claimed.changes === 0) return undefined;
    const record = this.getIntent(intentId);
    return { owner, fencingToken: record.fencingToken, runId, expiresAt };
  }

  /**
   * Fenced progress write: persists steps/lastError only while the caller's
   * claim is still the live owner of a running intent. Returns false when the
   * claim was fenced (cancelled, reclaimed, or already finished elsewhere).
   */
  updateProgress(intentId: string, lease: IntentLease, patch: { steps?: IntentStep[]; lastError?: string | null }, nowIso: string): boolean {
    const updated = this.db
      .prepare(
        `UPDATE intents SET steps_json = COALESCE($steps, steps_json),
           last_error = CASE WHEN $hasError THEN $error ELSE last_error END,
           updated_at = $now
         WHERE id = $id AND state = 'running' AND run_id = $run AND fencing_token = $fence
           AND lease_expires_at > $now`,
      )
      .run({
        $steps: patch.steps === undefined ? null : JSON.stringify(patch.steps),
        $hasError: patch.lastError !== undefined ? 1 : 0,
        $error: patch.lastError ?? null,
        $now: nowIso,
        $id: intentId,
        $run: lease.runId,
        $fence: lease.fencingToken,
      });
    return updated.changes === 1;
  }

  /**
   * Fenced terminal/transition write for the claim holder: moves a running
   * intent to `state`, clears the lease, and stamps completed_at for terminal
   * states. Returns false when the claim no longer owns the row.
   */
  finishClaim(intentId: string, lease: IntentLease, state: IntentState, patch: { steps?: IntentStep[]; lastError?: string | null }, nowIso: string): boolean {
    const terminal = TERMINAL.has(state);
    const updated = this.db
      .prepare(
        `UPDATE intents SET state = $state,
           steps_json = COALESCE($steps, steps_json),
           last_error = CASE WHEN $hasError THEN $error ELSE last_error END,
           lease_owner = NULL, lease_expires_at = NULL, run_id = NULL,
           completed_at = CASE WHEN $terminal THEN $now ELSE completed_at END,
           updated_at = $now
         WHERE id = $id AND state = 'running' AND run_id = $run AND fencing_token = $fence
           AND lease_expires_at > $now`,
      )
      .run({
        $state: state,
        $steps: patch.steps === undefined ? null : JSON.stringify(patch.steps),
        $hasError: patch.lastError !== undefined ? 1 : 0,
        $error: patch.lastError ?? null,
        $terminal: terminal ? 1 : 0,
        $now: nowIso,
        $id: intentId,
        $run: lease.runId,
        $fence: lease.fencingToken,
      });
    return updated.changes === 1;
  }

  /**
   * Owner cancellation. Fences out any in-flight claim (fencing bump makes
   * every guarded write by the old claim fail) and marks the intent
   * cancelled. Terminal records are never rewritten: a completed or already
   * cancelled intent retains its state (the call returns applied:false).
   */
  markCancelled(intentId: string, owner: string, nowIso: string): { applied: boolean; record: IntentRecord } {
    const updated = this.db
      .prepare(
        `UPDATE intents SET state = 'cancelled',
           fencing_token = fencing_token + 1,
           lease_owner = NULL, lease_expires_at = NULL, run_id = NULL,
           cancelled_by = $owner, cancelled_at = $now, updated_at = $now
         WHERE id = $id AND state NOT IN ('completed', 'cancelled')`,
      )
      .run({ $owner: owner, $now: nowIso, $id: intentId });
    return { applied: updated.changes === 1, record: this.getIntent(intentId) };
  }

  /**
   * Transition out of `running` during restart reconciliation. Fences the
   * dead claim (token bump, lease cleared) and moves the intent to the
   * evidence-derived state. Returns false when the row moved on its own.
   */
  recoverRunning(intentId: string, state: IntentState, patch: { steps?: IntentStep[]; lastError?: string | null }, nowIso: string): boolean {
    const updated = this.db
      .prepare(
        `UPDATE intents SET state = $state,
           steps_json = COALESCE($steps, steps_json),
           last_error = CASE WHEN $hasError THEN $error ELSE last_error END,
           fencing_token = fencing_token + 1,
           lease_owner = NULL, lease_expires_at = NULL, run_id = NULL,
           completed_at = CASE WHEN $terminal THEN $now ELSE completed_at END,
           updated_at = $now
         WHERE id = $id AND state = 'running'`,
      )
      .run({
        $state: state,
        $steps: patch.steps === undefined ? null : JSON.stringify(patch.steps),
        $hasError: patch.lastError !== undefined ? 1 : 0,
        $error: patch.lastError ?? null,
        $terminal: TERMINAL.has(state) ? 1 : 0,
        $now: nowIso,
        $id: intentId,
      });
    return updated.changes === 1;
  }

  /**
   * Mark a non-terminal intent blocked (e.g. deadline expired). Not fenced —
   * used by sweep bookkeeping rather than a claim holder; still refuses to
   * rewrite terminal rows.
   */
  markBlocked(intentId: string, reason: string, nowIso: string): boolean {
    const updated = this.db
      .prepare(
        `UPDATE intents SET state = 'blocked', last_error = $error,
           fencing_token = fencing_token + 1,
           lease_owner = NULL, lease_expires_at = NULL, run_id = NULL,
           updated_at = $now
         WHERE id = $id AND state NOT IN ('completed', 'cancelled', 'blocked')`,
      )
      .run({ $error: reason, $now: nowIso, $id: intentId });
    return updated.changes === 1;
  }

  /**
   * Evidence resync for a NON-running intent (cancelled/terminal reads, or
   * reconciliation updating the view after an external heal). Only step
   * references are refreshed — never state — so a cancelled record stays
   * cancelled while honestly showing which effects landed.
   */
  recordObservedSteps(intentId: string, steps: IntentStep[], nowIso: string): void {
    this.db
      .prepare(
        `UPDATE intents SET steps_json = $steps, updated_at = $now
         WHERE id = $id AND state != 'running'`,
      )
      .run({ $steps: JSON.stringify(steps), $now: nowIso, $id: intentId });
  }

  /**
   * Evidence-driven settle for a non-running, non-terminal intent after
   * reconciliation: heals to completed when every referenced effect durably
   * landed, or re-parks as uncertain when evidence is still absent. Never
   * rewrites terminal rows and never revives a running claim.
   */
  settleFromEvidence(intentId: string, state: "completed" | "uncertain", steps: IntentStep[], nowIso: string): boolean {
    const updated = this.db
      .prepare(
        `UPDATE intents SET state = $state, steps_json = $steps,
           lease_owner = NULL, lease_expires_at = NULL, run_id = NULL,
           completed_at = CASE WHEN $terminal THEN $now ELSE completed_at END,
           updated_at = $now
         WHERE id = $id AND state NOT IN ('completed', 'cancelled', 'running')`,
      )
      .run({ $state: state, $steps: JSON.stringify(steps), $terminal: state === "completed" ? 1 : 0, $now: nowIso, $id: intentId });
    return updated.changes === 1;
  }

  /** Intents whose steps reference a provider operation key (for reconcile routing). */
  listByOperationKey(operationKey: string): IntentRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM intents WHERE steps_json LIKE $needle ORDER BY created_at, rowid")
      .all({ $needle: `%"${operationKey.replace(/"/g, "")}"%` }) as unknown[];
    return rows
      .map((value) => this.toIntent(row(value)))
      .filter((intent) => intent.steps.some((step) => step.operationKey === operationKey));
  }

  private toIntent(value: SqlRow): IntentRecord {
    return {
      id: String(value.id),
      commandKey: String(value.command_key),
      kind: String(value.kind) as IntentKind,
      payload: parseJson(value.payload_json, {}),
      payloadHash: String(value.payload_hash),
      mode: String(value.mode),
      businessId: value.business_id === null ? undefined : String(value.business_id),
      bookingId: value.booking_id === null ? undefined : String(value.booking_id),
      proposedActionId: value.proposed_action_id === null ? undefined : String(value.proposed_action_id),
      proposalVersion: value.proposal_version === null ? undefined : Number(value.proposal_version),
      state: String(value.state) as IntentState,
      steps: parseJson<IntentStep[]>(value.steps_json, []),
      leaseOwner: value.lease_owner === null ? undefined : String(value.lease_owner),
      fencingToken: Number(value.fencing_token),
      leaseExpiresAt: value.lease_expires_at === null ? undefined : String(value.lease_expires_at),
      deadlineAt: value.deadline_at === null ? undefined : String(value.deadline_at),
      runId: value.run_id === null ? undefined : String(value.run_id),
      attempts: Number(value.attempts),
      lastError: value.last_error === null ? undefined : String(value.last_error),
      cancelledBy: value.cancelled_by === null ? undefined : String(value.cancelled_by),
      createdAt: String(value.created_at),
      updatedAt: String(value.updated_at),
      completedAt: value.completed_at === null ? undefined : String(value.completed_at),
      cancelledAt: value.cancelled_at === null ? undefined : String(value.cancelled_at),
    };
  }
}
