import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  DEMO_BUSINESS_ID,
  DEMO_CLOCK_ANCHOR,
  listPreparedInbox,
  listPreparedScenarios,
  PREPARED_BUSINESS_ID,
  PREPARED_CALENDAR_ID,
  PREPARED_SCENARIOS,
  preparedFixtureSlots,
  readPreparedState,
  seedPreparedFixtures,
  type PreparedScenarioId,
} from "../src/server/demo-fixtures.ts";
import {
  databasePath,
  gatherMode,
  isManagedInstall,
  ModePathError,
  runtimeModeInfo,
  secondBusinessDenial,
} from "../src/server/runtime.ts";
import { GatherStore } from "../src/server/sqlite-store.ts";

function tempStore(): { store: GatherStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "gather-prepared-"));
  return { store: new GatherStore(join(dir, "prepared.sqlite")), dir };
}

function withEnv(patch: Record<string, string | undefined>, fn: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(patch)) {
    saved.set(key, process.env[key]);
    if (patch[key] === undefined) delete process.env[key];
    else process.env[key] = patch[key];
  }
  try {
    fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const FIXTURE_DIR = new URL("./fixtures/prepared/", import.meta.url).pathname;

function fixtureJson(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, `${name}.json`), "utf8")) as Record<string, unknown>;
}

test("glasshouse seeds six inbox messages, two busy blocks and zero offers", () => {
  const { store, dir } = tempStore();
  try {
    const summary = seedPreparedFixtures(store, "glasshouse");
    assert.equal(summary.scenario, "glasshouse");
    assert.equal(summary.businessId, PREPARED_BUSINESS_ID);
    assert.equal(summary.inboxCount, 6);
    assert.equal(summary.busyBlockCount, 2);
    assert.equal(summary.offerCount, 0);
    assert.equal(summary.coverage, "complete");

    const inbox = listPreparedInbox(store);
    assert.equal(inbox.length, 6);
    const kinds = inbox.map((m) => m.kind).sort();
    assert.deepEqual(kinds, ["event_inquiry", "event_inquiry", "event_inquiry", "invoice", "newsletter", "vendor_pitch"].sort());
    // Every record carries explicitly fictional provenance.
    for (const message of inbox) {
      assert.ok(message.sourceReferences.every((ref) => ref.fictional === true));
    }
    // Exactly one complete inquiry, one missing a date, one conflicting.
    const ava = inbox.find((m) => m.id === "prepared-inbox-ava-reyes-wedding");
    assert.ok(ava?.body.includes("November 14, 2026"));
    const jordan = inbox.find((m) => m.id === "prepared-inbox-jordan-lee-anniversary");
    assert.ok(jordan?.body.includes("haven't picked a date"));
    const sam = inbox.find((m) => m.id === "prepared-inbox-sam-okafor-holiday");
    assert.ok(sam?.body.includes("November 21") && sam?.body.includes("December 5"));

    // Zero prebuilt offers and zero bookings: nothing is proposed before preparation.
    assert.equal(store.listAllProposedActions().length, 0);
    assert.equal(store.listBookings(PREPARED_BUSINESS_ID).length, 0);

    // Commercial facts are fictional, owner-confirmed fixture facts.
    const facts = store.listBusinessFacts(PREPARED_BUSINESS_ID);
    assert.ok(facts.length >= 5);
    for (const fact of facts) {
      assert.equal(fact.confidence, "verified");
      assert.ok(fact.sourceReferences.every((ref) => ref.fictional === true));
    }
    const pricing = facts.find((fact) => fact.key === "pricing.package");
    assert.deepEqual(pricing?.value, {
      kind: "per_guest",
      currency: "USD",
      amountMinor: 5000,
      durationHours: 4,
      minimumTotalMinor: 100000,
    });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prepared calendar slots hydrate two busy blocks plus open windows", () => {
  const { store, dir } = tempStore();
  try {
    assert.deepEqual(preparedFixtureSlots(store), []);
    seedPreparedFixtures(store, "glasshouse");
    const slots = preparedFixtureSlots(store);
    assert.equal(slots.length, 4);
    const busy = slots.filter((slot) => !slot.available);
    assert.equal(busy.length, 2);
    assert.ok(busy.every((slot) => slot.calendarId === PREPARED_CALENDAR_ID));
    assert.ok(busy.every((slot) => typeof slot.reason === "string" && slot.reason.includes("DEMO ONLY")));
    const open = slots.filter((slot) => slot.available);
    assert.equal(open.length, 2);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("repeated seeding is idempotent and produces the documented counts", () => {
  const { store, dir } = tempStore();
  try {
    seedPreparedFixtures(store, "glasshouse");
    const second = seedPreparedFixtures(store, "glasshouse");
    assert.equal(second.inboxCount, 6);
    assert.equal(second.busyBlockCount, 2);
    assert.equal(second.offerCount, 0);
    assert.equal(listPreparedInbox(store).length, 6);
    assert.equal(store.listBusinessFacts(PREPARED_BUSINESS_ID).length, 5);
    // Switching scenarios replaces the fixture state deterministically.
    const partial = seedPreparedFixtures(store, "partial");
    assert.equal(partial.inboxCount, 3);
    assert.equal(partial.coverage, "partial");
    assert.equal(listPreparedInbox(store).length, 3);
    const again = seedPreparedFixtures(store, "glasshouse");
    assert.equal(again.inboxCount, 6);
    assert.equal(listPreparedInbox(store).length, 6);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("empty, non-event, partial and connection-failed scenarios are honest about absence", () => {
  const { store, dir } = tempStore();
  try {
    const empty = seedPreparedFixtures(store, "empty");
    assert.equal(empty.inboxCount, 0);
    assert.equal(empty.coverage, "complete");
    assert.match(empty.coverageDetail, /No event inquiries found/);

    const nonEvent = seedPreparedFixtures(store, "non-event");
    assert.equal(nonEvent.inboxCount, 3);
    assert.equal(listPreparedInbox(store).filter((m) => m.kind === "event_inquiry").length, 0);

    const partial = seedPreparedFixtures(store, "partial");
    assert.equal(partial.inboxCount, 3);
    assert.equal(partial.coverage, "partial");
    // The partial import has the room fact but no pricing — no invented facts.
    const factKeys = store.listBusinessFacts(PREPARED_BUSINESS_ID).map((fact) => fact.key);
    assert.ok(factKeys.includes("venue.room"));

    const failed = seedPreparedFixtures(store, "connection-failed");
    assert.equal(failed.inboxCount, 0);
    assert.equal(failed.coverage, "failed");
    const account = store.getConnectedAccount("prepared-account-gmail-001");
    assert.equal(account.status, "error");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy scenario delegates to the preserved two-proposal regression seed", () => {
  const { store, dir } = tempStore();
  try {
    const summary = seedPreparedFixtures(store, "legacy");
    assert.equal(summary.scenario, "legacy");
    assert.equal(summary.businessId, DEMO_BUSINESS_ID);
    assert.equal(summary.bookingIds.length, 2);
    assert.equal(summary.proposalIds.length, 2);
    assert.equal(store.listAllProposedActions().length, 2);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fixture JSON files agree exactly with the scenario registry", () => {
  const registry = PREPARED_SCENARIOS;
  const glasshouse = fixtureJson("glasshouse");
  assert.equal(glasshouse.id, "glasshouse");
  assert.equal(registry.glasshouse.inbox.length, (glasshouse.expected as { inboxCount: number }).inboxCount);
  assert.equal(
    registry.glasshouse.calendar.filter((slot) => !slot.available).length,
    (glasshouse.expected as { busyBlockCount: number }).busyBlockCount,
  );
  // Message keys and kinds match the committed fixture one-for-one.
  const jsonInbox = glasshouse.inbox as Array<{ key: string; kind: string }>;
  assert.deepEqual(
    registry.glasshouse.inbox.map((m) => ({ key: m.key, kind: m.kind })),
    jsonInbox.map((m) => ({ key: m.key, kind: m.kind })),
  );
  const jsonCalendar = glasshouse.calendar as Array<{ key: string; startAt: string; endAt: string; available: boolean; reason?: string }>;
  assert.deepEqual(
    registry.glasshouse.calendar.map((s) => ({
      key: s.key,
      startAt: s.startAt,
      endAt: s.endAt,
      available: s.available,
      ...(s.reason === undefined ? {} : { reason: s.reason }),
    })),
    jsonCalendar,
  );
  for (const id of ["empty", "non-event", "partial", "connection-failed"] as const) {
    const json = fixtureJson(id);
    assert.equal(json.id, id);
    assert.equal(json.coverage, registry[id].coverage);
    assert.equal(json.coverageDetail, registry[id].coverageDetail);
  }
  // Scenario list exposes every scenario for the selector.
  assert.deepEqual(
    listPreparedScenarios().map((s) => s.id).sort(),
    ["glasshouse", "empty", "non-event", "partial", "connection-failed", "legacy"].sort(),
  );
});

test("managed mode resolves state under .runtime/<mode> and denies cross-mode access", () => {
  const root = mkdtempSync(join(tmpdir(), "gather-root-"));
  try {
    withEnv(
      { GATHER_INSTALL_ROOT: root, GATHER_MODE: "prepared", GATHER_DATABASE_PATH: undefined },
      () => {
        assert.equal(gatherMode(), "prepared");
        assert.equal(isManagedInstall(), true);
        assert.equal(databasePath(), join(root, ".runtime", "prepared", "gather.sqlite"));
        const info = runtimeModeInfo();
        assert.equal(info.managed, true);
        assert.equal(info.liveEnabled, false);
      },
    );
    withEnv(
      { GATHER_INSTALL_ROOT: root, GATHER_MODE: "live", GATHER_DATABASE_PATH: undefined },
      () => {
        assert.equal(databasePath(), join(root, ".runtime", "live", "gather.sqlite"));
      },
    );
    // An explicit developer path into the other mode's state is refused.
    withEnv(
      {
        GATHER_INSTALL_ROOT: root,
        GATHER_MODE: "prepared",
        GATHER_DATABASE_PATH: join(root, ".runtime", "live", "gather.sqlite"),
      },
      () => {
        assert.throws(() => databasePath(), ModePathError);
      },
    );
    // An explicit developer path elsewhere is still honoured.
    withEnv(
      { GATHER_INSTALL_ROOT: root, GATHER_MODE: "prepared", GATHER_DATABASE_PATH: join(root, "custom.sqlite") },
      () => {
        assert.equal(databasePath(), join(root, "custom.sqlite"));
      },
    );
    // Unmanaged runs keep the historical default.
    withEnv({ GATHER_INSTALL_ROOT: undefined, GATHER_MODE: undefined, GATHER_DATABASE_PATH: undefined }, () => {
      assert.equal(databasePath(), "data/gather.sqlite");
      assert.equal(isManagedInstall(), false);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a symlinked mode state directory is refused", () => {
  const root = mkdtempSync(join(tmpdir(), "gather-root-"));
  const outside = mkdtempSync(join(tmpdir(), "gather-outside-"));
  try {
    mkdirSync(join(root, ".runtime"), { recursive: true });
    symlinkSync(outside, join(root, ".runtime", "prepared"));
    withEnv({ GATHER_INSTALL_ROOT: root, GATHER_MODE: "prepared", GATHER_DATABASE_PATH: undefined }, () => {
      assert.throws(() => databasePath(), ModePathError);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("managed installs deny a second distinct business but allow the idempotent same one", () => {
  const root = mkdtempSync(join(tmpdir(), "gather-root-"));
  const { store, dir } = tempStore();
  try {
    seedPreparedFixtures(store, "glasshouse");
    withEnv({ GATHER_INSTALL_ROOT: root, GATHER_MODE: "prepared" }, () => {
      const denial = secondBusinessDenial(store, "Other Hall", "UTC");
      assert.match(denial ?? "", /one venue per mode/);
      // Same name+timezone is the existing idempotent retry — still allowed.
      assert.equal(
        secondBusinessDenial(store, "Fictional Glasshouse (DEMO ONLY)", "America/New_York"),
        undefined,
      );
    });
    // Unmanaged development is unchanged.
    withEnv({ GATHER_INSTALL_ROOT: undefined }, () => {
      assert.equal(secondBusinessDenial(store, "Other Hall", "UTC"), undefined);
    });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("demo clock anchor is fixed and documented", () => {
  assert.equal(DEMO_CLOCK_ANCHOR, "2026-10-01T12:00:00.000Z");
  const { store, dir } = tempStore();
  try {
    seedPreparedFixtures(store, "glasshouse");
    const state = readPreparedState(store);
    assert.equal(state?.demoClockAnchor, DEMO_CLOCK_ANCHOR);
    assert.equal(state?.scenario, "glasshouse");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
