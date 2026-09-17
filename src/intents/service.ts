import { randomUUID } from "node:crypto";
import { availabilityOperationKey } from "../connectors/contracts.ts";
import type { ConnectorMetadata } from "../connectors/contracts.ts";
import { CoordinationLedger } from "../coordination/ledger.ts";
import type { ActionExecution, ProposedAction, SourceReference } from "../domain/contracts.ts";
import {
  emailOperationKey,
  holdOperationKey,
  ownerIdentity,
  reconcileExecution,
  resolveHoldParams,
  ServiceError,
  STEP_CLAIM_LEASE_MS,
  type BookingServiceDeps,
  type HoldParams,
} from "../server/booking-service.ts";
import type { GatherStore } from "../server/sqlite-store.ts";
import { IntentStore, type IntentFilter } from "./store.ts";
import {
  assertValidCommand,
  canonicalHash,
  defaultCommandKey,
  type EnqueueInput,
  type IntentCommand,
  type IntentDTO,
  type IntentLease,
  type IntentRecord,
  type IntentStep,
} from "./types.ts";

/**
 * The single progression owner for durable intents (ADR-002 / C06).
 *
 * Composition, not a new scheduler: the intent lane reuses the existing
 * building blocks — GatherStore execution claims (reserveStepExecution,
 * claim-token completion, reconcile-before-retry), the CoordinationLedger
 * (applyOwnerControl for attested control, control state consulted between
 * steps), and the existing provider reconciliation ports. The operator
 * host's per-account sweep drains due intents inside the same guarded tick
 * (see operator-runtime/automation.ts), and process start/shutdown stay in
 * the existing host (server/runtime.ts + proactive/bootstrap.ts). No second
 * timer, queue, or receipt store is introduced.
 *
 * Honest-uncertainty rules (C06):
 * - Provider operation identity (operationKey) is bound into the intent's
 *   steps BEFORE any dispatch; the execution row is reserved before the
 *   provider call.
 * - A reclaimed/crashed step is reconciled by stable key first: found
 *   provider evidence heals the step to done; no evidence leaves it
 *   uncertain — a missing search result NEVER licenses a blind retry.
 * - Cancellation fences the in-flight claim: the next guarded write fails
 *   and no further step dispatches, while already-landed effects keep
 *   their honest receipts.
 */

/** Intent claim lease: how long one advance pass may run before reclaim. */
export const DEFAULT_INTENT_LEASE_MS = 120_000;
/** Default execution deadline measured from submit (30 minutes). */
export const DEFAULT_INTENT_DEADLINE_MS = 30 * 60 * 1000;
/** Bounded re-drive budget for transient internal failures before blocking. */
export const MAX_INTENT_ATTEMPTS = 8;

export interface IntentServiceDeps {
  /** Existing booking service deps: shared store + dispatching calendar/email connectors. */
  booking: BookingServiceDeps;
  /** Installation mode label stamped on every intent ("prepared" | "live" | unmanaged). */
  mode?: string;
  /** Injectable ISO clock (defaults to the booking clock, then wall clock). */
  now?: () => string;
  leaseMs?: number;
  deadlineMs?: number;
}

export interface EnqueueResult {
  intent: IntentRecord;
  /** True when an identical command key already existed (canonical replay). */
  duplicate: boolean;
}

export interface ClaimedIntent {
  intent: IntentRecord;
  lease: IntentLease;
}

export interface DrainReport {
  claimed: string[];
  completed: string[];
  retryable: string[];
  uncertain: string[];
  blocked: string[];
  /** Ids whose claim was lost to a concurrent fenced owner. */
  fenced: string[];
  errors: Array<{ intentId: string; message: string }>;
}

export type ReconcileOutcome = "healed" | "pending" | "blocked" | "settled";

export interface ReconcileReport {
  operationKey: string;
  outcome: ReconcileOutcome;
  execution: ActionExecution;
  /** Intents referencing this operation key after resync. */
  intents: IntentRecord[];
  error?: string;
}

type StepOutcome =
  | { status: "done" }
  | { status: "uncertain"; error: string }
  | { status: "failed"; error: string; retryable: boolean }
  | { status: "blocked"; error: string };

/** Attach the connector's preserved proof to a succeeded step result (same shape as the sync pipeline). */
function provenResult(outcome: { metadata: ConnectorMetadata; data: { provenance?: SourceReference[] } }): Record<string, unknown> {
  const refs = Array.isArray(outcome.data.provenance) ? outcome.data.provenance : [];
  return {
    ...(outcome.data as Record<string, unknown>),
    proof: {
      mode: outcome.metadata.mode.mode,
      simulated: outcome.metadata.simulated,
      provenance: refs.map((ref) => ({ ...(ref as SourceReference) })),
    },
  };
}

function commandPayload(command: IntentCommand): Record<string, unknown> {
  return { ...command } as Record<string, unknown>;
}

export class IntentService {
  readonly intents: IntentStore;
  private readonly deps: BookingServiceDeps;
  private readonly store: GatherStore;
  private readonly ledger: CoordinationLedger;
  private readonly mode: string;
  private readonly leaseMs: number;
  private readonly deadlineMs: number;
  private readonly clock: () => string;

  constructor(options: IntentServiceDeps) {
    this.deps = options.booking;
    this.store = options.booking.store;
    this.intents = new IntentStore(this.store);
    this.mode = options.mode ?? "prepared";
    this.clock = options.now ?? this.deps.now ?? (() => new Date().toISOString());
    this.ledger = new CoordinationLedger(this.store.db, { clock: () => this.clock() });
    this.leaseMs = options.leaseMs ?? DEFAULT_INTENT_LEASE_MS;
    this.deadlineMs = options.deadlineMs ?? DEFAULT_INTENT_DEADLINE_MS;
  }

  private nowIso(): string {
    return this.clock();
  }

  private nowMs(): number {
    const parsed = Date.parse(this.clock());
    return Number.isFinite(parsed) ? parsed : Date.now();
  }

  // ------------------------------------------------------------------ ports

  /**
   * enqueue(command, expectedVersion): validate, dedupe by stable command
   * key, and COMMIT the queued intent before returning. An identical retry
   * returns the same intent; a reused key carrying different content
   * conflicts (409). Semantic validation (action exists, exact version, live
   * window) runs here so a malformed or stale command never gains a record.
   */
  enqueue(rawInput: EnqueueInput): EnqueueResult {
    const command = assertValidCommand(rawInput.command);
    const commandKey = rawInput.commandKey ?? defaultCommandKey(command);
    const payload = commandPayload(command);
    const payloadHash = canonicalHash(payload);
    const existing = this.intents.getByCommandKey(commandKey);
    if (existing) {
      if (existing.payloadHash !== payloadHash) {
        throw new ServiceError("CONFLICT", `Intent command key ${commandKey} is already bound to a different command`, false);
      }
      return { intent: existing, duplicate: true };
    }
    if (rawInput.expectedVersion !== undefined && command.kind === "approve_booking_proposal" && command.proposalVersion !== rawInput.expectedVersion) {
      throw new ServiceError("INVALID_REQUEST", "expectedVersion does not match the command's proposalVersion", false);
    }
    const bound = this.bindCommand(command);
    const deadlineAt = new Date(this.nowMs() + (rawInput.deadlineMs ?? this.deadlineMs)).toISOString();
    const inserted = this.intents.insertIntent({
      commandKey,
      kind: command.kind,
      payload,
      payloadHash,
      mode: this.mode,
      ...(bound.businessId === undefined ? {} : { businessId: bound.businessId }),
      ...(bound.bookingId === undefined ? {} : { bookingId: bound.bookingId }),
      ...(bound.proposedActionId === undefined ? {} : { proposedActionId: bound.proposedActionId }),
      ...(bound.proposalVersion === undefined ? {} : { proposalVersion: bound.proposalVersion }),
      steps: bound.steps,
      deadlineAt,
      nowIso: this.nowIso(),
    });
    if (!inserted) {
      // Lost a submit race on another connection: classify the winner's row.
      const winner = this.intents.getByCommandKey(commandKey);
      if (!winner) throw new ServiceError("CONFLICT", "Intent submit raced but no winner row is visible", true);
      if (winner.payloadHash !== payloadHash) {
        throw new ServiceError("CONFLICT", `Intent command key ${commandKey} is already bound to a different command`, false);
      }
      return { intent: winner, duplicate: true };
    }
    return { intent: inserted, duplicate: false };
  }

  /**
   * claimDue(now, owner): mark deadline-expired work blocked, then atomically
   * claim runnable intents. The conditional update guarantees exactly one
   * winner per intent across processes/connections; losers get nothing.
   */
  claimDue(input: { owner: string; nowIso?: string; businessId?: string; limit?: number }): ClaimedIntent[] {
    const nowIso = input.nowIso ?? this.nowIso();
    for (const stale of this.intents.listDeadlineExpired(nowIso)) {
      this.intents.markBlocked(stale.id, "Execution deadline passed before the intent could be advanced", nowIso);
    }
    const claimed: ClaimedIntent[] = [];
    for (const candidate of this.intents.listRunnable(nowIso, input.businessId)) {
      if (claimed.length >= (input.limit ?? 25)) break;
      const lease = this.intents.claim(candidate.id, input.owner, nowIso, this.leaseMs);
      if (lease === undefined) continue; // a concurrent claim won the fencing race
      claimed.push({ intent: this.intents.getIntent(candidate.id), lease });
    }
    return claimed;
  }

  /**
   * advance(intent, lease): drive the claimed intent's remaining steps. Every
   * step boundary re-reads the row under the claim's fencing triple — a
   * cancellation, reclaim, or expired lease stops progression before the next
   * effect. Already-landed provider effects keep their durable receipts.
   */
  async advance(intentId: string, lease: IntentLease): Promise<IntentRecord> {
    let record = this.intents.getIntent(intentId);
    if (!this.ownsClaim(record, lease)) return record;
    for (;;) {
      record = this.intents.getIntent(intentId);
      if (!this.ownsClaim(record, lease)) return record; // cancelled or reclaimed between awaits
      const next = record.steps.find((step) => step.status === "pending" || step.status === "failed");
      if (!next) {
        this.intents.finishClaim(intentId, lease, "completed", { steps: record.steps }, this.nowIso());
        return this.intents.getIntent(intentId);
      }
      if (record.deadlineAt !== undefined && Date.parse(record.deadlineAt) <= this.nowMs()) {
        this.intents.finishClaim(intentId, lease, "blocked", { lastError: "Execution deadline passed; no further steps were dispatched" }, this.nowIso());
        return this.intents.getIntent(intentId);
      }
      let outcome: StepOutcome;
      try {
        outcome = await this.runStep(record, next, lease);
      } catch (error) {
        outcome = this.mapUnexpected(error, record);
      }
      // Persist step progress under the fencing triple. A failed write means
      // the claim was fenced mid-step (cancel/reclaim): stop immediately —
      // the next step must not dispatch under a dead claim.
      const steps = this.applyOutcome(record.steps, next.name, outcome);
      if (outcome.status === "done") {
        if (!this.intents.updateProgress(intentId, lease, { steps }, this.nowIso())) return this.intents.getIntent(intentId);
        continue;
      }
      const target = outcome.status === "uncertain" ? "uncertain" : outcome.status === "blocked" ? "blocked" : outcome.retryable ? "retryable" : "blocked";
      this.intents.finishClaim(intentId, lease, target, { steps, lastError: outcome.error }, this.nowIso());
      return this.intents.getIntent(intentId);
    }
  }

  /**
   * reconcile(operationKey): read-only provider reconciliation for one stable
   * operation identity, then resync every intent whose steps reference it.
   * Missing provider evidence leaves the step uncertain — never a retry.
   */
  async reconcile(operationKey: string): Promise<ReconcileReport> {
    const execution = this.store.getExecutionByIdempotencyKey(operationKey);
    if (!execution) {
      throw new ServiceError("NOT_FOUND", `No execution exists for operation key ${operationKey}`, false);
    }
    let outcome: ReconcileOutcome;
    let error: string | undefined;
    let current = execution;
    if (execution.status !== "uncertain" && execution.status !== "partial") {
      outcome = "settled";
    } else {
      try {
        await reconcileExecution(this.deps, execution.id);
        current = this.store.getActionExecution(execution.id);
        outcome = current.status === "succeeded" ? "healed" : "pending";
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
        if (caught instanceof ServiceError && caught.code === "RECONCILE_PENDING") {
          outcome = "pending";
        } else {
          outcome = "blocked";
        }
      }
    }
    const intents = this.intents.listByOperationKey(operationKey).map((intent) => this.resyncFromEvidence(intent));
    return { operationKey, outcome, execution: current, intents, ...(error === undefined ? {} : { error }) };
  }

  /**
   * cancel(intent, owner): host-attested cancellation. Fences the live claim
   * so no further step can dispatch after the next await boundary. Terminal
   * records retain their state: a completed or cancelled intent is never
   * rewritten (applied:false).
   */
  cancel(intentId: string, owner: string): { intent: IntentRecord; applied: boolean } {
    const result = this.intents.markCancelled(intentId, owner, this.nowIso());
    // Keep the step view honest for the cancelled record: effects that
    // already landed keep their observed status.
    this.intents.recordObservedSteps(intentId, this.evidenceSteps(result.record), this.nowIso());
    return { intent: this.intents.getIntent(intentId), applied: result.applied };
  }

  /** get(intentId): persisted progress with evidence-resolved step view. */
  get(intentId: string): IntentRecord {
    return this.intents.getIntent(intentId);
  }

  /** List intents (bounded) with optional scope filters. */
  list(filter: IntentFilter = {}): IntentRecord[] {
    return this.intents.listIntents(filter);
  }

  /** DTO for API responses: persisted record plus evidence-resolved steps. */
  toDTO(record: IntentRecord): IntentDTO {
    return {
      id: record.id,
      commandKey: record.commandKey,
      kind: record.kind,
      state: record.state,
      mode: record.mode,
      ...(record.businessId === undefined ? {} : { businessId: record.businessId }),
      ...(record.bookingId === undefined ? {} : { bookingId: record.bookingId }),
      ...(record.proposedActionId === undefined ? {} : { proposedActionId: record.proposedActionId }),
      ...(record.proposalVersion === undefined ? {} : { proposalVersion: record.proposalVersion }),
      steps: this.evidenceSteps(record),
      attempts: record.attempts,
      ...(record.lastError === undefined ? {} : { lastError: record.lastError }),
      ...(record.runId === undefined ? {} : { runId: record.runId }),
      ...(record.deadlineAt === undefined ? {} : { deadlineAt: record.deadlineAt }),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...(record.completedAt === undefined ? {} : { completedAt: record.completedAt }),
      ...(record.cancelledAt === undefined ? {} : { cancelledAt: record.cancelledAt }),
      ...(record.cancelledBy === undefined ? {} : { cancelledBy: record.cancelledBy }),
    };
  }

  /**
   * Claim one specific intent (when runnable) and advance it. `reopenBlocked`
   * is the explicit-owner-action path: after the blocking cause is fixed
   * (reconnect, re-approval), an advance may re-drive a blocked intent —
   * drains never claim blocked rows on their own.
   */
  async drive(intentId: string, owner: string, opts: { reopenBlocked?: boolean } = {}): Promise<IntentRecord> {
    const lease = this.intents.claim(intentId, owner, this.nowIso(), this.leaseMs, { includeBlocked: opts.reopenBlocked === true });
    if (lease === undefined) return this.intents.getIntent(intentId);
    return this.advance(intentId, lease);
  }

  /** Sweep stage: claim and advance all runnable intents for one business. */
  async drainDue(input: { owner: string; businessId?: string; limit?: number } = { owner: "intent-drain" }): Promise<DrainReport> {
    const report: DrainReport = { claimed: [], completed: [], retryable: [], uncertain: [], blocked: [], fenced: [], errors: [] };
    for (const { intent, lease } of this.claimDue(input)) {
      report.claimed.push(intent.id);
      try {
        const settled = await this.advance(intent.id, lease);
        if (settled.runId !== undefined && settled.state === "running") {
          report.fenced.push(intent.id); // still running under someone else's claim
          continue;
        }
        report[this.bucketOf(settled.state)].push(intent.id);
      } catch (error) {
        report.errors.push({ intentId: intent.id, message: error instanceof Error ? error.message : String(error) });
      }
    }
    return report;
  }

  /**
   * Restart reconciliation (process start, called once by the host): every
   * `running` intent's prior owner is dead. Effects are CHECKED before the
   * row is reclaimed — uncertain steps get a read-only provider reconcile;
   * then the record moves to completed / uncertain / retryable by evidence.
   * Reclaimed intents are never blind-replayed: re-drive reconciles each
   * step's durable execution state before any new write.
   */
  async recoverInterrupted(): Promise<{ recovered: string[]; completed: string[]; uncertain: string[]; errors: string[] }> {
    const report = { recovered: [] as string[], completed: [] as string[], uncertain: [] as string[], errors: [] as string[] };
    for (const intent of this.intents.listRunning()) {
      try {
        const settled = await this.reconcileIntentEffects(intent);
        const steps = this.evidenceSteps(this.intents.getIntent(intent.id));
        const target = settled === "complete" ? "completed" : settled === "uncertain" ? "uncertain" : "retryable";
        const note = settled === "complete"
          ? null
          : settled === "uncertain"
            ? "Restart: a step's provider outcome is still unproven; held for reconciliation"
            : "Restart: prior progression owner lost; remaining steps re-run under a fresh claim with reconcile-first";
        this.intents.recoverRunning(intent.id, target, { steps, lastError: note }, this.nowIso());
        report.recovered.push(intent.id);
        if (target === "completed") report.completed.push(intent.id);
        if (target === "uncertain") report.uncertain.push(intent.id);
      } catch (error) {
        report.errors.push(`${intent.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return report;
  }

  // ------------------------------------------------------------- internals

  private bucketOf(state: IntentRecord["state"]): "completed" | "retryable" | "uncertain" | "blocked" | "fenced" {
    return state === "completed" ? "completed" : state === "uncertain" ? "uncertain" : state === "blocked" ? "blocked" : state === "cancelled" ? "fenced" : "retryable";
  }

  private ownsClaim(record: IntentRecord, lease: IntentLease): boolean {
    return (
      record.state === "running" &&
      record.runId === lease.runId &&
      record.fencingToken === lease.fencingToken &&
      record.leaseExpiresAt !== undefined &&
      Date.parse(record.leaseExpiresAt) > this.nowMs()
    );
  }

  private applyOutcome(steps: IntentStep[], name: string, outcome: StepOutcome): IntentStep[] {
    return steps.map((step) => {
      if (step.name !== name) return step;
      const status: IntentStep["status"] = outcome.status === "done" ? "done" : outcome.status === "uncertain" ? "uncertain" : "failed";
      return { ...step, status, at: this.nowIso(), error: outcome.status === "done" ? undefined : outcome.error };
    });
  }

  private mapUnexpected(error: unknown, record: IntentRecord): StepOutcome {
    if (error instanceof ServiceError) {
      switch (error.code) {
        case "RECONCILE_PENDING":
        case "UNCERTAIN":
          return { status: "uncertain", error: error.message };
        case "CONFLICT":
          return error.retryable
            ? { status: "failed", error: error.message, retryable: true }
            : { status: "blocked", error: error.message };
        case "RECONCILE_REQUIRED":
          return { status: "uncertain", error: error.message };
        default:
          return { status: "blocked", error: error.message };
      }
    }
    // Transient/unknown failures stay retryable until the attempt budget is
    // exhausted; then the intent blocks rather than looping forever.
    if (record.attempts >= MAX_INTENT_ATTEMPTS) {
      return { status: "blocked", error: `Attempt budget exhausted (${MAX_INTENT_ATTEMPTS}): ${error instanceof Error ? error.message : String(error)}` };
    }
    return { status: "failed", error: error instanceof Error ? error.message : String(error), retryable: true };
  }

  /**
   * Read-only evidence resync for one intent's steps and (when not terminal
   * or running) its state. Used after reconcile/recovery and on read — the
   * step view always reflects the durable execution rows it references.
   */
  private resyncFromEvidence(intent: IntentRecord): IntentRecord {
    const steps = this.evidenceSteps(intent);
    this.intents.recordObservedSteps(intent.id, steps, this.nowIso());
    const current = this.intents.getIntent(intent.id);
    if (current.state === "cancelled" || current.state === "completed" || current.state === "running") {
      return current;
    }
    if (steps.every((step) => step.status === "done" || step.status === "skipped")) {
      this.intents.settleFromEvidence(intent.id, "completed", steps, this.nowIso());
    } else if (steps.some((step) => step.status === "uncertain")) {
      this.intents.settleFromEvidence(intent.id, "uncertain", steps, this.nowIso());
    }
    return this.intents.getIntent(intent.id);
  }

  /** Steps overlaid with the current durable evidence rows they reference. */
  private evidenceSteps(intent: IntentRecord): IntentStep[] {
    return intent.steps.map((step) => {
      const execution = step.executionId !== undefined
        ? this.executionById(step.executionId)
        : step.operationKey !== undefined
          ? this.store.getExecutionByIdempotencyKey(step.operationKey)
          : undefined;
      if (step.name === "approve" && intent.proposedActionId !== undefined) {
        const live = this.store.listApprovals(intent.proposedActionId).some((approval) => approval.status === "approved");
        if (live && step.status !== "done") return { ...step, status: "done" };
        return step;
      }
      if (execution === undefined) return step;
      const status: IntentStep["status"] =
        execution.status === "succeeded" ? "done"
        : execution.status === "failed" ? "failed"
        : execution.status === "pending" ? (step.status === "done" ? "done" : "pending")
        : "uncertain";
      return { ...step, executionId: execution.id, status };
    });
  }

  private executionById(id: string): ActionExecution | undefined {
    try {
      return this.store.getActionExecution(id);
    } catch {
      return undefined;
    }
  }

  /**
   * Effect check used by restart recovery: reconcile each uncertain/partial
   * step execution read-only. Returns the aggregate evidence verdict.
   */
  private async reconcileIntentEffects(intent: IntentRecord): Promise<"complete" | "uncertain" | "incomplete"> {
    let sawUncertain = false;
    for (const step of intent.steps) {
      const execution = step.executionId !== undefined
        ? this.executionById(step.executionId)
        : step.operationKey !== undefined
          ? this.store.getExecutionByIdempotencyKey(step.operationKey)
          : undefined;
      if (execution === undefined) continue;
      if (execution.status === "uncertain" || execution.status === "partial") {
        try {
          await reconcileExecution(this.deps, execution.id);
        } catch {
          sawUncertain = true;
          continue;
        }
        const healed = this.executionById(execution.id);
        if (!healed || healed.status !== "succeeded") sawUncertain = true;
      }
    }
    const steps = this.evidenceSteps(this.intents.getIntent(intent.id));
    if (steps.every((step) => step.status === "done" || step.status === "skipped")) return "complete";
    return sawUncertain || steps.some((step) => step.status === "uncertain") ? "uncertain" : "incomplete";
  }

  /**
   * Validate a command against current durable state and derive the intent's
   * bound references + step plan. Provider operation identity is bound here,
   * BEFORE any dispatch (C06).
   */
  private bindCommand(command: IntentCommand): {
    businessId?: string;
    bookingId?: string;
    proposedActionId?: string;
    proposalVersion?: number;
    steps: IntentStep[];
  } {
    if (command.kind === "approve_booking_proposal") {
      const action = this.getAction(command.proposedActionId);
      if (action.bookingId !== command.bookingId) {
        throw new ServiceError("CROSS_BOOKING", "Proposed action belongs to a different booking; cross-booking approval is denied", false);
      }
      if (action.proposalVersion !== command.proposalVersion || action.proposalFingerprint !== command.proposalFingerprint) {
        throw new ServiceError(
          "STALE_PROPOSAL",
          `Stale proposal: expected v${action.proposalVersion}/${action.proposalFingerprint.slice(0, 12)}..., refusing approval intent`,
          false,
        );
      }
      if (!this.store.isCurrentProposalAction(action.id)) {
        throw new ServiceError("STALE_PROPOSAL", "This proposal is no longer current: a newer proposal superseded it — re-approve the displayed proposal", false);
      }
      const booking = this.getBooking(command.bookingId);
      if (booking.status === "cancelled") {
        throw new ServiceError("CONFLICT", "This booking was cancelled; no further booking actions are permitted", false);
      }
      if (action.kind !== "create_provisional_hold") {
        throw new ServiceError("INVALID_REQUEST", `Unsupported proposal kind "${action.kind}": only a provisional-hold + email plan is executable`, false);
      }
      resolveHoldParams(action.payload, { nowMs: this.nowMs() });
      return {
        businessId: booking.businessId,
        bookingId: booking.id,
        proposedActionId: action.id,
        proposalVersion: action.proposalVersion,
        steps: [
          { name: "approve", status: "pending" },
          { name: "hold", status: "pending", operationKey: holdOperationKey(action.id, action.proposalVersion) },
          { name: "email", status: "pending", operationKey: emailOperationKey(action.id, action.proposalVersion) },
        ],
      };
    }
    if (command.kind === "reconcile_execution") {
      const execution = this.executionById(command.executionId);
      if (!execution) {
        throw new ServiceError("NOT_FOUND", `Action execution not found: ${command.executionId}`, false);
      }
      const action = this.getAction(execution.proposedActionId);
      const booking = this.getBooking(action.bookingId);
      return {
        businessId: booking.businessId,
        bookingId: booking.id,
        proposedActionId: action.id,
        proposalVersion: execution.proposalVersion,
        steps: [{ name: "reconcile", status: "pending", operationKey: execution.idempotencyKey, executionId: execution.id }],
      };
    }
    const booking = this.getBooking(command.bookingId);
    return {
      businessId: booking.businessId,
      bookingId: booking.id,
      steps: [{ name: "control", status: "pending" }],
    };
  }

  private getAction(actionId: string): ProposedAction {
    try {
      return this.store.getProposedAction(actionId);
    } catch {
      throw new ServiceError("NOT_FOUND", `Proposed action not found: ${actionId}`, false);
    }
  }

  private getBooking(bookingId: string) {
    try {
      return this.store.getBooking(bookingId);
    } catch {
      throw new ServiceError("NOT_FOUND", `Booking not found: ${bookingId}`, false);
    }
  }

  // --------------------------------------------------------- step executors

  private async runStep(record: IntentRecord, step: IntentStep, _lease: IntentLease): Promise<StepOutcome> {
    switch (record.kind) {
      case "approve_booking_proposal":
        if (step.name === "approve") return this.stepApprove(record);
        if (step.name === "hold") return this.stepProvider(record, step, "hold");
        return this.stepProvider(record, step, "email");
      case "reconcile_execution":
        return this.stepReconcile(record, step);
      case "owner_control":
        return this.stepOwnerControl(record);
    }
  }

  /**
   * Authority gate consulted at every step boundary AND after every provider
   * await: intent cancellation, booking cancellation, and owner pause/cancel
   * (CoordinationLedger control state) all block the next effect. Landed
   * effects keep their receipts; only UNSENT steps are blocked.
   */
  private authorityBlock(record: IntentRecord): StepOutcome | undefined {
    const fresh = this.intents.getIntent(record.id);
    if (fresh.state === "cancelled") {
      return { status: "blocked", error: "Intent was cancelled while a provider call was in flight" };
    }
    if (record.bookingId !== undefined) {
      const booking = this.getBooking(record.bookingId);
      if (booking.status === "cancelled") {
        return { status: "blocked", error: "The booking was cancelled while a provider call was in flight" };
      }
      const control = this.ledger.controlStateForBooking(record.bookingId);
      if (control === "cancelled" || control === "paused") {
        return { status: "blocked", error: `Owner ${control} landed while a provider call was in flight; remaining effects are blocked` };
      }
    }
    return undefined;
  }

  /** Approve step: exact-version + current-pointer + supported-kind gate, then the durable approval row. */
  private stepApprove(record: IntentRecord): StepOutcome {
    const blocked = this.authorityBlock(record);
    if (blocked !== undefined) return blocked;
    const command = record.payload as Record<string, unknown>;
    const action = this.getAction(String(command.proposedActionId));
    if (action.bookingId !== record.bookingId) return { status: "blocked", error: "Proposed action belongs to a different booking" };
    if (action.proposalVersion !== record.proposalVersion || action.proposalFingerprint !== command.proposalFingerprint) {
      return { status: "blocked", error: `Stale proposal: expected v${action.proposalVersion}; re-submit the displayed proposal` };
    }
    if (!this.store.isCurrentProposalAction(action.id)) {
      return { status: "blocked", error: "This proposal is no longer current; re-approve the displayed proposal" };
    }
    if (action.kind !== "create_provisional_hold") {
      return { status: "blocked", error: `Unsupported proposal kind "${action.kind}"` };
    }
    const booking = this.getBooking(action.bookingId);
    if (booking.status === "cancelled") return { status: "blocked", error: "This booking was cancelled" };
    try {
      resolveHoldParams(action.payload, { nowMs: this.nowMs() });
    } catch (error) {
      return { status: "blocked", error: error instanceof Error ? error.message : "Incomplete proposal payload" };
    }
    this.store.approveProposedAction(action.id, ownerIdentity(this.deps));
    return { status: "done" };
  }

  /**
   * Provider step (hold or email): reserve the durable execution claim, run
   * the guarded connector call, and map every outcome honestly. Reclaimed or
   * uncertain rows are reconciled by stable key BEFORE any new write.
   */
  private async stepProvider(record: IntentRecord, step: IntentStep, kind: "hold" | "email"): Promise<StepOutcome> {
    const action = this.getAction(record.proposedActionId as string);
    const version = record.proposalVersion as number;
    const key = step.operationKey ?? (kind === "hold" ? holdOperationKey(action.id, version) : emailOperationKey(action.id, version));
    let params: HoldParams;
    try {
      params = resolveHoldParams(action.payload, { nowMs: this.nowMs() });
    } catch (error) {
      return { status: "blocked", error: error instanceof Error ? error.message : "Incomplete proposal payload" };
    }
    // Pre-dispatch authority check: owner pause/cancel or a cancelled booking
    // blocks the provider write before it can even be attempted — the same
    // gate the post-await check enforces mid-flight.
    const preBlocked = this.authorityBlock(record);
    if (preBlocked !== undefined) return preBlocked;
    // Eligibility: email requires the hold receipt to have durably landed.
    if (kind === "email") {
      const hold = this.store.getExecutionByIdempotencyKey(holdOperationKey(action.id, version));
      if (hold?.status !== "succeeded") {
        return { status: "uncertain", error: "Email step is not eligible: the hold step has no succeeded receipt yet" };
      }
    }

    const existing = this.store.getExecutionByIdempotencyKey(key);
    if (existing?.status === "succeeded") return { status: "done" };
    if (existing && (existing.status === "uncertain" || existing.status === "partial")) {
      return this.reconcileStepExecution(existing.id);
    }

    if (kind === "hold") {
      // Fresh availability immediately before any hold write — skipped only
      // when the hold already succeeded or must be reconciled instead (no
      // write can occur on either path). Runs before reserving so a
      // slot-blocked hold never orphans a pending execution row.
      const fresh = await this.checkFreshAvailability(record, action, params, key);
      if (fresh !== undefined) return fresh;
    }

    let claimToken = randomUUID();
    let execution: ActionExecution;
    try {
      const reservation = this.store.reserveStepExecution(action.id, version, key, {
        claimToken,
        leaseMs: STEP_CLAIM_LEASE_MS,
        nowMs: this.nowMs(),
      });
      execution = reservation.execution;
      if (execution.status === "succeeded") return { status: "done" };
      if (execution.status === "uncertain" || execution.status === "partial") {
        return this.reconcileStepExecution(execution.id);
      }
      if (reservation.reclaimed) {
        // The prior owner crashed mid-dispatch: reconcile by stable key
        // before ANY write; a missing provider record leaves the step
        // uncertain — never a blind retry.
        return this.recoverReclaimedStep(record, execution, key, claimToken, kind);
      }
      if (execution.status === "failed") {
        // An explicit re-drive may reopen a failed step under a fresh claim.
        claimToken = randomUUID();
        execution = this.store.reopenFailedStep(execution.id, {
          claimToken,
          leaseMs: STEP_CLAIM_LEASE_MS,
          nowMs: this.nowMs(),
        });
      } else if (!reservation.created) {
        return { status: "failed", error: `${kind} step is already in progress under another claim`, retryable: true };
      }
    } catch (error) {
      if (error instanceof Error && /already in progress/.test(error.message)) {
        return { status: "failed", error: `${kind} step is already in progress; wait or reconcile`, retryable: true };
      }
      if (error instanceof Error && /exact current proposal version|Stale proposal version|requires approval/.test(error.message)) {
        return { status: "blocked", error: "The proposal changed or lost approval while the intent was in flight; re-approve the displayed proposal" };
      }
      throw error;
    }

    const claim = { claimToken };
    try {
      const outcome =
        kind === "hold"
          ? await this.deps.calendar.createProvisionalHold({
              operationKey: key,
              bookingId: action.bookingId,
              calendarId: params.calendarId,
              startAt: params.startAt,
              endAt: params.endAt,
              expiresAt: params.expiresAt,
            })
          : await this.deps.email.sendEmail({
              operationKey: key,
              to: params.emailTo,
              subject: params.emailSubject,
              body: params.emailBody,
            });
      const stale = this.authorityBlock(record);
      if (outcome.status === "succeeded") {
        this.store.completeActionExecution(execution.id, { status: "succeeded", result: provenResult(outcome) }, claim);
        if (kind === "hold") this.updateBookingProgress(action.bookingId, "provisional_hold");
        if (stale !== undefined) return stale;
        return { status: "done" };
      }
      if (outcome.status === "uncertain") {
        // Persist uncertainty BEFORE any retry, then one read-only reconcile.
        this.store.markExecutionUncertain(execution.id, outcome.error.message, claim);
        this.updateBookingProgress(action.bookingId, "uncertain");
        const found = await this.reconcileByKey(key, kind);
        if (found) {
          this.updateBookingProgress(action.bookingId, "provisional_hold");
          if (stale !== undefined) return stale;
          return { status: "done" };
        }
        return { status: "uncertain", error: outcome.error.message };
      }
      const failed = outcome.error;
      this.store.completeActionExecution(execution.id, { status: "failed", error: failed.message }, claim);
      if (kind === "hold") this.updateBookingProgress(action.bookingId, "failed");
      if (failed.kind === "access_revoked" || failed.kind === "authorization_denied") {
        return { status: "blocked", error: failed.message };
      }
      if (stale !== undefined) return stale;
      return { status: "failed", error: failed.message, retryable: failed.retryable };
    } catch (error) {
      this.store.markExecutionUncertain(execution.id, error instanceof Error ? error.message : `${kind} outcome was not received`, claim);
      return { status: "uncertain", error: error instanceof Error ? error.message : `${kind} outcome was not received` };
    }
  }

  /**
   * Reconcile one uncertain/partial execution through the existing service
   * (exact-approval revalidated inside). No provider evidence keeps the step
   * uncertain; nothing is retried.
   */
  private async reconcileStepExecution(executionId: string): Promise<StepOutcome> {
    try {
      await reconcileExecution(this.deps, executionId);
    } catch (error) {
      if (error instanceof ServiceError) {
        if (error.code === "RECONCILE_PENDING") return { status: "uncertain", error: error.message };
        return { status: "blocked", error: error.message };
      }
      return { status: "uncertain", error: error instanceof Error ? error.message : String(error) };
    }
    const healed = this.executionById(executionId);
    return healed?.status === "succeeded" ? { status: "done" } : { status: "uncertain", error: "Reconciliation left the step unresolved" };
  }

  /**
   * Reclaimed pending row: provider search by stable correlation key first.
   * Found evidence adopts the receipt (heals via the uncertain path); a
   * missing record leaves the step uncertain — never a blind re-dispatch.
   */
  private async recoverReclaimedStep(
    record: IntentRecord,
    execution: ActionExecution,
    key: string,
    claimToken: string,
    kind: "hold" | "email",
  ): Promise<StepOutcome> {
    const result =
      kind === "hold"
        ? await this.deps.calendar.reconcileProvisionalHold({ operationKey: key })
        : await this.deps.email.reconcileSentEmail({ operationKey: key });
    const stale = this.authorityBlock(record);
    if (result.status === "succeeded") {
      const pending = this.store.markExecutionUncertain(
        execution.id,
        "Recovered pending step matched provider evidence on reconcile",
        { claimToken },
      );
      this.store.reconcileActionExecution(pending.id, { status: "succeeded", result: provenResult(result) });
      if (kind === "hold") this.updateBookingProgress(this.getAction(execution.proposedActionId).bookingId, "provisional_hold");
      if (stale !== undefined) return stale;
      return { status: "done" };
    }
    this.store.markExecutionUncertain(
      execution.id,
      "Recovered pending step has no provider evidence; it remains uncertain until the provider record appears",
      { claimToken },
    );
    if (stale !== undefined) return stale;
    return { status: "uncertain", error: `${kind} outcome is unproven: no provider record for ${key}` };
  }

  /** Fresh full-coverage availability + durable-conflict check before a hold write. */
  private async checkFreshAvailability(
    record: IntentRecord,
    action: ProposedAction,
    params: HoldParams,
    ownKey: string,
  ): Promise<StepOutcome | undefined> {
    const availability = await this.deps.calendar.checkAvailability({
      operationKey: availabilityOperationKey({ calendarId: params.calendarId, startAt: params.startAt, endAt: params.endAt }),
      calendarId: params.calendarId,
      startAt: params.startAt,
      endAt: params.endAt,
    });
    const stale = this.authorityBlock(record);
    if (stale !== undefined) return stale;
    if (availability.status === "failed") {
      const errorKind = availability.error.kind;
      if (errorKind === "access_revoked" || errorKind === "authorization_denied") {
        return { status: "blocked", error: availability.error.message };
      }
      return { status: "blocked", error: availability.error.message };
    }
    if (availability.status === "uncertain") {
      return { status: "failed", error: "Availability check was uncertain; the intent may retry", retryable: true };
    }
    const startMs = Date.parse(params.startAt);
    const endMs = Date.parse(params.endAt);
    const blockedSlot = availability.data.slots.find((slot) => !slot.available);
    if (blockedSlot) {
      return { status: "blocked", error: blockedSlot.reason ?? "Requested date is unavailable" };
    }
    const fullyCovered = availability.data.slots.some(
      (slot) => slot.available && Date.parse(slot.startAt) <= startMs && Date.parse(slot.endAt) >= endMs,
    );
    if (!fullyCovered) {
      return { status: "blocked", error: "No available slot fully covers the requested range" };
    }
    const durableConflict = this.store.findHoldConflict(params.calendarId, params.startAt, params.endAt, {
      excludeOperationKey: ownKey,
      nowMs: this.nowMs(),
    });
    if (durableConflict) {
      return { status: "blocked", error: `The window is already durably held (record ${durableConflict}); choose another window or reconcile the conflicting record` };
    }
    return undefined;
  }

  /** Reconcile a just-uncertain step once, by stable operation key. */
  private async reconcileByKey(key: string, kind: "hold" | "email"): Promise<boolean> {
    const execution = this.store.getExecutionByIdempotencyKey(key);
    if (!execution) return false;
    const result =
      kind === "hold"
        ? await this.deps.calendar.reconcileProvisionalHold({ operationKey: key })
        : await this.deps.email.reconcileSentEmail({ operationKey: key });
    if (result.status !== "succeeded") return false;
    this.store.reconcileActionExecution(execution.id, { status: "succeeded", result: provenResult(result) });
    return true;
  }

  /** Reconcile command: one step wrapping the existing execution reconcile. */
  private async stepReconcile(record: IntentRecord, step: IntentStep): Promise<StepOutcome> {
    const executionId = step.executionId ?? (typeof record.payload.executionId === "string" ? record.payload.executionId : undefined);
    if (executionId === undefined) return { status: "blocked", error: "reconcile_execution intent is missing its executionId" };
    const execution = this.executionById(executionId);
    if (!execution) return { status: "blocked", error: `Action execution not found: ${executionId}` };
    if (execution.status !== "uncertain" && execution.status !== "partial") return { status: "done" };
    return this.reconcileStepExecution(execution.id);
  }

  /** Attested owner control through the ledger — the only control authority path. */
  private stepOwnerControl(record: IntentRecord): StepOutcome {
    const command = record.payload as Record<string, unknown>;
    try {
      this.ledger.applyOwnerControl({
        dedupeKey: String(command.dedupeKey),
        kind: command.control as "pause" | "resume" | "cancel",
        bookingId: String(command.bookingId),
        attestedBy: ownerIdentity(this.deps),
        ...(typeof command.note === "string" ? { note: command.note } : {}),
        observedAt: this.nowIso(),
      });
      return { status: "done" };
    } catch (error) {
      return { status: "blocked", error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Progress the booking status without ever downgrading terminal states —
   * mirrors the sync pipeline's rule: cancelled stays cancelled, confirmed is
   * never moved back to provisional.
   */
  private updateBookingProgress(bookingId: string, status: "provisional_hold" | "failed" | "uncertain"): void {
    const booking = this.getBooking(bookingId);
    if (booking.status === "cancelled" || (booking.status === "confirmed" && status === "provisional_hold")) return;
    this.store.updateBookingStatus(bookingId, status);
  }
}
