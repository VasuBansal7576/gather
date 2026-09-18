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
      calendarId: DEMO_CALENDAR_ID,
      startAt: "2026-10-18T00:00:00.000Z",
      endAt: "2026-10-19T00:00:00.000Z",
      available: true,
      sourceReferences: [source],
    },
    {
      slotId: "demo-slot-2026-10-23",
      calendarId: DEMO_CALENDAR_ID,
      startAt: "2026-10-23T00:00:00.000Z",
      endAt: "2026-10-24T00:00:00.000Z",
      available: true,
      sourceReferences: [source],
    },
  ];
}

/* ------------------------------------------------------------------------
 * Prepared-product fixture scenarios (ADR-001 / C01).
 *
 * The legacy two-proposal seed above is the explicitly named "legacy"
 * regression fixture; callers and tests keep it unchanged. The product
 * scenarios below are inquiry-first: they seed a durable inbox, calendar
 * busy blocks and owner-confirmed fictional commercial facts — and never a
 * prebuilt offer.
 * --------------------------------------------------------------------- */

export const PREPARED_BUSINESS_ID = "prepared-business-glasshouse";
export const PREPARED_CALENDAR_ID = "prepared-calendar-glasshouse";
export const PREPARED_GMAIL_ACCOUNT_ID = "prepared-account-gmail-001";
export const PREPARED_CALENDAR_ACCOUNT_ID = "prepared-account-calendar-001";

/**
 * Documented demo clock anchor (C01): fixture timestamps are fixed relative
 * to this anchor so seeded dates never silently expire against the wall
 * clock. Simulated expiry still uses the service clock for explicit
 * hold-expiry exercise.
 */
export const DEMO_CLOCK_ANCHOR = "2026-10-01T12:00:00.000Z";

export type PreparedScenarioId =
  | "glasshouse"
  | "empty"
  | "non-event"
  | "partial"
  | "connection-failed"
  | "legacy";

export type PreparedCoverage = "complete" | "partial" | "failed";

export interface PreparedInboxSpec {
  key: string;
  kind: "event_inquiry" | "invoice" | "newsletter" | "vendor_pitch";
  threadId: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  receivedAt: string;
}

export interface PreparedSlotSpec {
  key: string;
  startAt: string;
  endAt: string;
  available: boolean;
  reason?: string;
}

export interface PreparedFactSpec {
  key: string;
  value: unknown;
}

export interface PreparedAccountSpec {
  id: string;
  provider: "gmail" | "google_calendar";
  displayName: string;
  status: "connected" | "error";
}

export interface PreparedScenarioSpec {
  id: PreparedScenarioId;
  label: string;
  description: string;
  coverage: PreparedCoverage;
  coverageDetail: string;
  inbox: PreparedInboxSpec[];
  calendar: PreparedSlotSpec[];
  facts: PreparedFactSpec[];
  accounts: PreparedAccountSpec[];
}

const PREPARED_SOURCE: SourceReference = {
  kind: "fixture",
  locator: "demo://gather/prepared-scenario",
  label: "DEMO ONLY fictional prepared fixture",
  fictional: true,
};

const PREPARED_BUSINESS = {
  id: PREPARED_BUSINESS_ID,
  name: "Fictional Glasshouse (DEMO ONLY)",
  timezone: "America/New_York",
};

const PREPARED_ACCOUNTS_CONNECTED: PreparedAccountSpec[] = [
  { id: PREPARED_GMAIL_ACCOUNT_ID, provider: "gmail", displayName: "DEMO ONLY fictional Gmail", status: "connected" },
  { id: PREPARED_CALENDAR_ACCOUNT_ID, provider: "google_calendar", displayName: "DEMO ONLY fictional Calendar", status: "connected" },
];

/**
 * Reference commercial facts for the Fictional Glasshouse (C01): exclusive
 * room, capacity 100, 4-hour package at $50/guest, $1,000 minimum, no
 * concessions, no extra taxes/fees, 30 minutes of setup/teardown each side.
 * Seeded as explicitly fictional owner-confirmed fixture facts with
 * provenance; they are never live authority.
 */
const GLASSHOUSE_FACTS: PreparedFactSpec[] = [
  {
    key: "venue.room",
    value: { name: "The Glasshouse Room", exclusive: true, capacity: 100 },
  },
  {
    key: "pricing.package",
    value: {
      kind: "per_guest",
      currency: "USD",
      amountMinor: 5000,
      durationHours: 4,
      minimumTotalMinor: 100000,
    },
  },
  { key: "policy.concessions", value: { allowed: false } },
  { key: "policy.taxes_fees", value: { extraTaxes: false, extraFees: false } },
  { key: "policy.setup_teardown", value: { minutesEachSide: 30 } },
];

const GLASSHOUSE_INBOX: PreparedInboxSpec[] = [
  {
    key: "ava-reyes-wedding",
    kind: "event_inquiry",
    threadId: "prepared-thread-ava-001",
    from: "ava.reyes@example.test",
    to: "events@glasshouse.example.test",
    subject: "Wedding dinner — November 14?",
    body:
      "Hello! We're planning our wedding dinner for Saturday November 14, 2026, " +
      "about 90 guests, 6:30pm to 11pm. Is the Glasshouse available, and what would it cost?",
    receivedAt: "2026-09-28T14:12:00.000Z",
  },
  {
    key: "jordan-lee-anniversary",
    kind: "event_inquiry",
    threadId: "prepared-thread-jordan-002",
    from: "jordan.lee@example.test",
    to: "events@glasshouse.example.test",
    subject: "Anniversary party for ~60",
    body:
      "Hi — we'd like to host my parents' 40th anniversary at your venue, roughly 60 guests, " +
      "evening. We haven't picked a date yet. What are the options?",
    receivedAt: "2026-09-28T16:40:00.000Z",
  },
  {
    key: "sam-okafor-holiday",
    kind: "event_inquiry",
    threadId: "prepared-thread-sam-003",
    from: "sam.okafor@example.test",
    to: "events@glasshouse.example.test",
    subject: "Holiday reception — Nov 21 or Dec 5?",
    body:
      "Our company holiday reception, around 80 people. The invite says November 21, " +
      "but half the team asked for December 5 — the body of this message is genuinely " +
      "ambiguous about which date we want.",
    receivedAt: "2026-09-29T09:05:00.000Z",
  },
  {
    key: "invoice-1042",
    kind: "invoice",
    threadId: "prepared-thread-invoice-004",
    from: "billing@linenworks.example.test",
    to: "events@glasshouse.example.test",
    subject: "Invoice #1042 — September linens",
    body: "Attached: invoice #1042 for September linen rental, $412.00 due Oct 15.",
    receivedAt: "2026-09-29T11:30:00.000Z",
  },
  {
    key: "newsletter-october",
    kind: "newsletter",
    threadId: "prepared-thread-news-005",
    from: "newsletter@venueweekly.example.test",
    to: "events@glasshouse.example.test",
    subject: "Venue Weekly: October booking trends",
    body: "This week: weekday weddings keep climbing; holiday corporate dates are filling fast.",
    receivedAt: "2026-09-29T13:00:00.000Z",
  },
  {
    key: "vendor-pitch-photobooth",
    kind: "vendor_pitch",
    threadId: "prepared-thread-vendor-006",
    from: "sales@snapbooth.example.test",
    to: "events@glasshouse.example.test",
    subject: "Partner with SnapBooth photo booths",
    body: "We'd love to be your preferred photo booth vendor. Revenue share available.",
    receivedAt: "2026-09-30T08:15:00.000Z",
  },
];

const GLASSHOUSE_CALENDAR: PreparedSlotSpec[] = [
  {
    key: "busy-private-event-nov21",
    startAt: "2026-11-21T17:00:00.000Z",
    endAt: "2026-11-21T23:00:00.000Z",
    available: false,
    reason: "DEMO ONLY busy block: existing private event",
  },
  {
    key: "busy-buyout-nov28",
    startAt: "2026-11-28T17:00:00.000Z",
    endAt: "2026-11-28T23:00:00.000Z",
    available: false,
    reason: "DEMO ONLY busy block: full-venue buyout",
  },
  // Open windows covering the candidate event dates the busy blocks do not claim.
  { key: "open-nov14", startAt: "2026-11-14T00:00:00.000Z", endAt: "2026-11-15T00:00:00.000Z", available: true },
  { key: "open-dec05", startAt: "2026-12-05T00:00:00.000Z", endAt: "2026-12-06T00:00:00.000Z", available: true },
];

const NON_EVENT_INBOX: PreparedInboxSpec[] = [
  GLASSHOUSE_INBOX[3]!,
  GLASSHOUSE_INBOX[4]!,
  GLASSHOUSE_INBOX[5]!,
];

const PARTIAL_INBOX: PreparedInboxSpec[] = [
  GLASSHOUSE_INBOX[0]!,
  GLASSHOUSE_INBOX[3]!,
  GLASSHOUSE_INBOX[4]!,
];

export const PREPARED_SCENARIOS: Readonly<Record<PreparedScenarioId, PreparedScenarioSpec>> = {
  glasshouse: {
    id: "glasshouse",
    label: "Fictional Glasshouse — inquiry-first",
    description:
      "Reference prepared business: six inbox messages (three event inquiries — one complete, " +
      "one missing a date, one with conflicting dates — plus an invoice, a newsletter and a " +
      "vendor pitch), two busy calendar blocks and owner-confirmed fictional venue facts. " +
      "No offers are prebuilt.",
    coverage: "complete",
    coverageDetail: "Scanned 6 emails. 3 look like event inquiries; 3 are not event inquiries.",
    inbox: GLASSHOUSE_INBOX,
    calendar: GLASSHOUSE_CALENDAR,
    facts: GLASSHOUSE_FACTS,
    accounts: PREPARED_ACCOUNTS_CONNECTED,
  },
  empty: {
    id: "empty",
    label: "Empty inbox",
    description: "Prepared business with a connected inbox that contains nothing at all.",
    coverage: "complete",
    coverageDetail: "Scanned 0 emails. No event inquiries found.",
    inbox: [],
    calendar: [],
    facts: GLASSHOUSE_FACTS,
    accounts: PREPARED_ACCOUNTS_CONNECTED,
  },
  "non-event": {
    id: "non-event",
    label: "Non-event inbox",
    description: "Prepared business whose inbox holds only non-event mail (invoice, newsletter, vendor pitch).",
    coverage: "complete",
    coverageDetail: "Scanned 3 emails. No event inquiries found.",
    inbox: NON_EVENT_INBOX,
    calendar: [],
    facts: GLASSHOUSE_FACTS,
    accounts: PREPARED_ACCOUNTS_CONNECTED,
  },
  partial: {
    id: "partial",
    label: "Partial import",
    description:
      "Prepared business whose initial import stopped partway: only some inbox messages and " +
      "some venue facts are present, honestly labelled as incomplete.",
    coverage: "partial",
    coverageDetail:
      "Import incomplete: 3 of 6 messages imported before the scan paused. " +
      "Pricing facts were not imported — no price is known yet.",
    inbox: PARTIAL_INBOX,
    calendar: [GLASSHOUSE_CALENDAR[2]!],
    facts: [GLASSHOUSE_FACTS[0]!],
    accounts: PREPARED_ACCOUNTS_CONNECTED,
  },
  "connection-failed": {
    id: "connection-failed",
    label: "Connection failed",
    description:
      "Prepared business whose inbox connection failed during the first scan: nothing was imported.",
    coverage: "failed",
    coverageDetail:
      "Connection failed during the initial scan; no messages were imported. " +
      "There is no last successful sync to report.",
    inbox: [],
    calendar: [],
    facts: [],
    accounts: [
      { id: PREPARED_GMAIL_ACCOUNT_ID, provider: "gmail", displayName: "DEMO ONLY fictional Gmail", status: "error" },
      { id: PREPARED_CALENDAR_ACCOUNT_ID, provider: "google_calendar", displayName: "DEMO ONLY fictional Calendar", status: "connected" },
    ],
  },
  legacy: {
    id: "legacy",
    label: "Legacy regression fixture",
    description:
      "The original two-proposal seed kept for regression tests — not the product demonstration.",
    coverage: "complete",
    coverageDetail: "Legacy regression seed: two bookings with prebuilt proposals.",
    inbox: [],
    calendar: [],
    facts: [],
    accounts: [],
  },
};

export function listPreparedScenarios(): Array<Pick<PreparedScenarioSpec, "id" | "label" | "description">> {
  return Object.values(PREPARED_SCENARIOS).map(({ id, label, description }) => ({ id, label, description }));
}

export function isPreparedScenarioId(value: unknown): value is PreparedScenarioId {
  return typeof value === "string" && Object.hasOwn(PREPARED_SCENARIOS, value);
}

/**
 * Fixture-owned durable tables on the shared Gather database handle —
 * the same pattern the operator intake store already uses. These rows are
 * the prepared scenario's durable inbox/calendar truth; deleting the mode
 * database removes them entirely.
 */
function ensureFixtureTables(store: GatherStore): void {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS fixture_inbox_messages (
      id TEXT PRIMARY KEY,
      business_id TEXT NOT NULL,
      scenario TEXT NOT NULL,
      position INTEGER NOT NULL,
      kind TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      from_address TEXT NOT NULL,
      to_address TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      received_at TEXT NOT NULL,
      source_references_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS fixture_calendar_slots (
      id TEXT PRIMARY KEY,
      business_id TEXT NOT NULL,
      scenario TEXT NOT NULL,
      calendar_id TEXT NOT NULL,
      start_at TEXT NOT NULL,
      end_at TEXT NOT NULL,
      available INTEGER NOT NULL,
      reason TEXT,
      source_references_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS fixture_scenario_state (
      business_id TEXT PRIMARY KEY,
      scenario TEXT NOT NULL,
      coverage TEXT NOT NULL,
      coverage_detail TEXT,
      inbox_count INTEGER NOT NULL,
      busy_block_count INTEGER NOT NULL,
      offer_count INTEGER NOT NULL,
      demo_clock_anchor TEXT NOT NULL,
      seeded_at TEXT NOT NULL
    );
  `);
}

export interface PreparedInboxMessage {
  id: string;
  kind: PreparedInboxSpec["kind"];
  threadId: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  receivedAt: string;
  sourceReferences: SourceReference[];
}

export interface PreparedStateSummary {
  scenario: PreparedScenarioId;
  coverage: PreparedCoverage;
  coverageDetail: string;
  inboxCount: number;
  busyBlockCount: number;
  offerCount: number;
  demoClockAnchor: string;
  seededAt: string;
}

export interface PreparedSeedSummary extends PreparedStateSummary {
  businessId: string;
  bookingIds: string[];
  proposalIds: string[];
}

/**
 * Read the currently seeded prepared scenario, if any. Used by the setup/mode
 * route and by restart verification so the reported state is the durable one.
 */
export function readPreparedState(store: GatherStore): PreparedStateSummary | undefined {
  ensureFixtureTables(store);
  const found = store.db
    .prepare("SELECT * FROM fixture_scenario_state WHERE business_id = $businessId")
    .get({ $businessId: PREPARED_BUSINESS_ID });
  if (!found || typeof found !== "object") return undefined;
  const value = found as Record<string, unknown>;
  return {
    scenario: String(value.scenario) as PreparedScenarioId,
    coverage: String(value.coverage) as PreparedCoverage,
    coverageDetail: String(value.coverage_detail ?? ""),
    inboxCount: Number(value.inbox_count),
    busyBlockCount: Number(value.busy_block_count),
    offerCount: Number(value.offer_count),
    demoClockAnchor: String(value.demo_clock_anchor),
    seededAt: String(value.seeded_at),
  };
}

/** Durable inbox messages of the active prepared scenario, in seed order. */
export function listPreparedInbox(store: GatherStore): PreparedInboxMessage[] {
  ensureFixtureTables(store);
  const rows = store.db
    .prepare("SELECT * FROM fixture_inbox_messages WHERE business_id = $businessId ORDER BY position")
    .all({ $businessId: PREPARED_BUSINESS_ID });
  return rows.map((raw) => {
    const value = raw as Record<string, unknown>;
    return {
      id: String(value.id),
      kind: String(value.kind) as PreparedInboxSpec["kind"],
      threadId: String(value.thread_id),
      from: String(value.from_address),
      to: String(value.to_address),
      subject: String(value.subject),
      body: String(value.body),
      receivedAt: String(value.received_at),
      sourceReferences: parseJsonArray(value.source_references_json),
    };
  });
}

function parseJsonArray(value: unknown): SourceReference[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as SourceReference[]) : [];
  } catch {
    return [];
  }
}

/**
 * Calendar slots for the in-memory demo world, hydrated from the durable
 * prepared scenario so busy blocks survive restarts. Returns the seeded set
 * for the active scenario, or an empty world when nothing is seeded yet.
 */
export function preparedFixtureSlots(store: GatherStore): CalendarSlot[] {
  ensureFixtureTables(store);
  const rows = store.db
    .prepare("SELECT * FROM fixture_calendar_slots WHERE business_id = $businessId ORDER BY start_at")
    .all({ $businessId: PREPARED_BUSINESS_ID });
  return rows.map((raw) => {
    const value = raw as Record<string, unknown>;
    return {
      slotId: String(value.id),
      calendarId: String(value.calendar_id),
      startAt: String(value.start_at),
      endAt: String(value.end_at),
      available: Number(value.available) === 1,
      ...(value.reason === null || value.reason === undefined ? {} : { reason: String(value.reason) }),
      sourceReferences: parseJsonArray(value.source_references_json),
    };
  });
}

/**
 * Seed a prepared-product scenario into the store. Idempotent: fixture rows
 * for the prepared business are replaced as one documented state, so a
 * repeated seed (or a scenario switch after reset) always produces the same
 * counts. The "legacy" id delegates to the preserved two-proposal seed and
 * records no prepared-scenario state.
 */
export function seedPreparedFixtures(store: GatherStore, scenarioId: PreparedScenarioId): PreparedSeedSummary {
  const spec = PREPARED_SCENARIOS[scenarioId];
  if (scenarioId === "legacy") {
    const legacy = seedDemoFixtures(store);
    return {
      scenario: "legacy",
      businessId: legacy.businessId,
      bookingIds: legacy.bookingIds,
      proposalIds: legacy.proposalIds,
      coverage: spec.coverage,
      coverageDetail: spec.coverageDetail,
      inboxCount: 0,
      busyBlockCount: 0,
      offerCount: legacy.proposalIds.length,
      demoClockAnchor: DEMO_CLOCK_ANCHOR,
      seededAt: new Date().toISOString(),
    };
  }

  ensureFixtureTables(store);
  if (!fixtureExists(() => store.getBusiness(PREPARED_BUSINESS_ID))) {
    store.createBusiness({ id: PREPARED_BUSINESS.id, name: PREPARED_BUSINESS.name, timezone: PREPARED_BUSINESS.timezone });
  }
  for (const account of spec.accounts) {
    store.upsertConnectedAccount({
      id: account.id,
      businessId: PREPARED_BUSINESS_ID,
      provider: account.provider,
      displayName: account.displayName,
      status: account.status,
    });
  }

  const timestamp = new Date().toISOString();
  store.db.exec("BEGIN IMMEDIATE");
  try {
    store.db.prepare("DELETE FROM fixture_inbox_messages WHERE business_id = $businessId").run({ $businessId: PREPARED_BUSINESS_ID });
    store.db.prepare("DELETE FROM fixture_calendar_slots WHERE business_id = $businessId").run({ $businessId: PREPARED_BUSINESS_ID });
    spec.inbox.forEach((message, position) => {
      store.db
        .prepare(`INSERT INTO fixture_inbox_messages
          (id, business_id, scenario, position, kind, thread_id, from_address, to_address,
           subject, body, received_at, source_references_json, created_at)
          VALUES ($id, $businessId, $scenario, $position, $kind, $threadId, $from, $to,
           $subject, $body, $receivedAt, $refs, $createdAt)`)
        .run({
          $id: `prepared-inbox-${message.key}`,
          $businessId: PREPARED_BUSINESS_ID,
          $scenario: spec.id,
          $position: position,
          $kind: message.kind,
          $threadId: message.threadId,
          $from: message.from,
          $to: message.to,
          $subject: message.subject,
          $body: message.body,
          $receivedAt: message.receivedAt,
          $refs: JSON.stringify([PREPARED_SOURCE]),
          $createdAt: timestamp,
        });
    });
    spec.calendar.forEach((slot) => {
      store.db
        .prepare(`INSERT INTO fixture_calendar_slots
          (id, business_id, scenario, calendar_id, start_at, end_at, available, reason, source_references_json)
          VALUES ($id, $businessId, $scenario, $calendarId, $startAt, $endAt, $available, $reason, $refs)`)
        .run({
          $id: `prepared-slot-${slot.key}`,
          $businessId: PREPARED_BUSINESS_ID,
          $scenario: spec.id,
          $calendarId: PREPARED_CALENDAR_ID,
          $startAt: slot.startAt,
          $endAt: slot.endAt,
          $available: slot.available ? 1 : 0,
          $reason: slot.reason ?? null,
          $refs: JSON.stringify([PREPARED_SOURCE]),
        });
    });
    store.db
      .prepare(`INSERT INTO fixture_scenario_state
        (business_id, scenario, coverage, coverage_detail, inbox_count, busy_block_count, offer_count, demo_clock_anchor, seeded_at)
        VALUES ($businessId, $scenario, $coverage, $coverageDetail, $inbox, $busy, $offers, $anchor, $seededAt)
        ON CONFLICT(business_id) DO UPDATE SET scenario = excluded.scenario, coverage = excluded.coverage,
          coverage_detail = excluded.coverage_detail, inbox_count = excluded.inbox_count,
          busy_block_count = excluded.busy_block_count, offer_count = excluded.offer_count,
          demo_clock_anchor = excluded.demo_clock_anchor, seeded_at = excluded.seeded_at`)
      .run({
        $businessId: PREPARED_BUSINESS_ID,
        $scenario: spec.id,
        $coverage: spec.coverage,
        $coverageDetail: spec.coverageDetail,
        $inbox: spec.inbox.length,
        $busy: spec.calendar.filter((slot) => !slot.available).length,
        $offers: 0,
        $anchor: DEMO_CLOCK_ANCHOR,
        $seededAt: timestamp,
      });
    store.db.exec("COMMIT");
  } catch (error) {
    try {
      store.db.exec("ROLLBACK");
    } catch {
      // Already rolled back; surface the original failure.
    }
    throw error;
  }

  const existingFactKeys = new Set(store.listBusinessFacts(PREPARED_BUSINESS_ID).map((fact) => fact.key));
  for (const fact of spec.facts) {
    const factId = `prepared-fact-${fact.key}`;
    if (!existingFactKeys.has(fact.key)) {
      store.addBusinessFact({
        id: factId,
        businessId: PREPARED_BUSINESS_ID,
        key: fact.key,
        value: fact.value,
        // Owner-confirmed fixture facts: verified confidence inside an
        // explicitly fictional fixture, never live commercial authority.
        confidence: "verified",
        sourceReferences: [PREPARED_SOURCE],
        observedAt: DEMO_CLOCK_ANCHOR,
      });
    }
  }

  const state = readPreparedState(store);
  if (!state) throw new Error("Prepared scenario seed did not persist its state row");
  return {
    ...state,
    businessId: PREPARED_BUSINESS_ID,
    bookingIds: [],
    proposalIds: [],
  };
}
