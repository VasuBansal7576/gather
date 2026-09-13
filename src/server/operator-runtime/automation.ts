import { drainDueWork } from "./due-work.ts";
import { runIntakeSweep } from "./intake.ts";
import type { OperatorRuntimeDeps } from "./types.ts";

/**
 * Host-owned proactive scheduling: one bounded local timer per registered
 * account binding. There is deliberately no generic scheduler framework
 * here (and the OpenClaw gateway denies `cron` to the agent surface): each
 * binding owns exactly one interval timer, replaced on refresh and cleared
 * on remove/stop. The scheduler never sends, approves, holds, or links
 * anything itself — it only invokes the injected sweep, which runs the
 * existing guarded intake + due-work paths (pause/cancel and approval gates
 * stay enforced there, so a firing timer can never send an unapproved
 * followup).
 *
 * Production connector composition is injected, never imported: the host
 * (or D's bootstrap) registers fully-built runtime deps per account. This
 * file imports no provider, connection, or credential modules.
 */

export const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
export const MIN_SWEEP_INTERVAL_MS = 30 * 1000;
export const MAX_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_CONSECUTIVE_ERRORS = 5;
/** Real-time bound for one sweep body before it is declared stuck (degraded). */
export const DEFAULT_MAX_SWEEP_MS = 10 * 60 * 1000;

export type ProactiveBindingStatus = "running" | "stopped" | "degraded";

export interface ProactiveSweepResult {
  ok: boolean;
  at: string;
  skippedOverlap: boolean;
  error?: string;
}

export interface ProactiveBindingConfig {
  accountId: string;
  businessId: string;
  /** Injected sweep body (normally intake + due-work drain). Never sends by itself. */
  runSweep: () => Promise<unknown>;
  intervalMs?: number;
  maxConsecutiveErrors?: number;
  /** Real-time bound for one sweep before it is declared stuck. Never the business clock. */
  maxSweepMs?: number;
  clock?: () => number;
}

export interface ProactiveBindingState {
  accountId: string;
  businessId: string;
  intervalMs: number;
  status: ProactiveBindingStatus;
  /** True while one sweep cycle is in flight for this account. */
  inFlight: boolean;
  totalRuns: number;
  skippedOverlaps: number;
  consecutiveErrors: number;
  lastRunAt?: string;
  lastOk?: boolean;
  lastError?: string;
  degradedAt?: string;
}

interface BindingRecord extends ProactiveBindingState {
  runSweep: () => Promise<unknown>;
  maxConsecutiveErrors: number;
  maxSweepMs: number;
  clock: () => number;
  timer: ReturnType<typeof setInterval> | undefined;
  /**
   * Per-account sweep latch from the SHARED registry below — never a fresh
   * object per lifecycle. A re-registered (or remove + re-registered)
   * binding keeps overlap protection against a still-running old sweep
   * body, and that old completion clears the shared latch. A fresh latch
   * per lifecycle would let the new body overlap the old one.
   */
  sweepCell: SweepCell;
  /**
   * Monotonic epoch: bumped on stop/remove. A sweep that completes after
   * its binding was stopped/degraded writes its outcome nowhere — late
   * writes can never mutate reported state or restart counters.
   */
  epoch: number;
}

interface SweepCell {
  inFlight: boolean;
  promise?: Promise<unknown>;
}

const bindings = new Map<string, BindingRecord>();

/**
 * Per-account latch registry, independent of binding-record lifecycles.
 * removeProactiveBinding drops the record but keeps the cell until the
 * orphan body settles, so a re-register cannot start overlapping work.
 * Cells for accounts with no live binding are released when the orphan
 * completion is observed.
 */
const sweepCells = new Map<string, SweepCell>();

function cellFor(accountId: string): SweepCell {
  let cell = sweepCells.get(accountId);
  if (!cell) {
    cell = { inFlight: false };
    sweepCells.set(accountId, cell);
  }
  return cell;
}

/** Real-clock deadline for the bounded stop drain — NEVER the injectable
 *  business clock (a frozen clock would make the drain spin forever). */
function realDeadline(ms: number): number {
  return Date.now() + ms;
}

function nowIso(record: BindingRecord): string {
  return new Date(record.clock()).toISOString();
}

function snapshot(record: BindingRecord): ProactiveBindingState {
  return {
    accountId: record.accountId,
    businessId: record.businessId,
    intervalMs: record.intervalMs,
    status: record.status,
    // The shared per-account latch is the truth — a refreshed record's own
    // field could be stale while a prior sweep still runs.
    inFlight: record.sweepCell.inFlight,
    totalRuns: record.totalRuns,
    skippedOverlaps: record.skippedOverlaps,
    consecutiveErrors: record.consecutiveErrors,
    ...(record.lastRunAt === undefined ? {} : { lastRunAt: record.lastRunAt }),
    ...(record.lastOk === undefined ? {} : { lastOk: record.lastOk }),
    ...(record.lastError === undefined ? {} : { lastError: record.lastError }),
    ...(record.degradedAt === undefined ? {} : { degradedAt: record.degradedAt }),
  };
}

/**
 * Register (or refresh) the proactive binding for one account. Refreshing
 * replaces the timer and resets the error budget; bindings never overlap
 * sweeps for the same account.
 */
export function registerProactiveBinding(config: ProactiveBindingConfig): ProactiveBindingState {
  if (config.accountId.trim().length === 0) throw new Error("Proactive binding requires a non-empty accountId");
  if (config.businessId.trim().length === 0) throw new Error("Proactive binding requires a non-empty businessId");
  const intervalMs = config.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  if (!Number.isInteger(intervalMs) || intervalMs < MIN_SWEEP_INTERVAL_MS || intervalMs > MAX_SWEEP_INTERVAL_MS) {
    throw new Error(`intervalMs must be an integer in ${MIN_SWEEP_INTERVAL_MS}..${MAX_SWEEP_INTERVAL_MS}`);
  }
  if (config.maxSweepMs !== undefined && (!Number.isInteger(config.maxSweepMs) || config.maxSweepMs <= 0)) {
    throw new Error("maxSweepMs must be a positive integer when present");
  }
  const existing = bindings.get(config.accountId);
  if (existing && existing.businessId !== config.businessId) {
    throw new Error(
      `Proactive binding for account ${config.accountId} belongs to business ${existing.businessId}; remove it before rebinding to ${config.businessId}`,
    );
  }
  if (existing?.timer !== undefined) {
    clearInterval(existing.timer);
    existing.epoch += 1; // late writes from a prior lifecycle are dead
  }
  const record: BindingRecord = {
    accountId: config.accountId,
    businessId: config.businessId,
    intervalMs,
    status: "running",
    inFlight: false, // reported state comes from sweepCell, not this field
    totalRuns: 0,
    skippedOverlaps: 0,
    consecutiveErrors: 0,
    runSweep: config.runSweep,
    maxConsecutiveErrors: config.maxConsecutiveErrors ?? DEFAULT_MAX_CONSECUTIVE_ERRORS,
    maxSweepMs: config.maxSweepMs ?? DEFAULT_MAX_SWEEP_MS,
    clock: config.clock ?? Date.now,
    timer: undefined,
    // Registry latch, never a fresh object: overlap protection survives
    // refresh AND remove/re-register until the old body settles.
    sweepCell: cellFor(config.accountId),
    epoch: 0,
  };
  record.timer = setInterval(() => {
    void tickBinding(config.accountId).catch(() => {
      // Errors are recorded on the binding state itself; never unhandled.
    });
  }, intervalMs);
  record.timer.unref?.();
  bindings.set(config.accountId, record);
  return snapshot(record);
}

/** Remove a binding and stop its timer. Returns true when one existed. */
export function removeProactiveBinding(accountId: string): boolean {
  const record = bindings.get(accountId);
  if (!record) return false;
  if (record.timer !== undefined) clearInterval(record.timer);
  record.epoch += 1; // any in-flight sweep's late writes die with the record
  bindings.delete(accountId);
  return true;
}

/**
 * Stop a binding's timer without removing it, awaiting any in-flight sweep
 * (bounded drain). The drain deadline is REAL elapsed time (Date.now) —
 * never the injectable business clock, which may be frozen — and the
 * returned snapshot honestly reports inFlight when the sweep did not
 * drain inside the bound. A sweep completing after stop writes nothing:
 * its epoch is stale, so no late write can mutate the stopped record.
 * The binding reports stopped; restart via re-register.
 *
 * The drain bound is `drainTimeoutMs` of REAL elapsed time (default 30 s)
 * — independent of the injectable business clock, which may be frozen.
 */
export async function stopProactiveBinding(accountId: string, drainTimeoutMs = 30_000): Promise<ProactiveBindingState | undefined> {
  const record = bindings.get(accountId);
  if (!record) return undefined;
  if (record.timer !== undefined) {
    clearInterval(record.timer);
    record.timer = undefined;
  }
  record.status = "stopped";
  record.epoch += 1;
  const cell = record.sweepCell;
  if (cell.inFlight && cell.promise) {
    const deadline = realDeadline(drainTimeoutMs);
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      drainTimer = setTimeout(() => resolve("timeout"), Math.max(0, deadline - Date.now()));
    });
    try {
      await Promise.race([cell.promise.catch(() => {}), timeout]);
    } finally {
      // Never retain the drain timer past the wait: an early sweep finish
      // must not hold the event loop for the whole bound after shutdown.
      if (drainTimer !== undefined) clearTimeout(drainTimer);
    }
  }
  return snapshot(record);
}

/**
 * Run exactly one guarded sweep cycle for an account now (timer tick entry
 * point; also the fake-clock seam for tests). Overlap protection lives on
 * the per-account sweep cell — shared across refreshes — so a re-registered
 * binding still cannot run concurrently with a prior sweep, and that prior
 * sweep's completion releases the SHARED latch (never a dead record's flag
 * that would wedge the fresh binding). Completion writes land only when the
 * record is still current and running: a sweep finishing after stop,
 * remove, revoke, or refresh writes nothing — no late counters, no clobbered
 * revocation error, no resurrected status. Repeated failures degrade the
 * binding explicitly (timer stopped, status degraded with the last error)
 * instead of retrying silently forever; re-register to resume.
 */
export async function tickBinding(accountId: string): Promise<ProactiveSweepResult & { state?: ProactiveBindingState }> {
  const record = bindings.get(accountId);
  if (!record || record.status !== "running" || record.timer === undefined) {
    return { ok: false, at: new Date().toISOString(), skippedOverlap: false, error: "no running binding", ...(record ? { state: snapshot(record) } : {}) };
  }
  const cell = record.sweepCell;
  if (cell.inFlight) {
    record.skippedOverlaps += 1;
    return { ok: true, at: nowIso(record), skippedOverlap: true, state: snapshot(record) };
  }
  cell.inFlight = true;
  const epochAtStart = record.epoch;
  const running = (async () => record.runSweep())();
  cell.promise = running;
  const writeable = () => record.epoch === epochAtStart && record.status === "running";
  // Real-time stuck watchdog (never the business clock): a body that never
  // settles is declared explicitly stuck — degraded with the reason kept —
  // instead of running forever. Ownership and the tombstone are retained
  // (no forced new body); a late completion still clears the shared latch
  // but writes nothing. Re-register to resume.
  let settled = false;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const armWatchdog = (): void => {
    watchdog = setTimeout(() => {
      if (settled || cell.promise !== running) return;
      // Attribute the stuck state to the live record sharing this latch
      // when there is one (e.g. a refresh that inherited it); otherwise to
      // the captured record. Either way the tombstone is reachable.
      const current = bindings.get(accountId);
      const target = current && current.sweepCell === cell ? current : record;
      target.lastRunAt = nowIso(target);
      target.lastOk = false;
      target.lastError = `sweep body did not settle within ${record.maxSweepMs}ms; treated as stuck (ownership retained, re-register to resume)`;
      if (target.timer !== undefined) {
        clearInterval(target.timer);
        target.timer = undefined;
      }
      target.status = "degraded";
      target.degradedAt = target.lastRunAt;
    }, record.maxSweepMs);
    watchdog.unref?.();
  };
  armWatchdog();
  try {
    await running;
    if (writeable()) {
      record.totalRuns += 1;
      record.consecutiveErrors = 0;
      record.lastRunAt = nowIso(record);
      record.lastOk = true;
      record.lastError = undefined;
    }
    return { ok: true, at: nowIso(record), skippedOverlap: false, state: snapshot(record) };
  } catch (error) {
    if (writeable()) {
      record.totalRuns += 1;
      record.consecutiveErrors += 1;
      record.lastRunAt = nowIso(record);
      record.lastOk = false;
      record.lastError = error instanceof Error ? error.message : String(error);
      if (record.consecutiveErrors > record.maxConsecutiveErrors) {
        if (record.timer !== undefined) {
          clearInterval(record.timer);
          record.timer = undefined;
        }
        record.status = "degraded";
        record.degradedAt = record.lastRunAt;
      }
    }
    const lastError = record.lastError ?? (error instanceof Error ? error.message : String(error));
    return { ok: false, at: nowIso(record), skippedOverlap: false, error: lastError, state: snapshot(record) };
  } finally {
    settled = true;
    if (watchdog !== undefined) clearTimeout(watchdog);
    cell.inFlight = false;
    cell.promise = undefined;
    if (!bindings.has(accountId)) sweepCells.delete(accountId);
  }
}

/**
 * Explicit revocation hook for connection-revoked events: marks the binding
 * degraded and stops its timer at once (no quiet retries against a dead
 * credential). An in-flight sweep may still finish — but its completion
 * writes are suppressed by the epoch bump, so it can never clobber the
 * revocation error or resurrect the binding. Re-register after the owner
 * reconnects.
 */
export function noteProactiveRevocation(accountId: string, message: string): ProactiveBindingState | undefined {
  const record = bindings.get(accountId);
  if (!record) return undefined;
  if (record.timer !== undefined) {
    clearInterval(record.timer);
    record.timer = undefined;
  }
  record.status = "degraded";
  record.epoch += 1;
  record.lastError = message;
  record.degradedAt = nowIso(record);
  return snapshot(record);
}

export function getProactiveBinding(accountId: string): ProactiveBindingState | undefined {
  const record = bindings.get(accountId);
  return record ? snapshot(record) : undefined;
}

export function listProactiveBindings(): ProactiveBindingState[] {
  return [...bindings.values()].map(snapshot).sort((a, b) => a.accountId.localeCompare(b.accountId));
}

/**
 * Bindings filtered to a caller-authorized account set. The proactive
 * registry is separate from the operator-deps registry — listings for
 * owners/routes must pass through this scope so an unwired or foreign
 * account's binding never leaks into a status response.
 */
export function listProactiveBindingsForAccounts(accountIds: readonly string[]): ProactiveBindingState[] {
  const allowed = new Set(accountIds);
  return listProactiveBindings().filter((binding) => allowed.has(binding.accountId));
}

/** Test-only reset (stops timers first). */
export function resetProactiveAutomation(): void {
  for (const record of bindings.values()) {
    if (record.timer !== undefined) clearInterval(record.timer);
  }
  bindings.clear();
  sweepCells.clear();
}

// ---------------------------------------------------------------------------
// Host adapter: binds registered runtime deps to the scheduler.
// ---------------------------------------------------------------------------

export interface ProactiveHostConfig {
  /** Fully-built runtime deps (injected provider ports included). */
  runtime: OperatorRuntimeDeps;
  intervalMs?: number;
  maxConsecutiveErrors?: number;
  clock?: () => number;
}

export interface ProactiveHostSweep {
  intake: Awaited<ReturnType<typeof runIntakeSweep>>;
  dueWork: Awaited<ReturnType<typeof drainDueWork>>;
}

/**
 * Start proactive sweeps for one account from already-built runtime deps:
 * each cycle runs the intake sweep then the due-work drain (both honor
 * ledger pause/cancel and approval gates; neither sends unapproved
 * followups — sending stays behind guarded service paths). Restart state
 * comes from existing SQLite (cursors, checkpoints, batches, waiting
 * rows); bindings themselves are re-registered by the host on boot.
 */
export function startProactiveAccount(config: ProactiveHostConfig): ProactiveBindingState {
  const runtime = config.runtime;
  return registerProactiveBinding({
    accountId: runtime.accountId,
    businessId: runtime.businessId,
    runSweep: async (): Promise<ProactiveHostSweep> => {
      const intake = await runIntakeSweep(runtime);
      const dueWork = await drainDueWork(runtime);
      return { intake, dueWork };
    },
    ...(config.intervalMs === undefined ? {} : { intervalMs: config.intervalMs }),
    ...(config.maxConsecutiveErrors === undefined ? {} : { maxConsecutiveErrors: config.maxConsecutiveErrors }),
    ...(config.clock === undefined ? {} : { clock: config.clock }),
  });
}

export function stopProactiveAccount(accountId: string, drainTimeoutMs?: number): Promise<ProactiveBindingState | undefined> {
  return stopProactiveBinding(accountId, drainTimeoutMs);
}
