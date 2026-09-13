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
  clock: () => number;
  timer: ReturnType<typeof setInterval> | undefined;
}

const bindings = new Map<string, BindingRecord>();

function nowIso(record: BindingRecord): string {
  return new Date(record.clock()).toISOString();
}

function snapshot(record: BindingRecord): ProactiveBindingState {
  return {
    accountId: record.accountId,
    businessId: record.businessId,
    intervalMs: record.intervalMs,
    status: record.status,
    inFlight: record.inFlight,
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
  const existing = bindings.get(config.accountId);
  if (existing?.timer !== undefined) clearInterval(existing.timer);
  const record: BindingRecord = {
    accountId: config.accountId,
    businessId: config.businessId,
    intervalMs,
    status: "running",
    inFlight: existing?.inFlight ?? false,
    totalRuns: 0,
    skippedOverlaps: 0,
    consecutiveErrors: 0,
    runSweep: config.runSweep,
    maxConsecutiveErrors: config.maxConsecutiveErrors ?? DEFAULT_MAX_CONSECUTIVE_ERRORS,
    clock: config.clock ?? Date.now,
    timer: undefined,
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
  bindings.delete(accountId);
  return true;
}

/**
 * Stop a binding's timer without removing it, awaiting any in-flight sweep
 * (bounded drain). The binding reports stopped; restart via re-register.
 */
export async function stopProactiveBinding(accountId: string): Promise<ProactiveBindingState | undefined> {
  const record = bindings.get(accountId);
  if (!record) return undefined;
  if (record.timer !== undefined) {
    clearInterval(record.timer);
    record.timer = undefined;
  }
  record.status = "stopped";
  const deadline = record.clock() + 30_000;
  while (record.inFlight && record.clock() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return snapshot(record);
}

/**
 * Run exactly one guarded sweep cycle for an account now (timer tick entry
 * point; also the fake-clock seam for tests). Overlapping ticks skip and
 * count instead of running concurrently. Repeated failures degrade the
 * binding explicitly (timer stopped, status degraded with the last error)
 * instead of retrying silently forever; re-register to resume.
 */
export async function tickBinding(accountId: string): Promise<ProactiveSweepResult & { state?: ProactiveBindingState }> {
  const record = bindings.get(accountId);
  if (!record || record.status !== "running" || record.timer === undefined) {
    return { ok: false, at: new Date().toISOString(), skippedOverlap: false, error: "no running binding", ...(record ? { state: snapshot(record) } : {}) };
  }
  if (record.inFlight) {
    record.skippedOverlaps += 1;
    return { ok: true, at: nowIso(record), skippedOverlap: true, state: snapshot(record) };
  }
  record.inFlight = true;
  try {
    await record.runSweep();
    record.totalRuns += 1;
    record.consecutiveErrors = 0;
    record.lastRunAt = nowIso(record);
    record.lastOk = true;
    record.lastError = undefined;
    return { ok: true, at: record.lastRunAt, skippedOverlap: false, state: snapshot(record) };
  } catch (error) {
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
    return { ok: false, at: record.lastRunAt, skippedOverlap: false, error: record.lastError, state: snapshot(record) };
  } finally {
    record.inFlight = false;
  }
}

/**
 * Explicit revocation hook for connection-revoked events: marks the binding
 * degraded and stops its timer at once (no quiet retries against a dead
 * credential). Re-register after the owner reconnects.
 */
export function noteProactiveRevocation(accountId: string, message: string): ProactiveBindingState | undefined {
  const record = bindings.get(accountId);
  if (!record) return undefined;
  if (record.timer !== undefined) {
    clearInterval(record.timer);
    record.timer = undefined;
  }
  record.status = "degraded";
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

/** Test-only reset (stops timers first). */
export function resetProactiveAutomation(): void {
  for (const record of bindings.values()) {
    if (record.timer !== undefined) clearInterval(record.timer);
  }
  bindings.clear();
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

export function stopProactiveAccount(accountId: string): Promise<ProactiveBindingState | undefined> {
  return stopProactiveBinding(accountId);
}
