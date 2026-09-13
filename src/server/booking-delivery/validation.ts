import type { ConfirmRequestDTO } from "./service.ts";
import { ValidationError } from "../validation.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string, min = 1, max = 500): string {
  if (typeof value !== "string" || value.trim().length < min || value.length > max) {
    throw new ValidationError(`${field} must be a non-empty string`);
  }
  return value;
}

/**
 * Reject unknown confirm-request shapes at the boundary before any domain
 * logic runs. The body may assert the exact action/version/fingerprint it
 * intends to confirm plus its idempotent command key — nothing else in the
 * payload carries authority: evidence, policy, and identity are all
 * host-fetched.
 */
export function parseConfirmBody(body: unknown, bookingIdFromPath: string): ConfirmRequestDTO {
  if (!isRecord(body)) throw new ValidationError("Request body must be a JSON object");
  const bookingId = requiredString(body.bookingId ?? bookingIdFromPath, "bookingId");
  if (bookingId !== bookingIdFromPath) throw new ValidationError("Path bookingId and body bookingId must match");
  const proposedActionId = requiredString(body.proposedActionId, "proposedActionId");
  const version = body.proposalVersion;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new ValidationError("proposalVersion must be a positive integer");
  }
  const fingerprint = requiredString(body.proposalFingerprint, "proposalFingerprint", 8, 256);
  if (!/^[0-9a-f]{16,128}$/.test(fingerprint)) {
    throw new ValidationError("proposalFingerprint must be the exact hex fingerprint shown with the proposal");
  }
  const confirmKey = requiredString(body.confirmKey, "confirmKey", 1, 200);
  return { bookingId, proposedActionId, proposalVersion: version, proposalFingerprint: fingerprint, confirmKey };
}
