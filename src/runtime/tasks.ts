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
 * Unrecognized statuses are treated as non-terminal: they never imply the
 * remote run finished.
 */

export const DEFAULT_AGENT_ID = "main";

const UNSAFE_SESSION_CHARS = /[^a-zA-Z0-9._-]+/g;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string, method: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`malformed ${method} response: ${field} is not a non-empty string`);
  }
  return value;
}

function requireNumber(value: unknown, field: string, method: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`malformed ${method} response: ${field} is not a finite number`);
  }
  return value;
}

/**
 * Deterministic per-booking session key in the supported
 * `agent:<agentId>:<rest>` form (non-empty rest segments).
 *
 * Collision-resistant: the readable slug is sanitized for humans only, while
 * a sha256 digest of the exact bookingId + agentId identity makes distinct
 * bookings distinct — sanitization can never alias "a/b" and "a-b".
 */
export function bookingSessionKey(
  bookingId: string,
  agentId: string = DEFAULT_AGENT_ID,
): string {
  const trimmed = bookingId.trim();
  if (!trimmed) throw new Error("bookingId must contain a usable character");
  const safeBooking = trimmed.replace(UNSAFE_SESSION_CHARS, "-").slice(0, 48) || "booking";
  const safeAgent = agentId.trim().replace(UNSAFE_SESSION_CHARS, "-") || DEFAULT_AGENT_ID;
  const digest = createHash("sha256")
    .update(`gather-booking:${safeAgent}:${trimmed}`)
    .digest("hex")
    .slice(0, 12);
  return `agent:${safeAgent}:gather:booking:${safeBooking}-${digest}`;
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

export type RunWaitStatus = "ok" | "error" | "timeout" | "pending" | "unknown";

const KNOWN_WAIT_STATUSES = new Set(["ok", "error", "timeout", "pending"]);

export interface RunWaitResult {
  status: RunWaitStatus;
  /** The raw status string reported by the gateway, if any. */
  rawStatus?: string;
  runId: string;
  /**
   * True unless the run verifiably reached a terminal state ("ok" or
   * "error"). A wait timeout is wait-only — it does not stop the run — and
   * an unrecognized status can never prove the run finished.
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

    const response = await this.connection.request<unknown>("agent", params);
    if (!isRecord(response)) {
      throw new Error("malformed agent response: not an object");
    }
    return {
      runId: requireString(response.runId, "runId", "agent"),
      acceptedAt: requireNumber(response.acceptedAt, "acceptedAt", "agent"),
      sessionKey,
      idempotencyKey: request.idempotencyKey,
    };
  }

  /**
   * Waits for a run's terminal snapshot. A "timeout" result means ONLY that
   * the wait expired — the run may still be executing remotely; it does not
   * stop or cancel the run. An unrecognized status is reported as "unknown"
   * and can never imply the run finished.
   */
  async waitForRun(input: {
    runId: string;
    timeoutMs?: number;
  }): Promise<RunWaitResult> {
    const timeoutMs = input.timeoutMs ?? 30000;
    const response = await this.connection.request<unknown>(
      "agent.wait",
      { runId: input.runId, timeoutMs },
      { timeoutMs: timeoutMs + 15000 },
    );
    if (!isRecord(response)) {
      throw new Error("malformed agent.wait response: not an object");
    }
    const rawStatus = typeof response.status === "string" ? response.status : undefined;
    const status: RunWaitStatus =
      rawStatus && KNOWN_WAIT_STATUSES.has(rawStatus)
        ? (rawStatus as RunWaitStatus)
        : "unknown";
    const terminal = status === "ok" || status === "error";
    return {
      status,
      rawStatus,
      runId: input.runId,
      executionMayContinue: !terminal,
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
    const response = await this.connection.request<unknown>(
      "chat.history",
      { sessionKey: input.sessionKey, limit: input.limit ?? 50 },
    );
    if (!isRecord(response)) {
      throw new Error("malformed chat.history response: not an object");
    }
    const messages = response.messages ?? [];
    if (!Array.isArray(messages)) {
      throw new Error("malformed chat.history response: messages is not an array");
    }
    return messages.map((raw) => ({ raw }));
  }

  /** Durable session index rows (sessions.list). */
  async listSessions(): Promise<unknown> {
    return this.connection.request("sessions.list", {});
  }

  /** Gateway status summary (status). */
  async gatewayStatus(): Promise<unknown> {
    return this.connection.request("status", {});
  }

  /** Redacted config snapshot (config.get) — config is never returned raw. */
  async configSnapshot(): Promise<unknown> {
    return this.connection.request("config.get", {});
  }
}
