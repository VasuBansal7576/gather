import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { installLeaseStatus, type LeaseStatus } from "../setup/installation-lease.ts";

/**
 * ADR-009 step 3 (budgets half) + C08: persistent per-call/run/day
 * reservations with tool-count and token caps and a real execution
 * deadline.
 *
 * Release defaults (configurable before running): 15 tool calls, 32,000
 * total input/output tokens per run, 5-minute execution deadline, 50 runs
 * per business per day. The next call's maximum input/output budget is
 * reserved BEFORE dispatch; a reservation that cannot fit is rejected and
 * the downstream adapter is never called. Retries and repair diagnosis
 * count against the same budgets.
 *
 * Persistence: file-backed JSON under the caller's state dir (atomic
 * tmp+rename writes), so usage and reservations survive restarts. This
 * module creates no locks of its own: it composes with the ADR-001
 * installation lease through the read-only `installLeaseStatus` API
 * (lease evidence is attached to errors, never re-acquired).
 *
 * Budget exhaustion maps to the shared 429 (budget exhausted) error path;
 * it never synthesizes success, relaxes authority, or auto-upgrades.
 */

export const DEFAULT_MAX_TOOL_CALLS_PER_RUN = 15;
export const DEFAULT_MAX_TOKENS_PER_RUN = 32_000;
export const DEFAULT_RUN_DEADLINE_MS = 300_000;
export const DEFAULT_MAX_RUNS_PER_BUSINESS_PER_DAY = 50;

export const BUDGET_STATE_VERSION = 1;

export type RunStatus = "running" | "continuing" | "completed" | "failed" | "cancelled" | "blocked" | "fenced";

export class BudgetError extends Error {
  readonly code:
    | "BUDGET_TOOL_EXHAUSTED"
    | "BUDGET_TOKEN_EXHAUSTED"
    | "BUDGET_RUNS_EXHAUSTED"
    | "BUDGET_UNKNOWN_RUN"
    | "BUDGET_RELAUNCH_DENIED"
    | "BUDGET_DEADLINE_EXCEEDED"
    | "BUDGET_RUN_NOT_ACTIVE"
    | "BUDGET_INVALID";
  /** Shared-contract mapping: exhaustion is a 429, unknown/relaunch a 409, deadline a 503-style fence. */
  readonly httpStatus: 409 | 429 | 503;
  constructor(code: BudgetError["code"], message: string) {
    super(message);
    this.name = "BudgetError";
    this.code = code;
    this.httpStatus = code === "BUDGET_UNKNOWN_RUN" || code === "BUDGET_RELAUNCH_DENIED" ? 409 : code === "BUDGET_DEADLINE_EXCEEDED" ? 503 : 429;
  }
}

export interface RunBudget {
  runId: string;
  businessId: string;
  idempotencyKey: string;
  status: RunStatus;
  toolCalls: number;
  tokensReserved: number;
  tokensUsed: number;
  startedAt: number;
  deadlineAt: number;
  day: string;
  fenced: boolean;
}

export interface BudgetLimits {
  maxToolCallsPerRun: number;
  maxTokensPerRun: number;
  runDeadlineMs: number;
  maxRunsPerBusinessPerDay: number;
}

export interface BudgetStoreOptions {
  /** Directory owning budget.json (e.g. <install-root>/.runtime/live or a test tmp dir). */
  stateDir: string;
  limits?: Partial<BudgetLimits>;
  now?: () => number;
}

interface BudgetFile {
  version: number;
  runs: Record<string, RunBudget>;
  /** `${businessId}\n${day}` -> runs started that day. */
  days: Record<string, number>;
}

function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function dayKey(businessId: string, day: string): string {
  return `${businessId}\n${day}`;
}

export class BudgetStore {
  readonly stateDir: string;
  readonly limits: BudgetLimits;
  private readonly now: () => number;
  private readonly filePath: string;
  private state: BudgetFile;

  constructor(options: BudgetStoreOptions) {
    if (!options.stateDir || options.stateDir.trim().length === 0) {
      throw new BudgetError("BUDGET_INVALID", "BudgetStore requires a stateDir");
    }
    this.stateDir = options.stateDir;
    this.limits = {
      maxToolCallsPerRun: options.limits?.maxToolCallsPerRun ?? DEFAULT_MAX_TOOL_CALLS_PER_RUN,
      maxTokensPerRun: options.limits?.maxTokensPerRun ?? DEFAULT_MAX_TOKENS_PER_RUN,
      runDeadlineMs: options.limits?.runDeadlineMs ?? DEFAULT_RUN_DEADLINE_MS,
      maxRunsPerBusinessPerDay: options.limits?.maxRunsPerBusinessPerDay ?? DEFAULT_MAX_RUNS_PER_BUSINESS_PER_DAY,
    };
    for (const [key, value] of Object.entries(this.limits)) {
      if (!Number.isFinite(value) || (value as number) <= 0) {
        throw new BudgetError("BUDGET_INVALID", `budget limit ${key} must be a positive number, got ${JSON.stringify(value)}`);
      }
    }
    this.now = options.now ?? (() => Date.now());
    this.filePath = join(this.stateDir, "budgets", "budget.json");
    this.state = this.load();
  }

  /** Re-reads persisted state from disk (restart-recovery path; also used by tests to prove durability). */
  reload(): void {
    this.state = this.load();
  }

  private load(): BudgetFile {
    if (!existsSync(this.filePath)) {
      return { version: BUDGET_STATE_VERSION, runs: {}, days: {} };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
    } catch (error) {
      throw new BudgetError(
        "BUDGET_INVALID",
        `budget state at ${this.filePath} is corrupt: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (typeof parsed !== "object" || parsed === null) {
      throw new BudgetError("BUDGET_INVALID", `budget state at ${this.filePath} is not an object`);
    }
    const record = parsed as { version?: unknown; runs?: unknown; days?: unknown };
    if (record.version !== BUDGET_STATE_VERSION) {
      throw new BudgetError(
        "BUDGET_INVALID",
        `budget state version ${JSON.stringify(record.version)} is not compatible with ${BUDGET_STATE_VERSION}; restore only through restoreCompatible`,
      );
    }
    return {
      version: BUDGET_STATE_VERSION,
      runs: (record.runs ?? {}) as Record<string, RunBudget>,
      days: (record.days ?? {}) as Record<string, number>,
    };
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    chmodSync(dirname(this.filePath), 0o700);
    const tmpPath = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify(this.state)}\n`, { mode: 0o600 });
    chmodSync(tmpPath, 0o600);
    renameSync(tmpPath, this.filePath);
  }

  /**
   * Starts one budgeted run. Same business + same idempotency key replays
   * the existing run (no duplicate). A prior run that is cancelled,
   * blocked, or unknown can NEVER relaunch as a duplicate under the same
   * key — reconcile it first.
   */
  startRun(input: { businessId: string; idempotencyKey: string }): { run: RunBudget; duplicate: boolean } {
    const businessId = input.businessId?.trim() ?? "";
    const idempotencyKey = input.idempotencyKey?.trim() ?? "";
    if (!businessId) throw new BudgetError("BUDGET_INVALID", "startRun requires a businessId");
    if (!idempotencyKey) throw new BudgetError("BUDGET_INVALID", "startRun requires an idempotencyKey");
    const existing = Object.values(this.state.runs).find(
      (run) => run.businessId === businessId && run.idempotencyKey === idempotencyKey,
    );
    if (existing) {
      if (existing.status === "cancelled" || existing.status === "blocked") {
        throw new BudgetError(
          "BUDGET_RELAUNCH_DENIED",
          `run ${existing.runId} is ${existing.status} and cannot relaunch as a duplicate under the same idempotency key; reconcile the original run first`,
        );
      }
      return { run: { ...existing }, duplicate: true };
    }
    const nowMs = this.now();
    const day = utcDay(nowMs);
    const key = dayKey(businessId, day);
    const used = this.state.days[key] ?? 0;
    if (used >= this.limits.maxRunsPerBusinessPerDay) {
      throw new BudgetError(
        "BUDGET_RUNS_EXHAUSTED",
        `business ${businessId} exhausted its ${this.limits.maxRunsPerBusinessPerDay} runs for ${day}`,
      );
    }
    const run: RunBudget = {
      runId: `run_${nowMs}_${Math.random().toString(36).slice(2, 10)}`,
      businessId,
      idempotencyKey,
      status: "running",
      toolCalls: 0,
      tokensReserved: 0,
      tokensUsed: 0,
      startedAt: nowMs,
      deadlineAt: nowMs + this.limits.runDeadlineMs,
      day,
      fenced: false,
    };
    this.state.runs[run.runId] = run;
    this.state.days[key] = used + 1;
    this.persist();
    return { run: { ...run }, duplicate: false };
  }

  getRun(runId: string): RunBudget {
    const run = this.state.runs[runId];
    if (!run) {
      throw new BudgetError("BUDGET_UNKNOWN_RUN", `unknown run ${JSON.stringify(runId)}: it cannot relaunch as a duplicate; reconcile it first`);
    }
    return { ...run };
  }

  private ref(runId: string): RunBudget {
    const run = this.state.runs[runId];
    if (!run) {
      throw new BudgetError("BUDGET_UNKNOWN_RUN", `unknown run ${JSON.stringify(runId)}: it cannot relaunch as a duplicate; reconcile it first`);
    }
    return run;
  }

  private requireActive(runId: string): RunBudget {
    const run = this.ref(runId);
    if (run.fenced) {
      throw new BudgetError("BUDGET_DEADLINE_EXCEEDED", `run ${runId} is fenced after its execution deadline; reconcile pending effects before resuming`);
    }
    if (run.status !== "running" && run.status !== "continuing") {
      throw new BudgetError("BUDGET_RUN_NOT_ACTIVE", `run ${runId} is ${run.status}; only running/continuing runs accept reservations`);
    }
    return run;
  }

  /**
   * Reserves the NEXT call's maximum input/output budget before dispatch.
   * The 16th tool call is denied; a reservation that cannot fit the token
   * cap is denied. Callers must not dispatch when this throws.
   */
  reserveToolCall(runId: string, estimate: { maxInputTokens: number; maxOutputTokens: number }): RunBudget {
    const run = this.requireActive(runId);
    if (run.toolCalls + 1 > this.limits.maxToolCallsPerRun) {
      throw new BudgetError(
        "BUDGET_TOOL_EXHAUSTED",
        `run ${runId} exhausted its ${this.limits.maxToolCallsPerRun} tool calls; further Gather tools are fenced`,
      );
    }
    const estimateTotal = estimate.maxInputTokens + estimate.maxOutputTokens;
    if (!Number.isFinite(estimateTotal) || estimateTotal < 0) {
      throw new BudgetError("BUDGET_INVALID", "token estimate must be finite and non-negative");
    }
    if (run.tokensReserved + estimateTotal > this.limits.maxTokensPerRun) {
      throw new BudgetError(
        "BUDGET_TOKEN_EXHAUSTED",
        `run ${runId} cannot reserve ${estimateTotal} more tokens (${run.tokensReserved}/${this.limits.maxTokensPerRun} reserved)`,
      );
    }
    run.toolCalls += 1;
    run.tokensReserved += estimateTotal;
    this.persist();
    return { ...run };
  }

  /**
   * Commits actual usage after a reserved call settles, releasing the
   * unused reservation headroom. Retries and repair diagnosis go through
   * reserveToolCall first, so they count against the same caps.
   */
  commitUsage(runId: string, actual: { inputTokens: number; outputTokens: number; reservedEstimate: number }): RunBudget {
    const run = this.ref(runId);
    const actualTotal = actual.inputTokens + actual.outputTokens;
    if (!Number.isFinite(actualTotal) || actualTotal < 0) {
      throw new BudgetError("BUDGET_INVALID", "actual token usage must be finite and non-negative");
    }
    run.tokensUsed += actualTotal;
    run.tokensReserved = Math.max(0, run.tokensReserved - Math.max(0, actual.reservedEstimate - actualTotal));
    this.persist();
    return { ...run };
  }

  /** Real execution deadline check. Expired -> the run is fenced (further tools denied) until reconciled. */
  deadlineStatus(runId: string, nowMs?: number): "ok" | "expired" {
    const run = this.getRun(runId);
    return (nowMs ?? this.now()) <= run.deadlineAt ? "ok" : "expired";
  }

  /** Fences a run whose deadline expired: tools stop, in-flight effects stay uncertain until reconciled. */
  fenceRun(runId: string): RunBudget {
    const run = this.ref(runId);
    run.fenced = true;
    if (run.status === "running") run.status = "continuing";
    this.persist();
    return { ...run };
  }

  finishRun(runId: string, status: Extract<RunStatus, "completed" | "failed" | "cancelled" | "blocked" | "continuing">): RunBudget {
    const run = this.ref(runId);
    run.status = status;
    this.persist();
    return { ...run };
  }

  dailyUsage(businessId: string, day: string): number {
    return this.state.days[dayKey(businessId, day)] ?? 0;
  }

  /** Allowlisted snapshot for backup (counts and run records only — no secrets exist in this store). */
  snapshot(): { version: number; limits: BudgetLimits; runs: RunBudget[]; days: Record<string, number> } {
    return {
      version: BUDGET_STATE_VERSION,
      limits: { ...this.limits },
      runs: Object.values(this.state.runs).map((run) => ({ ...run })),
      days: { ...this.state.days },
    };
  }

  /** Restores a compatible snapshot (used by RuntimeControl.restoreCompatible after its own version gate). */
  restoreSnapshot(snapshot: { version: number; runs: RunBudget[]; days: Record<string, number> }): void {
    if (snapshot.version !== BUDGET_STATE_VERSION) {
      throw new BudgetError(
        "BUDGET_INVALID",
        `budget snapshot version ${JSON.stringify(snapshot.version)} is not compatible with ${BUDGET_STATE_VERSION}`,
      );
    }
    const runs: Record<string, RunBudget> = {};
    for (const run of snapshot.runs) {
      // Restored active runs resume fenced: external effects from before
      // the backup are uncertain until reconciled.
      const restored: RunBudget = { ...run, fenced: true };
      if (restored.status === "running") restored.status = "continuing";
      runs[restored.runId] = restored;
    }
    this.state = { version: BUDGET_STATE_VERSION, runs, days: { ...snapshot.days } };
    this.persist();
  }
}

/**
 * ADR-001 lease composition (read-only): attaches the installation lease
 * status as evidence for budget-affecting operations. This NEVER acquires
 * or creates a lock — the installation lease remains the single writer
 * lease; budget state is data under it.
 */
export function leaseEvidence(runtimeDir: string): LeaseStatus {
  return installLeaseStatus(runtimeDir);
}
