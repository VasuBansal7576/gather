import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { GatherStore } from "../sqlite-store.ts";
import type { GatherRuntimeTasks } from "../../runtime/tasks.ts";
import { GatherOpenClawRuntime } from "../../runtime/openclaw-runtime.ts";
import type { GatherModelSelection } from "../../runtime/config.ts";
import { ModelConfigError } from "../../runtime/config.ts";
import type { ProviderConnectors } from "../provider-runtime/index.ts";
import { GatherMcpBoundary } from "../../runtime/mcp.ts";
import { createLiveMcpTools, type LiveMcpAuditEntry } from "./mcp-tools.ts";
import type {
  LiveRunInput,
  LiveRunRecord,
  LiveRunStep,
  PreparedProposal,
  ProposalTerms,
} from "./types.ts";
import { LiveModelError } from "./types.ts";

/**
 * Executable live-model host: a real GatherOpenClawRuntime (explicit
 * N-model selection, never a fallback) fronts four run-scoped Gather MCP
 * tools on a loopback boundary, and the model drives the journey by
 * CALLING those tools — reads and proposal assembly happen inside tool
 * handlers against server-side designated sources, never in a hardcoded
 * pipeline. The run lifecycle (submit/wait/history) rides the injected
 * tasks channel; tool-call audit is durable per call.
 *
 * Nothing here executes a live model or touches live Google until the
 * gates pass: explicit model selection, live opt-in + consent, and the
 * designated connected account/recipient. Scripted verification drives
 * the same boundary through a real MCP client over loopback HTTP.
 */

export const CONTROLLED_TEST_RECIPIENT = "work.vasu.ai@gmail.com";

export interface ExecutionPlannerCall {
  tool: string;
  args: Record<string, unknown>;
}

export interface ExecutionPlanner {
  planCall(history: Array<{ tool: string; ok: boolean; result?: unknown; error?: string }>): Promise<ExecutionPlannerCall | { done: true }>;
}

export interface LiveExecutionOptions {
  store: GatherStore;
  providers: ProviderConnectors;
  /** Explicit N-model selection (ids only, never credentials); absent means MODEL_UNCONFIGURED. */
  model?: GatherModelSelection;
  /** Injected tasks channel (scripted in verification; live channel later). */
  tasks?: GatherRuntimeTasks;
  recipient?: string;
  runTimeoutMs?: number;
  mcpPort?: number;
  now?: () => string;
}

export interface ScopedExecution {
  runtime: GatherOpenClawRuntime;
  runtimeStarted: boolean;
  boundary: GatherMcpBoundary;
  boundaryUrl: string;
  authToken: string;
  model: string;
  close(): Promise<void>;
}

function nowIso(options: Pick<LiveExecutionOptions, "now">): string {
  return options.now ? options.now() : new Date().toISOString();
}

export function ensureLiveRunTables(store: GatherStore): void {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS live_model_runs (
      id TEXT PRIMARY KEY,
      business_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      simulated INTEGER NOT NULL,
      status TEXT NOT NULL,
      idempotency_key TEXT,
      record_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_live_model_runs_key ON live_model_runs(business_id, idempotency_key);
    CREATE TABLE IF NOT EXISTS live_model_tool_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      tool TEXT NOT NULL,
      at TEXT NOT NULL,
      ok INTEGER NOT NULL,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_live_model_tool_calls_run ON live_model_tool_calls(run_id);
  `);
}

function writeLiveRun(store: GatherStore, record: LiveRunRecord, idempotencyKey?: string): void {
  store.db
    .prepare(
      `INSERT INTO live_model_runs (id, business_id, account_id, mode, simulated, status, idempotency_key, record_json, created_at, updated_at)
       VALUES ($id, $b, $a, $mode, $sim, $status, $key, $record, $at, $at)
       ON CONFLICT (id) DO UPDATE SET status = excluded.status, record_json = excluded.record_json, updated_at = excluded.updated_at`,
    )
    .run({
      $id: record.runId,
      $b: record.businessId,
      $a: record.accountId,
      $mode: record.mode,
      $sim: record.simulated ? 1 : 0,
      $status: record.status,
      $key: idempotencyKey ?? null,
      $record: JSON.stringify(record),
      $at: record.finishedAt,
    });
}

function readPriorRun(store: GatherStore, businessId: string, idempotencyKey: string): LiveRunRecord | undefined {
  const row = store.db
    .prepare("SELECT record_json FROM live_model_runs WHERE business_id = $b AND idempotency_key = $k ORDER BY created_at DESC LIMIT 1")
    .get({ $b: businessId, $k: idempotencyKey }) as { record_json: string } | undefined;
  if (!row) return undefined;
  return JSON.parse(String(row.record_json)) as LiveRunRecord;
}

/**
 * Start the executable host: gate the explicit model selection through N's
 * contract, construct (not spawn) the owned GatherOpenClawRuntime with the
 * run's MCP tools registered, and listen on loopback. The host owns close:
 * a started runtime is always reaped there — the runner never quits while
 * an owned runtime is unreaped.
 */
export async function startScopedExecutionHost(input: {
  model?: GatherModelSelection;
  tools: ReturnType<typeof createLiveMcpTools>;
  mcpPort?: number;
  rootDir?: string;
}): Promise<ScopedExecution> {
  const runtime = new GatherOpenClawRuntime({
    rootDir: input.rootDir ?? join(tmpdir(), "gather-live-model-idle"),
    // Construction only resolves layout (no bind/spawn until start); the
    // port below is never bound on this path.
    gatewayPort: 19411,
    ...(input.model === undefined ? {} : { model: input.model }),
    mcpTools: input.tools,
    ...(input.mcpPort === undefined ? {} : { mcpPort: input.mcpPort }),
  });
  let model: string;
  try {
    model = runtime.requireModelSelection().model;
  } catch (error) {
    if (error instanceof ModelConfigError) {
      throw new LiveModelError("MODEL_UNCONFIGURED", `model not configured: ${error.message}`);
    }
    throw error;
  }
  const authToken = randomBytes(24).toString("hex");
  const boundary = new GatherMcpBoundary({ tools: input.tools, authToken });
  const { url } = await boundary.listen({ port: input.mcpPort ?? 0 });
  const runtimeStarted = false;
  return {
    runtime,
    runtimeStarted,
    boundary,
    boundaryUrl: url,
    authToken,
    model,
    close: async () => {
      await boundary.close().catch(() => undefined);
      if (runtimeStarted) await runtime.stop().catch(() => undefined);
    },
  };
}

/**
 * Execute one designated journey with the model (or its scripted planner
 * stand-in) calling the registered MCP tools over loopback HTTP. Source
 * identity stays server-side; the run record + tool-call audit persist
 * durably; timeouts preserve the continuing run id without duplicates.
 */
export async function runLiveExecution(
  input: LiveRunInput & { runTimeoutMs?: number; gatewayIdempotencyKey?: string },
  deps: LiveExecutionOptions & { execution?: "live" | "simulated"; planner?: ExecutionPlanner },
): Promise<LiveRunRecord> {
  if (!input.businessId?.trim() || !input.threadId?.trim() || !input.fileId?.trim() || !input.calendarId?.trim()) {
    throw new LiveModelError("INVALID_REQUEST", "businessId, threadId, fileId, and calendarId are all designated and required");
  }
  ensureLiveRunTables(deps.store);
  if (input.idempotencyKey) {
    const prior = readPriorRun(deps.store, input.businessId, input.idempotencyKey);
    if (prior && prior.status !== "continuing") return prior;
  }
  if (!deps.planner) {
    throw new LiveModelError(
      "MODEL_UNCONFIGURED",
      "no tool-calling driver is wired: live model driving arrives with the authorized path (I, pending); scripted verification injects a planner explicitly",
    );
  }
  const planner = deps.planner;
  const execution = deps.execution ?? (input.mode === "scripted" ? "simulated" : "live");
  const runId = `lmr_${randomUUID()}`;
  const startedAt = nowIso(deps);
  const steps: LiveRunStep[] = [];
  let accountId = "";
  const persistAudit = (entry: LiveMcpAuditEntry): void => {
    deps.store.db
      .prepare("INSERT INTO live_model_tool_calls (run_id, tool, at, ok, error) VALUES ($r, $t, $at, $ok, $e)")
      .run({ $r: runId, $t: entry.tool, $at: entry.at, $ok: entry.ok ? 1 : 0, $e: entry.error ?? null });
  };
  const finish = (status: LiveRunRecord["status"], proposal?: PreparedProposal, error?: string): LiveRunRecord => {
    const record: LiveRunRecord = {
      runId,
      businessId: input.businessId,
      accountId,
      mode: input.mode,
      simulated: execution === "simulated",
      status,
      steps,
      ...(proposal === undefined ? {} : { proposal }),
      ...(error === undefined ? {} : { error }),
      startedAt,
      finishedAt: nowIso(deps),
    };
    writeLiveRun(deps.store, record, input.idempotencyKey);
    return record;
  };

  let scoped: ScopedExecution | undefined;
  let client: Client | undefined;
  try {
    if (input.mode === "live") {
      if (input.allowLive !== true) throw new LiveModelError("LIVE_NOT_AUTHORIZED", "live runs require explicit allowLive opt-in");
      if (!process.env.GATHER_LIVE_CONSENT?.trim()) {
        throw new LiveModelError("LIVE_NOT_AUTHORIZED", "live runs require explicit consent (GATHER_LIVE_CONSENT); no live Google/model requests until the Astra start handoff");
      }
    }
    const gmail = deps.providers.resolveAccountPorts({ businessId: input.businessId, capability: "gmail" });
    if (!gmail.ok || !gmail.ports.inbox || !gmail.ports.threads) {
      throw new LiveModelError("LIVE_NOT_AUTHORIZED", `no verified connected Gmail account with inbox+threads for business ${input.businessId}`);
    }
    const drive = deps.providers.resolveAccountPorts({ businessId: input.businessId, capability: "google_drive" });
    if (!drive.ok || !drive.ports.documents) {
      throw new LiveModelError("LIVE_NOT_AUTHORIZED", `no verified connected Drive account for business ${input.businessId}`);
    }
    if (drive.ports.account.businessId !== input.businessId) {
      throw new LiveModelError("LIVE_NOT_AUTHORIZED", "Drive ports resolved to a different business; refusing cross-business assembly");
    }
    const calendar = deps.providers.resolveCalendarPorts({ businessId: input.businessId, calendarId: input.calendarId });
    if (!calendar.ok) {
      throw new LiveModelError("LIVE_NOT_AUTHORIZED", `calendar ${input.calendarId} is not bound to a verified account of this business`);
    }
    if (calendar.ports.account.businessId !== input.businessId) {
      throw new LiveModelError("LIVE_NOT_AUTHORIZED", "calendar is pinned to a different business; refusing cross-business assembly");
    }
    accountId = gmail.ports.account.id;
    const recipient = deps.recipient ?? CONTROLLED_TEST_RECIPIENT;
    if (!recipient.trim()) throw new LiveModelError("INVALID_REQUEST", "a server-side controlled recipient is required");

    const tools = createLiveMcpTools({
      store: deps.store,
      businessId: input.businessId,
      accountId,
      runId,
      threadId: input.threadId,
      fileId: input.fileId,
      calendarId: input.calendarId,
      recipient,
      threads: gmail.ports.threads,
      documents: drive.ports.documents,
      calendar: calendar.ports.calendar,
      execution,
      ...(deps.now === undefined ? {} : { now: deps.now }),
      audit: persistAudit,
      state: {},
    });
    scoped = await startScopedExecutionHost({ model: deps.model, tools });

    const transport = new StreamableHTTPClientTransport(new URL(scoped.boundaryUrl), {
      requestInit: { headers: { authorization: `Bearer ${scoped.authToken}` } },
    });
    client = new Client({ name: "gather-live-runner", version: "0.1.0" });
    await client.connect(transport);
    const listed = await client.listTools();
    const available = new Set(listed.tools.map((tool) => tool.name));
    for (const tool of tools) {
      if (!available.has(tool.name)) throw new LiveModelError("TOOL_FAILURE", `registered tool ${tool.name} missing from the live boundary`);
    }

    // Run lifecycle on the tasks channel when injected: announce the run
    // session, then wait it out at the end. Gateway idempotency is stable
    // per caller key, so retries never duplicate the provider run.
    let gatewayRunId: string | undefined;
    if (deps.tasks) {
      const submitted = await deps.tasks.submitTask({
        bookingId: `live-model:${input.businessId}:${runId}`,
        message: `Live-model proposal run ${runId} for business ${input.businessId} (tools called over MCP; no approval authority).`,
        idempotencyKey: input.gatewayIdempotencyKey ?? input.idempotencyKey ?? `live-model:${runId}`,
        label: `gather:live-model:${input.businessId}`,
      });
      gatewayRunId = submitted.runId;
    }

    const timeoutMs = input.runTimeoutMs ?? deps.runTimeoutMs;
    const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
    const history: Array<{ tool: string; ok: boolean; result?: unknown; error?: string }> = [];
    let proposal: PreparedProposal | undefined;
    const withDeadline = async <T>(work: Promise<T>, what: string): Promise<T> => {
      if (deadline === undefined) return work;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new LiveModelError("TOOL_FAILURE", `run deadline expired before ${what}; run continues under its id`);
      let timer;
      try {
        return await Promise.race([
          work,
          new Promise<T>((_, reject) => {
            timer = setTimeout(() => reject(new LiveModelError("TOOL_FAILURE", `run deadline expired during ${what}; run continues under its id`)), remaining);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    const expired = (error: unknown): boolean =>
      error instanceof LiveModelError && error.message.startsWith("run deadline expired");
    for (;;) {
      if (deadline !== undefined && Date.now() >= deadline) {
        return finish("continuing", undefined, "run deadline expired; run continues under its id and may be resumed");
      }
      let planned;
      try {
        planned = await withDeadline(planner.planCall(history), "planning the next tool call");
      } catch (error) {
        if (expired(error)) return finish("continuing", undefined, error instanceof Error ? error.message : String(error));
        throw error;
      }
      if ("done" in planned) break;
      const at = nowIso(deps);
      try {
        let result;
        try {
          result = await withDeadline(client.callTool({ name: planned.tool, arguments: planned.args }), `MCP call ${planned.tool}`);
        } catch (error) {
          if (expired(error)) return finish("continuing", undefined, error instanceof Error ? error.message : String(error));
          throw error;
        }
        const structured = (result as { structuredContent?: unknown }).structuredContent;
        const isError = (result as { isError?: boolean }).isError === true;
        history.push({ tool: planned.tool, ok: !isError, ...(isError ? { error: JSON.stringify(structured ?? result).slice(0, 500) } : { result: structured }) });
        steps.push({ tool: planned.tool as LiveRunStep["tool"], ok: !isError, at });
        if (!isError && planned.tool === "gather.prepare_proposal") {
          const content = structured as { bookingId?: string; proposedActionId?: string; terms?: ProposalTerms; evidence?: PreparedProposal["evidence"] } | undefined;
          if (content?.bookingId && content?.proposedActionId && content?.terms && content?.evidence) {
            proposal = {
              bookingId: content.bookingId,
              proposedActionId: content.proposedActionId,
              terms: content.terms,
              evidence: content.evidence,
              provenance: {
                tool: "prepareProposal",
                runId,
                businessId: input.businessId,
                accountId,
                source: { kind: "manual", locator: `gather:proposal/${content.proposedActionId}` },
                at,
              },
            };
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        history.push({ tool: planned.tool, ok: false, error: message });
        steps.push({ tool: planned.tool as LiveRunStep["tool"], ok: false, at, error: message });
        throw new LiveModelError("TOOL_FAILURE", `MCP call ${planned.tool} transport-failed: ${message}`);
      }
    }

    if (deps.tasks && gatewayRunId) {
      const wait = await deps.tasks.waitForRun({ runId: gatewayRunId, timeoutMs: 5000 });
      if (wait.status === "timeout" || wait.status === "unknown") {
        return finish("continuing", proposal, `gateway wait ${wait.status}; run continues under ${runId}`);
      }
      if (wait.status === "error") {
        throw new LiveModelError("TOOL_FAILURE", `gateway run failed: ${wait.error ?? wait.stopReason ?? "unknown"}`);
      }
    }
    if (!proposal) throw new LiveModelError("TOOL_FAILURE", "planner finished without preparing a proposal");
    return finish("ok", proposal);
  } catch (error) {
    const record: LiveRunRecord = {
      runId,
      businessId: input.businessId,
      accountId,
      mode: input.mode,
      simulated: execution === "simulated",
      status: "error",
      steps,
      error: error instanceof Error ? error.message : String(error),
      startedAt,
      finishedAt: nowIso(deps),
    };
    writeLiveRun(deps.store, record, input.idempotencyKey);
    throw error;
  } finally {
    await client?.close().catch(() => undefined);
    await scoped?.close().catch(() => undefined);
  }
}

export function getLiveRun(store: GatherStore, runId: string): LiveRunRecord | undefined {
  ensureLiveRunTables(store);
  const row = store.db.prepare("SELECT record_json FROM live_model_runs WHERE id = $id").get({ $id: runId }) as
    | { record_json: string }
    | undefined;
  if (!row) return undefined;
  return JSON.parse(String(row.record_json)) as LiveRunRecord;
}

export function listToolCalls(store: GatherStore, runId: string): Array<{ tool: string; at: string; ok: boolean; error?: string }> {
  ensureLiveRunTables(store);
  const rows = store.db
    .prepare("SELECT tool, at, ok, error FROM live_model_tool_calls WHERE run_id = $r ORDER BY id")
    .all({ $r: runId }) as Array<{ tool: string; at: string; ok: number; error: string | null }>;
  return rows.map((row) => ({ tool: row.tool, at: row.at, ok: row.ok === 1, ...(row.error == null ? {} : { error: row.error }) }));
}
