/**
 * ADR-006 live integration evidence (006-A02/A04): the own-account flow runs
 * ONLY on explicitly authorized test accounts. Without operator-supplied
 * accounts/credentials every live proof stays explicitly BLOCKED with named
 * missing evidence — no fixture injection into the empty-account path, and
 * fake transports are never marked live.
 *
 * Default checks run entirely local: no Google/model/network contact, no
 * personal runtime discovery. Real invocation requires the operator's
 * explicit accounts plus GATHER_LIVE_CONSENT/GATHER_TEST_RECIPIENT, which
 * this suite asserts are absent (or, where set, still insufficient alone).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { liveGateReport } from "../src/server/live-model/live-status.ts";
import { LiveModelError, runLiveExecution } from "../src/server/live-model/index.ts";
import { createProviderConnectors } from "../src/server/provider-runtime/index.ts";
import { createDemoConnectors } from "../src/connectors/demo.ts";
import { demoFixtureSlots } from "../src/server/demo-fixtures.ts";
import { DurableDemoCalendar, DurableDemoEmail } from "../src/server/durable-demo-connectors.ts";
import { GatherStore } from "../src/server/sqlite-store.ts";

function emptyWorld() {
  const dir = mkdtempSync(join(tmpdir(), "gather-006-live-"));
  const path = join(dir, "gather.sqlite");
  const store = new GatherStore(path);
  const businessId = store.createBusiness({ name: "Real Test Venue", timezone: "UTC" }).id;
  const demo = createDemoConnectors({ calendarSlots: demoFixtureSlots() });
  const providers = createProviderConnectors({
    store,
    ownerId: "test-owner",
    demo: {
      calendar: new DurableDemoCalendar(store, demo.calendar),
      email: new DurableDemoEmail(store, demo.email),
    },
    secretsNamespace: path,
  });
  return { dir, store, businessId, providers, cleanup: () => { try { store.close(); } catch { /* already closed */ } rmSync(dir, { recursive: true, force: true }); } };
}

async function withEnv(values: Record<string, string | undefined>, run: () => void | Promise<unknown>): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(values)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("006-A02/A04 BLOCKED: empty account path names missing evidence, injects no fixtures", async () => {
  const w = emptyWorld();
  try {
    await withEnv(
      {
        GATHER_TEST_OPENCLAW_BIN: undefined,
        GATHER_MODEL_PROFILE_ID: undefined,
        GATHER_LIVE_CONSENT: undefined,
        GATHER_TEST_RECIPIENT: undefined,
        GATHER_ACCEPTANCE_KEY: undefined,
      },
      () => {
        const report = liveGateReport(
          {
            store: w.store,
            providerReadiness: () => [{ provider: "google", status: "unavailable" }],
          },
          "base",
        );
        assert.equal(report.liveReady, false);
        assert.ok(report.blockedBy.length > 0);
        assert.match(report.notice, /BLOCKED/);
        // The empty store stays empty: no fixture was injected to fake coverage.
        assert.equal(w.store.listBookings().length, 0);
        assert.equal(w.store.listConnectedAccounts().length, 0);
      },
    );
  } finally {
    w.cleanup();
  }
});

test("006-A02/A04 BLOCKED: recipient+key+model alone cannot pass without accounts", async () => {
  const w = emptyWorld();
  try {
    await withEnv(
      {
        GATHER_MODEL_PROFILE_ID: "test-profile",
        GATHER_LIVE_CONSENT: "1",
        GATHER_TEST_RECIPIENT: "operator-test@example.test",
        GATHER_ACCEPTANCE_KEY: "test-only-key",
        GATHER_TEST_OPENCLAW_BIN: undefined,
      },
      () => {
        const report = liveGateReport(
          {
            store: w.store,
            providerReadiness: () => [{ provider: "google", status: "available" }],
          },
          "base",
        );
        // Connected-account, runtime, and native-knowledge evidence are still
        // absent: the gate stays blocked and names exactly those.
        assert.equal(report.liveReady, false);
        const joined = report.blockedBy.join("\n");
        assert.match(joined, /no connected authorized Google account/);
        assert.match(joined, /OpenClaw runtime/);
        assert.match(joined, /native knowledge/);
        assert.doesNotMatch(joined, /GATHER_TEST_RECIPIENT/);
      },
    );
  } finally {
    w.cleanup();
  }
});

test("006-A02 BLOCKED: live model invocation refuses without consent and designation", async () => {
  const w = emptyWorld();
  try {
    await withEnv({ GATHER_LIVE_CONSENT: undefined }, async () => {
      await assert.rejects(
        runLiveExecution(
          {
            businessId: w.businessId, threadId: "thread-1", fileId: "file-1",
            calendarId: "cal-1", mode: "live", allowLive: true,
          },
          { store: w.store, providers: w.providers },
        ),
        (error: unknown) => error instanceof LiveModelError && error.code === "LIVE_NOT_AUTHORIZED",
      );
      await assert.rejects(
        runLiveExecution(
          {
            businessId: w.businessId, threadId: "thread-1", fileId: "file-1",
            calendarId: "cal-1", mode: "live", allowLive: false,
          },
          { store: w.store, providers: w.providers },
        ),
        (error: unknown) => error instanceof LiveModelError && error.code === "LIVE_NOT_AUTHORIZED",
      );
    });
  } finally {
    w.cleanup();
  }
});

test("006-A02 honest: even scripted verification needs designated accounts — no fake ports", async () => {
  const w = emptyWorld();
  try {
    // No connected Gmail account exists, so even a fully scripted planner
    // run refuses: the journey's designated ports are real preconditions,
    // and a fake transport is never substituted to make it pass.
    await assert.rejects(
      runLiveExecution(
        {
          businessId: w.businessId, threadId: "thread-1", fileId: "file-1",
          calendarId: "cal-1", mode: "scripted", idempotencyKey: "006-live-gate-scripted",
        },
        {
          store: w.store,
          providers: w.providers,
          execution: "simulated",
          planner: { planCall: async () => ({ done: true as const }) },
        },
      ),
      (error: unknown) => error instanceof LiveModelError && error.code === "LIVE_NOT_AUTHORIZED",
    );
  } finally {
    w.cleanup();
  }
});
