import { ValidationError } from "../validation.ts";
import type { RevisionBinding, RevisionRequest } from "./types.ts";
import type { CancellationVerifyRequest } from "./service.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string, min = 1, max = 500): string {
  if (typeof value !== "string" || value.trim().length < min || value.length > max) {
    throw new ValidationError(`${field} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, field: string, max = 2000): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, field, 1, max);
}

/** Exact authority binding shared by every revision command body. */
export function parseRevisionBinding(body: unknown, bookingIdFromPath: string): RevisionBinding {
  if (!isRecord(body)) throw new ValidationError("Request body must be a JSON object");
  const bookingId = requiredString(body.bookingId ?? bookingIdFromPath, "bookingId");
  if (bookingId !== bookingIdFromPath) throw new ValidationError("Path bookingId and body bookingId must match");
  const businessId = requiredString(body.businessId, "businessId");
  const proposedActionId = requiredString(body.proposedActionId, "proposedActionId");
  const version = body.proposalVersion;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new ValidationError("proposalVersion must be a positive integer");
  }
  const fingerprint = requiredString(body.proposalFingerprint, "proposalFingerprint", 8, 256);
  if (!/^[0-9a-f]{16,128}$/.test(fingerprint)) {
    throw new ValidationError("proposalFingerprint must be the exact hex fingerprint shown with the proposal");
  }
  const commandId = requiredString(body.commandId, "commandId", 1, 200);
  return { businessId, bookingId, proposedActionId, proposalVersion: version, proposalFingerprint: fingerprint, commandId };
}

function parseEmail(value: unknown): { to: string[]; subject: string; body: string } {
  if (!isRecord(value)) throw new ValidationError("email must be an object");
  if (!Array.isArray(value.to) || value.to.length === 0 || value.to.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    throw new ValidationError("email.to must be a non-empty array of addresses");
  }
  return {
    to: value.to as string[],
    subject: requiredString(value.subject, "email.subject", 1, 500),
    body: requiredString(value.body, "email.body", 1, 20000),
  };
}

export function parseRevisionBody(body: unknown, bookingIdFromPath: string): RevisionRequest {
  const binding = parseRevisionBinding(body, bookingIdFromPath);
  if (!isRecord(body)) throw new ValidationError("Request body must be a JSON object");
  const inquiry = body.inquiry;
  if (!isRecord(inquiry)) throw new ValidationError("inquiry must be a complete revised inquiry object");
  const calendarId = requiredString(body.calendarId, "calendarId");
  const email = parseEmail(body.email);
  const expiresAt = requiredString(body.expiresAt, "expiresAt");
  if (!Number.isFinite(Date.parse(expiresAt))) throw new ValidationError("expiresAt must be a valid date-time string");
  return { binding, inquiry, calendarId, email, expiresAt };
}

export function parseCancellationBody(body: unknown, bookingIdFromPath: string): { binding: RevisionBinding; action: "request" | "verify"; waiver?: { policyId: string }; note?: string } {
  const binding = parseRevisionBinding(body, bookingIdFromPath);
  if (!isRecord(body)) throw new ValidationError("Request body must be a JSON object");
  const action = body.action === undefined ? "request" : body.action;
  if (action !== "request" && action !== "verify") {
    throw new ValidationError('action must be "request" or "verify"');
  }
  let waiver: { policyId: string } | undefined;
  if (body.waiver !== undefined) {
    if (!isRecord(body.waiver)) throw new ValidationError("waiver must be an object");
    waiver = { policyId: requiredString(body.waiver.policyId, "waiver.policyId") };
  }
  return { binding, action, waiver, note: optionalString(body.note, "note") };
}

export function parsePauseBody(body: unknown, bookingIdFromPath: string): { binding: RevisionBinding; action: "pause" | "resume"; note?: string } {
  const binding = parseRevisionBinding(body, bookingIdFromPath);
  if (!isRecord(body)) throw new ValidationError("Request body must be a JSON object");
  const action = body.action;
  if (action !== "pause" && action !== "resume") {
    throw new ValidationError('action must be "pause" or "resume"');
  }
  return { binding, action, note: optionalString(body.note, "note") };
}

export function toVerifyRequest(parsed: { binding: RevisionBinding; waiver?: { policyId: string } }): CancellationVerifyRequest {
  return { binding: parsed.binding, ...(parsed.waiver === undefined ? {} : { waiver: parsed.waiver }) };
}
