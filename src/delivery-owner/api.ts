import {
  parseApiError,
  parseConfirmResponse,
  parseHandoffResponse,
  parseReadinessResponse,
  type ApiError,
  type ConfirmResponse,
  type HandoffResponse,
  type ProposalIdentity,
  type ReadinessResponse,
  type StepReceipt,
} from "./contracts.ts";

export type { ApiError, ConfirmResponse, HandoffResponse, ProposalIdentity, ReadinessResponse, StepReceipt };

/**
 * Injected fetch shape. Production passes global fetch against the local
 * Gather origin; tests pass a fixture transport. No provider URLs anywhere.
 */
export type DeliveryFetch = (input: string, init?: RequestInit) => Promise<Response>;

export class DeliveryApiError extends Error {
  readonly apiError: ApiError;
  readonly httpStatus: number;
  constructor(apiError: ApiError, httpStatus: number) {
    super(`${apiError.code}: ${apiError.message}`);
    this.name = "DeliveryApiError";
    this.apiError = apiError;
    this.httpStatus = httpStatus;
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return undefined;
  }
}

async function request<T>(
  fetchImpl: DeliveryFetch,
  path: string,
  init: RequestInit,
  parse: (value: unknown) => T | undefined,
  action: string,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(path, init);
  } catch {
    throw new DeliveryApiError(
      { code: "NETWORK_ERROR", message: "Gather could not be reached. Check the local app is running and retry.", retryable: true },
      0,
    );
  }
  const body = await readJson(response);
  if (!response.ok) {
    throw new DeliveryApiError(parseApiError(body, response.status), response.status);
  }
  const parsed = parse(body);
  if (parsed === undefined) {
    throw new DeliveryApiError(
      { code: "BAD_RESPONSE", message: `Gather returned an unexpected ${action} response. Retry.`, retryable: true },
      response.status,
    );
  }
  return parsed;
}

export interface DeliveryApi {
  getReadiness(bookingId: string): Promise<ReadinessResponse>;
  getHandoff(bookingId: string): Promise<HandoffResponse>;
  recordHandoff(bookingId: string): Promise<HandoffResponse>;
  confirmBooking(bookingId: string, identity: ProposalIdentity, confirmKey: string): Promise<ConfirmResponse>;
  getBookingContext(bookingId: string): Promise<{ identity: ProposalIdentity | undefined; receipts: StepReceipt[]; demo: boolean; eventName: string; status: string }>;
}

/**
 * Real local-service client. Same-origin relative paths only. Step receipts
 * come from the existing workspace aggregation (proposals + executions for
 * this booking) — no new backend, no fabricated proofs.
 */
export function createDeliveryApi(fetchImpl: DeliveryFetch): DeliveryApi {
  return {
    getReadiness(bookingId: string): Promise<ReadinessResponse> {
      return request(fetchImpl, `/api/bookings/${encodeURIComponent(bookingId)}/readiness`, { method: "GET" }, parseReadinessResponse, "readiness");
    },
    getHandoff(bookingId: string): Promise<HandoffResponse> {
      return request(fetchImpl, `/api/bookings/${encodeURIComponent(bookingId)}/handoff`, { method: "GET" }, parseHandoffResponse, "handoff");
    },
    recordHandoff(bookingId: string): Promise<HandoffResponse> {
      return request(fetchImpl, `/api/bookings/${encodeURIComponent(bookingId)}/handoff`, { method: "POST" }, parseHandoffResponse, "handoff record");
    },
    confirmBooking(bookingId: string, identity: ProposalIdentity, confirmKey: string): Promise<ConfirmResponse> {
      return request(
        fetchImpl,
        `/api/bookings/${encodeURIComponent(bookingId)}/confirm`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            bookingId,
            proposedActionId: identity.proposedActionId,
            proposalVersion: identity.proposalVersion,
            proposalFingerprint: identity.proposalFingerprint,
            confirmKey,
          }),
        },
        parseConfirmResponse,
        "confirmation",
      );
    },
    async getBookingContext(bookingId: string): Promise<{ identity: ProposalIdentity | undefined; receipts: StepReceipt[]; demo: boolean; eventName: string; status: string }> {
      const workspace = await request<Record<string, unknown>>(
        fetchImpl,
        "/api/workspace",
        { method: "GET" },
        (value) => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined),
        "workspace",
      );
      const bookings = Array.isArray(workspace.bookings) ? workspace.bookings : [];
      const demo = workspace.demo === true;
      for (const entry of bookings) {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
        const record = entry as Record<string, unknown>;
        const booking = record.booking as Record<string, unknown> | undefined;
        if (!booking || booking.id !== bookingId) continue;
        const proposals = Array.isArray(record.proposals) ? record.proposals : [];
        const last = proposals.length > 0 ? proposals[proposals.length - 1] : undefined;
        const action = (last as Record<string, unknown> | undefined)?.action as Record<string, unknown> | undefined;
        let identity: ProposalIdentity | undefined;
        if (action && typeof action.id === "string" && typeof action.proposalVersion === "number" && typeof action.proposalFingerprint === "string" && typeof action.kind === "string") {
          identity = { proposedActionId: action.id, proposalVersion: action.proposalVersion, proposalFingerprint: action.proposalFingerprint, kind: action.kind };
        }
        const executions = Array.isArray(record.executions) ? record.executions : [];
        const receipts: StepReceipt[] = [];
        for (const item of executions) {
          if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
          const execution = item as Record<string, unknown>;
          const key = typeof execution.idempotencyKey === "string" ? execution.idempotencyKey : "";
          const step = key.includes(":send:") ? "email" as const : "hold" as const;
          if (typeof execution.id !== "string" || typeof execution.status !== "string" || typeof execution.startedAt !== "string") continue;
          receipts.push({
            id: execution.id,
            step,
            status: execution.status,
            startedAt: execution.startedAt,
            ...(typeof execution.completedAt === "string" ? { completedAt: execution.completedAt } : {}),
            ...(typeof execution.error === "string" ? { error: execution.error } : {}),
          });
        }
        return {
          identity,
          receipts,
          demo,
          eventName: typeof booking.eventName === "string" ? booking.eventName : bookingId,
          status: typeof booking.status === "string" ? booking.status : "unknown",
        };
      }
      throw new DeliveryApiError({ code: "NOT_FOUND", message: "This booking is not in the workspace.", retryable: false }, 404);
    },
  };
}
