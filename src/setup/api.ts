import {
  parseApiError,
  parseAuthorizationStart,
  parseConnectionsSummary,
  parseCreateBusinessResult,
  parseDisconnectResult,
  parseSetupBusiness,
  parseSetupMode,
  parseSetupSummary,
  type ApiErrorDTO,
  type AuthorizationStartDTO,
  type ConnectedAccountDTO,
  type ConnectionProvider,
  type ConnectionsSummaryDTO,
  type ConnectionStatus,
  type CreateBusinessResultDTO,
  type DisconnectResultDTO,
  type PreparedScenarioIdDTO,
  type SetupBusinessDTO,
  type SetupModeDTO,
  type SetupSummaryDTO,
} from "./contracts.ts";

export type {
  ApiErrorDTO,
  AuthorizationStartDTO,
  ConnectedAccountDTO,
  ConnectionProvider,
  ConnectionsSummaryDTO,
  ConnectionStatus,
  CreateBusinessResultDTO,
  DisconnectResultDTO,
  PreparedScenarioIdDTO,
  SetupBusinessDTO,
  SetupModeDTO,
  SetupSummaryDTO,
};

/**
 * Injected fetch shape. Production passes global fetch; tests and the
 * browser harness pass a fixture transport. The client never touches
 * credentials, tokens, or provider endpoints directly.
 */
export type SetupFetch = (input: string, init?: RequestInit) => Promise<Response>;

export class SetupApiError extends Error {
  readonly apiError: ApiErrorDTO;
  readonly httpStatus: number;
  constructor(apiError: ApiErrorDTO, httpStatus: number) {
    super(`${apiError.code}: ${apiError.message}`);
    this.name = "SetupApiError";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function request<T>(
  fetchImpl: SetupFetch,
  path: string,
  init: RequestInit,
  parse: (value: unknown) => T | undefined,
  action: string,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(path, init);
  } catch {
    throw new SetupApiError(
      { code: "NETWORK_ERROR", message: "Gather could not be reached. Check the local app is running and retry.", retryable: true },
      0,
    );
  }
  const body = await readJson(response);
  if (!response.ok) {
    throw new SetupApiError(parseApiError(body, response.status), response.status);
  }
  const parsed = parse(body);
  if (parsed === undefined) {
    throw new SetupApiError(
      { code: "BAD_RESPONSE", message: `Gather returned an unexpected ${action} response. Retry, or restart the local app.`, retryable: true },
      response.status,
    );
  }
  return parsed;
}

function sameOriginJson(method: string, body: Record<string, unknown>): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

export interface SetupApi {
  getSetup(): Promise<SetupSummaryDTO>;
  getConnections(businessId: string): Promise<ConnectionsSummaryDTO>;
  startGoogleAuthorization(businessId: string, displayName?: string): Promise<AuthorizationStartDTO>;
  disconnectGoogleAccount(accountId: string, businessId: string): Promise<DisconnectResultDTO>;
  getBusinesses(): Promise<SetupBusinessDTO[]>;
  createBusiness(name: string, timezone: string): Promise<CreateBusinessResultDTO>;
  startDemo(scenario?: PreparedScenarioIdDTO): Promise<{ businessId: string; bookingIds: string[]; scenario?: string }>;
  getMode(): Promise<SetupModeDTO>;
}

/**
 * Real local-service client. Every call targets the local Gather app
 * origin (same-origin relative paths); there is no provider, cloud, or
 * third-party URL anywhere in this module.
 */
export function createSetupApi(fetchImpl: SetupFetch): SetupApi {
  return {
    getSetup(): Promise<SetupSummaryDTO> {
      return request(fetchImpl, "/api/setup", { method: "GET" }, parseSetupSummary, "setup overview");
    },
    getConnections(businessId: string): Promise<ConnectionsSummaryDTO> {
      return request(
        fetchImpl,
        `/api/connections?businessId=${encodeURIComponent(businessId)}`,
        { method: "GET" },
        parseConnectionsSummary,
        "connection status",
      );
    },
    startGoogleAuthorization(businessId: string, displayName?: string): Promise<AuthorizationStartDTO> {
      return request(
        fetchImpl,
        "/api/connections/google/authorize",
        sameOriginJson("POST", displayName === undefined ? { businessId } : { businessId, displayName }),
        parseAuthorizationStart,
        "authorization",
      );
    },
    disconnectGoogleAccount(accountId: string, businessId: string): Promise<DisconnectResultDTO> {
      return request(
        fetchImpl,
        "/api/connections/google/disconnect",
        sameOriginJson("POST", { accountId, businessId }),
        parseDisconnectResult,
        "disconnect",
      );
    },
    /**
     * Owner venues, preferred from GET /api/setup. When the setup route
     * itself is absent (API_ABSENT — an older server), the workspace
     * aggregation is an explicit, documented fallback rendering the same
     * business rows; anything else propagates honestly.
     */
    async getBusinesses(): Promise<SetupBusinessDTO[]> {
      try {
        return (await this.getSetup()).businesses;
      } catch (error) {
        if (!(error instanceof SetupApiError) || error.apiError.code !== "API_ABSENT") throw error;
      }
      const workspace = await request<Record<string, unknown>>(
        fetchImpl,
        "/api/workspace",
        { method: "GET" },
        (value) => (isRecord(value) ? value : undefined),
        "workspace",
      );
      const raw = Array.isArray(workspace.businesses) ? workspace.businesses : [];
      return raw.map((item) => parseSetupBusiness(item)).filter((item) => item !== undefined);
    },
    createBusiness(name: string, timezone: string): Promise<CreateBusinessResultDTO> {
      return request(
        fetchImpl,
        "/api/setup/business",
        sameOriginJson("POST", { name, timezone }),
        parseCreateBusinessResult,
        "business creation",
      );
    },
    async startDemo(scenario?: PreparedScenarioIdDTO): Promise<{ businessId: string; bookingIds: string[]; scenario?: string }> {
      const result = await request<Record<string, unknown>>(
        fetchImpl,
        "/api/demo/init",
        sameOriginJson("POST", scenario === undefined ? { demo: true } : { demo: true, scenario }),
        (value) => (isRecord(value) ? value : undefined),
        "demo start",
      );
      const businessId = typeof result.businessId === "string" ? result.businessId : undefined;
      const bookingIds = Array.isArray(result.bookingIds)
        ? result.bookingIds.filter((id): id is string => typeof id === "string")
        : undefined;
      if (!businessId || !bookingIds) {
        throw new SetupApiError(
          { code: "BAD_RESPONSE", message: "Gather returned an unexpected demo response. Retry.", retryable: true },
          200,
        );
      }
      return {
        businessId,
        bookingIds,
        ...(typeof result.scenario === "string" ? { scenario: result.scenario } : {}),
      };
    },
    getMode(): Promise<SetupModeDTO> {
      return request(fetchImpl, "/api/setup/mode", { method: "GET" }, parseSetupMode, "mode overview");
    },
  };
}
