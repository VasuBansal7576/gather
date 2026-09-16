import type { ApproveRequestDTO } from "./dto.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string, min = 1, max = 500): string {
  if (typeof value !== "string" || value.trim().length < min || value.length > max) {
    throw new ValidationError(`${field} must be a non-empty string`);
  }
  return value;
}

export class ValidationError extends Error {
  readonly code = "INVALID_REQUEST" as const;
}

export class CrossOriginError extends Error {
  readonly code = "CROSS_ORIGIN_DENIED" as const;
}

/** Reject unknown HTTP shapes at the boundary before any domain logic runs. */
export function parseApproveBody(body: unknown, bookingIdFromPath: string): ApproveRequestDTO {
  if (!isRecord(body)) throw new ValidationError("Request body must be a JSON object");
  const bookingId = requiredString(body.bookingId ?? bookingIdFromPath, "bookingId");
  if (bookingId !== bookingIdFromPath) throw new ValidationError("Path bookingId and body bookingId must match");
  const proposedActionId = requiredString(body.proposedActionId, "proposedActionId");
  const version = body.proposalVersion;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new ValidationError("proposalVersion must be a positive integer");
  }
  const fingerprint = requiredString(body.proposalFingerprint, "proposalFingerprint", 8, 256);
  // proposalFingerprint is a sha256 hex digest; accept hex only to block free-text injection.
  if (!/^[0-9a-f]{16,128}$/.test(fingerprint)) {
    throw new ValidationError("proposalFingerprint must be the exact hex fingerprint shown with the proposal");
  }
  // approvedBy is NEVER trusted from the request. The server boundary derives it
  // from the configured local owner identity. A client-supplied value is ignored
  // so untrusted inquiry text cannot authorize execution.
  return { bookingId, proposedActionId, proposalVersion: version, proposalFingerprint: fingerprint };
}

export function parseId(value: unknown, field: string): string {
  return requiredString(value, field);
}

export function parseDemoInitBody(body: unknown): { demo: true } {
  if (!isRecord(body)) throw new ValidationError("Request body must be a JSON object");
  if (body.demo !== true) throw new ValidationError("Demo initialization requires { \"demo\": true }");
  return { demo: true };
}

/**
 * Protect local mutation endpoints from cross-origin browser requests.
 * Same-origin fetch and non-browser clients typically omit Origin; those pass.
 * When Origin (or Referer fallback) is present it must match the Host.
 */
export function assertSameOrigin(headers: { origin?: string | null; referer?: string | null; host?: string | null }): void {
  const origin = headers.origin ?? undefined;
  const referer = headers.referer ?? undefined;
  const host = (headers.host ?? "").toLowerCase();
  const candidate = origin ?? referer;
  if (candidate === undefined) return;
  if (!host || !candidate) throw new CrossOriginError("Missing Host or empty Origin was rejected");
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new CrossOriginError("Unparseable Origin was rejected");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new CrossOriginError("Invalid browser Origin was rejected");
  }
  if (parsed.host.toLowerCase() !== host) {
    throw new CrossOriginError(`Cross-origin mutation denied (origin ${parsed.host} != host ${host})`);
  }
}

export function readHeaders(req: { headers: { get(name: string): string | null } }): {
  origin?: string | null;
  referer?: string | null;
  host?: string | null;
} {
  return {
    origin: req.headers.get("origin"),
    referer: req.headers.get("referer"),
    host: req.headers.get("host") ?? req.headers.get("x-forwarded-host"),
  };
}
