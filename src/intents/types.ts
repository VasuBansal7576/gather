import { createHash } from "node:crypto";
import { ValidationError } from "../server/validation.ts";

/**
 * Durable intent envelope contracts (ADR-002 / C02 / C06).
 *
 * An Intent is the user-visible durable progress record for one submitted
 * command. It owns no provider truth of its own: steps REFERENCE existing
 * authority rows (approvals, action_executions, provider_receipts) by their
 * stable identities — operation keys and execution ids — and never copy
 * receipts into a second store.
 *
 * States: queued -> running -> completed | retryable | uncertain | blocked
 * | cancelled. Terminal states (completed, cancelled) are never rewritten by
 * replay: a duplicate command key returns the same record, and a cancelled
 * or completed intent is never re-driven.
 */

export type IntentState =
  | "queued"
  | "running"
  | "completed"
  | "retryable"
  | "uncertain"
  | "blocked"
  | "cancelled";

export type IntentKind =
  | "approve_booking_proposal"
  | "reconcile_execution"
  | "owner_control";

/** Step progress states. `skipped` marks a step legitimately not needed on this run. */
export type IntentStepStatus = "pending" | "done" | "uncertain" | "failed" | "skipped";

export interface IntentStep {
  name: string;
  status: IntentStepStatus;
  /** Stable provider operation identity bound BEFORE any dispatch (C06). */
  operationKey?: string;
  /** Referenced action_executions row once the step was reserved. */
  executionId?: string;
  at?: string;
  error?: string;
}

export interface IntentRecord {
  id: string;
  /** Stable caller-assigned (or derived) command dedupe key. */
  commandKey: string;
  kind: IntentKind;
  payload: Record<string, unknown>;
  /** Canonical sha256 of the validated payload; a reused key with different content conflicts. */
  payloadHash: string;
  /** Installation mode at submit time ("prepared" | "live" | unmanaged label). */
  mode: string;
  businessId?: string;
  bookingId?: string;
  proposedActionId?: string;
  proposalVersion?: number;
  state: IntentState;
  steps: IntentStep[];
  /** Current progression owner while leased; cleared on release/terminal states. */
  leaseOwner?: string;
  /** Monotonic fencing token: every successful claim/cancel/reclaim bumps it. */
  fencingToken: number;
  leaseExpiresAt?: string;
  /** Execution deadline: no new step dispatches after this instant. */
  deadlineAt?: string;
  /** Per-claim run identity; runId + fencingToken fence writes to the claim holder. */
  runId?: string;
  attempts: number;
  lastError?: string;
  cancelledBy?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  cancelledAt?: string;
}

/** The fencing triple a claim holder must present to advance an intent. */
export interface IntentLease {
  owner: string;
  fencingToken: number;
  runId: string;
  expiresAt: string;
}

export type IntentCommand =
  | {
      kind: "approve_booking_proposal";
      bookingId: string;
      proposedActionId: string;
      proposalVersion: number;
      proposalFingerprint: string;
    }
  | { kind: "reconcile_execution"; executionId: string }
  | {
      kind: "owner_control";
      bookingId: string;
      control: "pause" | "resume" | "cancel";
      /** Stable idempotency key for the attested ledger control event. */
      dedupeKey: string;
      note?: string;
    };

export interface EnqueueInput {
  command: IntentCommand;
  /** Optional caller-assigned stable key; derived deterministically per kind when absent. */
  commandKey?: string;
  /** Cross-checked against the payload's own version field when both are present. */
  expectedVersion?: number;
  /** Milliseconds from submit until the execution deadline (bounded default applies). */
  deadlineMs?: number;
}

export interface IntentDTO {
  id: string;
  commandKey: string;
  kind: IntentKind;
  state: IntentState;
  mode: string;
  businessId?: string;
  bookingId?: string;
  proposedActionId?: string;
  proposalVersion?: number;
  steps: IntentStep[];
  attempts: number;
  lastError?: string;
  runId?: string;
  deadlineAt?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  cancelledAt?: string;
  cancelledBy?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** Boundary validation failure; maps to HTTP 400 INVALID_REQUEST via the shared helpers. */
export class IntentValidationError extends ValidationError {}

/** Validate an unknown command payload into a typed IntentCommand (C02 boundary). */
export function assertValidCommand(raw: unknown): IntentCommand {
  if (!isRecord(raw)) throw new IntentValidationError("Intent command must be an object");
  if (raw.kind === "approve_booking_proposal") {
    if (!isNonEmptyString(raw.bookingId)) throw new IntentValidationError("bookingId must be a non-empty string");
    if (!isNonEmptyString(raw.proposedActionId)) throw new IntentValidationError("proposedActionId must be a non-empty string");
    if (!isPositiveInt(raw.proposalVersion)) throw new IntentValidationError("proposalVersion must be a positive integer");
    if (!isNonEmptyString(raw.proposalFingerprint) || !/^[0-9a-f]{16,128}$/.test(raw.proposalFingerprint)) {
      throw new IntentValidationError("proposalFingerprint must be the exact hex fingerprint shown with the proposal");
    }
    return {
      kind: "approve_booking_proposal",
      bookingId: raw.bookingId,
      proposedActionId: raw.proposedActionId,
      proposalVersion: raw.proposalVersion,
      proposalFingerprint: raw.proposalFingerprint,
    };
  }
  if (raw.kind === "reconcile_execution") {
    if (!isNonEmptyString(raw.executionId)) throw new IntentValidationError("executionId must be a non-empty string");
    return { kind: "reconcile_execution", executionId: raw.executionId };
  }
  if (raw.kind === "owner_control") {
    if (!isNonEmptyString(raw.bookingId)) throw new IntentValidationError("bookingId must be a non-empty string");
    if (raw.control !== "pause" && raw.control !== "resume" && raw.control !== "cancel") {
      throw new IntentValidationError("control must be one of pause|resume|cancel");
    }
    if (!isNonEmptyString(raw.dedupeKey)) throw new IntentValidationError("dedupeKey must be a non-empty string");
    if (raw.note !== undefined && typeof raw.note !== "string") throw new IntentValidationError("note must be a string when present");
    return {
      kind: "owner_control",
      bookingId: raw.bookingId,
      control: raw.control,
      dedupeKey: raw.dedupeKey,
      ...(raw.note === undefined ? {} : { note: raw.note }),
    };
  }
  throw new IntentValidationError("kind must be one of approve_booking_proposal|reconcile_execution|owner_control");
}

/** Validate the submit body (unknown HTTP input) into an EnqueueInput. */
export function assertValidEnqueueBody(raw: unknown): EnqueueInput {
  if (!isRecord(raw)) throw new IntentValidationError("Request body must be a JSON object");
  const command = assertValidCommand(raw.command ?? raw);
  if (raw.commandKey !== undefined && (!isNonEmptyString(raw.commandKey) || raw.commandKey.length > 200)) {
    throw new IntentValidationError("commandKey must be a non-empty string of at most 200 characters");
  }
  if (raw.expectedVersion !== undefined && !isPositiveInt(raw.expectedVersion)) {
    throw new IntentValidationError("expectedVersion must be a positive integer when present");
  }
  if (raw.deadlineMs !== undefined && (!Number.isInteger(raw.deadlineMs) || (raw.deadlineMs as number) < 1000 || (raw.deadlineMs as number) > 86_400_000)) {
    throw new IntentValidationError("deadlineMs must be an integer between 1000 and 86400000 when present");
  }
  return {
    command,
    ...(raw.commandKey === undefined ? {} : { commandKey: raw.commandKey as string }),
    ...(raw.expectedVersion === undefined ? {} : { expectedVersion: raw.expectedVersion as number }),
    ...(raw.deadlineMs === undefined ? {} : { deadlineMs: raw.deadlineMs as number }),
  };
}

/** Canonical sha256 of a payload: object key order never changes the hash. */
export function canonicalHash(value: unknown): string {
  const canonicalize = (input: unknown): unknown =>
    Array.isArray(input)
      ? input.map(canonicalize)
      : input !== null && typeof input === "object"
        ? Object.fromEntries(
            Object.entries(input as Record<string, unknown>)
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([key, nested]) => [key, canonicalize(nested)]),
          )
        : input;
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

/**
 * Deterministic default command keys: retries of the same logical command
 * dedupe to the same intent without the caller inventing an identity.
 */
export function defaultCommandKey(command: IntentCommand): string {
  switch (command.kind) {
    case "approve_booking_proposal":
      return `approve:${command.proposedActionId}:v${command.proposalVersion}:${command.proposalFingerprint.slice(0, 16)}`;
    case "reconcile_execution":
      return `reconcile:${command.executionId}`;
    case "owner_control":
      return `control:${command.bookingId}:${command.control}:${command.dedupeKey}`;
  }
}
