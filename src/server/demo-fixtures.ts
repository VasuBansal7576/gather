import type { CalendarSlot } from "../connectors/contracts.ts";
import type { SourceReference } from "../domain/contracts.ts";
import type { GatherStore } from "./sqlite-store.ts";

export const DEMO_BUSINESS_ID = "demo-business-001";
export const DEMO_CALENDAR_ID = "demo-calendar-001";
export const DEMO_GMAIL_ACCOUNT_ID = "demo-account-gmail-001";
export const DEMO_CALENDAR_ACCOUNT_ID = "demo-account-calendar-001";

const FIXTURE_SOURCE: SourceReference = {
  kind: "fixture",
  locator: "demo://gather/booking-fixtures",
  label: "DEMO ONLY fictional fixture",
  fictional: true,
};

function fixtureExists<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

export interface DemoFixtureSummary {
  businessId: string;
  bookingIds: string[];
  proposalIds: string[];
}

/**
 * Durably seed explicitly fictional demo records into SQLite. Idempotent:
 * fixed IDs are reused when they already exist. Every record carries
 * fictional fixture source references and must be rendered as DEMO ONLY.
 */
export function seedDemoFixtures(store: GatherStore): DemoFixtureSummary {
  if (!fixtureExists(() => store.getBusiness(DEMO_BUSINESS_ID))) {
    store.createBusiness({ id: DEMO_BUSINESS_ID, name: "Fictional Glasshouse (DEMO ONLY)", timezone: "America/New_York" });
  }

  store.upsertConnectedAccount({
    id: DEMO_GMAIL_ACCOUNT_ID,
    businessId: DEMO_BUSINESS_ID,
    provider: "gmail",
    displayName: "DEMO ONLY fictional Gmail",
    status: "connected",
  });
  store.upsertConnectedAccount({
    id: DEMO_CALENDAR_ACCOUNT_ID,
    businessId: DEMO_BUSINESS_ID,
    provider: "google_calendar",
    displayName: "DEMO ONLY fictional Calendar",
    status: "connected",
  });

  const specs = [
    {
      bookingId: "demo-booking-clara-01",
      eventName: "Fictional wedding dinner (DEMO ONLY)",
      startAt: "2026-10-18T18:30:00.000Z",
      endAt: "2026-10-18T23:00:00.000Z",
      guestCount: 84,
      notes: "DEMO ONLY fictional inquiry derived from a simulated thread.",
      actionId: "demo-proposal-clara-v1",
      calendarId: DEMO_CALENDAR_ID,
      emailTo: ["clara-guest@example.test"],
      emailSubject: "DEMO ONLY: your Glasshouse dinner proposal",
      emailBody: "DEMO ONLY simulated offer for the fictional wedding dinner on 2026-10-18.",
    },
    {
      bookingId: "demo-booking-maya-02",
      eventName: "Fictional product launch (DEMO ONLY)",
      startAt: "2026-10-23T17:00:00.000Z",
      endAt: "2026-10-23T21:30:00.000Z",
      guestCount: 56,
      notes: "DEMO ONLY fictional inquiry derived from a simulated thread.",
      actionId: "demo-proposal-maya-v1",
      calendarId: DEMO_CALENDAR_ID,
      emailTo: ["maya-guest@example.test"],
      emailSubject: "DEMO ONLY: your Glasshouse launch proposal",
      emailBody: "DEMO ONLY simulated offer for the fictional product launch on 2026-10-23.",
    },
  ];

  const bookingIds: string[] = [];
  const proposalIds: string[] = [];
  for (const spec of specs) {
    if (!fixtureExists(() => store.getBooking(spec.bookingId))) {
      store.createBooking({
        id: spec.bookingId,
        businessId: DEMO_BUSINESS_ID,
        eventName: spec.eventName,
        status: "pending_approval",
        startAt: spec.startAt,
        endAt: spec.endAt,
        guestCount: spec.guestCount,
        notes: spec.notes,
        sourceReferences: [FIXTURE_SOURCE],
      });
    }
    bookingIds.push(spec.bookingId);
    if (!fixtureExists(() => store.getProposedAction(spec.actionId))) {
      store.createProposedAction({
        id: spec.actionId,
        bookingId: spec.bookingId,
        kind: "create_provisional_hold",
        payload: {
          startAt: spec.startAt,
          endAt: spec.endAt,
          expiresAt: new Date(Date.parse(spec.endAt) + 24 * 3600 * 1000).toISOString(),
          calendarId: spec.calendarId,
          emailTo: spec.emailTo,
          emailSubject: spec.emailSubject,
          emailBody: spec.emailBody,
        },
        sourceReferences: [FIXTURE_SOURCE],
      });
    }
    proposalIds.push(spec.actionId);
  }
  return { businessId: DEMO_BUSINESS_ID, bookingIds, proposalIds };
}

/** Calendar slots covering the fixture ranges for the in-memory demo adapter. */
export function demoFixtureSlots(): CalendarSlot[] {
  const source: SourceReference = { ...FIXTURE_SOURCE };
  return [
    {
      slotId: "demo-slot-2026-10-18",
      startAt: "2026-10-18T00:00:00.000Z",
      endAt: "2026-10-19T00:00:00.000Z",
      available: true,
      sourceReferences: [source],
    },
    {
      slotId: "demo-slot-2026-10-23",
      startAt: "2026-10-23T00:00:00.000Z",
      endAt: "2026-10-24T00:00:00.000Z",
      available: true,
      sourceReferences: [source],
    },
  ];
}
