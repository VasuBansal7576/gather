import type {
  ConnectorMetadata,
  LiveModeLabel,
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
 * Response body exceeded the configured streaming byte cap. Adapters map
 * this to a fail-closed over-cap result; it is never a timeout and never
 * authorizes uncertainty about a write.
 */
export class TransportBodyTooLargeError extends Error {
  readonly kind = "body_too_large" as const;
  readonly limitBytes: number;
  constructor(limitBytes: number, message = `Response body exceeded the ${limitBytes}-byte streaming cap`) {
    super(message);
    this.name = "TransportBodyTooLargeError";
    this.limitBytes = limitBytes;
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
export const DRIVE_BASE_URL = "https://www.googleapis.com";

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
  /** Extra headers (e.g. Range for capped downloads). Never Authorization. */
  headers?: Record<string, string>;
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
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json", ...(req.headers ?? {}) };
  if (req.body !== undefined) {
    headers["Content-Type"] = req.contentType ?? "application/json";
  }
  return options.transport.request({ method: req.method, url: req.url, headers, body: req.body });
}

/** Live mode marker: receipts are provider-issued, never simulated or fictional. */
export const LIVE_MODE: LiveModeLabel = {
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
  /** Document content retrieval (explicit IDs only, never account scan). */
  driveReadonly: "https://www.googleapis.com/auth/drive.readonly",
  /** Event reads (reconcile/409 verification). */
  calendarRead: "https://www.googleapis.com/auth/calendar.readonly",
  /** Availability reads via freeBusy.query (least privilege for busy intervals). */
  calendarFreeBusy: "https://www.googleapis.com/auth/calendar.freebusy",
  calendarWrite: "https://www.googleapis.com/auth/calendar.events",
  gmailRead: "https://www.googleapis.com/auth/gmail.readonly",
  gmailSend: "https://www.googleapis.com/auth/gmail.send",
  /** Picker-selected Drive files only; never an account-wide Drive scan. */
  driveFile: "https://www.googleapis.com/auth/drive.file",
} as const;

export type GoogleCapability =
  | "identity"
  | "gmail_read"
  | "gmail_send"
  | "calendar_freebusy"
  | "calendar_events"
  | "selected_document_read";

/** C11's least-privilege scope-to-capability mapping. */
export const GOOGLE_SCOPE_CAPABILITIES: Readonly<Record<string, GoogleCapability>> = Object.freeze({
  openid: "identity",
  email: "identity",
  "https://www.googleapis.com/auth/userinfo.email": "identity",
  "https://www.googleapis.com/auth/gmail.readonly": "gmail_read",
  "https://www.googleapis.com/auth/gmail.send": "gmail_send",
  "https://www.googleapis.com/auth/calendar.freebusy": "calendar_freebusy",
  "https://www.googleapis.com/auth/calendar.events": "calendar_events",
  "https://www.googleapis.com/auth/drive.file": "selected_document_read",
});

export function capabilitiesForGoogleScopes(scopes: readonly string[]): Set<GoogleCapability> {
  return new Set(scopes.map((scope) => GOOGLE_SCOPE_CAPABILITIES[scope]).filter((value): value is GoogleCapability => value !== undefined));
}

export type FetchImpl = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal },
) => Promise<{ status: number; headers: Record<string, string>; text: () => Promise<string>; streamBytes?: AsyncIterable<Uint8Array> }>;

export interface FetchTransportOptions {
  fetchImpl?: FetchImpl;
  /** Bounded per-request timeout. No request may hang indefinitely. */
  timeoutMs?: number;
  /**
   * Optional streaming response cap: body bytes are counted as they arrive
   * and the request aborts with TransportBodyTooLargeError past the cap, so
   * memory stays bounded even when the server ignores Range. Absent by
   * default (fully backward compatible): without it the whole body buffers
   * exactly as before, and timeout/uncertain-write behavior is untouched.
   */
  maxBytes?: number;
}

const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

/**
 * Built-in fetch transport with a bounded timeout per request. Aborts (and
 * any network failure before a response) surface as {@link TransportTimeoutError}
 * / {@link TransportNetworkError}, which mutating adapters translate into
 * `uncertain` — never into a blind retry. Performs no auth lookup and
 * registers nothing; it only speaks the injected fetch.
 */
export function createFetchTransport(options: FetchTransportOptions = {}): GoogleHttpTransport {
  const fetchImpl: FetchImpl = options.fetchImpl ?? (async (url, init) => {
    const response = await fetch(url, init);
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const webBody = response.body;
    return {
      status: response.status,
      headers,
      text: () => response.text(),
      streamBytes: webBody === null || webBody === undefined ? undefined : readWebStream(webBody),
    };
  });
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const maxBytes = options.maxBytes;
  return {
    request: async (req: GoogleHttpRequest): Promise<GoogleHttpResponse> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(req.url, { method: req.method, headers: req.headers, body: req.body, signal: controller.signal });
        if (maxBytes === undefined) {
          return { status: response.status, headers: response.headers, text: await response.text() };
        }
        const text = await readCappedBody(response, maxBytes);
        return { status: response.status, headers: response.headers, text };
      } catch (error) {
        if (error instanceof TransportBodyTooLargeError) throw error;
        if (error instanceof Error && (error.name === "AbortError" || error instanceof TransportTimeoutError)) {
          throw new TransportTimeoutError(`Request aborted after ${timeoutMs}ms; a write may have been accepted`);
        }
        throw new TransportNetworkError(error instanceof Error ? error.message : "Network failure before any response");
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

async function *readWebStream(body: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value !== undefined) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Read a response body with a hard byte cap. When the fetch impl supplies a
 * byte stream, chunks are counted as they arrive and the cap aborts before
 * unbounded memory is consumed; otherwise the buffered body is length
 * checked (correctness bound, memory as before). Either way an over-cap
 * body throws TransportBodyTooLargeError instead of truncating silently.
 */
async function readCappedBody(
  response: { text: () => Promise<string>; streamBytes?: AsyncIterable<Uint8Array> },
  maxBytes: number,
): Promise<string> {
  if (response.streamBytes === undefined) {
    const body = await response.text();
    if (Buffer.byteLength(body, "utf-8") > maxBytes) {
      throw new TransportBodyTooLargeError(maxBytes);
    }
    return body;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response.streamBytes) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new TransportBodyTooLargeError(maxBytes);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

export function withQuery(base: string, params: Record<string, string | undefined>): string {
  const query = Object.entries(params)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
  return query.length > 0 ? `${base}?${query}` : base;
}
