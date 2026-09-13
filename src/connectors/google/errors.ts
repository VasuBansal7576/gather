import type { ConnectorError } from "../contracts.ts";

/**
 * Boundary validation for unknown provider JSON plus HTTP status mapping.
 * Everything crossing this file is `unknown` until a guard proves otherwise;
 * `any` is never used and tokens are never present in these shapes.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return undefined;
    out.push(item);
  }
  return out;
}

export function safeParseJson(text: string): unknown {
  if (text.trim().length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

interface GoogleErrorDetail {
  reason?: string;
  message?: string;
}

function googleErrorDetails(body: unknown): GoogleErrorDetail[] {
  if (!isRecord(body)) return [];
  const error = body.error;
  if (!isRecord(error)) return [];
  const errors = error.errors;
  if (!Array.isArray(errors)) return [];
  const details: GoogleErrorDetail[] = [];
  for (const item of errors) {
    if (!isRecord(item)) continue;
    const detail: GoogleErrorDetail = {};
    const reason = asString(item.reason);
    const message = asString(item.message);
    if (reason !== undefined) detail.reason = reason;
    if (message !== undefined) detail.message = message;
    details.push(detail);
  }
  return details;
}

function googleErrorMessage(body: unknown, fallback: string): string {
  if (isRecord(body) && isRecord(body.error)) {
    const message = asString(body.error.message);
    if (message !== undefined && message.length > 0) return message;
  }
  return fallback;
}

/**
 * Map an HTTP response from a Google API into a connector error.
 * Verified against the published Calendar error guide and Gmail error
 * guide: 401 authError (expired/invalid credentials, invalid_grant) means
 * revoked/refreshable access; 403 reasons distinguish rate limits from
 * permission denial; 429 and 5xx are transient; 404/409/400 are definite.
 */
export function mapGoogleHttpError(status: number, body: unknown, operation: string): ConnectorError {
  const details = googleErrorDetails(body);
  const reasons = new Set(details.map((detail) => detail.reason).filter((reason) => reason !== undefined));
  const message = googleErrorMessage(body, `Google API ${operation} failed with HTTP ${status}`);

  if (status === 401) {
    return { kind: "access_revoked", message: `${message} (HTTP 401: refresh or re-authorize the Google account)`, retryable: false };
  }
  if (status === 403) {
    if (reasons.has("rateLimitExceeded") || reasons.has("userRateLimitExceeded")) {
      return { kind: "rate_limited", message: `${message} (quota exhausted; back off and retry)`, retryable: true };
    }
    return { kind: "authorization_denied", message: `${message} (HTTP 403: missing scope or privilege)`, retryable: false };
  }
  if (status === 429) {
    return { kind: "rate_limited", message: `${message} (HTTP 429: back off and retry)`, retryable: true };
  }
  if (status === 404) {
    return { kind: "not_found", message, retryable: false };
  }
  if (status === 409) {
    return { kind: "conflict", message, retryable: false };
  }
  if (status === 400) {
    return { kind: "invalid_request", message, retryable: false };
  }
  if (status >= 500) {
    return { kind: "transport_error", message: `${message} (transient server error)`, retryable: true };
  }
  return { kind: "transport_error", message, retryable: status === 408 || status === 425 };
}

/** Definite client-side validation failures before any HTTP call. */
export function invalidRequest(message: string): ConnectorError {
  return { kind: "invalid_request", message, retryable: false };
}

/** Transport died before a response: safe to retry reads; writes are uncertain. */
export function transportError(message: string): ConnectorError {
  return { kind: "transport_error", message, retryable: true };
}
