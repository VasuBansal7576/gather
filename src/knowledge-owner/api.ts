import {
  parseCandidatesResponse,
  parseDecisionResponse,
  parseFactsResponse,
  parseSetupBusinesses,
  parseSnapshotResponse,
  parseWorkspaceBookings,
  type CandidatesResponse,
  type DecisionKind,
  type DecisionResponse,
  type FactsResponse,
  type KnowledgeBusiness,
  type SnapshotResponse,
  type WorkspaceBooking,
} from "./types.ts";

/**
 * Owner knowledge-review service client. Every call targets the local Gather
 * app origin (same-origin relative paths); there is no provider, cloud, or
 * third-party URL anywhere in this module. The approving owner identity is
 * host-derived server-side — this client never sends an actor.
 */
export type KnowledgeFetch = (input: string, init?: RequestInit) => Promise<Response>;

export class KnowledgeApiError extends Error {
  readonly apiError: { code: string; message: string; retryable: boolean };
  readonly httpStatus: number;
  constructor(apiError: { code: string; message: string; retryable: boolean }, httpStatus: number) {
    super(`${apiError.code}: ${apiError.message}`);
    this.name = "KnowledgeApiError";
    this.apiError = apiError;
    this.httpStatus = httpStatus;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseApiError(body: unknown, status: number): { code: string; message: string; retryable: boolean } {
  if (isRecord(body)) {
    const code = typeof body.code === "string" ? body.code : `HTTP_${status}`;
    const message = typeof body.message === "string" ? body.message : `Request failed (${status})`;
    const retryable = typeof body.retryable === "boolean" ? body.retryable : status >= 500;
    return { code, message, retryable };
  }
  return { code: `HTTP_${status}`, message: `Request failed (${status})`, retryable: status >= 500 };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return undefined;
  }
}

async function request<T>(
  fetchImpl: KnowledgeFetch,
  path: string,
  init: RequestInit,
  parse: (value: unknown) => T | undefined,
  action: string,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(path, init);
  } catch {
    throw new KnowledgeApiError(
      { code: "NETWORK_ERROR", message: "Gather could not be reached. Check the local app is running and retry.", retryable: true },
      0,
    );
  }
  const body = await readJson(response);
  if (!response.ok) {
    throw new KnowledgeApiError(parseApiError(body, response.status), response.status);
  }
  const parsed = parse(body);
  if (parsed === undefined) {
    throw new KnowledgeApiError(
      { code: "BAD_RESPONSE", message: `Gather returned an unexpected ${action} response. Retry, or restart the local app.`, retryable: true },
      response.status,
    );
  }
  return parsed;
}

function postJson(body: Record<string, unknown>): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

export interface CorrectInput {
  key: string;
  subjectId?: string;
  expectedRevision: number;
  value: Record<string, unknown>;
  commandId: string;
}

export interface ExceptionInput {
  policyId: string;
  effect: "allow" | "require_owner_decision";
  scope: "booking" | "customer";
  scopeId: string;
  subjectId?: string;
  value: Record<string, unknown>;
  commandId: string;
}

export interface KnowledgeOwnerApi {
  getBusinesses(): Promise<KnowledgeBusiness[]>;
  listCandidates(businessId: string, status?: string): Promise<CandidatesResponse>;
  getSnapshot(businessId: string): Promise<SnapshotResponse>;
  listFacts(businessId: string): Promise<FactsResponse>;
  /** Owned-business bookings for meaningful scope selection (read-only). */
  listWorkspaceBookings(): Promise<WorkspaceBooking[]>;
  confirmCandidate(businessId: string, candidateId: string, commandId: string): Promise<DecisionResponse>;
  rejectCandidate(businessId: string, candidateId: string, reason: string, commandId: string): Promise<DecisionResponse>;
  correctFact(businessId: string, input: CorrectInput): Promise<DecisionResponse>;
  addException(businessId: string, input: ExceptionInput): Promise<DecisionResponse>;
}

export function createKnowledgeOwnerApi(fetchImpl: KnowledgeFetch): KnowledgeOwnerApi {
  return {
    getBusinesses(): Promise<KnowledgeBusiness[]> {
      return request(fetchImpl, "/api/setup", { method: "GET" }, parseSetupBusinesses, "venue list");
    },
    listCandidates(businessId: string, status?: string): Promise<CandidatesResponse> {
      const query = status
        ? `?businessId=${encodeURIComponent(businessId)}&status=${encodeURIComponent(status)}`
        : `?businessId=${encodeURIComponent(businessId)}`;
      return request(fetchImpl, `/api/knowledge/candidates${query}`, { method: "GET" }, parseCandidatesResponse, "candidate list");
    },
    getSnapshot(businessId: string): Promise<SnapshotResponse> {
      return request(
        fetchImpl,
        `/api/knowledge/snapshot?businessId=${encodeURIComponent(businessId)}`,
        { method: "GET" },
        parseSnapshotResponse,
        "knowledge snapshot",
      );
    },
    listFacts(businessId: string): Promise<FactsResponse> {
      return request(
        fetchImpl,
        `/api/knowledge/facts?businessId=${encodeURIComponent(businessId)}`,
        { method: "GET" },
        parseFactsResponse,
        "confirmed fact list",
      );
    },
    listWorkspaceBookings(): Promise<WorkspaceBooking[]> {
      return request(fetchImpl, "/api/workspace", { method: "GET" }, parseWorkspaceBookings, "booking list");
    },
    confirmCandidate(businessId: string, candidateId: string, commandId: string): Promise<DecisionResponse> {
      return request(
        fetchImpl,
        "/api/knowledge/decisions",
        postJson({ kind: "confirm" satisfies DecisionKind, businessId, candidateId, commandId }),
        parseDecisionResponse,
        "confirm",
      );
    },
    rejectCandidate(businessId: string, candidateId: string, reason: string, commandId: string): Promise<DecisionResponse> {
      return request(
        fetchImpl,
        "/api/knowledge/decisions",
        postJson({ kind: "reject" satisfies DecisionKind, businessId, candidateId, reason, commandId }),
        parseDecisionResponse,
        "reject",
      );
    },
    correctFact(businessId: string, input: CorrectInput): Promise<DecisionResponse> {
      return request(
        fetchImpl,
        "/api/knowledge/decisions",
        postJson({ kind: "correct" satisfies DecisionKind, businessId, ...input }),
        parseDecisionResponse,
        "correct",
      );
    },
    addException(businessId: string, input: ExceptionInput): Promise<DecisionResponse> {
      return request(
        fetchImpl,
        "/api/knowledge/decisions",
        postJson({ kind: "exception" satisfies DecisionKind, businessId, ...input }),
        parseDecisionResponse,
        "exception",
      );
    },
  };
}
