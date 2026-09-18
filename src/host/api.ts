import type { ProposalIdentity } from "../components/gather/types.ts";
import { parseErrorDTO, parseWorkspaceDTO, type ErrorDTO, type WorkspaceDTO } from "./dto.ts";

/** An API failure carrying the server's typed error when it sent one. */
export class ApiError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status: number;
  constructor(status: number, error: ErrorDTO | undefined, fallback: string) {
    super(error?.message ?? fallback);
    this.code = error?.code ?? `HTTP_${status}`;
    this.retryable = error?.retryable ?? status >= 500;
    this.status = status;
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.trim().length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError(response.status, undefined, "The workspace service returned unreadable data");
  }
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new ApiError(0, undefined, "The workspace service is unreachable — is the local server running?");
  }
  const body = await readJson(response);
  if (!response.ok) {
    throw new ApiError(response.status, parseErrorDTO(body), `Request failed (${response.status})`);
  }
  return body;
}

function post(path: string, payload?: unknown): Promise<unknown> {
  return request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload === undefined ? "{}" : JSON.stringify(payload),
  });
}

/** GET /api/workspace — validated at the boundary. */
export async function fetchWorkspace(): Promise<WorkspaceDTO> {
  return parseWorkspaceDTO(await request("/api/workspace", { cache: "no-store" }));
}

/** POST /api/bookings/:bookingId/approve with the exact displayed identity. */
export async function approveProposal(identity: ProposalIdentity): Promise<unknown> {
  return post(`/api/bookings/${encodeURIComponent(identity.bookingId)}/approve`, {
    bookingId: identity.bookingId,
    proposedActionId: identity.proposedActionId,
    proposalVersion: identity.proposalVersion,
    proposalFingerprint: identity.proposalFingerprint,
  });
}

/**
 * Durable variant: `{ intent: true }` commits the exact approval as a
 * durable intent and returns `{ intentId, intent }` (202) for persisted
 * progress via GET /api/intents/:id. Same authority and error mapping.
 */
export async function approveProposalAsync(identity: ProposalIdentity): Promise<{ intentId: string; intent: unknown }> {
  return post(`/api/bookings/${encodeURIComponent(identity.bookingId)}/approve`, {
    bookingId: identity.bookingId,
    proposedActionId: identity.proposedActionId,
    proposalVersion: identity.proposalVersion,
    proposalFingerprint: identity.proposalFingerprint,
    intent: true,
  }) as Promise<{ intentId: string; intent: unknown }>;
}

/** POST /api/actions/:actionId/retry — retries failed steps only. */
export async function retryAction(actionId: string): Promise<unknown> {
  return post(`/api/actions/${encodeURIComponent(actionId)}/retry`);
}

/** POST /api/executions/:executionId/reconcile — reconcile uncertain/partial. */
export async function reconcileExecution(executionId: string): Promise<unknown> {
  return post(`/api/executions/${encodeURIComponent(executionId)}/reconcile`);
}

/**
 * Durable variant: commits the reconciliation as a durable intent (202 with
 * `{ intentId, intent }`) for persisted progress via GET /api/intents/:id.
 */
export async function reconcileExecutionAsync(executionId: string): Promise<{ intentId: string; intent: unknown }> {
  return post(`/api/executions/${encodeURIComponent(executionId)}/reconcile`, { intent: true }) as Promise<{
    intentId: string;
    intent: unknown;
  }>;
}

/** GET /api/live-model/status — owner-visible live capability gate. */
export async function fetchLiveStatus(profile = 'base'): Promise<unknown> {
  return request(`/api/live-model/status?profile=${encodeURIComponent(profile)}`, { cache: 'no-store' });
}

/** POST /api/demo/init — seeds explicitly fictional demo fixtures. */
export async function initDemoFixtures(): Promise<unknown> {
  return post("/api/demo/init", { demo: true });
}
