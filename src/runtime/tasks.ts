import { createHash } from "node:crypto";
import type { GatherGatewayConnection } from "./client.ts";

/**
 * Task submission / status / history over documented Gateway RPC methods.
 *
 * Methods used (all present in the installed server methods list and the RPC
 * reference at https://docs.openclaw.ai/gateway/protocol/rpc-methods):
 *   agent         — start one agent run; returns { runId, acceptedAt }
 *   agent.wait    — wait for a run; returns { status: ok|error|timeout, ... }
 *   chat.history  — session transcript for evidence display
 *   sessions.list — durable session index
 *
 * Timeout semantics per https://docs.openclaw.ai/gateway/external-apps and
 * /concepts/agent-loop: an agent.wait timeout is wait-only — it does NOT stop
 * the underlying run. Terminal "error" may represent cancellation;
 * stopReason "superseded" means a newer session writer replaced the run.
 */

export const DEFAULT_AGENT_ID = "main";

const UNSAFE_SESSION_CHARS = /[^a-zA-Z0-9._-]+/g;

/**
 * Deterministic per-booking session key in the supported
 * `agent:<agentId>:<rest>` form (non-empty rest segments).
 * Every message for one booking shares one session, so conversational state
 * and deduping are stable across process restarts.
 */
export function bookingSessionKey(
  bookingId: string,
  agentId: string = DEFAULT_AGENT_ID,
): string {
  const safeBooking = bookingId.trim().replace(UNSAFE_SESSION_CHARS, "-");
  const safeAgent = agentId.trim().replace(UNSAFE_SESSION_CHARS, "-") || DEFAULT_AGENT_ID;
  if (!safeBooking) throw new Error("bookingId must contain a usable character");
  return `agent:${safeAgent}:gather:booking:${safeBooking}`;
}

/**
 * Deterministic idempotency key for one logical task submission. Callers
 * persist the key and reuse it on retry; the gateway requires
 * `idempotencyKey` on the `agent` RPC, which is Gather's duplicate-run
 * prevention hook.
 */
export function stableTaskIdempotencyKey(input: {
  bookingId: string;
  step: string;
  identity: Record<string, string | number>;
}): string {
  const canonicalIdentity = Object.fromEntries(
    Object.entries(input.identity)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, value]),
  );
  const material = JSON.stringify({
    bookingId: input.bookingId,
    step: input.step,
    identity: canonicalIdentity,
  });
  const digest = createHash("sha256").update(material).digest("hex").slice(0, 16);
  return `gather:runtime:${input.step}:${digest}`;
}

export interface SubmitTaskRequest {
  bookingId: string;
  /** The instruction for this run. */
  message: string;
  /**
   * Idempotency key for this exact submission. Derive with
   * stableTaskIdempotencyKey or supply a persisted key on retry.
   */
  idempotencyKey: string;
  agentId?: string;
  /** Extra system-prompt context for this run only. */
  extraSystemPrompt?: string;
  /** Operator-visible label. */
  label?: string;
  /** Server-side run budget in ms (NOT the wait timeout). */
  runTimeoutMs?: number;
}

export interface SubmittedTask {
  runId: string;
  acceptedAt: number;
  sessionKey: string;
  idempotencyKey: string;
}

export type RunWaitStatus = "ok" | "error" | "timeout" | "pending";

export interface RunWaitResult {
  status: RunWaitStatus;
  runId: string;
  /**
   * True when status is "timeout" or "pending": the wait expired but the
   * remote run may still be executing. A timeout is never proof the run
   * stopped — reconcile before retrying or declaring failure.
   */
  executionMayContinue: boolean;
  stopReason?: string;
  error?: string;
  startedAt?: number;
  endedAt?: number;
  raw: unknown;
}

export interface SessionHistoryEntry {
  raw: unknown;
}

export class GatherRuntimeTasks {
  private readonly connection: GatherGatewayConnection;

  constructor(connection: GatherGatewayConnection) {
    this.connection = connection;
  }

  /** Starts one agent run on the booking's stable session. */
  async submitTask(request: SubmitTaskRequest): Promise<SubmittedTask> {
    const sessionKey = bookingSessionKey(request.bookingId, request.agentId);
    const params: Record<string, unknown> = {
      message: request.message,
      sessionKey,
      idempotencyKey: request.idempotencyKey,
      deliver: false,
      label: request.label ?? `gather:${request.bookingId}`,
    };
    if (request.agentId) params.agentId = request.agentId;
    if (request.extraSystemPrompt) params.extraSystemPrompt = request.extraSystemPrompt;
    if (request.runTimeoutMs) params.timeout = request.runTimeoutMs;

    const response = await this.connection.request<{ runId: string; acceptedAt: number }>(
      "agent",
      params,
    );
    return {
      runId: response.runId,
      acceptedAt: response.acceptedAt,
      sessionKey,
      idempotencyKey: request.idempotencyKey,
    };
  }

  /**
   * Waits for a run's terminal snapshot. A "timeout" result means ONLY that
   * the wait expired — the run may still be executing remotely; it does not
   * stop or cancel the run.
   */
  async waitForRun(input: {
    runId: string;
    timeoutMs?: number;
  }): Promise<RunWaitResult> {
    const timeoutMs = input.timeoutMs ?? 30000;
    const response = await this.connection.request<Record<string, unknown>>(
      "agent.wait",
      { runId: input.runId, timeoutMs },
      { timeoutMs: timeoutMs + 15000 },
    );
    const status = (response.status as RunWaitStatus | undefined) ?? "timeout";
    return {
      status,
      runId: input.runId,
      executionMayContinue: status === "timeout" || status === "pending",
      stopReason: typeof response.stopReason === "string" ? response.stopReason : undefined,
      error: typeof response.error === "string" ? response.error : undefined,
      startedAt: typeof response.startedAt === "number" ? response.startedAt : undefined,
      endedAt: typeof response.endedAt === "number" ? response.endedAt : undefined,
      raw: response,
    };
  }

  /** Transcript for one session — display evidence, not a source of truth. */
  async sessionHistory(input: {
    sessionKey: string;
    limit?: number;
  }): Promise<SessionHistoryEntry[]> {
    const response = await this.connection.request<{ messages?: unknown[] }>(
      "chat.history",
      { sessionKey: input.sessionKey, limit: input.limit ?? 50 },
    );
    return (response.messages ?? []).map((raw) => ({ raw }));
  }

  /** Durable session index rows (sessions.list). */
  async listSessions(): Promise<unknown> {
    return this.connection.request("sessions.list", {});
  }

  /** Gateway status summary (status). */
  async gatewayStatus(): Promise<unknown> {
    return this.connection.request("status", {});
  }
}
