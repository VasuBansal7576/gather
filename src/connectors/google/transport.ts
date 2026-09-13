import type {
  ConnectorMetadata,
  ConnectorModeLabel,
  SourceReference,
} from "../contracts.ts";

/**
 * Injected HTTP boundary for the live Google adapters.
 *
 * The adapters never read credentials, environment variables, files, or any
 * personal runtime. OAuth access tokens arrive exclusively through the
 * injected {@link AccessTokenSupplier}, which onboarding wires to approved
 * account assets later. The live gate is BLOCKED until those assets exist:
 * nothing here may call a live user API without them.
 */

export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

export interface GoogleHttpRequest {
  method: HttpMethod;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface GoogleHttpResponse {
  status: number;
  headers: Record<string, string>;
  /** Raw response text; may be empty or non-JSON on failures. */
  text: string;
}

/**
 * Minimal fetch-compatible transport injected by the caller (tests inject a
 * scripted fake; production injects a thin fetch wrapper). Throwing
 * {@link TransportTimeoutError} signals that the request may have reached
 * the server but its response was lost — mutating adapters translate that
 * into `uncertain`, never into success or failure.
 */
export interface GoogleHttpTransport {
  request(req: GoogleHttpRequest): Promise<GoogleHttpResponse>;
}

export class TransportTimeoutError extends Error {
  readonly kind = "timeout" as const;
  constructor(message = "Request timed out; the write may have been accepted") {
    super(message);
    this.name = "TransportTimeoutError";
  }
}

export class TransportNetworkError extends Error {
  readonly kind = "network" as const;
  constructor(message = "Network failure before any response was received") {
    super(message);
    this.name = "TransportNetworkError";
  }
}

/**
 * Supplies a ready-to-use OAuth 2.0 access token for one request. Refresh,
 * storage, and onboarding own this; adapters only consume the returned
 * string and must never log it.
 */
export type AccessTokenSupplier = () => Promise<string>;

export interface GoogleAdapterOptions {
  transport: GoogleHttpTransport;
  tokens: AccessTokenSupplier;
  /** Gmail userId / Calendar identity scope. Defaults to "me"/explicit calendar ids per call. */
  userId?: string;
}

export const CALENDAR_BASE_URL = "https://www.googleapis.com/calendar/v3";
export const GMAIL_BASE_URL = "https://gmail.googleapis.com/gmail/v1";

/** Thrown when no approved token is available; adapters map it to access_revoked. */
export class TokenUnavailableError extends Error {
  readonly kind = "token_unavailable" as const;
  constructor(message = "No approved Google access token is available (live gate BLOCKED)") {
    super(message);
    this.name = "TokenUnavailableError";
  }
}

export interface AuthorizedRequest {
  method: HttpMethod;
  url: string;
  body?: string;
  contentType?: string;
}

/**
 * Attach the injected bearer token and dispatch one request. The token
 * string is used in the header only and is never logged, stored, or
 * returned. Token-supplier failures surface as {@link TokenUnavailableError}.
 */
export async function authorized(
  options: GoogleAdapterOptions,
  req: AuthorizedRequest,
): Promise<GoogleHttpResponse> {
  let token: string;
  try {
    token = await options.tokens();
  } catch (error) {
    throw new TokenUnavailableError(error instanceof Error ? error.message : "Token supplier failed");
  }
  if (token.trim().length === 0) {
    throw new TokenUnavailableError("Token supplier returned an empty token");
  }
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  if (req.body !== undefined) {
    headers["Content-Type"] = req.contentType ?? "application/json";
  }
  return options.transport.request({ method: req.method, url: req.url, headers, body: req.body });
}

/** Live mode marker: receipts are provider-issued, never simulated or fictional. */
export const LIVE_MODE: ConnectorModeLabel = {
  mode: "live",
  label: "LIVE",
  fictional: false,
};

/**
 * Live receipt metadata. `simulated` is false here by construction; the
 * discriminated contract type (not a forced literal) carries the distinction
 * from demo results. See docs/GOOGLE_CONNECTORS.md for the contract note.
 */
export function liveMetadata(operationKey: string, sourceReferences: SourceReference[]): ConnectorMetadata {
  return { operationKey, mode: LIVE_MODE, simulated: false, sourceReferences };
}

export type { ConnectorMetadata };

/** Least-privilege scopes required by each adapter surface. */
export const GOOGLE_SCOPES = {
  calendarRead: "https://www.googleapis.com/auth/calendar.readonly",
  calendarWrite: "https://www.googleapis.com/auth/calendar.events",
  gmailRead: "https://www.googleapis.com/auth/gmail.readonly",
  gmailSend: "https://www.googleapis.com/auth/gmail.send",
} as const;

export function withQuery(base: string, params: Record<string, string | undefined>): string {
  const query = Object.entries(params)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
  return query.length > 0 ? `${base}?${query}` : base;
}
