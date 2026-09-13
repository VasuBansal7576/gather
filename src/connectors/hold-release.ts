/**
 * CONTRACT VENDORED VERBATIM from the provider lane
 * (`gather-hold-release/src/connectors/hold-release.ts`, N-owned).
 *
 * Single source of truth lives in N's lane; this copy exists only so the
 * G11 revisions service compiles against the EXACT exported contract
 * instead of a divergent mirror. Do not edit here — request a verified
 * handoff from the coordinator when N's contract changes, then re-vendor.
 * Key derivation (`releaseHoldOperationKey`) is N's exact helper, never an
 * independent re-derivation.
 */

import {
  stableOperationKey,
  type ConnectorResult,
  type OperationRequest,
  type SourceReference,
} from "./contracts.ts";

/**
 * Bounded verified calendar hold release for governing G11
 * cancellation/revision flows.
 *
 * This is a SEPARATE optional port. It is intentionally NOT merged into
 * `CalendarConnector` (see contracts.ts), so the K cancellation service can
 * consume it independently and other lanes keep compiling unchanged.
 */

export interface ReleaseProvisionalHoldRequest extends OperationRequest {
  /** Gather booking identity the hold was created for. */
  bookingId: string;
  /** Owning calendar. Releases are always scoped to exactly one calendar. */
  calendarId: string;
  /** Provider event/hold identifier to release. */
  holdId: string;
  /** Operation key the original hold was created under (identity anchor). */
  originalHoldOperationKey: string;
  /** Exact expected hold window, when known. Verified before delete. */
  startAt?: string;
  endAt?: string;
  expiresAt?: string;
}

export interface ReleasedHold {
  holdId: string;
  /** Release operation key (this release action's stable key). */
  operationKey: string;
  originalHoldOperationKey: string;
  bookingId: string;
  calendarId: string;
  status: "released";
  /** True when the hold was already absent before this release deleted it. */
  alreadyReleased: boolean;
  releasedAt: string;
  sourceReferences: SourceReference[];
}

export interface ReleaseProvisionalHoldResponse {
  released: ReleasedHold;
  /** Provenance repeats the source references for downstream evidence. */
  provenance: SourceReference[];
}

/**
 * Provider-neutral release port. Both methods return standard
 * `ConnectorResult` values:
 * - `succeeded` only after genuine absence is verified (never assumed),
 * - `failed` for definite outcomes (identity mismatch, permission, not
 *   scoped), with honest error kinds,
 * - `uncertain` (reconciliationRequired) when a DELETE may have been
 *   accepted but its response was lost — reconcile before blind retry.
 */
export interface CalendarHoldReleaseConnector {
  releaseProvisionalHold(
    request: ReleaseProvisionalHoldRequest,
  ): Promise<ConnectorResult<ReleaseProvisionalHoldResponse>>;
  reconcileReleasedHold(
    request: OperationRequest,
  ): Promise<ConnectorResult<ReleaseProvisionalHoldResponse>>;
}

/**
 * Durable release scope for restart-stable reconciliation. Backed by
 * caller-owned durable storage (e.g. the booking service's receipts).
 * Volatile maps are never sufficient: after a restart the in-memory world
 * is empty while the provider may still hold the event.
 */
export interface ReleaseScope {
  calendarId: string;
  holdId: string;
  bookingId: string;
  originalHoldOperationKey: string;
  startAt?: string;
  endAt?: string;
  expiresAt?: string;
}

export type ReleaseScopeResolver = (
  releaseOperationKey: string,
) => Promise<ReleaseScope | undefined>;

/**
 * Deterministic release operation key helper. Callers persist this value
 * with the cancellation action and reuse it across retries/reconciliation.
 */
export function releaseHoldOperationKey(input: {
  bookingId: string;
  holdId: string;
  originalHoldOperationKey: string;
}): string {
  return stableOperationKey({
    connector: "calendar",
    operation: "release-provisional-hold",
    identity: {
      bookingId: input.bookingId,
      holdId: input.holdId,
      originalHoldOperationKey: input.originalHoldOperationKey,
    },
  });
}
