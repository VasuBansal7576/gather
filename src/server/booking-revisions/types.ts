import { createHash } from "node:crypto";
import type { ConnectorMetadata, SourceReference } from "../../connectors/contracts.ts";
import type { CalendarHoldReleaseConnector } from "../../connectors/hold-release.ts";
import type { Booking, ProposedAction } from "../../domain/contracts.ts";

// ---------- Hold-release port (N's exact exported contract, vendored) ----------

// The service consumes the exact `CalendarHoldReleaseConnector` contract
// vendored at `src/connectors/hold-release.ts` (N-owned, verbatim copy —
// never a divergent mirror, never an independent key derivation). The port
// is constructor-injected and optional: when absent, every release-gated
// verification fails closed with an explicit blocked condition.
export type {
  CalendarHoldReleaseConnector,
  ReleasedHold,
  ReleaseProvisionalHoldRequest,
  ReleaseProvisionalHoldResponse,
  ReleaseScope,
  ReleaseScopeResolver,
} from "../../connectors/hold-release.ts";
export { releaseHoldOperationKey } from "../../connectors/hold-release.ts";

/** Injectable port: the service consumes N's exact exported contract. */
export type HoldReleasePort = CalendarHoldReleaseConnector;

/**
 * G11 owner booking revision/cancellation/pause command contract.
 *
 * Every command names the exact host-owner authority it executes under:
 * business, booking, and the booking's durable current action triple
 * (action id + version + fingerprint), plus a caller-chosen idempotent
 * command id. Request-supplied owner identities are ignored; the host
 * owner id is authoritative. No second current pointer exists anywhere
 * here — currency always resolves through the store's durable pointer.
 */

/** Trusted connector proof preserved on a verified release. */
export interface ReleaseProof {
  mode: "demo" | "live";
  simulated: boolean;
  provenance: SourceReference[];
}

export function releaseProofOf(metadata: ConnectorMetadata, provenance: unknown): ReleaseProof {
  const refs = Array.isArray(provenance) ? provenance : [];
  return {
    mode: metadata.mode.mode,
    simulated: metadata.simulated,
    provenance: refs.map((ref) => ({ ...(ref as SourceReference) })),
  };
}

// ---------- Command bindings and log ----------

export interface RevisionBinding {
  businessId: string;
  bookingId: string;
  proposedActionId: string;
  proposalVersion: number;
  proposalFingerprint: string;
  commandId: string;
}

export type RevisionCommandKind = "revision" | "cancellation_request" | "cancellation_verify" | "pause" | "resume";

export interface RevisionCommandRecord {
  commandId: string;
  bookingId: string;
  kind: RevisionCommandKind;
  requestHash: string;
  status: "succeeded" | "blocked" | "failed";
  response: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface BookingLifecycle {
  bookingId: string;
  paused: boolean;
  cancelState: "none" | "requested" | "verified";
  cancelCommandId?: string;
  updatedAt: string;
}

export interface BlockedCondition {
  code:
    | "obsolete_hold_unreleased"
    | "obsolete_hold_unverified"
    | "actions_not_settled"
    | "release_unverified"
    | "release_uncertain"
    | "release_failed"
    | "refund_unverified"
    | "offer_not_feasible"
    | "revision_not_persisted";
  detail: string;
}

export interface RevisionRequest {
  binding: RevisionBinding;
  inquiry: Record<string, unknown>;
  calendarId: string;
  email: { to: string[]; subject: string; body: string };
  expiresAt: string;
}

export interface RevisionResponse {
  commandId: string;
  status: "revised" | "blocked";
  booking: Booking;
  duplicate?: boolean;
  action?: ProposedAction;
  /** The superseded action id, so callers can see what was displaced. */
  supersedesActionId?: string;
  blocked?: BlockedCondition[];
  reused?: boolean;
  note: string;
}

export interface CancellationRequestResponse {
  commandId: string;
  status: "request_received" | "already_requested" | "already_verified";
  booking: Booking;
  duplicate?: boolean;
  cancelState: "requested" | "verified";
  invalidatedApprovals: number;
  note: string;
}

export interface CancellationVerifyResponse {
  commandId: string;
  status: "verified" | "blocked";
  booking: Booking;
  duplicate?: boolean;
  /** Local request recorded vs externally verified provider-side effect. */
  cancellationScope: "local_request" | "external_verified";
  blocked?: BlockedCondition[];
  note: string;
}

export interface PauseResponse {
  commandId: string;
  status: "paused" | "resumed";
  booking: Booking;
  paused: boolean;
  duplicate?: boolean;
  note: string;
}

export function canonicalRequestHash(value: unknown): string {
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
