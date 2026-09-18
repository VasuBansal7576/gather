/**
 * Setup API boundary types (owner setup UI, PRD G01/G18).
 *
 * Shapes mirror the connections service contracts (read, never imported:
 * this UI package must validate everything crossing the network boundary).
 * Unknown JSON is rejected — no `any`, no silent coercion. Tokens never
 * appear in any shape here; the authorize flow hands the owner a server
 * URL and the provider calls back server-side.
 */

export type ConnectionProvider = "google";

export type ConnectionStatus =
  | "unavailable"
  | "not_connected"
  | "authorization_pending"
  | "connected"
  | "revoked"
  | "error"
  | "expired";

export type ConnectedAccountStatus = "connected" | "revoked" | "error" | "expired";

export interface ConnectedAccountDTO {
  id: string;
  businessId: string;
  provider: string;
  displayName: string;
  status: ConnectedAccountStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderConnectionDTO {
  provider: ConnectionProvider;
  status: ConnectionStatus;
  unavailableReason?: string;
  accounts: ConnectedAccountDTO[];
}

export interface ConnectionsSummaryDTO {
  businessId: string;
  providers: ProviderConnectionDTO[];
}

export interface AuthorizationStartDTO {
  provider: ConnectionProvider;
  authorizationUrl: string;
  expiresAt: string;
}

export interface DisconnectResultDTO {
  disconnected: true;
}

export interface ApiErrorDTO {
  code: string;
  message: string;
  retryable: boolean;
}

export interface SetupBusinessDTO {
  id: string;
  name: string;
  timezone: string;
  status: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

const CONNECTION_STATUSES: readonly string[] = [
  "unavailable",
  "not_connected",
  "authorization_pending",
  "connected",
  "revoked",
  "error",
  "expired",
];

const ACCOUNT_STATUSES: readonly string[] = ["connected", "revoked", "error", "expired"];

function parseAccount(value: unknown): ConnectedAccountDTO | undefined {
  if (!isRecord(value)) return undefined;
  const id = nonEmptyString(value.id);
  const businessId = nonEmptyString(value.businessId);
  const provider = nonEmptyString(value.provider);
  const displayName = nonEmptyString(value.displayName);
  const status = typeof value.status === "string" && ACCOUNT_STATUSES.includes(value.status)
    ? (value.status as ConnectedAccountStatus)
    : undefined;
  const createdAt = nonEmptyString(value.createdAt);
  const updatedAt = nonEmptyString(value.updatedAt);
  if (!id || !businessId || !provider || !displayName || !status || !createdAt || !updatedAt) return undefined;
  return { id, businessId, provider, displayName, status, createdAt, updatedAt };
}

function parseProvider(value: unknown): ProviderConnectionDTO | undefined {
  if (!isRecord(value)) return undefined;
  if (value.provider !== "google") return undefined;
  if (typeof value.status !== "string" || !CONNECTION_STATUSES.includes(value.status)) return undefined;
  if (!Array.isArray(value.accounts)) return undefined;
  const accounts: ConnectedAccountDTO[] = [];
  for (const item of value.accounts) {
    const account = parseAccount(item);
    if (!account) return undefined;
    accounts.push(account);
  }
  const unavailableReason = value.unavailableReason === undefined
    ? undefined
    : nonEmptyString(value.unavailableReason);
  if (value.unavailableReason !== undefined && unavailableReason === undefined) return undefined;
  return {
    provider: "google",
    status: value.status as ConnectionStatus,
    ...(unavailableReason === undefined ? {} : { unavailableReason }),
    accounts,
  };
}

/** Strict parse of GET /api/connections?businessId. Returns undefined on any shape violation. */
export function parseConnectionsSummary(value: unknown): ConnectionsSummaryDTO | undefined {
  if (!isRecord(value)) return undefined;
  const businessId = nonEmptyString(value.businessId);
  if (!businessId || !Array.isArray(value.providers)) return undefined;
  const providers: ProviderConnectionDTO[] = [];
  for (const item of value.providers) {
    const provider = parseProvider(item);
    if (!provider) return undefined;
    providers.push(provider);
  }
  return { businessId, providers };
}

/**
 * Strict parse of the authorize response. The URL must be an absolute
 * http(s) URL — the UI only ever navigates to this server-returned value
 * and never constructs provider URLs itself.
 */
export function parseAuthorizationStart(value: unknown): AuthorizationStartDTO | undefined {
  if (!isRecord(value)) return undefined;
  if (value.provider !== "google") return undefined;
  const rawUrl = nonEmptyString(value.authorizationUrl);
  const expiresAt = nonEmptyString(value.expiresAt);
  if (!rawUrl || !expiresAt) return undefined;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (Number.isNaN(Date.parse(expiresAt))) return undefined;
  return { provider: "google", authorizationUrl: url.toString(), expiresAt };
}

/** Strict parse of the disconnect response. */
export function parseDisconnectResult(value: unknown): DisconnectResultDTO | undefined {
  if (!isRecord(value)) return undefined;
  if (value.disconnected !== true) return undefined;
  return { disconnected: true };
}

/** Strict parse of a server error body. */
export function parseApiError(value: unknown, httpStatus: number): ApiErrorDTO {
  // A non-JSON 404 from a Next route means the API route itself is absent
  // in this build (the owning service has not delivered it yet) — distinct
  // from a JSON 404 the service returns for unknown ids.
  if (value === undefined && httpStatus === 404) {
    return {
      code: "API_ABSENT",
      message: "This step isn't available in this build yet. You can retry, or try the demo below.",
      retryable: false,
    };
  }
  if (isRecord(value)) {
    const code = nonEmptyString(value.code) ?? `HTTP_${httpStatus}`;
    const message = nonEmptyString(value.message) ?? "The request did not complete.";
    const retryable = value.retryable === true;
    return { code, message, retryable };
  }
  return { code: `HTTP_${httpStatus}`, message: "The request did not complete.", retryable: false };
}

/** Strict parse of a business row (workspace aggregation or setup API). */
export function parseSetupBusiness(value: unknown): SetupBusinessDTO | undefined {
  if (!isRecord(value)) return undefined;
  const id = nonEmptyString(value.id);
  const name = nonEmptyString(value.name);
  const timezone = nonEmptyString(value.timezone);
  const status = nonEmptyString(value.status) ?? "active";
  if (!id || !name || !timezone) return undefined;
  return { id, name, timezone, status };
}

export type SetupProviderReadiness = "available" | "unavailable";

export interface SetupProviderDTO {
  provider: ConnectionProvider;
  status: SetupProviderReadiness;
  unavailableReason?: string;
}

export interface SetupSummaryDTO {
  ownerId: string;
  businesses: SetupBusinessDTO[];
  providers: SetupProviderDTO[];
}

export interface CreateBusinessResultDTO {
  business: SetupBusinessDTO;
  created: boolean;
  ownerId: string;
}

function parseSetupProvider(value: unknown): SetupProviderDTO | undefined {
  if (!isRecord(value)) return undefined;
  if (value.provider !== "google") return undefined;
  if (value.status !== "available" && value.status !== "unavailable") return undefined;
  const unavailableReason = value.unavailableReason === undefined
    ? undefined
    : nonEmptyString(value.unavailableReason);
  if (value.unavailableReason !== undefined && unavailableReason === undefined) return undefined;
  return {
    provider: "google",
    status: value.status,
    ...(unavailableReason === undefined ? {} : { unavailableReason }),
  };
}

/** Strict parse of GET /api/setup (ownerId server-derived; never from the request). */
export function parseSetupSummary(value: unknown): SetupSummaryDTO | undefined {
  if (!isRecord(value)) return undefined;
  const ownerId = nonEmptyString(value.ownerId);
  if (!ownerId || !Array.isArray(value.businesses) || !Array.isArray(value.providers)) return undefined;
  const businesses: SetupBusinessDTO[] = [];
  for (const item of value.businesses) {
    const business = parseSetupBusiness(item);
    if (!business) return undefined;
    businesses.push(business);
  }
  const providers: SetupProviderDTO[] = [];
  for (const item of value.providers) {
    const provider = parseSetupProvider(item);
    if (!provider) return undefined;
    providers.push(provider);
  }
  return { ownerId, businesses, providers };
}

/** Strict parse of POST /api/setup/business: the business nests under `business`. */
export function parseCreateBusinessResult(value: unknown): CreateBusinessResultDTO | undefined {
  if (!isRecord(value)) return undefined;
  const business = parseSetupBusiness(value.business);
  const ownerId = nonEmptyString(value.ownerId);
  if (!business || !ownerId || typeof value.created !== "boolean") return undefined;
  return { business, created: value.created, ownerId };
}

/* ------------------------------------------------------------------
 * GET /api/setup/mode — installation mode, live availability and the
 * prepared scenario's durable counts. Everything is server-derived; the UI
 * renders only what this shape proves.
 * ---------------------------------------------------------------- */

export type PreparedScenarioIdDTO =
  | "glasshouse"
  | "empty"
  | "non-event"
  | "partial"
  | "connection-failed"
  | "legacy";

export interface PreparedScenarioOptionDTO {
  id: PreparedScenarioIdDTO;
  label: string;
  description: string;
}

export interface PreparedInboxItemDTO {
  id: string;
  kind: string;
  subject: string;
  from: string;
  receivedAt: string;
}

export interface PreparedStateDTO {
  scenario: PreparedScenarioIdDTO;
  coverage: "complete" | "partial" | "failed";
  coverageDetail: string;
  inboxCount: number;
  busyBlockCount: number;
  offerCount: number;
  demoClockAnchor: string;
  inbox: PreparedInboxItemDTO[];
}

export interface SetupModeDTO {
  managed: boolean;
  mode: "prepared" | "live" | null;
  installRoot: string | null;
  stateDir: string | null;
  databasePath: string;
  customDatabasePath: boolean;
  simulated: boolean;
  live: { available: false; reason: string };
  scenarios: PreparedScenarioOptionDTO[];
  prepared: PreparedStateDTO | null;
}

const SCENARIO_IDS: readonly string[] = [
  "glasshouse",
  "empty",
  "non-event",
  "partial",
  "connection-failed",
  "legacy",
];

function parseScenarioOption(value: unknown): PreparedScenarioOptionDTO | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.id !== "string" || !SCENARIO_IDS.includes(value.id)) return undefined;
  const label = nonEmptyString(value.label);
  const description = nonEmptyString(value.description);
  if (!label || !description) return undefined;
  return { id: value.id as PreparedScenarioIdDTO, label, description };
}

function parseInboxItem(value: unknown): PreparedInboxItemDTO | undefined {
  if (!isRecord(value)) return undefined;
  const id = nonEmptyString(value.id);
  const kind = nonEmptyString(value.kind);
  const subject = nonEmptyString(value.subject);
  const from = nonEmptyString(value.from);
  const receivedAt = nonEmptyString(value.receivedAt);
  if (!id || !kind || !subject || !from || !receivedAt) return undefined;
  return { id, kind, subject, from, receivedAt };
}

function parsePreparedState(value: unknown): PreparedStateDTO | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.scenario !== "string" || !SCENARIO_IDS.includes(value.scenario)) return undefined;
  if (value.coverage !== "complete" && value.coverage !== "partial" && value.coverage !== "failed") return undefined;
  const coverageDetail = typeof value.coverageDetail === "string" ? value.coverageDetail : undefined;
  if (coverageDetail === undefined) return undefined;
  for (const count of [value.inboxCount, value.busyBlockCount, value.offerCount]) {
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0) return undefined;
  }
  const demoClockAnchor = nonEmptyString(value.demoClockAnchor);
  if (!demoClockAnchor) return undefined;
  if (!Array.isArray(value.inbox)) return undefined;
  const inbox: PreparedInboxItemDTO[] = [];
  for (const item of value.inbox) {
    const parsed = parseInboxItem(item);
    if (!parsed) return undefined;
    inbox.push(parsed);
  }
  return {
    scenario: value.scenario as PreparedScenarioIdDTO,
    coverage: value.coverage,
    coverageDetail,
    inboxCount: value.inboxCount as number,
    busyBlockCount: value.busyBlockCount as number,
    offerCount: value.offerCount as number,
    demoClockAnchor,
    inbox,
  };
}

/** Strict parse of GET /api/setup/mode. Returns undefined on any shape violation. */
export function parseSetupMode(value: unknown): SetupModeDTO | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.managed !== "boolean" || typeof value.customDatabasePath !== "boolean") return undefined;
  if (typeof value.simulated !== "boolean") return undefined;
  if (value.mode !== null && value.mode !== "prepared" && value.mode !== "live") return undefined;
  if (value.installRoot !== null && typeof value.installRoot !== "string") return undefined;
  if (value.stateDir !== null && typeof value.stateDir !== "string") return undefined;
  const databasePath = nonEmptyString(value.databasePath);
  if (!databasePath) return undefined;
  if (!isRecord(value.live) || value.live.available !== false) return undefined;
  const liveReason = nonEmptyString(value.live.reason);
  if (!liveReason) return undefined;
  if (!Array.isArray(value.scenarios)) return undefined;
  const scenarios: PreparedScenarioOptionDTO[] = [];
  for (const item of value.scenarios) {
    const parsed = parseScenarioOption(item);
    if (!parsed) return undefined;
    scenarios.push(parsed);
  }
  const prepared: PreparedStateDTO | null =
    value.prepared === null ? null : (parsePreparedState(value.prepared) ?? null);
  if (value.prepared !== null && prepared === null) return undefined;
  return {
    managed: value.managed,
    mode: value.mode,
    installRoot: value.installRoot,
    stateDir: value.stateDir,
    databasePath,
    customDatabasePath: value.customDatabasePath,
    simulated: value.simulated,
    live: { available: false, reason: liveReason },
    scenarios,
    prepared,
  };
}
