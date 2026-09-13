import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import type {
  CalendarAvailabilityReader,
  CheckAvailabilityRequest,
  CheckAvailabilityResponse,
  ConnectorMetadata,
  ConnectorResult,
} from "../src/connectors/contracts.ts";
import { ServiceError } from "../src/server/booking-service.ts";
import {
  confirmBooking,
  confirmRequestHash,
  handoffForBooking,
  readinessForBooking,
} from "../src/server/booking-delivery/service.ts";
import type { BookingDeliveryDeps } from "../src/server/booking-delivery/service.ts";
import { DeliveryStore } from "../src/server/booking-delivery/store.ts";
import { GatherStore } from "../src/server/sqlite-store.ts";
import type { ConfirmationPolicy } from "../src/delivery/contracts.ts";
import type { SourceReference } from "../src/domain/contracts.ts";

// Fixture-only proofs are clearly separated from "live" (verified) receipt
// evidence: fixture refs carry fictional:true and can never produce
// live-ready confirmation.
const NOW = "2030-05-01T12:00:00.000Z";
const START = "2030-06-12T17:00:00.000Z";
const END = "2030-06-12T23:00:00.000Z";

function liveRef(locator: string): SourceReference {
  return { kind: "calendar", locator };
}

function fixtureRef(locator: string): SourceReference {
  return { kind: "fixture", locator, fictional: true };
}

function payload(): Record<string, unknown> {
  return {
    startAt: START,
    endAt: END,
    calendarId: "cal-1",
    services: [{ name: "Plated dinner" }],
    responsibilities: [{ party: "House captain", task: "Run of show" }],
  };
}

function coveringCalendar(fictional: boolean): CalendarAvailabilityReader {
  const refs = fictional ? [fixtureRef("cal://slot")] : [liveRef("cal://slot")];
  return {
    async checkAvailability(request: CheckAvailabilityRequest): Promise<ConnectorResult<CheckAvailabilityResponse>> {
      const metadata: ConnectorMetadata = fictional
        ? { operationKey: request.operationKey, sourceReferences: refs, mode: { mode: "demo", label: "DEMO ONLY", fictional: true }, simulated: true }
        : { operationKey: request.operationKey, sourceReferences: refs, mode: { mode: "live", label: "LIVE", fictional: false }, simulated: false };
      return {
        status: "succeeded",
        metadata,
        data: {
          slots: [{
            slotId: "slot-cover",
            calendarId: request.calendarId,
            startAt: "2030-06-12T00:00:00.000Z",
            endAt: "2030-06-13T00:00:00.000Z",
            available: true,
            sourceReferences: refs,
          }],
          provenance: refs,
        },
      };
    },
  };
}

interface Setup {
  dir: string;
  path: string;
  store: GatherStore;
  delivery: DeliveryStore;
  deps: BookingDeliveryDeps;
  businessId: string;
  bookingId: string;
  actionId: string;
  version: number;
  fingerprint: string;
  cleanup: () => void;
}

function setup(opts: { fictionalAvailability?: boolean; noCalendar?: boolean; fictional?: boolean } = {}): Setup {
  const fictional = opts.fictional ?? false;
  const dir = mkdtempSync(join(tmpdir(), "gather-bd-"));
  const path = join(dir, "gather.sqlite");
  const store = new GatherStore(path);
  const delivery = new DeliveryStore(store.db);
  const deps: BookingDeliveryDeps = {
    store,
    delivery,
    calendar: opts.noCalendar ? undefined : coveringCalendar(opts.fictionalAvailability ?? fictional),
    ownerId: "test-owner",
    now: () => NOW,
  };
  const entityRef = fictional ? fixtureRef : liveRef;
  const business = store.createBusiness({ name: "Fictional Test Hall", timezone: "UTC" });
  const booking = store.createBooking({
    businessId: business.id,
    eventName: "Fictional wedding",
    status: "provisional_hold",
    startAt: START,
    endAt: END,
    guestCount: 80,
    sourceReferences: [entityRef("booking://1")],
  });
  const action = store.createProposedAction({
    bookingId: booking.id,
    kind: "create_provisional_hold",
    payload: payload(),
    sourceReferences: [entityRef("proposal://1")],
  });
  // Drive the existing prepare/approve contract: the exact-version owner
  // approval that confirm's authority gate requires.
  store.approveProposedAction(action.id, "test-owner");
  return {
    dir,
    path,
    store,
    delivery,
    deps,
    businessId: business.id,
    bookingId: booking.id,
    actionId: action.id,
    version: action.proposalVersion,
    fingerprint: action.proposalFingerprint,
    cleanup: () => {
      try {
        store.close();
      } catch {
        // Already closed (restart test).
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function fullPolicy(): ConfirmationPolicy {
  return {
    businessId: "",
    conditions: [
      { kind: "customer_acceptance", required: true },
      { kind: "deposit", required: true, deposit: { requiredAmountCents: 50000, currency: "USD" } },
      { kind: "availability", required: true },
      { kind: "resource_commitment", required: true, resources: { requiredResourceIds: ["room-a"] } },
    ],
  };
}

function seedLiveEvidence(s: Setup): void {
  const policy = fullPolicy();
  policy.businessId = s.businessId;
  s.delivery.savePolicy(policy);
  s.delivery.recordAcceptance({
    businessId: s.businessId,
    bookingId: s.bookingId,
    proposalVersion: s.version,
    proposalFingerprint: s.fingerprint,
    acceptedAt: "2030-04-30T10:00:00.000Z",
    acceptedBy: "customer@example.test",
    sourceRefs: [liveRef("acceptance://1")],
  });
  s.delivery.recordDepositReceipt({
    businessId: s.businessId,
    bookingId: s.bookingId,
    receiptId: "rcpt-1",
    amountCents: 60000,
    currency: "USD",
    status: "settled",
    observedAt: "2030-05-01T11:30:00.000Z",
    sourceRefs: [liveRef("ledger://rcpt-1")],
  });
  s.delivery.recordResourceCommitment({
    businessId: s.businessId,
    bookingId: s.bookingId,
    resourceId: "room-a",
    proposalVersion: s.version,
    proposalFingerprint: s.fingerprint,
    status: "committed",
    startAt: "2030-06-12T16:00:00.000Z",
    endAt: "2030-06-13T00:00:00.000Z",
    observedAt: "2030-05-01T11:30:00.000Z",
    sourceRefs: [liveRef("registry://room-a")],
  });
}

function confirmInput(s: Setup, confirmKey = "cmd-1") {
  return {
    bookingId: s.bookingId,
    proposedActionId: s.actionId,
    proposalVersion: s.version,
    proposalFingerprint: s.fingerprint,
    confirmKey,
  };
}

test("guarded confirm: full live evidence transitions the booking to confirmed and persists the decision", async () => {
  const s = setup();
  try {
    seedLiveEvidence(s);
    const readiness = await readinessForBooking(s.deps, s.bookingId);
    assert.equal(readiness.decision.ready, true);
    assert.equal(readiness.decision.liveReady, true);
    assert.equal(readiness.decision.provenance, "live");

    const response = await confirmBooking(s.deps, confirmInput(s));
    assert.equal(response.confirmedBooking, true);
    assert.equal(response.command.status, "confirmed");
    assert.equal(s.store.getBooking(s.bookingId).status, "confirmed");

    // The evaluated decision is durably persisted against the binding.
    const persisted = s.delivery.latestDecisionForAction(s.actionId, s.version);
    assert.ok(persisted);
    assert.equal(persisted.ready, true);
    assert.equal(persisted.binding.proposalFingerprint, s.fingerprint);
  } finally {
    s.cleanup();
  }
});

test("canonical replay: the same confirm key returns the persisted command without re-evaluating", async () => {
  const s = setup();
  try {
    seedLiveEvidence(s);
    const first = await confirmBooking(s.deps, confirmInput(s));
    const second = await confirmBooking(s.deps, confirmInput(s));
    assert.equal(second.command.status, "confirmed");
    assert.equal(second.confirmedBooking, true);
    assert.match(second.note, /replay/i);
    assert.deepEqual(second.decision?.binding, first.decision?.binding);
  } finally {
    s.cleanup();
  }
});

test("same confirm key bound to different inputs conflicts; in-progress commands report concurrency", async () => {
  const s = setup();
  try {
    seedLiveEvidence(s);
    await confirmBooking(s.deps, confirmInput(s));
    await assert.rejects(
      confirmBooking(s.deps, { ...confirmInput(s), proposalFingerprint: "f".repeat(64) }),
      (error: unknown) => error instanceof ServiceError && error.code === "STALE_PROPOSAL",
    );
    // Same key bound to a different request: non-retryable conflict.
    s.delivery.reserveConfirmCommand({
      confirmKey: "cmd-conflict",
      bookingId: s.bookingId,
      proposedActionId: s.actionId,
      proposalVersion: s.version,
      proposalFingerprint: s.fingerprint,
      requestHash: "different-hash",
      leaseMs: 120_000,
      nowMs: Date.parse(NOW),
    });
    await assert.rejects(
      confirmBooking(s.deps, { ...confirmInput(s), confirmKey: "cmd-conflict" }),
      (error: unknown) => error instanceof ServiceError && error.code === "CONFLICT" && error.retryable === false,
    );
    // Same key + same request still in progress: retryable concurrency.
    const requestHash = confirmRequestHash(confirmInput(s));
    s.delivery.reserveConfirmCommand({
      confirmKey: "cmd-busy",
      bookingId: s.bookingId,
      proposedActionId: s.actionId,
      proposalVersion: s.version,
      proposalFingerprint: s.fingerprint,
      requestHash,
      leaseMs: 120_000,
      nowMs: Date.parse(NOW),
    });
    // Keep the forged in-progress row live under the injected clock: its
    // persisted updated_at must sit inside the service's lease window.
    s.delivery.db.prepare("UPDATE delivery_confirm_commands SET updated_at = $now WHERE confirm_key = 'cmd-busy'").run({ $now: NOW });
    await assert.rejects(
      confirmBooking(s.deps, { ...confirmInput(s), confirmKey: "cmd-busy" }),
      (error: unknown) => error instanceof ServiceError && error.code === "CONFLICT" && error.retryable === true,
    );
  } finally {
    s.cleanup();
  }
});

test("stale version and missing live approval are refused before any transition", async () => {
  const s = setup();
  try {
    seedLiveEvidence(s);
    await assert.rejects(
      confirmBooking(s.deps, { ...confirmInput(s), proposalVersion: s.version + 1 }),
      (error: unknown) => error instanceof ServiceError && error.code === "STALE_PROPOSAL",
    );
    // Replace the proposal: approval is invalidated and the version moves.
    s.store.replaceProposedAction(s.actionId, { kind: "create_provisional_hold", payload: payload(), sourceReferences: [liveRef("proposal://2")] });
    await assert.rejects(
      confirmBooking(s.deps, { ...confirmInput(s), proposalVersion: s.version + 1, proposalFingerprint: s.fingerprint }),
      (error: unknown) => error instanceof ServiceError && error.code === "STALE_PROPOSAL",
    );
    assert.equal(s.store.getBooking(s.bookingId).status, "provisional_hold");
  } finally {
    s.cleanup();
  }
});

test("fixture provenance can never confirm a real booking: ready but not live-ready blocks", async () => {
  const s = setup({ fictional: true });
  try {
    const policy = fullPolicy();
    policy.businessId = s.businessId;
    s.delivery.savePolicy(policy);
    s.delivery.recordAcceptance({
      businessId: s.businessId,
      bookingId: s.bookingId,
      proposalVersion: s.version,
      proposalFingerprint: s.fingerprint,
      acceptedAt: "2030-04-30T10:00:00.000Z",
      sourceRefs: [fixtureRef("acceptance://demo")],
    });
    s.delivery.recordDepositReceipt({
      businessId: s.businessId,
      bookingId: s.bookingId,
      receiptId: "rcpt-demo",
      amountCents: 60000,
      currency: "USD",
      status: "settled",
      observedAt: "2030-05-01T11:30:00.000Z",
      sourceRefs: [fixtureRef("ledger://demo")],
    });
    s.delivery.recordResourceCommitment({
      businessId: s.businessId,
      bookingId: s.bookingId,
      resourceId: "room-a",
      proposalVersion: s.version,
      proposalFingerprint: s.fingerprint,
      status: "committed",
      startAt: "2030-06-12T16:00:00.000Z",
      endAt: "2030-06-13T00:00:00.000Z",
      observedAt: "2030-05-01T11:30:00.000Z",
      sourceRefs: [fixtureRef("registry://demo")],
    });
    const readiness = await readinessForBooking(s.deps, s.bookingId);
    assert.equal(readiness.decision.ready, true);
    assert.equal(readiness.decision.liveReady, false);
    assert.equal(readiness.decision.provenance, "demo");

    const response = await confirmBooking(s.deps, confirmInput(s));
    assert.equal(response.confirmedBooking, false);
    assert.equal(response.command.status, "blocked");
    assert.equal(s.store.getBooking(s.bookingId).status, "provisional_hold");
  } finally {
    s.cleanup();
  }
});

test("missing evidence, revoked acceptance, and net-refunded deposits all block", async () => {
  const s = setup();
  try {
    const policy = fullPolicy();
    policy.businessId = s.businessId;
    s.delivery.savePolicy(policy);
    // No evidence at all → missing conditions.
    const none = await confirmBooking(s.deps, confirmInput(s, "cmd-none"));
    assert.equal(none.confirmedBooking, false);
    assert.equal(s.store.getBooking(s.bookingId).status, "provisional_hold");

    // Revoked acceptance + fully refunded deposit.
    s.delivery.recordAcceptance({
      businessId: s.businessId,
      bookingId: s.bookingId,
      proposalVersion: s.version,
      proposalFingerprint: s.fingerprint,
      acceptedAt: "2030-04-30T10:00:00.000Z",
      revoked: true,
      sourceRefs: [liveRef("acceptance://revoked")],
    });
    s.delivery.recordDepositReceipt({
      businessId: s.businessId,
      bookingId: s.bookingId,
      receiptId: "rcpt-refunded",
      amountCents: 60000,
      currency: "USD",
      status: "settled",
      refundedCents: 60000,
      observedAt: "2030-05-01T11:30:00.000Z",
      sourceRefs: [liveRef("ledger://refunded")],
    });
    const blocked = await confirmBooking(s.deps, confirmInput(s, "cmd-blocked"));
    assert.equal(blocked.confirmedBooking, false);
    assert.ok(blocked.decision?.blockedBy.some((entry) => entry.includes("customer_acceptance")));
    assert.ok(blocked.decision?.blockedBy.some((entry) => entry.includes("deposit")));
  } finally {
    s.cleanup();
  }
});

test("a hold alone never confirms: availability-only evidence is blocked", async () => {
  const s = setup();
  try {
    const policy: ConfirmationPolicy = {
      businessId: s.businessId,
      conditions: [
        { kind: "customer_acceptance", required: true },
        { kind: "availability", required: true },
      ],
    };
    s.delivery.savePolicy(policy);
    // Only the availability proof exists — a hold alone is not confirmation.
    const response = await confirmBooking(s.deps, confirmInput(s));
    assert.equal(response.confirmedBooking, false);
    assert.ok(response.decision?.blockedBy.some((entry) => entry.includes("customer_acceptance:missing")));
  } finally {
    s.cleanup();
  }
});

test("stale-proof revalidation fails closed: proposal drift and evidence drift abort the commit", async () => {
  const s = setup();
  try {
    seedLiveEvidence(s);
    // Simulate the proposal being replaced between evaluation and commit.
    s.deps.beforeCommitRevalidation = () => {
      s.store.replaceProposedAction(s.actionId, { kind: "create_provisional_hold", payload: payload(), sourceReferences: [liveRef("proposal://drift")] });
    };
    await assert.rejects(
      confirmBooking(s.deps, confirmInput(s, "cmd-drift")),
      (error: unknown) => error instanceof ServiceError && error.code === "STALE_PROPOSAL",
    );
    assert.notEqual(s.store.getBooking(s.bookingId).status, "confirmed");

    // Simulate acceptance evidence changing mid-flight (a new record arrives).
    const s2 = setup();
    try {
      seedLiveEvidence(s2);
      s2.deps.beforeCommitRevalidation = () => {
        s2.delivery.recordAcceptance({
          businessId: s2.businessId,
          bookingId: s2.bookingId,
          proposalVersion: s2.version,
          proposalFingerprint: s2.fingerprint,
          acceptedAt: "2030-04-30T11:00:00.000Z",
          sourceRefs: [liveRef("acceptance://late")],
        });
      };
      await assert.rejects(
        confirmBooking(s2.deps, confirmInput(s2, "cmd-drift2")),
        (error: unknown) => error instanceof ServiceError && error.code === "CONFLICT",
      );
      assert.notEqual(s2.store.getBooking(s2.bookingId).status, "confirmed");
    } finally {
      s2.cleanup();
    }
  } finally {
    s.cleanup();
  }
});

test("handoff ties services, responsibilities, and outstanding items to the accepted version with revisions", async () => {
  const s = setup();
  try {
    seedLiveEvidence(s);
    await confirmBooking(s.deps, confirmInput(s));
    const first = await handoffForBooking(s.deps, s.bookingId);
    assert.equal(first.revision, 1);
    assert.equal(first.handoff.binding.proposalVersion, s.version);
    assert.equal(first.handoff.binding.proposalFingerprint, s.fingerprint);
    assert.equal(first.handoff.ready, true);
    assert.deepEqual(first.handoff.services.map((svc) => svc.name), ["Plated dinner"]);
    assert.deepEqual(first.handoff.responsibilities.map((entry) => entry.party), ["House captain"]);
    assert.equal(first.handoff.event.guestCount, 80);
    const second = await handoffForBooking(s.deps, s.bookingId);
    assert.equal(second.revision, 2);
  } finally {
    s.cleanup();
  }
});

test("restart persistence: decisions, commands, and handoff revisions survive a new store connection", async () => {
  const s = setup();
  try {
    seedLiveEvidence(s);
    await confirmBooking(s.deps, confirmInput(s));
    await handoffForBooking(s.deps, s.bookingId);
    s.store.close();

    const reopened = new GatherStore(s.path);
    const delivery2 = new DeliveryStore(reopened.db);
    const deps2: BookingDeliveryDeps = { ...s.deps, store: reopened, delivery: delivery2 };
    const replay = await confirmBooking(deps2, confirmInput(s));
    assert.equal(replay.command.status, "confirmed");
    assert.match(replay.note, /replay/i);
    assert.equal(reopened.getBooking(s.bookingId).status, "confirmed");
    const handoff = await handoffForBooking(deps2, s.bookingId);
    assert.equal(handoff.revision, 2);
    reopened.close();
  } finally {
    s.cleanup();
  }
});

test("readiness is read-only and a cancelled booking can never be confirmed", async () => {
  const s = setup();
  try {
    seedLiveEvidence(s);
    await readinessForBooking(s.deps, s.bookingId);
    assert.equal(s.delivery.latestDecisionForAction(s.actionId, s.version), undefined);

    s.store.updateBookingStatus(s.bookingId, "cancelled");
    const response = await confirmBooking(s.deps, confirmInput(s));
    assert.equal(response.confirmedBooking, false);
    assert.ok(response.decision?.blockedBy.some((entry) => entry.includes("cancelled")));
    assert.equal(s.store.getBooking(s.bookingId).status, "cancelled");
  } finally {
    s.cleanup();
  }
});
