/**
 * ADR-006 workspace composition tests (006-A01..A04, 006-CHECKS).
 *
 * Integration-only: the IntegrationProfile registry/gate (C12), the live
 * gate evidence report (explicitly BLOCKED without operator credentials),
 * the deferred 011 live inbound acceptance callback (fail-closed validator),
 * durable intent progress on the approve/reconcile routes' opt-in path,
 * DTO adapter preservation, and mode-switch payload hygiene.
 *
 * All fixtures are fictional and versioned; no live accounts, credentials,
 * or network are touched. Live-or-blocked proof lives in
 * tests/live-integration-gate.test.ts.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDemoConnectors } from "../src/connectors/demo.ts";
import {
  evaluateLiveGate,
  type LiveGateEvidence,
} from "../src/integrations/contracts.ts";
import {
  getProfile,
  isProfileAvailable,
  listProfiles,
} from "../src/integrations/registry.ts";
import {
  approveAndExecute,
  emailOperationKey,
  getWorkspace,
  type BookingServiceDeps,
} from "../src/server/booking-service.ts";
import { DeliveryStore } from "../src/server/booking-delivery/store.ts";
import { DurableDemoCalendar, DurableDemoEmail } from "../src/server/durable-demo-connectors.ts";
import { demoFixtureSlots, seedDemoFixtures } from "../src/server/demo-fixtures.ts";
import { IntentService } from "../src/intents/index.ts";
import {
  createLiveAcceptanceValidator,
  liveAcceptanceWired,
} from "../src/server/live-model/acceptance-callback.ts";
import { issueAcceptanceToken } from "../src/server/acceptance/index.ts";
import { GatherStore } from "../src/server/sqlite-store.ts";
import { parseApproveBody } from "../src/server/validation.ts";

const NOW = "2030-06-01T00:00:00.000Z";

function world() {
  const dir = mkdtempSync(join(tmpdir(), "gather-006-"));
  const store = new GatherStore(join(dir, "gather.sqlite"));
  // Wall-clock everywhere: the versioned demo fixtures carry fixed 2026
  // event windows, so a pinned test clock would expire them at the
  // connector boundary.
  const demo = createDemoConnectors({ calendarSlots: demoFixtureSlots(), nowMs: () => Date.now() });
  const deps: BookingServiceDeps = {
    store,
    calendar: new DurableDemoCalendar(store, demo.calendar, () => Date.now()),
    email: new DurableDemoEmail(store, demo.email),
    ownerId: "test-owner",
    now: () => new Date().toISOString(),
  };
  const businessId = store.createBusiness({ name: "Fictional Test Hall", timezone: "UTC" }).id;
  return { dir, store, deps, businessId, cleanup: () => { try { store.close(); } catch { /* already closed */ } rmSync(dir, { recursive: true, force: true }); } };
}

const EMPTY_EVIDENCE: LiveGateEvidence = {
  runtimeProvisioned: false,
  knowledgeNative: false,
  googleConfigured: false,
  googleAccountConnected: false,
  modelAuthorized: false,
  testRecipientConfigured: false,
  acceptanceKeyConfigured: false,
};

// ---------- C12 registry (consumed by event ADRs in 016) ----------

test("006 registry: base is implemented; event profiles are specified-only", () => {
  const profiles = listProfiles();
  assert.deepEqual(profiles.map((profile) => profile.id).sort(), ["amazon", "assemblyai", "base", "nebius"]);
  assert.equal(getProfile("base").implementationStatus, "implemented");
  assert.equal(isProfileAvailable("base"), true);
  for (const id of ["assemblyai", "amazon", "nebius"] as const) {
    assert.equal(getProfile(id).implementationStatus, "specified");
    assert.equal(isProfileAvailable(id), false, `${id} must stay inert until its owning ADR lands`);
  }
  // No silent fallback: event profiles require their own capabilities.
  assert.ok(getProfile("assemblyai").requiredCapabilities.includes("voice"));
  assert.ok(getProfile("amazon").requiredCapabilities.includes("owner-mcp"));
});

// ---------- Live gate: blocked with named missing evidence ----------

test("006 gate: empty evidence blocks base with every missing item named", () => {
  const report = evaluateLiveGate(getProfile("base"), EMPTY_EVIDENCE);
  assert.equal(report.liveReady, false);
  assert.ok(report.blockedBy.length >= 6, `expected all gates named, got: ${report.blockedBy.join("; ")}`);
  const joined = report.blockedBy.join("\n");
  assert.match(joined, /OpenClaw runtime/);
  assert.match(joined, /native knowledge/);
  assert.match(joined, /Google provider app/);
  assert.match(joined, /model access/);
  assert.match(joined, /GATHER_TEST_RECIPIENT/);
  assert.match(joined, /GATHER_ACCEPTANCE_KEY/);
  assert.match(report.notice, /BLOCKED/);
});

test("006 gate: full evidence passes; partial evidence names exactly what remains", () => {
  const full: LiveGateEvidence = {
    runtimeProvisioned: true,
    knowledgeNative: true,
    googleConfigured: true,
    googleAccountConnected: true,
    modelAuthorized: true,
    testRecipientConfigured: true,
    acceptanceKeyConfigured: true,
  };
  const ready = evaluateLiveGate(getProfile("base"), full);
  assert.equal(ready.liveReady, true);
  assert.deepEqual(ready.blockedBy, []);

  // Operator wired everything except the test recipient: still blocked, and
  // the report names exactly the recipient — nothing else.
  const partial = evaluateLiveGate(getProfile("base"), { ...full, testRecipientConfigured: false });
  assert.equal(partial.liveReady, false);
  assert.equal(partial.blockedBy.length, 1);
  assert.match(partial.blockedBy[0], /GATHER_TEST_RECIPIENT/);
});

// ---------- Deferred 011 callback: fail-closed validator ----------

const KEYRING = { activeVersion: "v1", keys: { v1: "test-only-006-signing-key" } };

function seedTokenWorld(w: ReturnType<typeof world>) {
  const booking = w.store.createBooking({
    id: "bk-accept", businessId: w.businessId, eventName: "Fictional acceptance event",
    status: "pending_approval", startAt: "2030-06-12T17:00:00.000Z", endAt: "2030-06-12T23:00:00.000Z",
    sourceReferences: [{ kind: "document", locator: "doc://real/booking" }],
  });
  const action = w.store.createProposedAction({
    id: "act-accept", bookingId: booking.id, kind: "create_provisional_hold",
    payload: {
      startAt: "2030-06-12T17:00:00.000Z", endAt: "2030-06-12T23:00:00.000Z",
      expiresAt: "2030-06-13T23:00:00.000Z", calendarId: "demo-calendar-001",
      emailTo: ["customer@example.test"], emailSubject: "Offer", emailBody: "Body.",
    },
    sourceReferences: [{ kind: "document", locator: "doc://real/proposal" }],
  });
  const delivery = new DeliveryStore(w.store.db);
  const issued = issueAcceptanceToken(delivery, {
    businessId: w.businessId, bookingId: booking.id,
    proposalVersion: action.proposalVersion, proposalFingerprint: action.proposalFingerprint,
    authorizedSender: "customer@example.test", mailbox: "events@venue.test",
    issuedAt: "2030-06-01T00:00:00.000Z", expiresAt: "2030-06-10T00:00:00.000Z", keyVersion: "v1",
  }, KEYRING);
  const token = decodeURIComponent(issued.mailto).match(/gather-token=[^&]+/)?.[0] ?? "";
  return { booking, action, token };
}

function inboundMessage(body: string, from = "Customer <customer@example.test>") {
  return {
    id: "msg-1", threadId: "thread-1", from, to: ["events@venue.test"],
    subject: "Re: offer", body, receivedAt: "2030-06-02T00:00:00.000Z",
    sourceReferences: [{ kind: "email" as const, locator: "gmail://thread-1/msg-1" }],
  };
}

test("006 callback: non-token mail is ignored; missing keyring never validates", async () => {
  const w = world();
  try {
    const { token } = seedTokenWorld(w);
    const validator = createLiveAcceptanceValidator({ store: w.store, keyring: KEYRING, liveTransport: true });
    assert.deepEqual(await validator({ message: inboundMessage("yes, we accept, see you then!") }), { outcome: "ignored" });
    // Without the original offer-send receipt the token reply is review
    // (proven in the next test); without a keyring it is ignored entirely.
    const noKey = createLiveAcceptanceValidator({ store: w.store, liveTransport: true });
    assert.deepEqual(await noKey({ message: inboundMessage(token) }), { outcome: "ignored" });
  } finally {
    w.cleanup();
  }
});

test("006 callback: missing original send receipt is review, never acceptance", async () => {
  const w = world();
  try {
    const { token, action } = seedTokenWorld(w);
    // No email provider receipt persisted for the exact action step: the
    // original offer-send cannot be proven, so this is review — not accepted.
    const validator = createLiveAcceptanceValidator({ store: w.store, keyring: KEYRING, liveTransport: true });
    const outcome = await validator({ message: inboundMessage(token) });
    assert.equal(outcome.outcome, "review");

    // Persist the exact email-step provider receipt: now it accepts.
    w.store.saveProviderReceipt("email", emailOperationKey(action.id, action.proposalVersion), {
      sentEmail: {
        messageId: "live-msg-1", operationKey: emailOperationKey(action.id, action.proposalVersion),
        to: ["customer@example.test"], cc: [], subject: "Offer", body: "Body.",
        sentAt: NOW, sourceReferences: [],
      },
      provenance: [],
    });
    const accepted = await validator({ message: inboundMessage(token) });
    assert.deepEqual(accepted, { outcome: "accepted", bookingId: "bk-accept" });
  } finally {
    w.cleanup();
  }
});

test("006 callback: non-live transport fails authentication closed (review)", async () => {
  const w = world();
  try {
    const { token } = seedTokenWorld(w);
    const prepared = createLiveAcceptanceValidator({ store: w.store, keyring: KEYRING, liveTransport: false });
    const outcome = await prepared({ message: inboundMessage(token) });
    assert.equal(outcome.outcome, "review");
  } finally {
    w.cleanup();
  }
});

test("006 wiring gate: prepared never wires; live wires only on a passing gate", () => {
  assert.equal(liveAcceptanceWired({ mode: "prepared", liveGatePasses: true }), false);
  assert.equal(liveAcceptanceWired({ mode: "live", liveGatePasses: false }), false);
  assert.equal(liveAcceptanceWired({ mode: "live", liveGatePasses: true }), true);
});

// ---------- Durable intent progress: same authority, persisted handle ----------

test("006 intents: approve via the durable lane completes with identical receipts", async () => {
  const w = world();
  try {
    seedDemoFixtures(w.store);
    const intents = new IntentService({ booking: w.deps, mode: "prepared", now: () => new Date().toISOString() });
    const workspace = getWorkspace(w.store, { ownerId: "test-owner" });
    const clara = workspace.bookings[0];
    const action = w.store.getCurrentProposalAction(clara.booking.id);
    assert.ok(action);
    const { intent, duplicate } = intents.enqueue({
      command: {
        kind: "approve_booking_proposal",
        bookingId: clara.booking.id,
        proposedActionId: action.id,
        proposalVersion: action.proposalVersion,
        proposalFingerprint: action.proposalFingerprint,
      },
    });
    assert.equal(duplicate, false);
    const settled = await intents.drive(intent.id, "http-api");
    assert.equal(settled.state, "completed");
    // Identical outcome to the sync path: provisional hold, never confirmed.
    assert.equal(w.store.getBooking(clara.booking.id).status, "provisional_hold");
    const dto = intents.toDTO(settled);
    assert.ok(dto.steps.length > 0);
    assert.ok(dto.steps.every((step) => step.status === "done"));
  } finally {
    w.cleanup();
  }
});

test("006 intents: stale version is rejected at enqueue — same STALE mapping", async () => {
  const w = world();
  try {
    seedDemoFixtures(w.store);
    const intents = new IntentService({ booking: w.deps, mode: "prepared", now: () => new Date().toISOString() });
    const workspace = getWorkspace(w.store, { ownerId: "test-owner" });
    const clara = workspace.bookings[0];
    const action = w.store.getCurrentProposalAction(clara.booking.id);
    assert.ok(action);
    assert.throws(
      () =>
        intents.enqueue({
          command: {
            kind: "approve_booking_proposal",
            bookingId: clara.booking.id,
            proposedActionId: action.id,
            proposalVersion: action.proposalVersion + 1,
            proposalFingerprint: action.proposalFingerprint,
          },
        }),
      /Stale proposal|version/i,
    );
  } finally {
    w.cleanup();
  }
});

// ---------- DTO preservation + mode-switch hygiene ----------

test("006 DTO: exact approval still binds; request identity never carries owner", () => {
  const input = parseApproveBody(
    { bookingId: "bk-1", proposedActionId: "act-1", proposalVersion: 2, proposalFingerprint: "a".repeat(64), approvedBy: "mallory", intent: true },
    "bk-1",
  );
  assert.deepEqual(Object.keys(input).sort(), ["bookingId", "proposalFingerprint", "proposalVersion", "proposedActionId"]);
});

test("006 hygiene: fixture approval stays demo; workspace payload carries no secrets", async () => {
  const w = world();
  try {
    seedDemoFixtures(w.store);
    const workspace = getWorkspace(w.store, { ownerId: "test-owner" });
    const clara = workspace.bookings[0];
    const action = w.store.getCurrentProposalAction(clara.booking.id);
    assert.ok(action);
    const response = await approveAndExecute(w.deps, {
      bookingId: clara.booking.id,
      proposedActionId: action.id,
      proposalVersion: action.proposalVersion,
      proposalFingerprint: action.proposalFingerprint,
    });
    assert.equal(response.demo, true);
    assert.equal(response.mode.kind, "demo");
    assert.equal(response.confirmedBooking, false);
    const serialized = JSON.stringify(getWorkspace(w.store, { ownerId: "test-owner" }));
    assert.doesNotMatch(serialized, /"token"|"secret"|"password"|"credential"|"apiKey"|"privateKey"/i);
  } finally {
    w.cleanup();
  }
});
