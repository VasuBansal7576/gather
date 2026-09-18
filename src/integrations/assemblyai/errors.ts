/**
 * ADR-013 provider-error mapping (C02/C08).
 *
 * AssemblyAI HTTP/transport failures map to the existing service error
 * vocabulary instead of leaking provider bodies, credentials, or raw
 * responses into UI/logs. Callers use the mapped code to pick the durable,
 * scoped recovery path (retryable vs blocked).
 */

import { ServiceError } from "../../server/booking-service.ts";

export const ASSEMBLYAI_DISABLED_CODE = "DENIED";
export const ASSEMBLYAI_TOO_LARGE_CODE = "INVALID_REQUEST";
export const ASSEMBLYAI_RETRYABLE_CODE = "EXECUTION_FAILED";

/** Map an AssemblyAI upload/transcript HTTP status to a service error. */
export function assemblyAIStatusError(status: number, detail: string): ServiceError {
  const safe = detail.slice(0, 300);
  if (status === 400 || status === 422) {
    return new ServiceError("INVALID_REQUEST", `AssemblyAI rejected the request: ${safe}`, false);
  }
  if (status === 401 || status === 403) {
    return new ServiceError(
      "DENIED",
      "AssemblyAI credentials were rejected; check GATHER_ASSEMBLYAI_API_KEY without committing it",
      false,
    );
  }
  if (status === 404) {
    return new ServiceError("NOT_FOUND", `AssemblyAI transcript not found: ${safe}`, false);
  }
  if (status === 409) {
    return new ServiceError("CONFLICT", `AssemblyAI state conflict: ${safe}`, false);
  }
  if (status === 429) {
    return new ServiceError("EXECUTION_FAILED", "AssemblyAI budget/quota exhausted; retry later", true);
  }
  if (status >= 500) {
    return new ServiceError("EXECUTION_FAILED", `AssemblyAI provider unavailable (HTTP ${status}); retryable`, true);
  }
  return new ServiceError("INVALID_REQUEST", `AssemblyAI unexpected status ${status}: ${safe}`, false);
}

/** Map a transport-level failure (timeout, abort, network) to a service error. */
export function assemblyAITransportError(error: unknown): ServiceError {
  const message = error instanceof Error ? error.message : String(error);
  if (/abort|cancel/i.test(message)) {
    return new ServiceError("INVALID_REQUEST", "Voice upload/transcription was cancelled before dispatch", false);
  }
  if (/timeout|timed out/i.test(message)) {
    return new ServiceError("UNCERTAIN", `AssemblyAI request timed out: ${message.slice(0, 200)}`, true);
  }
  return new ServiceError("EXECUTION_FAILED", `AssemblyAI provider unreachable: ${message.slice(0, 200)}`, true);
}

/** Disabled-profile gate: no network, no data flow, displayable reason. */
export function assemblyAIDisabledError(missingEvidence: string): ServiceError {
  return new ServiceError("DENIED", missingEvidence, false);
}
