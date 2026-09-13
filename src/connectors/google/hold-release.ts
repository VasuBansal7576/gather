import type {
  ConnectorResult,
  OperationRequest,
  SourceReference,
} from "../contracts.ts";
import type {
  CalendarHoldReleaseConnector,
  ReleaseProvisionalHoldRequest,
  ReleaseProvisionalHoldResponse,
  ReleaseScope,
  ReleaseScopeResolver,
} from "../hold-release.ts";
import {
  asString,
  invalidRequest,
  isRecord,
  mapGoogleHttpError,
  safeParseJson,
  transportError,
} from "./errors.ts";
import {
  CALENDAR_BASE_URL,
  TokenUnavailableError,
  TransportNetworkError,
  TransportTimeoutError,
  liveMetadata,
  withQuery,
  type GoogleAdapterOptions,
  type GoogleHttpResponse,
  authorized,
} from "./transport.ts";
import { googleEventIdFor } from "./calendar.ts";

/**
 * Bounded verified calendar hold release (Google Calendar v3, LIVE,
 * unverified against a real account — scripted transports only).
 *
 * Verified API surface (developers.google.com/workspace/calendar/api):
 * - `GET /calendar/v3/calendars/{calendarId}/events/{eventId}`
 *   (`events.get`) — pre-delete identity read and post-delete absence
 *   verification. The Events resource carries an `etag`; reads capture it
 *   from the response `ETag` header (falling back to the body's `etag`
 *   field) for the conditional delete below.
 * - `DELETE /calendar/v3/calendars/{calendarId}/events/{eventId}?sendUpdates=none`
 *   (`events.delete`) — silent release; success returns an empty body
 *   (HTTP 200/204). A caller-supplied `If-Match` etag makes the delete
 *   conditional so a concurrently changed event fails with 412 instead of
 *   being silently removed.
 * - Absence semantics: HTTP 404/410 on either call is authentic provider
 *   attestation that the event is gone (idempotent success). HTTP 403 is
 *   permission denial, never absence. Timeouts, network failures, and
 *   5xx/408/425 after DELETE dispatch are ambiguous (the delete may have
 *   been accepted) and surface as `uncertain` — reconcile by re-reading,
 *   never blind-repeat the DELETE.
 *
 * The live gate is BLOCKED: tokens arrive only through the injected
 * supplier, no credentials are read here, and no live account verification
 * has been performed.
 */

const EXT_KEY = "gatherOperationKey";
const EXT_BOOKING = "gatherBookingId";
const EXT_EXPIRES = "gatherExpiresAt";

export interface GoogleHoldReleaseOptions extends GoogleAdapterOptions {
  /**
   * Explicit calendar binding. A bound adapter serves exactly one calendar
   * and rejects any release naming another without any HTTP call.
   */
  calendarId?: string;
  /**
   * Durable releaseOperationKey → scope lookup (caller-owned durable
   * storage) for `reconcileReleasedHold`, which receives only the release
   * operation key. Required: the binding alone cannot supply the hold id.
   */
  resolveReleaseScope?: ReleaseScopeResolver;
}

interface ParsedHoldEvent {
  id: string;
  status?: string;
  startMs?: number;
  endMs?: number;
  etag?: string;
  operationKey?: string;
  bookingId?: string;
  expiresAt?: string;
}

function parseEventTime(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  const dateTime = asString(value.dateTime);
  if (dateTime !== undefined) {
    const ms = Date.parse(dateTime);
    return Number.isFinite(ms) ? ms : undefined;
  }
  const date = asString(value.date);
  if (date !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const ms = Date.parse(`${date}T00:00:00.000Z`);
    return Number.isFinite(ms) ? ms : undefined;
  }
  return undefined;
}

function parseHoldEvent(value: unknown): ParsedHoldEvent | undefined {
  if (!isRecord(value)) return undefined;
  const id = asString(value.id);
  if (id === undefined) return undefined;
  const event: ParsedHoldEvent = { id };
  const status = asString(value.status);
  const etag = asString(value.etag);
  if (status !== undefined) event.status = status;
  if (etag !== undefined) event.etag = etag;
  const startMs = parseEventTime(value.start);
  if (startMs !== undefined) event.startMs = startMs;
  const endMs = parseEventTime(value.end);
  if (endMs !== undefined) event.endMs = endMs;
  if (isRecord(value.extendedProperties) && isRecord(value.extendedProperties.private)) {
    const key = asString(value.extendedProperties.private[EXT_KEY]);
    const booking = asString(value.extendedProperties.private[EXT_BOOKING]);
    const expires = asString(value.extendedProperties.private[EXT_EXPIRES]);
    if (key !== undefined) event.operationKey = key;
    if (booking !== undefined) event.bookingId = booking;
    if (expires !== undefined) event.expiresAt = expires;
  }
  return event;
}

/** Case-insensitive response header lookup (scripted fakes vary in case). */
function responseHeader(headers: Record<string, string>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

function tokenFailure(operationKey: string): ConnectorResult<never> {
  return {
    status: "failed",
    metadata: liveMetadata(operationKey, []),
    error: { kind: "access_revoked", message: "No approved Google access token is available (live gate BLOCKED until onboarding provides account assets)", retryable: false },
  };
}

/**
 * Delete-path ambiguity: HTTP 5xx, 408/425, timeouts, and network failures
 * after DELETE dispatch may all follow a server-side delete, so these
 * report `uncertain` (reconcile by re-reading) instead of a retryable
 * failure that could blind-repeat the delete.
 */
function ambiguousDelete(operationKey: string, detail: string): ConnectorResult<never> {
  return {
    status: "uncertain",
    metadata: liveMetadata(operationKey, []),
    error: { kind: "timeout_after_success", message: `${detail}; reconcile the release (re-read, never blind-repeat the delete) before retrying`, retryable: false },
    reconciliationRequired: true,
  };
}

export class GoogleCalendarHoldReleaseConnector implements CalendarHoldReleaseConnector {
  private readonly options: GoogleHoldReleaseOptions;

  constructor(options: GoogleHoldReleaseOptions) {
    this.options = options;
  }

  private releaseSource(calendarId: string, holdId: string, operationKey: string): SourceReference {
    return {
      kind: "calendar",
      locator: `google-calendar://${calendarId}/events/${holdId}?release=${operationKey}`,
      label: "LIVE Google Calendar",
      fictional: false,
    };
  }

  private bindingViolation(calendarId: string): boolean {
    return this.options.calendarId !== undefined && this.options.calendarId !== calendarId;
  }

  private eventUrl(calendarId: string, holdId: string): string {
    return `${CALENDAR_BASE_URL}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(holdId)}`;
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
      return {
        status: "failed",
        metadata: liveMetadata(request.operationKey, []),
        error: invalidRequest("operationKey, bookingId, calendarId, holdId, and originalHoldOperationKey are required"),
      };
    }
    if (this.bindingViolation(request.calendarId)) {
      return {
        status: "failed",
        metadata: liveMetadata(request.operationKey, []),
        error: invalidRequest(`Adapter is bound to calendar "${this.options.calendarId}"; request names "${request.calendarId}"`),
      };
    }
    for (const field of ["startAt", "endAt", "expiresAt"] as const) {
      const value = request[field];
      if (value !== undefined && !Number.isFinite(Date.parse(value))) {
        return {
          status: "failed",
          metadata: liveMetadata(request.operationKey, []),
          error: invalidRequest(`Expected hold window field ${field} is not a valid timestamp`),
        };
      }
    }
    if (
      request.startAt !== undefined &&
      request.endAt !== undefined &&
      Date.parse(request.startAt) >= Date.parse(request.endAt)
    ) {
      return {
        status: "failed",
        metadata: liveMetadata(request.operationKey, []),
        error: invalidRequest("Expected hold window startAt must precede endAt"),
      };
    }
    // Deterministic linkage guard: Gather-created holds always carry the
    // deterministic event id derived from the original hold operation key.
    // A holdId naming any other event is refused before any HTTP call, so a
    // caller typo can never delete (or falsely "release") someone else's
    // event, and a 404 for a mistyped id can never be mistaken for genuine
    // absence of the intended hold.
    const expectedHoldId = googleEventIdFor(request.originalHoldOperationKey);
    if (request.holdId !== expectedHoldId) {
      return {
        status: "failed",
        metadata: liveMetadata(request.operationKey, []),
        error: { kind: "conflict", message: "holdId does not match the deterministic event id for originalHoldOperationKey; refusing to delete an unverified event", retryable: false },
      };
    }

    // 1. Pre-delete read: verify Gather identity before touching the event.
    let existing: ParsedHoldEvent;
    let etag: string | undefined;
    try {
      const response = await authorized(this.options, {
        method: "GET",
        url: this.eventUrl(request.calendarId, request.holdId),
      });
      if (response.status === 404 || response.status === 410) {
        // Authentic provider attestation of absence: idempotent success.
        return this.released(request, true);
      }
      if (response.status !== 200) {
        const error = mapGoogleHttpError(response.status, safeParseJson(response.text), "releaseProvisionalHold");
        return { status: "failed", metadata: liveMetadata(request.operationKey, []), error };
      }
      const event = parseHoldEvent(safeParseJson(response.text));
      if (event === undefined) {
        return {
          status: "failed",
          metadata: liveMetadata(request.operationKey, []),
          error: transportError("Calendar events.get returned an unrecognized JSON shape; identity cannot be verified so the delete is refused"),
        };
      }
      const identity = this.verifyIdentity(request, event);
      if (identity !== undefined) {
        return { status: "failed", metadata: liveMetadata(request.operationKey, []), error: identity };
      }
      existing = event;
      void existing;
      etag = responseHeader(response.headers, "etag") ?? event.etag;
    } catch (error) {
      if (error instanceof TokenUnavailableError) return tokenFailure(request.operationKey);
      if (error instanceof TransportTimeoutError || error instanceof TransportNetworkError) {
        return {
          status: "failed",
          metadata: liveMetadata(request.operationKey, []),
          error: transportError("Calendar pre-delete read timed out; no delete was attempted so retry is safe"),
        };
      }
      throw error;
    }

    // 2. Conditional silent delete: If-Match pins the exact revision read
    // above, so a concurrently changed event fails with 412 (conflict)
    // instead of being silently removed.
    try {
      const response = await authorized(this.options, {
        method: "DELETE",
        url: withQuery(this.eventUrl(request.calendarId, request.holdId), { sendUpdates: "none" }),
        ...(etag === undefined ? {} : { headers: { "If-Match": etag } }),
      });
      if (response.status === 200 || response.status === 204) {
        return this.confirmAbsence(request, false);
      }
      if (response.status === 404 || response.status === 410) {
        // Deleted concurrently between our read and delete: the provider
        // attests absence, so this is an idempotent success.
        return this.released(request, true);
      }
      if (response.status === 412) {
        return {
          status: "failed",
          metadata: liveMetadata(request.operationKey, []),
          error: { kind: "conflict", message: "The hold changed after the pre-delete read (ETag precondition failed); refusing to delete a changed event", retryable: false },
        };
      }
      if (response.status >= 500 || response.status === 408 || response.status === 425) {
        return ambiguousDelete(request.operationKey, `Calendar delete returned HTTP ${response.status}, which may follow a server-side delete`);
      }
      const error = mapGoogleHttpError(response.status, safeParseJson(response.text), "releaseProvisionalHold");
      return { status: "failed", metadata: liveMetadata(request.operationKey, []), error };
    } catch (error) {
      if (error instanceof TokenUnavailableError) return tokenFailure(request.operationKey);
      if (error instanceof TransportTimeoutError || error instanceof TransportNetworkError) {
        return ambiguousDelete(request.operationKey, "Calendar delete response was lost after dispatch");
      }
      throw error;
    }
  }

  async reconcileReleasedHold(
    request: OperationRequest,
  ): Promise<ConnectorResult<ReleaseProvisionalHoldResponse>> {
    // Only the release operation key arrives here, so hold identity must
    // come from the injected durable resolver — never from volatile adapter
    // memory, which is empty after a restart. Reconcile only re-reads; it
    // never issues a DELETE, so it can never blind-repeat a release.
    const scope = this.options.resolveReleaseScope === undefined
      ? undefined
      : await this.options.resolveReleaseScope(request.operationKey);
    if (scope === undefined) {
      return {
        status: "failed",
        metadata: liveMetadata(request.operationKey, []),
        error: invalidRequest("Cannot reconcile: no durable release-operation-to-scope resolver is configured for this adapter"),
      };
    }
    if (this.bindingViolation(scope.calendarId)) {
      return {
        status: "failed",
        metadata: liveMetadata(request.operationKey, []),
        error: invalidRequest(`Adapter is bound to calendar "${this.options.calendarId}"; reconciled scope names "${scope.calendarId}"`),
      };
    }
    let response: GoogleHttpResponse;
    try {
      response = await authorized(this.options, {
        method: "GET",
        url: this.eventUrl(scope.calendarId, scope.holdId),
      });
    } catch (error) {
      if (error instanceof TokenUnavailableError) return tokenFailure(request.operationKey);
      if (error instanceof TransportTimeoutError || error instanceof TransportNetworkError) {
        return {
          status: "failed",
          metadata: liveMetadata(request.operationKey, []),
          error: transportError("Calendar reconcile read timed out; absence is unverified so the release may be retried with the same release operation key"),
        };
      }
      throw error;
    }
    if (response.status === 404 || response.status === 410) {
      return this.releasedFromScope(request.operationKey, scope, true);
    }
    if (response.status !== 200) {
      const error = mapGoogleHttpError(response.status, safeParseJson(response.text), "reconcileReleasedHold");
      return { status: "failed", metadata: liveMetadata(request.operationKey, []), error };
    }
    const event = parseHoldEvent(safeParseJson(response.text));
    if (event === undefined) {
      return {
        status: "failed",
        metadata: liveMetadata(request.operationKey, []),
        error: transportError("Calendar events.get returned an unrecognized JSON shape; absence cannot be verified"),
      };
    }
    if (event.status === "cancelled") {
      return this.releasedFromScope(request.operationKey, scope, true);
    }
    // The event is still present: the release did not complete. Identity is
    // still checked so a stranger event is never mistaken for our hold.
    const identity = this.verifyScopeIdentity(scope, event);
    if (identity !== undefined) {
      return { status: "failed", metadata: liveMetadata(request.operationKey, []), error: identity };
    }
    return {
      status: "failed",
      metadata: liveMetadata(request.operationKey, []),
      error: { kind: "conflict", message: "The hold is still present; the release did not complete. It is safe to retry releaseProvisionalHold with the same release operationKey (re-read first, never blind-repeat)", retryable: false },
    };
  }

  /**
   * Verify the pre-delete read is exactly our hold: response id equals the
   * requested holdId (by construction of the GET URL, re-asserted here),
   * the event is not cancelled, the stored operation-key linkage is present
   * and equals the original hold key (absent metadata is never a pass), the
   * booking matches, and — when the caller supplies the expected window —
   * the exact start, end, and expiry match. Anything else is conflict and
   * the delete is refused.
   */
  private verifyIdentity(
    request: ReleaseProvisionalHoldRequest,
    event: ParsedHoldEvent,
  ): { kind: "conflict"; message: string; retryable: false } | undefined {
    return this.verifyScopeIdentity(
      {
        calendarId: request.calendarId,
        holdId: request.holdId,
        bookingId: request.bookingId,
        originalHoldOperationKey: request.originalHoldOperationKey,
        ...(request.startAt === undefined ? {} : { startAt: request.startAt }),
        ...(request.endAt === undefined ? {} : { endAt: request.endAt }),
        ...(request.expiresAt === undefined ? {} : { expiresAt: request.expiresAt }),
      },
      event,
    );
  }

  private verifyScopeIdentity(
    scope: ReleaseScope,
    event: ParsedHoldEvent,
  ): { kind: "conflict"; message: string; retryable: false } | undefined {
    if (event.id !== scope.holdId) {
      return { kind: "conflict", message: "Provider returned a different event id than requested; cannot verify identity", retryable: false };
    }
    if (event.status === "cancelled") {
      return { kind: "conflict", message: "The event is already cancelled; it cannot be verified as the live hold", retryable: false };
    }
    if (event.operationKey === undefined || event.operationKey !== scope.originalHoldOperationKey) {
      return { kind: "conflict", message: "The event carries no verifiable linkage to the original hold operation key; refusing to release a stranger event", retryable: false };
    }
    if (event.bookingId !== scope.bookingId) {
      return { kind: "conflict", message: "The event belongs to a different booking (or its booking linkage is missing); refusing to release", retryable: false };
    }
    if (scope.startAt !== undefined && event.startMs !== Date.parse(scope.startAt)) {
      return { kind: "conflict", message: "The event starts at a different time than expected (or its start is missing); refusing to release a changed hold", retryable: false };
    }
    if (scope.endAt !== undefined && event.endMs !== Date.parse(scope.endAt)) {
      return { kind: "conflict", message: "The event ends at a different time than expected (or its end is missing); refusing to release a changed hold", retryable: false };
    }
    if (scope.expiresAt !== undefined && event.expiresAt !== scope.expiresAt) {
      return { kind: "conflict", message: "The event carries a different expiry than expected (or its expiry is missing); refusing to release a changed hold", retryable: false };
    }
    return undefined;
  }

  /**
   * Post-delete absence confirmation: a DELETE success is not trusted on
   * its own. A follow-up GET must attest 404/410 before success is
   * reported. A surviving event means the delete did not take
   * (retryable transport failure); a lost confirmation read means the
   * outcome is uncertain (reconcile, never blind-repeat).
   */
  private async confirmAbsence(
    request: ReleaseProvisionalHoldRequest,
    alreadyReleased: false,
  ): Promise<ConnectorResult<ReleaseProvisionalHoldResponse>> {
    let response: GoogleHttpResponse;
    try {
      response = await authorized(this.options, {
        method: "GET",
        url: this.eventUrl(request.calendarId, request.holdId),
      });
    } catch (error) {
      if (error instanceof TokenUnavailableError) return tokenFailure(request.operationKey);
      if (error instanceof TransportTimeoutError || error instanceof TransportNetworkError) {
        return ambiguousDelete(request.operationKey, "Calendar post-delete confirmation read was lost after a successful delete");
      }
      throw error;
    }
    if (response.status === 404 || response.status === 410) {
      return this.released(request, alreadyReleased);
    }
    if (response.status === 200) {
      const event = parseHoldEvent(safeParseJson(response.text));
      if (event !== undefined && event.status === "cancelled") {
        return this.released(request, alreadyReleased);
      }
      return {
        status: "failed",
        metadata: liveMetadata(request.operationKey, []),
        error: transportError("Calendar delete reported success but the event is still present; the release may be retried with the same release operation key"),
      };
    }
    const error = mapGoogleHttpError(response.status, safeParseJson(response.text), "releaseProvisionalHold");
    return { status: "failed", metadata: liveMetadata(request.operationKey, []), error };
  }

  private released(
    request: ReleaseProvisionalHoldRequest,
    alreadyReleased: boolean,
  ): ConnectorResult<ReleaseProvisionalHoldResponse> {
    const provenance = [this.releaseSource(request.calendarId, request.holdId, request.operationKey)];
    return {
      status: "succeeded",
      metadata: liveMetadata(request.operationKey, provenance),
      data: {
        released: {
          holdId: request.holdId,
          operationKey: request.operationKey,
          originalHoldOperationKey: request.originalHoldOperationKey,
          bookingId: request.bookingId,
          calendarId: request.calendarId,
          status: "released",
          alreadyReleased,
          releasedAt: new Date().toISOString(),
          sourceReferences: provenance,
        },
        provenance,
      },
    };
  }

  private releasedFromScope(
    releaseOperationKey: string,
    scope: ReleaseScope,
    alreadyReleased: boolean,
  ): ConnectorResult<ReleaseProvisionalHoldResponse> {
    const provenance = [this.releaseSource(scope.calendarId, scope.holdId, releaseOperationKey)];
    return {
      status: "succeeded",
      metadata: liveMetadata(releaseOperationKey, provenance),
      data: {
        released: {
          holdId: scope.holdId,
          operationKey: releaseOperationKey,
          originalHoldOperationKey: scope.originalHoldOperationKey,
          bookingId: scope.bookingId,
          calendarId: scope.calendarId,
          status: "released",
          alreadyReleased,
          releasedAt: new Date().toISOString(),
          sourceReferences: provenance,
        },
        provenance,
      },
    };
  }
}
