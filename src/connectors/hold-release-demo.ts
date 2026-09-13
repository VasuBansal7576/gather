import {
  DEMO_MODE,
  type ConnectorMetadata,
  type ConnectorResult,
  type OperationRequest,
  type SourceReference,
} from "./contracts.ts";
import type {
  CalendarHoldReleaseConnector,
  ReleaseProvisionalHoldRequest,
  ReleaseProvisionalHoldResponse,
  ReleaseScope,
  ReleaseScopeResolver,
} from "./hold-release.ts";

/**
 * Deterministic DEMO ONLY hold-release simulator for G11
 * cancellation/revision flows. Explicitly fictional: every result carries
 * `mode: DEMO ONLY`, `simulated: true`, and fixture locators. Never a live
 * outcome — the live Google adapter in `google/hold-release.ts` is the only
 * path that touches provider APIs (scripted transports in tests).
 *
 * This file is deliberately separate from `demo.ts` so the shared demo
 * simulator stays untouched; cancellation lanes seed this connector
 * directly with the holds under test.
 */

export interface DemoHoldSeed {
  holdId: string;
  bookingId: string;
  calendarId: string;
  originalHoldOperationKey: string;
  startAt?: string;
  endAt?: string;
  expiresAt?: string;
}

export interface DemoHoldReleaseSeed {
  holds?: readonly DemoHoldSeed[];
  /** Fixed receipt timestamp; defaults to a constant demo instant. */
  now?: string;
  /**
   * Release operation keys that delete in memory, then report an uncertain
   * timeout once. Reconciliation discovers the completed delete.
   */
  timeoutAfterSuccessOperationKeys?: readonly string[];
  /** Durable releaseOperationKey → scope lookup surviving restarts. */
  resolveReleaseScope?: ReleaseScopeResolver;
}

const DEMO_SOURCE: SourceReference = {
  kind: "fixture",
  locator: "demo://gather/hold-release",
  label: "Gather hold-release demo fixture",
  fictional: true,
};

const DEFAULT_NOW = "2030-01-02T00:00:00.000Z";

function metadata(operationKey: string, sources: SourceReference[]): ConnectorMetadata {
  return {
    operationKey,
    mode: DEMO_MODE,
    simulated: true,
    sourceReferences: [...sources, { ...DEMO_SOURCE }],
  };
}

export class DemoCalendarHoldReleaseConnector implements CalendarHoldReleaseConnector {
  private readonly holds = new Map<string, DemoHoldSeed>();
  private readonly releases = new Map<string, ReleaseScope>();
  private readonly now: string;
  private readonly timeoutKeys: Set<string>;
  private readonly consumedTimeouts = new Set<string>();
  private readonly resolveReleaseScope?: ReleaseScopeResolver;

  constructor(seed: DemoHoldReleaseSeed = {}) {
    for (const hold of seed.holds ?? []) {
      this.holds.set(hold.holdId, { ...hold });
    }
    this.now = seed.now ?? DEFAULT_NOW;
    this.timeoutKeys = new Set(seed.timeoutAfterSuccessOperationKeys ?? []);
    this.resolveReleaseScope = seed.resolveReleaseScope;
  }

  /** Test hook: seed an additional hold after construction. */
  public seedHold(hold: DemoHoldSeed): void {
    this.holds.set(hold.holdId, { ...hold });
  }

  public getHold(holdId: string): DemoHoldSeed | undefined {
    const hold = this.holds.get(holdId);
    return hold === undefined ? undefined : { ...hold };
  }

  async releaseProvisionalHold(
    request: ReleaseProvisionalHoldRequest,
  ): Promise<ConnectorResult<ReleaseProvisionalHoldResponse>> {
    if (
      request.operationKey.trim().length === 0 ||
      request.bookingId.trim().length === 0 ||
      request.calendarId.trim().length === 0 ||
      request.holdId.trim().length === 0 ||
      request.originalHoldOperationKey.trim().length === 0
    ) {
      return failed(request.operationKey, "operationKey, bookingId, calendarId, holdId, and originalHoldOperationKey are required");
    }
    const scope: ReleaseScope = {
      calendarId: request.calendarId,
      holdId: request.holdId,
      bookingId: request.bookingId,
      originalHoldOperationKey: request.originalHoldOperationKey,
      ...(request.startAt === undefined ? {} : { startAt: request.startAt }),
      ...(request.endAt === undefined ? {} : { endAt: request.endAt }),
      ...(request.expiresAt === undefined ? {} : { expiresAt: request.expiresAt }),
    };
    // Record the scope before mutating so reconcile works after a restart.
    this.releases.set(request.operationKey, { ...scope });

    const hold = this.holds.get(request.holdId);
    if (hold === undefined) {
      return this.released(request.operationKey, scope, true);
    }
    if (hold.calendarId !== request.calendarId) {
      return failed(request.operationKey, `Hold "${request.holdId}" belongs to calendar "${hold.calendarId}", not "${request.calendarId}"`, "conflict");
    }
    if (hold.originalHoldOperationKey !== request.originalHoldOperationKey || hold.bookingId !== request.bookingId) {
      return failed(request.operationKey, "The hold carries different booking/original-operation identity; refusing to release a stranger hold", "conflict");
    }
    if (request.startAt !== undefined && hold.startAt !== undefined && hold.startAt !== request.startAt) {
      return failed(request.operationKey, "The hold starts at a different time than expected; refusing to release a changed hold", "conflict");
    }
    if (request.endAt !== undefined && hold.endAt !== undefined && hold.endAt !== request.endAt) {
      return failed(request.operationKey, "The hold ends at a different time than expected; refusing to release a changed hold", "conflict");
    }
    if (request.expiresAt !== undefined && hold.expiresAt !== undefined && hold.expiresAt !== request.expiresAt) {
      return failed(request.operationKey, "The hold carries a different expiry than expected; refusing to release a changed hold", "conflict");
    }

    this.holds.delete(request.holdId);
    if (this.timeoutKeys.has(request.operationKey) && !this.consumedTimeouts.has(request.operationKey)) {
      this.consumedTimeouts.add(request.operationKey);
      return {
        status: "uncertain",
        metadata: metadata(request.operationKey, []),
        error: { kind: "timeout_after_success", message: "Demo hold deleted, then the response was lost; reconcile the release before retrying", retryable: false },
        reconciliationRequired: true,
      };
    }
    return this.released(request.operationKey, scope, false);
  }

  async reconcileReleasedHold(
    request: OperationRequest,
  ): Promise<ConnectorResult<ReleaseProvisionalHoldResponse>> {
    const recorded = this.releases.get(request.operationKey);
    const resolved = recorded ?? (this.resolveReleaseScope === undefined
      ? undefined
      : await this.resolveReleaseScope(request.operationKey));
    if (resolved === undefined) {
      return failed(request.operationKey, "Cannot reconcile: this demo connector has no record of the release operation key");
    }
    if (this.holds.has(resolved.holdId)) {
      return failed(request.operationKey, "The hold is still present; the release did not complete", "conflict");
    }
    return this.released(request.operationKey, resolved, true);
  }

  private released(
    operationKey: string,
    scope: ReleaseScope,
    alreadyReleased: boolean,
  ): ConnectorResult<ReleaseProvisionalHoldResponse> {
    const provenance: SourceReference[] = [{
      kind: "calendar",
      locator: `demo://gather/hold-release/${scope.calendarId}/${scope.holdId}?release=${operationKey}`,
      label: "Gather hold-release demo fixture",
      fictional: true,
    }];
    return {
      status: "succeeded",
      metadata: metadata(operationKey, provenance),
      data: {
        released: {
          holdId: scope.holdId,
          operationKey,
          originalHoldOperationKey: scope.originalHoldOperationKey,
          bookingId: scope.bookingId,
          calendarId: scope.calendarId,
          status: "released",
          alreadyReleased,
          releasedAt: this.now,
          sourceReferences: [...provenance],
        },
        provenance,
      },
    };
  }
}

function failed(
  operationKey: string,
  message: string,
  kind: "invalid_request" | "conflict" = "invalid_request",
): ConnectorResult<never> {
  return {
    status: "failed",
    metadata: metadata(operationKey, []),
    error: { kind, message, retryable: false },
  };
}
