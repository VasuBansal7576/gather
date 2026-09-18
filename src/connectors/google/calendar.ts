import { createHash } from "node:crypto";
import type {
  CalendarAvailabilityReader,
  CalendarSlot,
  CheckAvailabilityRequest,
  CheckAvailabilityResponse,
  ConnectorResult,
  CreateProvisionalHoldRequest,
  CreateProvisionalHoldResponse,
  ProvisionalHold,
  ProvisionalHoldWriter,
  SourceReference,
} from "../contracts.ts";
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

/** C11 calendar operations intentionally avoid the broad `calendar` scope. */
export const GOOGLE_CALENDAR_SCOPE_CAPABILITIES = Object.freeze({
  freeBusy: "https://www.googleapis.com/auth/calendar.freebusy",
  events: "https://www.googleapis.com/auth/calendar.events",
} as const);

const EXT_KEY = "gatherOperationKey";
const EXT_BOOKING = "gatherBookingId";
const EXT_EXPIRES = "gatherExpiresAt";

/**
 * Restart-stable operation-to-scope lookup, backed by durable storage owned
 * by the caller (e.g. the booking service's SQLite receipts). Volatile maps
 * are never sufficient: after a restart the in-memory world is empty while
 * the provider still holds the event.
 */
export interface HoldScope {
  calendarId: string;
  bookingId?: string;
  startAt?: string;
  endAt?: string;
  expiresAt?: string;
}

export type HoldScopeResolver = (operationKey: string) => Promise<HoldScope | undefined>;

export interface GoogleCalendarOptions extends GoogleAdapterOptions {
  /**
   * Explicit calendar binding: availability and holds are scoped to this
   * calendar, and reconcileProvisionalHold resolves its scope from it.
   * Preferred when the adapter serves one calendar.
   */
  calendarId?: string;
  /** Durable operationKey → scope lookup used when no explicit binding exists. */
  resolveHoldScope?: HoldScopeResolver;
}

/**
 * Derive a deterministic Calendar event id from the stable operation key.
 * Verified mapping: Calendar event ids accept base32hex (a-v, 0-9), 5–1024
 * chars, unique per calendar. Lowercase hex is a subset of base32hex, so a
 * `g`-prefixed sha256 slice is always valid. Re-inserting the same id after
 * a timeout returns HTTP 409 instead of a duplicate event, which is the
 * reconciliation anchor for timeout-after-acceptance.
 */
export function googleEventIdFor(operationKey: string): string {
  return `g${createHash("sha256").update(operationKey).digest("hex").slice(0, 31)}`;
}

interface ParsedGoogleEvent {
  id: string;
  summary?: string;
  status?: string;
  transparency?: string;
  startMs?: number;
  endMs?: number;
  htmlLink?: string;
  updated?: string;
  created?: string;
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
  // All-day `date` (YYYY-MM-DD): interpret as the UTC day boundary.
  const date = asString(value.date);
  if (date !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const ms = Date.parse(`${date}T00:00:00.000Z`);
    return Number.isFinite(ms) ? ms : undefined;
  }
  return undefined;
}

function parseGoogleEvent(value: unknown): ParsedGoogleEvent | undefined {
  if (!isRecord(value)) return undefined;
  const id = asString(value.id);
  if (id === undefined) return undefined;
  const event: ParsedGoogleEvent = { id };
  const summary = asString(value.summary);
  const status = asString(value.status);
  const transparency = asString(value.transparency);
  const htmlLink = asString(value.htmlLink);
  const updated = asString(value.updated);
  const created = asString(value.created);
  if (summary !== undefined) event.summary = summary;
  if (status !== undefined) event.status = status;
  if (transparency !== undefined) event.transparency = transparency;
  if (htmlLink !== undefined) event.htmlLink = htmlLink;
  if (updated !== undefined) event.updated = updated;
  if (created !== undefined) event.created = created;
  const startMs = parseEventTime(value.start);
  if (startMs !== undefined) event.startMs = startMs;
  // All-day end dates are exclusive in RFC5545; dateTime ends are exact.
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

interface FreeBusyWindow {
  startMs: number;
  endMs: number;
}

function parseFreeBusy(body: unknown, calendarId: string): { busy: FreeBusyWindow[] } | { calendarError: string } | undefined {
  if (!isRecord(body)) return undefined;
  const calendars = body.calendars;
  if (!isRecord(calendars)) return undefined;
  const entry = calendars[calendarId];
  if (!isRecord(entry)) return undefined;
  const errors = entry.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const reasons: string[] = [];
    for (const item of errors) {
      if (!isRecord(item)) return undefined;
      const reason = asString(item.reason);
      if (reason === undefined) return undefined;
      reasons.push(reason);
    }
    return { calendarError: reasons.join(",") };
  }
  const busyRaw = entry.busy;
  if (busyRaw !== undefined && !Array.isArray(busyRaw)) return undefined;
  const busy: FreeBusyWindow[] = [];
  for (const item of busyRaw ?? []) {
    if (!isRecord(item)) return undefined;
    const start = asString(item.start);
    const end = asString(item.end);
    // Fail closed: a busy window without exact instants cannot authorize
    // a free verdict.
    if (start === undefined || end === undefined) return undefined;
    const startMs = Date.parse(start);
    const endMs = Date.parse(end);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) return undefined;
    busy.push({ startMs, endMs });
  }
  return { busy };
}

function slotIdFor(calendarId: string, startMs: number, endMs: number, kind: string): string {
  const digest = createHash("sha256").update(`${calendarId}|${startMs}|${endMs}|${kind}`).digest("hex").slice(0, 12);
  return `live-slot-${digest}`;
}

function tokenFailure(operationKey: string): ConnectorResult<never> {
  return {
    status: "failed",
    metadata: liveMetadata(operationKey, []),
    error: { kind: "access_revoked", message: "No approved Google access token is available (live gate BLOCKED until onboarding provides account assets)", retryable: false },
  };
}

/**
 * Write-path ambiguity: HTTP 5xx, 408/425, timeouts, and network failures
 * after dispatch may all follow a server-side accept, so mutating calls
 * report `uncertain` (reconcile by deterministic id) instead of a retryable
 * failure that could duplicate the event on blind retry.
 */
function ambiguousWrite(operationKey: string, detail: string): ConnectorResult<never> {
  return {
    status: "uncertain",
    metadata: liveMetadata(operationKey, []),
    error: { kind: "timeout_after_success", message: `${detail}; reconcile the deterministic event id before retrying`, retryable: false },
    reconciliationRequired: true,
  };
}

export class GoogleCalendarConnector implements CalendarAvailabilityReader, ProvisionalHoldWriter {
  private readonly options: GoogleCalendarOptions;

  constructor(options: GoogleCalendarOptions) {
    this.options = options;
  }

  private calendarSource(calendarId: string, window: string): SourceReference {
    return {
      kind: "calendar",
      locator: `google-calendar://${calendarId}/events?${window}`,
      label: "LIVE Google Calendar",
      fictional: false,
    };
  }

  /** Resolve the owning calendar for an operation key (binding first, then durable resolver). */
  private async resolveScope(operationKey: string): Promise<HoldScope | undefined> {
    if (this.options.calendarId !== undefined && this.options.calendarId.trim().length > 0) {
      return { calendarId: this.options.calendarId };
    }
    if (this.options.resolveHoldScope !== undefined) {
      return this.options.resolveHoldScope(operationKey);
    }
    return undefined;
  }

  /**
   * Enforce an explicit calendar binding: a bound adapter serves exactly one
   * calendar and must reject any request naming another. Without this, a
   * caller could probe or write calendar B through an adapter bound to A.
   */
  private bindingViolation(calendarId: string): boolean {
    return this.options.calendarId !== undefined && this.options.calendarId !== calendarId;
  }

  async checkAvailability(request: CheckAvailabilityRequest): Promise<ConnectorResult<CheckAvailabilityResponse>> {
    if (request.operationKey.trim().length === 0 || request.calendarId.trim().length === 0) {
      return {
        status: "failed",
        metadata: liveMetadata(request.operationKey, []),
        error: invalidRequest("operationKey and calendarId are required"),
      };
    }
    const startMs = Date.parse(request.startAt);
    const endMs = Date.parse(request.endAt);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) {
      return {
        status: "failed",
        metadata: liveMetadata(request.operationKey, []),
        error: invalidRequest("A valid startAt/endAt range is required"),
      };
    }
    if (this.bindingViolation(request.calendarId)) {
      return {
        status: "failed",
        metadata: liveMetadata(request.operationKey, []),
        error: invalidRequest(`Adapter is bound to calendar "${this.options.calendarId}"; request names "${request.calendarId}"`),
      };
    }
    // Fresh, calendar-scoped availability via freeBusy.query: the server
    // returns busy instants (all-day dates resolved in the calendar's own
    // timezone, DST included), so the adapter performs no timezone math and
    // needs no event pagination. Per-calendar errors are surfaced, not
    // swallowed; malformed busy windows fail the whole check closed.
    let busy: FreeBusyWindow[];
    try {
      const response = await authorized(this.options, {
        method: "POST",
        url: `${CALENDAR_BASE_URL}/freeBusy`,
        body: JSON.stringify({
          timeMin: request.startAt,
          timeMax: request.endAt,
          timeZone: "UTC",
          items: [{ id: request.calendarId }],
        }),
      });
      if (response.status !== 200) {
        const error = mapGoogleHttpError(response.status, safeParseJson(response.text), "checkAvailability");
        return { status: "failed", metadata: liveMetadata(request.operationKey, []), error };
      }
      const parsed = parseFreeBusy(safeParseJson(response.text), request.calendarId);
      if (parsed === undefined) {
        return {
          status: "failed",
          metadata: liveMetadata(request.operationKey, []),
          error: transportError("Calendar freeBusy returned an unrecognized JSON shape; availability cannot be verified"),
        };
      }
      if ("calendarError" in parsed) {
        if (parsed.calendarError.includes("notFound")) {
          return {
            status: "failed",
            metadata: liveMetadata(request.operationKey, []),
            error: { kind: "invalid_request", message: `Calendar "${request.calendarId}" was not found or is not visible`, retryable: false },
          };
        }
        return {
          status: "failed",
          metadata: liveMetadata(request.operationKey, []),
          error: transportError(`Calendar freeBusy reported calendar errors: ${parsed.calendarError}`),
        };
      }
      busy = parsed.busy
        .map((window) => ({ startMs: Math.max(window.startMs, startMs), endMs: Math.min(window.endMs, endMs) }))
        .filter((window) => window.startMs < window.endMs);
    } catch (error) {
      if (error instanceof TokenUnavailableError) return tokenFailure(request.operationKey);
      if (error instanceof TransportTimeoutError || error instanceof TransportNetworkError) {
        return {
          status: "failed",
          metadata: liveMetadata(request.operationKey, []),
          error: transportError("Calendar availability read timed out; no write was attempted so retry is safe"),
        };
      }
      throw error;
    }
    busy.sort((left, right) => left.startMs - right.startMs);
    const merged: FreeBusyWindow[] = [];
    for (const interval of busy) {
      const last = merged[merged.length - 1];
      if (last !== undefined && interval.startMs <= last.endMs) {
        last.endMs = Math.max(last.endMs, interval.endMs);
      } else {
        merged.push({ ...interval });
      }
    }
    const provenance = [this.calendarSource(request.calendarId, `timeMin=${request.startAt}&timeMax=${request.endAt}`)];
    const slots: CalendarSlot[] = [];
    let cursor = startMs;
    for (const interval of merged) {
      if (interval.startMs > cursor) {
        slots.push({
          slotId: slotIdFor(request.calendarId, cursor, interval.startMs, "free"),
          calendarId: request.calendarId,
          startAt: new Date(cursor).toISOString(),
          endAt: new Date(interval.startMs).toISOString(),
          available: true,
          sourceReferences: provenance,
        });
      }
      slots.push({
        slotId: slotIdFor(request.calendarId, interval.startMs, interval.endMs, "busy"),
        calendarId: request.calendarId,
        startAt: new Date(interval.startMs).toISOString(),
        endAt: new Date(interval.endMs).toISOString(),
        available: false,
        reason: "Blocked by a live calendar event",
        sourceReferences: provenance,
      });
      cursor = Math.max(cursor, interval.endMs);
    }
    if (cursor < endMs) {
      slots.push({
        slotId: slotIdFor(request.calendarId, cursor, endMs, "free"),
        calendarId: request.calendarId,
        startAt: new Date(cursor).toISOString(),
        endAt: new Date(endMs).toISOString(),
        available: true,
        sourceReferences: provenance,
      });
    }
    return {
      status: "succeeded",
      metadata: liveMetadata(request.operationKey, provenance),
      data: { slots, provenance },
    };
  }

  async createProvisionalHold(request: CreateProvisionalHoldRequest): Promise<ConnectorResult<CreateProvisionalHoldResponse>> {
    if (request.operationKey.trim().length === 0 || request.bookingId.trim().length === 0 || request.calendarId.trim().length === 0) {
      return {
        status: "failed",
        metadata: liveMetadata(request.operationKey, []),
        error: invalidRequest("operationKey, bookingId, and calendarId are required"),
      };
    }
    if (this.bindingViolation(request.calendarId)) {
      return {
        status: "failed",
        metadata: liveMetadata(request.operationKey, []),
        error: invalidRequest(`Adapter is bound to calendar "${this.options.calendarId}"; request names "${request.calendarId}"`),
      };
    }
    const startMs = Date.parse(request.startAt);
    const endMs = Date.parse(request.endAt);
    const expiresMs = Date.parse(request.expiresAt);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs || !Number.isFinite(expiresMs)) {
      return {
        status: "failed",
        metadata: liveMetadata(request.operationKey, []),
        error: invalidRequest("A valid startAt/endAt range and expiresAt are required"),
      };
    }
    const eventId = googleEventIdFor(request.operationKey);
    const body = JSON.stringify({
      id: eventId,
      summary: `Gather provisional hold — ${request.bookingId}`,
      description: `Provisional hold created by Gather. This is NOT a confirmed booking. Operation ${request.operationKey}.`,
      start: { dateTime: request.startAt },
      end: { dateTime: request.endAt },
      transparency: "opaque",
      extendedProperties: {
        private: {
          [EXT_KEY]: request.operationKey,
          [EXT_BOOKING]: request.bookingId,
          [EXT_EXPIRES]: request.expiresAt,
        },
      },
    });
    let response: GoogleHttpResponse;
    try {
      response = await authorized(this.options, {
        method: "POST",
        url: withQuery(`${CALENDAR_BASE_URL}/calendars/${encodeURIComponent(request.calendarId)}/events`, { sendUpdates: "none" }),
        body,
      });
    } catch (error) {
      if (error instanceof TokenUnavailableError) return tokenFailure(request.operationKey);
      if (error instanceof TransportTimeoutError || error instanceof TransportNetworkError) {
        return ambiguousWrite(request.operationKey, "Calendar insert response was lost after dispatch");
      }
      throw error;
    }
    if (response.status === 200 || response.status === 201) {
      return this.holdSuccess(request, parseGoogleEvent(safeParseJson(response.text)));
    }
    if (response.status === 409) {
      // Deterministic id replay: verify the existing event matches the exact
      // calendar, booking, approved window, and expiry before reusing it.
      return this.fetchAndVerify(request.calendarId, request.operationKey, {
        bookingId: request.bookingId,
        startAt: request.startAt,
        endAt: request.endAt,
        expiresAt: request.expiresAt,
      });
    }
    if (response.status >= 500 || response.status === 408 || response.status === 425) {
      return ambiguousWrite(request.operationKey, `Calendar insert returned HTTP ${response.status}, which may follow a server-side accept`);
    }
    const error = mapGoogleHttpError(response.status, safeParseJson(response.text), "createProvisionalHold");
    if (error.kind === "not_found") {
      return {
        status: "failed",
        metadata: liveMetadata(request.operationKey, []),
        error: { kind: "invalid_request", message: "Target calendar was not found or is not writable", retryable: false },
      };
    }
    return { status: "failed", metadata: liveMetadata(request.operationKey, []), error };
  }

  async reconcileProvisionalHold(request: { operationKey: string }): Promise<ConnectorResult<CreateProvisionalHoldResponse>> {
    // Only the operation key arrives here, so the owning calendar must come
    // from the explicit binding or the injected durable resolver — never
    // from volatile adapter memory, which is empty after a restart.
    const scope = await this.resolveScope(request.operationKey);
    if (scope === undefined) {
      return {
        status: "failed",
        metadata: liveMetadata(request.operationKey, []),
        error: invalidRequest("Cannot reconcile: no calendar binding or durable operation-to-calendar resolver is configured for this adapter"),
      };
    }
    return this.fetchAndVerify(scope.calendarId, request.operationKey, scope);
  }

  /**
   * Fetch the deterministic event and verify it is exactly ours. Every
   * check below must pass: the event id equals the deterministic id (by
   * construction of the GET URL, re-asserted on the response), the stored
   * operation-key linkage is present and equal (absent metadata is NOT a
   * pass), the event is not cancelled, and — when the durable resolver
   * supplies the approved payload — booking, exact window, and expiry all
   * match. Anything else is conflict, never a coerced success with blank
   * booking/dates/expiry.
   */
  private async fetchAndVerify(
    calendarId: string,
    operationKey: string,
    expected: { bookingId?: string; startAt?: string; endAt?: string; expiresAt?: string },
  ): Promise<ConnectorResult<CreateProvisionalHoldResponse>> {
    const eventId = googleEventIdFor(operationKey);
    let response: GoogleHttpResponse;
    try {
      response = await authorized(this.options, {
        method: "GET",
        url: `${CALENDAR_BASE_URL}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      });
    } catch (error) {
      if (error instanceof TokenUnavailableError) return tokenFailure(operationKey);
      if (error instanceof TransportTimeoutError || error instanceof TransportNetworkError) {
        return {
          status: "failed",
          metadata: liveMetadata(operationKey, []),
          error: transportError("Calendar reconcile read timed out; the record may appear on retry"),
        };
      }
      throw error;
    }
    if (response.status === 200) {
      const event = parseGoogleEvent(safeParseJson(response.text));
      if (event === undefined) {
        return {
          status: "failed",
          metadata: liveMetadata(operationKey, []),
          error: transportError("Calendar events.get returned an unrecognized JSON shape"),
        };
      }
      if (event.status === "cancelled") {
        return {
          status: "failed",
          metadata: liveMetadata(operationKey, []),
          error: { kind: "not_found", message: "The reconciled event was cancelled; no live hold exists", retryable: false },
        };
      }
      if (event.id !== eventId) {
        return {
          status: "failed",
          metadata: liveMetadata(operationKey, []),
          error: { kind: "conflict", message: "Provider returned a different event id than the deterministic one", retryable: false },
        };
      }
      if (event.operationKey === undefined || event.operationKey !== operationKey) {
        return {
          status: "failed",
          metadata: liveMetadata(operationKey, []),
          error: { kind: "conflict", message: "The event carries no verifiable linkage to this operation key; cannot verify identity", retryable: false },
        };
      }
      if (expected.bookingId !== undefined && event.bookingId !== expected.bookingId) {
        return {
          status: "failed",
          metadata: liveMetadata(operationKey, []),
          error: { kind: "conflict", message: "The existing event belongs to a different booking (or its booking linkage is missing)", retryable: false },
        };
      }
      if (expected.startAt !== undefined && event.startMs !== Date.parse(expected.startAt)) {
        return {
          status: "failed",
          metadata: liveMetadata(operationKey, []),
          error: { kind: "conflict", message: "The existing event starts at a different time than approved (or its start is missing)", retryable: false },
        };
      }
      if (expected.endAt !== undefined && event.endMs !== Date.parse(expected.endAt)) {
        return {
          status: "failed",
          metadata: liveMetadata(operationKey, []),
          error: { kind: "conflict", message: "The existing event ends at a different time than approved (or its end is missing)", retryable: false },
        };
      }
      if (expected.expiresAt !== undefined && event.expiresAt !== expected.expiresAt) {
        return {
          status: "failed",
          metadata: liveMetadata(operationKey, []),
          error: { kind: "conflict", message: "The existing event carries a different expiry than approved (or its expiry is missing)", retryable: false },
        };
      }
      const hold = this.toHold(operationKey, calendarId, event, undefined);
      if (hold === undefined) {
        return {
          status: "failed",
          metadata: liveMetadata(operationKey, []),
          error: transportError("The verified event is missing required hold fields; provider evidence is incomplete"),
        };
      }
      const provenance = [this.calendarSource(calendarId, `eventId=${eventId}`)];
      return { status: "succeeded", metadata: liveMetadata(operationKey, provenance), data: { hold, provenance } };
    }
    const error = mapGoogleHttpError(response.status, safeParseJson(response.text), "reconcileProvisionalHold");
    return { status: "failed", metadata: liveMetadata(operationKey, []), error };
  }

  private holdSuccess(
    request: CreateProvisionalHoldRequest,
    event: ParsedGoogleEvent | undefined,
  ): ConnectorResult<CreateProvisionalHoldResponse> {
    const hold = event !== undefined ? this.toHold(request.operationKey, request.calendarId, event, request.expiresAt) : undefined;
    if (event === undefined || hold === undefined) {
      // A 200/201 without usable event fields is ambiguous, not a success:
      // the write may exist server-side, so report uncertain, never a
      // blind-retryable failure.
      return {
        status: "uncertain",
        metadata: liveMetadata(request.operationKey, []),
        error: { kind: "timeout_after_success", message: "Calendar insert succeeded but returned unusable event fields; reconcile the deterministic event id before retrying", retryable: false },
        reconciliationRequired: true,
      };
    }
    const provenance = [this.calendarSource(request.calendarId, `eventId=${event.id}`)];
    return { status: "succeeded", metadata: liveMetadata(request.operationKey, provenance), data: { hold, provenance } };
  }

  /**
   * Build provider evidence into a hold receipt. Returns undefined when any
   * required field is absent: blanks and local-time coercion are never
   * substituted for provider evidence.
   */
  private toHold(operationKey: string, calendarId: string, event: ParsedGoogleEvent, expiresAt: string | undefined): ProvisionalHold | undefined {
    if (event.bookingId === undefined || event.startMs === undefined || event.endMs === undefined) return undefined;
    const resolvedExpiry = event.expiresAt ?? expiresAt;
    const createdAt = event.created ?? event.updated;
    if (resolvedExpiry === undefined || createdAt === undefined) return undefined;
    return {
      holdId: event.id,
      operationKey,
      bookingId: event.bookingId,
      calendarId,
      startAt: new Date(event.startMs).toISOString(),
      endAt: new Date(event.endMs).toISOString(),
      expiresAt: resolvedExpiry,
      status: "provisional_hold",
      createdAt,
      sourceReferences: [this.calendarSource(calendarId, `eventId=${event.id}`)],
    };
  }
}
