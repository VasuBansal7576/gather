/**
 * Owner conflict-resolution client (business-wide cross-account conflicts).
 * Strict boundary validation; the exact reviewed revision set is always
 * sent back verbatim (winningRevisionId + consideredRevisionIds). A 409
 * STALE response means the set moved — the UI must force fresh review and
 * never auto-retry approval against the new set.
 */
import {
  KnowledgeApiError,
  type KnowledgeFetch,
} from "./api.ts";
import { formatMoneyPart } from "./state.ts";

export interface ConflictRevision {
  revisionId: string;
  factId: string;
  accountId: string;
  revision: number;
  value: Record<string, unknown>;
  reviewState: "none" | "review";
  approvedBy: string;
  approvedAt: string;
}

export interface BusinessConflict {
  key: string;
  subjectId: string;
  scope: string;
  scopeId?: string;
  revisions: ConflictRevision[];
  status: "conflicted" | "resolved";
  resolutionId?: string;
  winningRevisionId?: string;
}

export interface ConflictResolution {
  winningRevisionId: string;
  consideredRevisionIds: string[];
  duplicate: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseRevision(value: unknown): ConflictRevision | undefined {
  if (!isRecord(value)) return undefined;
  const revisionId = str(value.revisionId);
  const factId = str(value.factId);
  const accountId = str(value.accountId);
  if (!revisionId || !factId || !accountId) return undefined;
  if (typeof value.revision !== "number" || !Number.isInteger(value.revision)) return undefined;
  if (!isRecord(value.value)) return undefined;
  if (value.reviewState !== "none" && value.reviewState !== "review") return undefined;
  if (!str(value.approvedBy) || !str(value.approvedAt)) return undefined;
  return {
    revisionId, factId, accountId, revision: value.revision,
    value: value.value, reviewState: value.reviewState,
    approvedBy: value.approvedBy as string, approvedAt: value.approvedAt as string,
  };
}

export function parseConflict(value: unknown): BusinessConflict | undefined {
  if (!isRecord(value)) return undefined;
  const key = str(value.key);
  const subjectId = str(value.subjectId);
  const scope = str(value.scope);
  if (!key || !subjectId || !scope || !Array.isArray(value.revisions)) return undefined;
  const revisions: ConflictRevision[] = [];
  for (const item of value.revisions) {
    const revision = parseRevision(item);
    if (!revision) return undefined;
    revisions.push(revision);
  }
  if (value.status !== "conflicted" && value.status !== "resolved") return undefined;
  return {
    key, subjectId, scope,
    ...(str(value.scopeId) === undefined ? {} : { scopeId: value.scopeId as string }),
    revisions, status: value.status,
    ...(str(value.resolutionId) === undefined ? {} : { resolutionId: value.resolutionId as string }),
    ...(str(value.winningRevisionId) === undefined ? {} : { winningRevisionId: value.winningRevisionId as string }),
  };
}

export function parseConflictsResponse(value: unknown): BusinessConflict[] | undefined {
  if (!isRecord(value) || !Array.isArray(value.conflicts)) return undefined;
  const out: BusinessConflict[] = [];
  for (const item of value.conflicts) {
    const conflict = parseConflict(item);
    if (!conflict) return undefined;
    out.push(conflict);
  }
  return out;
}

export function parseResolution(value: unknown): ConflictResolution | undefined {
  if (!isRecord(value)) return undefined;
  const resolution = isRecord(value.resolution) ? value.resolution : undefined;
  const source = resolution ?? value;
  if (!isRecord(source)) return undefined;
  const winningRevisionId = str(source.winningRevisionId);
  if (!winningRevisionId || !Array.isArray(source.consideredRevisionIds)) return undefined;
  if (source.consideredRevisionIds.length === 0) return undefined;
  if (!source.consideredRevisionIds.every((id): id is string => typeof id === "string" && id.length > 0)) return undefined;
  return {
    winningRevisionId,
    consideredRevisionIds: source.consideredRevisionIds as string[],
    duplicate: source.duplicate === true,
  };
}

/**
 * Owner-readable one-line value for a conflict revision. Monetary values
 * use explicit source currency only; anything else renders bounded
 * key/value text. Profit is never computed or claimed.
 */
export function formatConflictValue(value: Record<string, unknown>): string {
  const amount = ((): number | undefined => {
    for (const key of ["amountCents", "unitCents"] as const) {
      const entry = value[key];
      if (typeof entry === "number" && Number.isFinite(entry)) return entry;
    }
    return undefined;
  })();
  if (amount !== undefined) {
    return formatMoneyPart(amount, value.currency);
  }
  const parts = Object.entries(value).map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
  const joined = parts.join(" · ");
  return joined.length > 160 ? `${joined.slice(0, 159)}…` : joined;
}

export interface ConflictApi {
  listConflicts(businessId: string): Promise<BusinessConflict[]>;
  resolveConflict(input: {
    businessId: string;
    key: string;
    subjectId?: string;
    scope?: "booking" | "customer";
    scopeId?: string;
    winningRevisionId: string;
    consideredRevisionIds: string[];
    commandId: string;
  }): Promise<ConflictResolution>;
}

export function createConflictApi(fetchImpl: KnowledgeFetch): ConflictApi {
  return {
    async listConflicts(businessId: string): Promise<BusinessConflict[]> {
      let response: Response;
      try {
        response = await fetchImpl(`/api/knowledge/conflicts?businessId=${encodeURIComponent(businessId)}`, { method: "GET" });
      } catch {
        throw new KnowledgeApiError({ code: "NETWORK_ERROR", message: "Gather could not be reached.", retryable: true }, 0);
      }
      return readConflicts(response);
    },
    async resolveConflict(input): Promise<ConflictResolution> {
      let response: Response;
      const body: Record<string, unknown> = {
        businessId: input.businessId,
        key: input.key,
        winningRevisionId: input.winningRevisionId,
        consideredRevisionIds: input.consideredRevisionIds,
        commandId: input.commandId,
      };
      if (input.subjectId !== undefined) body.subjectId = input.subjectId;
      if (input.scope !== undefined) body.scope = input.scope;
      if (input.scopeId !== undefined) body.scopeId = input.scopeId;
      try {
        response = await fetchImpl("/api/knowledge/conflicts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch {
        throw new KnowledgeApiError({ code: "NETWORK_ERROR", message: "Gather could not be reached.", retryable: true }, 0);
      }
      let parsed: unknown;
      try {
        parsed = (await response.json()) as unknown;
      } catch {
        parsed = undefined;
      }
      if (!response.ok) {
        const code = isRecord(parsed) && typeof parsed.code === "string" ? parsed.code : `HTTP_${response.status}`;
        const message = isRecord(parsed) && typeof parsed.message === "string" ? parsed.message : "The request did not complete.";
        const retryable = isRecord(parsed) && parsed.retryable === true;
        throw new KnowledgeApiError({ code, message, retryable }, response.status);
      }
      const resolution = parseResolution(parsed);
      if (!resolution) {
        throw new KnowledgeApiError({ code: "BAD_RESPONSE", message: "Gather returned an unexpected resolution response.", retryable: true }, response.status);
      }
      return resolution;
    },
  };
}

async function readConflicts(response: Response): Promise<BusinessConflict[]> {
  let parsed: unknown;
  try {
    parsed = (await response.json()) as unknown;
  } catch {
    parsed = undefined;
  }
  if (!response.ok) {
    const code = isRecord(parsed) && typeof parsed.code === "string" ? parsed.code : `HTTP_${response.status}`;
    const message = isRecord(parsed) && typeof parsed.message === "string" ? parsed.message : "The request did not complete.";
    const retryable = isRecord(parsed) && parsed.retryable === true;
    throw new KnowledgeApiError({ code, message, retryable }, response.status);
  }
  const conflicts = parseConflictsResponse(parsed);
  if (!conflicts) {
    throw new KnowledgeApiError({ code: "BAD_RESPONSE", message: "Gather returned an unexpected conflicts response.", retryable: true }, response.status);
  }
  return conflicts;
}
