import type { ConnectionService } from "../connections/service.ts";
import type { GatherStore } from "../sqlite-store.ts";
import { ValidationError } from "../validation.ts";

/**
 * Scoped owner calendar choice for the holds path. The owner names a
 * calendar (an opaque id they copy from their own Google calendar); the
 * server pins it to exactly one verified connected calendar account of
 * that business. No technical mappings (account ids, bindings) are ever
 * exposed: responses name only the business, the calendar id, and the
 * account display name. Ambiguous or missing calendar accounts fail with
 * an owner-actionable code instead of guessing, and use-time resolution
 * (provider-runtime `resolveBoundCalendar`) re-verifies business, owner,
 * and pinned-account liveness on every call — a stale binding fails
 * closed, never an arbitrary model-chosen calendar.
 */

export class CalendarBindError extends Error {
  readonly code: "CALENDAR_ACCOUNT_MISSING" | "CALENDAR_ACCOUNT_AMBIGUOUS";
  readonly retryable = false;
  constructor(code: CalendarBindError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export interface CalendarBindingView {
  businessId: string;
  calendarId: string;
  accountDisplayName: string;
  bound: true;
}

function requireCalendarId(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 200) {
    throw new ValidationError("calendarId must be a non-empty string (at most 200 characters)");
  }
  return value.trim();
}

/** Owner-pinned calendar binding for one business (upsert, owner-scoped). */
export function bindBusinessCalendar(input: {
  store: GatherStore;
  connectionService: ConnectionService;
  ownerId: string;
  businessId: string;
  calendarId: string;
  now?: () => string;
}): CalendarBindingView {
  const business = input.store.getBusiness(input.businessId);
  const calendarId = requireCalendarId(input.calendarId);
  const summary = input.connectionService.getConnections(business.id);
  const google = summary.providers.find((provider) => provider.provider === "google");
  const candidates = (google?.accounts ?? []).filter(
    (account) => account.provider === "google_calendar" && account.status === "connected",
  );
  if (candidates.length === 0) {
    throw new CalendarBindError(
      "CALENDAR_ACCOUNT_MISSING",
      "No connected Google calendar account for this business; connect one before choosing a calendar",
    );
  }
  if (candidates.length > 1) {
    throw new CalendarBindError(
      "CALENDAR_ACCOUNT_AMBIGUOUS",
      "Several calendar accounts are connected; keep exactly one connected calendar account before choosing a calendar",
    );
  }
  const account = candidates[0]!;
  const at = input.now ? input.now() : new Date().toISOString();
  input.store.db
    .prepare(
      `INSERT INTO provider_calendar_bindings (calendar_id, business_id, owner_id, connection_account_id, created_at)
       VALUES ($calendar, $business, $owner, $account, $at)
       ON CONFLICT (calendar_id) DO UPDATE SET
         business_id = excluded.business_id, owner_id = excluded.owner_id,
         connection_account_id = excluded.connection_account_id, created_at = excluded.created_at`,
    )
    .run({ $calendar: calendarId, $business: business.id, $owner: input.ownerId, $account: account.id, $at: at });
  return { businessId: business.id, calendarId, accountDisplayName: account.displayName, bound: true };
}

/** Current binding view for a business, without technical mappings. */
export function getBusinessCalendar(input: {
  store: GatherStore;
  connectionService: ConnectionService;
  businessId: string;
}): CalendarBindingView | undefined {
  const business = input.store.getBusiness(input.businessId);
  const row = input.store.db
    .prepare("SELECT calendar_id, connection_account_id FROM provider_calendar_bindings WHERE business_id = $b ORDER BY created_at DESC LIMIT 1")
    .get({ $b: business.id }) as { calendar_id: string; connection_account_id: string } | undefined;
  if (!row) return undefined;
  let displayName = "(connected calendar account)";
  try {
    const summary = input.connectionService.getConnections(business.id);
    for (const provider of summary.providers) {
      const found = provider.accounts.find((account) => account.id === String(row.connection_account_id));
      if (found) {
        displayName = found.displayName;
        break;
      }
    }
  } catch {
    displayName = "(connected calendar account)";
  }
  return { businessId: business.id, calendarId: String(row.calendar_id), accountDisplayName: displayName, bound: true };
}
