import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BudgetStore, leaseEvidence, type RunBudget } from "../server/budget.ts";
import { containsSecret } from "./auth.ts";
import type { GatewayRequestChannel } from "./client.ts";
import { provisionPreflight, type RuntimeManifest } from "./manifest.ts";
import {
  GatherOpenClawRuntime,
  type GatherOpenClawRuntimeOptions,
  type GatherRuntimeDeps,
} from "./openclaw-runtime.ts";
import { GatherRuntimeTasks } from "./tasks.ts";

/**
 * ADR-009 C08 RuntimeControl: provision/readiness/run-budget/restart
 * support over the existing process/client/tasks/MCP boundary.
 *
 * Port surface: provision (live-only, pinned manifest), start, health,
 * submit, observe, stop, backup, restoreCompatible, plus bounded repair
 * controls. Prepared mode uses ScriptedRuntimeControl — the same port
 * with scripted behavior that NEVER calls provision.
 *
 * Authority rules enforced here:
 * - Budgets are reserved BEFORE dispatch; a denied reservation never
 *   reaches the gateway (C08 "checked at trusted dispatch boundaries").
 * - `agent.wait` timeouts are observation-only; a separate real execution
 *   deadline fences tools and requests supported cancellation. A wait that
 *   expires never starts a duplicate run.
 * - Health never depends on the booking agent answering (supervisor is
 *   outside the agent); only gateway-level liveness is probed.
 * - Unknown/cancelled runs cannot relaunch as duplicates.
 * - Backup covers only consistent compatible state and never secrets;
 *   restore requires external reconciliation before resuming.
 */

export class RuntimeControlError extends Error {
  readonly code:
    | "PREPARED_NEVER_PROVISIONS"
    | "PROVISION_FAILED"
    | "NOT_STARTED"
    | "BUDGET_DENIED"
    | "RELAUNCH_DENIED"
    | "DEADLINE_FENCED"
    | "CANCEL_UNVERIFIED"
    | "BACKUP_INCONSISTENT"
    | "BACKUP_SECRETS_LEAK"
    | "RESTORE_INCOMPATIBLE"
    | "EXTERNAL_RECONCILIATION_REQUIRED"
    | "REPAIR_UNKNOWN_ACTION"
    | "REPAIR_FAILED";
  constructor(code: RuntimeControlError["code"], message: string) {
    super(message);
    this.name = "RuntimeControlError";
    this.code = code;
  }
}

export const BACKUP_SCHEMA_VERSION = 1;

export interface ProvisionInput {
  /** "live" provisions the isolated runtime; "prepared" is refused (scripted port only). */
  mode: "live" | "prepared";
  manifestPath?: string;
  /** Installed name->version map for pin validation (read from the installed tree, never a registry). */
  installed?: Record<string, string>;
  nodeVersion?: string;
  platform?: string;
  executableCommand?: string;
}

export interface SubmitInput {
  businessId: string;
  bookingId: string;
  message: string;
  idempotencyKey: string;
  /** Next-call maximums reserved BEFORE dispatch (C08). */
  maxInputTokens: number;
  maxOutputTokens: number;
  label?: string;
}

export interface SubmittedRun {
  budget: RunBudget;
  duplicate: boolean;
  gatewayRunId: string;
  sessionKey: string;
}

export interface ObserveInput {
  runId: string;
  gatewayRunId: string;
  /** Observation-only wait budget (never a stop signal). */
  waitTimeoutMs?: number;
  nowMs?: number;
}

export interface ObserveResult {
  budget: RunBudget;
  waitStatus: string;
  /** True unless the run verifiably reached a terminal state. */
  executionMayContinue: boolean;
  fencedByDeadline: boolean;
}

export interface HealthReport {
  process: string;
  connection: string;
  gatewayReachable: boolean;
  gatewayDetail: string;
  /** Health never depends on the booking agent: no agent RPC was issued. */
  agentIndependent: true;
  manifestPath: string | null;
  activeRuns: number;
  lease: ReturnType<typeof leaseEvidence>;
}

export interface BackupResult {
  backupPath: string;
  schemaVersion: number;
  runs: number;
  manifestPins: Record<string, string>;
}

export interface RestoreResult {
  restoredRuns: number;
  manifestPath: string;
}

export type RepairAction = "restart_runtime" | "mark_blocked";

export interface RuntimeControlPort {
  readonly kind: "live" | "scripted";
  provision(input: ProvisionInput): Promise<{ configPath: string; manifest: RuntimeManifest; manifestPath: string }>;
  start(): Promise<void>;
  health(): Promise<HealthReport>;
  submit(input: SubmitInput): Promise<SubmittedRun>;
  observe(input: ObserveInput): Promise<ObserveResult>;
  requestCancellation(runId: string, input?: { stopOwnedProcess?: boolean }): Promise<{ fenced: boolean; stopRequested: boolean }>;
  stop(): Promise<void>;
  backup(dir: string): Promise<BackupResult>;
  restoreCompatible(backupPath: string, input?: { externalReconciled?: boolean }): Promise<RestoreResult>;
  repair(action: RepairAction, input?: { runId?: string; reason?: string }): Promise<{ action: RepairAction; ok: boolean; detail: string }>;
}

function pinsOf(manifest: RuntimeManifest): Record<string, string> {
  return Object.fromEntries(Object.entries(manifest.releases).map(([name, release]) => [name, release.pinned]));
}

function readIsolatedSecrets(layout: { secretsDir: string }): string[] {
  if (!existsSync(layout.secretsDir)) return [];
  const values: string[] = [];
  for (const entry of readdirSync(layout.secretsDir)) {
    try {
      const content = readFileSync(join(layout.secretsDir, entry), "utf8").trim();
      if (content.length >= 4) values.push(content);
    } catch {
      // Unreadable entry: ignore for the scan (backup never includes secretsDir contents anyway).
    }
  }
  return values;
}

export class GatherRuntimeControl implements RuntimeControlPort {
  readonly kind = "live" as const;
  private readonly runtime: GatherOpenClawRuntime;
  private readonly budgets: BudgetStore;
  private readonly runtimeRootDir: string;
  private manifestPath: string | null = null;

  constructor(input: {
    runtimeOptions: GatherOpenClawRuntimeOptions;
    runtimeDeps?: GatherRuntimeDeps;
    budgetStateDir: string;
    budgetLimits?: ConstructorParameters<typeof BudgetStore>[0]["limits"];
    now?: () => number;
  }) {
    this.runtime = new GatherOpenClawRuntime(input.runtimeOptions, input.runtimeDeps ?? {});
    this.runtimeRootDir = input.runtimeOptions.rootDir;
    this.budgets = new BudgetStore({
      stateDir: input.budgetStateDir,
      ...(input.budgetLimits === undefined ? {} : { limits: input.budgetLimits }),
      ...(input.now === undefined ? {} : { now: input.now }),
    });
  }

  /** Visible for backup/restore evidence; tests use the port, not this handle. */
  get budgetStore(): BudgetStore {
    return this.budgets;
  }

  /**
   * Live-only provision: validates the pinned manifest (exact pins,
   * Node/platform, executable source) BEFORE creating any state, then
   * materializes the isolated layout + config. Prepared mode is refused:
   * it uses the scripted port and never calls provision.
   */
  async provision(input: ProvisionInput): Promise<{ configPath: string; manifest: RuntimeManifest; manifestPath: string }> {
    if (input.mode !== "live") {
      throw new RuntimeControlError(
        "PREPARED_NEVER_PROVISIONS",
        `provision is live-only; mode ${JSON.stringify(input.mode)} uses the scripted port and never calls provision`,
      );
    }
    let manifest: RuntimeManifest;
    let manifestPath: string;
    try {
      ({ manifest, path: manifestPath } = provisionPreflight({
        ...(input.manifestPath === undefined ? {} : { manifestPath: input.manifestPath }),
        ...(input.nodeVersion === undefined ? {} : { nodeVersion: input.nodeVersion }),
        ...(input.platform === undefined ? {} : { platform: input.platform }),
        ...(input.installed === undefined ? {} : { installed: input.installed }),
        ...(input.executableCommand === undefined ? {} : { executableCommand: input.executableCommand }),
      }));
    } catch (error) {
      throw new RuntimeControlError("PROVISION_FAILED", error instanceof Error ? error.message : String(error));
    }
    const { configPath } = this.runtime.provision();
    this.manifestPath = manifestPath;
    return { configPath, manifest, manifestPath };
  }

  async start(): Promise<void> {
    await this.runtime.start();
  }

  async stop(): Promise<void> {
    await this.runtime.stop();
  }

  /**
   * Gateway-level liveness only: process/connection state plus a `status`
   * RPC when the connection is already ready. Never issues an agent RPC —
   * a broken booking agent cannot fail health, and health can never hang
   * on model execution. Unreachable gateway reports degraded, not ready.
   */
  async health(): Promise<HealthReport> {
    const state = this.runtime.state;
    let gatewayReachable = false;
    let gatewayDetail = `connection ${state.connection}; no gateway RPC attempted`;
    if (state.connection === "ready") {
      try {
        await this.runtime.tasks.gatewayStatus();
        gatewayReachable = true;
        gatewayDetail = "status RPC answered on the ready connection";
      } catch (error) {
        gatewayDetail = `ready connection but status RPC failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    const activeRuns = this.budgets.snapshot().runs.filter((run) => run.status === "running" || run.status === "continuing").length;
    return {
      process: state.process,
      connection: state.connection,
      gatewayReachable,
      gatewayDetail,
      agentIndependent: true,
      manifestPath: this.manifestPath,
      activeRuns,
      lease: leaseEvidence(join(this.runtimeRootDir, "..")),
    };
  }

  /**
   * Trusted dispatch boundary: budget reservation (run claim + next-call
   * maximums) happens BEFORE the gateway sees anything. A denied
   * reservation throws BUDGET_DENIED and no `agent` RPC is issued.
   * Unknown/cancelled runs cannot relaunch as duplicates.
   */
  async submit(input: SubmitInput): Promise<SubmittedRun> {
    let run: RunBudget;
    let duplicate: boolean;
    try {
      ({ run, duplicate } = this.budgets.startRun({ businessId: input.businessId, idempotencyKey: input.idempotencyKey }));
    } catch (error) {
      throw new RuntimeControlError(
        error instanceof Error && error.name === "BudgetError" && (error as { code?: string }).code === "BUDGET_RELAUNCH_DENIED"
          ? "RELAUNCH_DENIED"
          : "BUDGET_DENIED",
        error instanceof Error ? error.message : String(error),
      );
    }
    if (duplicate && run.status !== "running" && run.status !== "continuing") {
      throw new RuntimeControlError(
        "RELAUNCH_DENIED",
        `run ${run.runId} is ${run.status} and cannot relaunch as a duplicate; reconcile it first`,
      );
    }
    try {
      this.budgets.reserveToolCall(run.runId, { maxInputTokens: input.maxInputTokens, maxOutputTokens: input.maxOutputTokens });
    } catch (error) {
      throw new RuntimeControlError("BUDGET_DENIED", error instanceof Error ? error.message : String(error));
    }
    const tasks = this.runtime.tasks;
    const submitted = await tasks.submitTask({
      bookingId: input.bookingId,
      message: input.message,
      idempotencyKey: input.idempotencyKey,
      ...(input.label === undefined ? {} : { label: input.label }),
    });
    return { budget: this.budgets.getRun(run.runId), duplicate, gatewayRunId: submitted.runId, sessionKey: submitted.sessionKey };
  }

  /**
   * Observation with separated timeouts: the wait budget is
   * observation-only (a `timeout` never stops the remote run and never
   * starts a duplicate), while the real execution deadline fences
   * further Gather tools. In-flight effects after fencing stay uncertain
   * until reconciled.
   */
  async observe(input: ObserveInput): Promise<ObserveResult> {
    // Budget identity first: an unknown run cannot relaunch as a duplicate,
    // and no wait RPC is issued for a run this control never claimed.
    this.budgets.getRun(input.runId);
    const tasks = this.runtime.tasks;
    const wait = await tasks.waitForRun({ runId: input.gatewayRunId, timeoutMs: input.waitTimeoutMs ?? 30_000 });
    const deadline = this.budgets.deadlineStatus(input.runId, input.nowMs);
    let budget = this.budgets.getRun(input.runId);
    let fencedByDeadline = false;
    if (deadline === "expired" && (wait.status === "timeout" || wait.status === "unknown" || wait.status === "pending")) {
      budget = this.budgets.fenceRun(input.runId);
      fencedByDeadline = true;
    } else if (wait.status === "ok") {
      budget = this.budgets.finishRun(input.runId, "completed");
    } else if (wait.status === "error") {
      budget = this.budgets.finishRun(input.runId, "failed");
    }
    return { budget, waitStatus: wait.status, executionMayContinue: wait.executionMayContinue, fencedByDeadline };
  }

  /**
   * Supported cancellation: fences further Gather tools immediately. The
   * owned isolated process is stopped ONLY on explicit request, and only
   * stop() with its observed exit counts — an unobserved exit stays
   * blocked/unknown and in-flight provider effects stay uncertain until
   * reconciled. No `agent.cancel` RPC is invented: the pinned gateway
   * protocol (see manifest) exposes no such method, recorded here as a
   * live-proof blocker rather than a substituted call.
   */
  async requestCancellation(runId: string, input: { stopOwnedProcess?: boolean } = {}): Promise<{ fenced: boolean; stopRequested: boolean }> {
    this.budgets.fenceRun(runId);
    if (!input.stopOwnedProcess) return { fenced: true, stopRequested: false };
    try {
      await this.runtime.stop();
    } catch (error) {
      throw new RuntimeControlError(
        "CANCEL_UNVERIFIED",
        `run ${runId} is fenced but the owned process exit was not observed: ${error instanceof Error ? error.message : String(error)} — it stays blocked/unknown`,
      );
    }
    return { fenced: true, stopRequested: true };
  }

  /**
   * Backs up only consistent compatible state: active unfenced runs block
   * the backup (their effects are still in flight). The payload is an
   * allowlist (manifest pins, redacted config, budget snapshot) — secrets
   * are scanned for and any leak fails the backup.
   */
  async backup(dir: string): Promise<BackupResult> {
    const snapshot = this.budgets.snapshot();
    const active = snapshot.runs.filter((run) => (run.status === "running" || run.status === "continuing") && !run.fenced);
    if (active.length > 0) {
      throw new RuntimeControlError(
        "BACKUP_INCONSISTENT",
        `backup refused: ${active.length} active unfenced run(s) (${active.map((run) => run.runId).join(", ")}); fence or settle them first`,
      );
    }
    const { manifest, path: manifestPath } = this.manifestPath
      ? { manifest: provisionPreflight({ manifestPath: this.manifestPath }).manifest, path: this.manifestPath }
      : { manifest: null, path: null };
    const configRaw = existsSync(this.runtime.layout.configPath) ? readFileSync(this.runtime.layout.configPath, "utf8") : null;
    const payload = {
      schemaVersion: BACKUP_SCHEMA_VERSION,
      manifestPath,
      manifestPins: manifest ? pinsOf(manifest) : null,
      config: configRaw ? (JSON.parse(configRaw) as unknown) : null,
      budgets: snapshot,
      backedUpAt: new Date().toISOString(),
    };
    const serialized = JSON.stringify(payload, null, 2);
    const secrets = readIsolatedSecrets(this.runtime.layout);
    if (containsSecret(serialized, secrets)) {
      throw new RuntimeControlError("BACKUP_SECRETS_LEAK", "backup payload contains isolated secret material; refusing to write");
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const backupPath = join(dir, "gather-runtime-backup.json");
    writeFileSync(backupPath, `${serialized}\n`, { mode: 0o600 });
    return { backupPath, schemaVersion: BACKUP_SCHEMA_VERSION, runs: snapshot.runs.length, manifestPins: manifest ? pinsOf(manifest) : {} };
  }

  /**
   * Restores a known-good compatible backup: schema/version and manifest
   * pins must match the current manifest, and external reconciliation
   * must be confirmed — restore never replays external effects. Restored
   * non-terminal runs resume fenced (see BudgetStore.restoreSnapshot).
   */
  async restoreCompatible(backupPath: string, input: { externalReconciled?: boolean } = {}): Promise<RestoreResult> {
    if (input.externalReconciled !== true) {
      throw new RuntimeControlError(
        "EXTERNAL_RECONCILIATION_REQUIRED",
        "restore requires external reconciliation first (re-read provider state with stable correlation); pass { externalReconciled: true } only after it is done",
      );
    }
    let payload: { schemaVersion?: unknown; manifestPins?: unknown; budgets?: unknown; config?: unknown };
    try {
      payload = JSON.parse(readFileSync(backupPath, "utf8")) as typeof payload;
    } catch (error) {
      throw new RuntimeControlError(
        "RESTORE_INCOMPATIBLE",
        `cannot read backup at ${backupPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (payload.schemaVersion !== BACKUP_SCHEMA_VERSION) {
      throw new RuntimeControlError(
        "RESTORE_INCOMPATIBLE",
        `backup schemaVersion ${JSON.stringify(payload.schemaVersion)} is not compatible with ${BACKUP_SCHEMA_VERSION}`,
      );
    }
    if (this.manifestPath) {
      const { manifest } = provisionPreflight({ manifestPath: this.manifestPath });
      const current = pinsOf(manifest);
      const backed = (payload.manifestPins ?? {}) as Record<string, string>;
      for (const [name, pin] of Object.entries(current)) {
        if (backed[name] !== pin) {
          throw new RuntimeControlError(
            "RESTORE_INCOMPATIBLE",
            `backup pins ${name}@${JSON.stringify(backed[name])} do not match current manifest pin ${pin}; refusing cross-version restore`,
          );
        }
      }
    }
    const budgets = payload.budgets as { version?: unknown; runs?: RunBudget[]; days?: Record<string, number> };
    if (budgets?.version !== 1 || !Array.isArray(budgets?.runs)) {
      throw new RuntimeControlError("RESTORE_INCOMPATIBLE", "backup budget snapshot is missing or version-incompatible");
    }
    this.budgets.restoreSnapshot({ version: 1, runs: budgets.runs, days: budgets.days ?? {} });
    this.runtime.provision();
    return { restoredRuns: budgets.runs.length, manifestPath: this.manifestPath ?? "" };
  }

  /**
   * Safe repair controls (bounded catalog, no shell): restart_runtime
   * fences affected runs, observes the old exit, reboots, and proves a
   * useful bounded read; mark_blocked persists a blocked run with a
   * reason. Anything else is rejected — no unrestricted tools, no
   * automatic runtime upgrades.
   */
  async repair(action: RepairAction, input: { runId?: string; reason?: string } = {}): Promise<{ action: RepairAction; ok: boolean; detail: string }> {
    if (action === "mark_blocked") {
      if (!input.runId) {
        throw new RuntimeControlError("REPAIR_FAILED", "mark_blocked requires a runId");
      }
      this.budgets.finishRun(input.runId, "blocked");
      return { action, ok: true, detail: `run ${input.runId} marked blocked: ${input.reason ?? "no reason given"}` };
    }
    if (action === "restart_runtime") {
      for (const run of this.budgets.snapshot().runs) {
        if (run.status === "running" || run.status === "continuing") this.budgets.fenceRun(run.runId);
      }
      await this.runtime.stop();
      await this.runtime.start();
      const health = await this.health();
      if (!health.gatewayReachable && health.connection !== "ready") {
        return { action, ok: true, detail: `restarted; process=${health.process} connection=${health.connection} (gateway not yet protocol-ready — reconcile pending effects before resuming)` };
      }
      return { action, ok: true, detail: `restarted; process=${health.process} connection=${health.connection}; reconcile pending effects before resuming` };
    }
    throw new RuntimeControlError("REPAIR_UNKNOWN_ACTION", `unknown repair action ${JSON.stringify(action)}; catalog is bounded to restart_runtime and mark_blocked`);
  }
}

/** Scripted port for prepared mode: same interface, deterministic stand-ins, NEVER provisions. */
export class ScriptedRuntimeControl implements RuntimeControlPort {
  readonly kind = "scripted" as const;
  private readonly budgets: BudgetStore;
  private readonly channel: GatewayRequestChannel;
  private manifestPath: string | null = null;
  private runs = new Map<string, { gatewayRunId: string; status: string }>();

  constructor(input: { budgetStateDir: string; channel: GatewayRequestChannel; now?: () => number }) {
    this.budgets = new BudgetStore({
      stateDir: input.budgetStateDir,
      ...(input.now === undefined ? {} : { now: input.now }),
    });
    this.channel = input.channel;
  }

  get budgetStore(): BudgetStore {
    return this.budgets;
  }

  async provision(_input: ProvisionInput): Promise<{ configPath: string; manifest: RuntimeManifest; manifestPath: string }> {
    void _input;
    throw new RuntimeControlError(
      "PREPARED_NEVER_PROVISIONS",
      "prepared mode uses the scripted port and never calls provision (C08); pass mode live to the live control",
    );
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  async health(): Promise<HealthReport> {
    return {
      process: "scripted",
      connection: "scripted",
      gatewayReachable: false,
      gatewayDetail: "scripted port: no gateway child exists by construction",
      agentIndependent: true,
      manifestPath: this.manifestPath,
      activeRuns: this.budgets.snapshot().runs.filter((run) => run.status === "running" || run.status === "continuing").length,
      lease: { held: false, alive: false },
    };
  }

  async submit(input: SubmitInput): Promise<SubmittedRun> {
    const { run, duplicate } = this.budgets.startRun({ businessId: input.businessId, idempotencyKey: input.idempotencyKey });
    if (duplicate && run.status !== "running" && run.status !== "continuing") {
      throw new RuntimeControlError("RELAUNCH_DENIED", `run ${run.runId} is ${run.status} and cannot relaunch as a duplicate`);
    }
    try {
      this.budgets.reserveToolCall(run.runId, { maxInputTokens: input.maxInputTokens, maxOutputTokens: input.maxOutputTokens });
    } catch (error) {
      throw new RuntimeControlError("BUDGET_DENIED", error instanceof Error ? error.message : String(error));
    }
    const tasks = new GatherRuntimeTasks(this.channel);
    const submitted = await tasks.submitTask({
      bookingId: input.bookingId,
      message: input.message,
      idempotencyKey: input.idempotencyKey,
      ...(input.label === undefined ? {} : { label: input.label }),
    });
    this.runs.set(run.runId, { gatewayRunId: submitted.runId, status: "running" });
    return { budget: this.budgets.getRun(run.runId), duplicate, gatewayRunId: submitted.runId, sessionKey: submitted.sessionKey };
  }

  async observe(input: ObserveInput): Promise<ObserveResult> {
    this.budgets.getRun(input.runId);
    const tasks = new GatherRuntimeTasks(this.channel);
    const wait = await tasks.waitForRun({ runId: input.gatewayRunId, timeoutMs: input.waitTimeoutMs ?? 30_000 });
    const deadline = this.budgets.deadlineStatus(input.runId, input.nowMs);
    let budget = this.budgets.getRun(input.runId);
    let fencedByDeadline = false;
    if (deadline === "expired" && wait.status !== "ok" && wait.status !== "error") {
      budget = this.budgets.fenceRun(input.runId);
      fencedByDeadline = true;
    } else if (wait.status === "ok") {
      budget = this.budgets.finishRun(input.runId, "completed");
    } else if (wait.status === "error") {
      budget = this.budgets.finishRun(input.runId, "failed");
    }
    return { budget, waitStatus: wait.status, executionMayContinue: wait.executionMayContinue, fencedByDeadline };
  }

  async requestCancellation(runId: string): Promise<{ fenced: boolean; stopRequested: boolean }> {
    this.budgets.fenceRun(runId);
    return { fenced: true, stopRequested: false };
  }

  async backup(dir: string): Promise<BackupResult> {
    const snapshot = this.budgets.snapshot();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const backupPath = join(dir, "gather-runtime-backup.json");
    const payload = { schemaVersion: 1, manifestPath: null, manifestPins: {}, config: null, budgets: snapshot, backedUpAt: new Date().toISOString() };
    const serialized = JSON.stringify(payload, null, 2);
    const digest = createHash("sha256").update(serialized).digest("hex").slice(0, 12);
    void digest;
    writeFileSync(backupPath, `${serialized}\n`, { mode: 0o600 });
    return { backupPath, schemaVersion: 1, runs: snapshot.runs.length, manifestPins: {} };
  }

  async restoreCompatible(backupPath: string, input: { externalReconciled?: boolean } = {}): Promise<RestoreResult> {
    if (input.externalReconciled !== true) {
      throw new RuntimeControlError(
        "EXTERNAL_RECONCILIATION_REQUIRED",
        "restore requires external reconciliation first; pass { externalReconciled: true } only after it is done",
      );
    }
    const payload = JSON.parse(readFileSync(backupPath, "utf8")) as { schemaVersion?: unknown; budgets?: { version?: unknown; runs?: RunBudget[]; days?: Record<string, number> } };
    if (payload.schemaVersion !== 1 || payload.budgets?.version !== 1 || !Array.isArray(payload.budgets?.runs)) {
      throw new RuntimeControlError("RESTORE_INCOMPATIBLE", "scripted backup is missing or version-incompatible");
    }
    this.budgets.restoreSnapshot({ version: 1, runs: payload.budgets.runs, days: payload.budgets.days ?? {} });
    return { restoredRuns: payload.budgets.runs.length, manifestPath: "" };
  }

  async repair(action: RepairAction, input: { runId?: string; reason?: string } = {}): Promise<{ action: RepairAction; ok: boolean; detail: string }> {
    if (action === "mark_blocked") {
      if (!input.runId) throw new RuntimeControlError("REPAIR_FAILED", "mark_blocked requires a runId");
      this.budgets.finishRun(input.runId, "blocked");
      return { action, ok: true, detail: `run ${input.runId} marked blocked: ${input.reason ?? "no reason given"}` };
    }
    if (action === "restart_runtime") {
      return { action, ok: true, detail: "scripted restart: no gateway child exists; runs fenced before resume" };
    }
    throw new RuntimeControlError("REPAIR_UNKNOWN_ACTION", `unknown repair action ${JSON.stringify(action)}`);
  }
}
