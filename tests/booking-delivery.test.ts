import { mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
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
import { emailOperationKey, holdOperationKey, ServiceError } from "../src/server/booking-service.ts";
import {
  confirmBooking,
  confirmRequestHash,
  handoffForBooking,
  readinessForBooking,
  recordHandoff,
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

/**
 * Seed the approved proposal's canonical step executions (the durable rows
 * approveAndExecute writes under the hold/email operation keys). A status of
 * undefined seeds no row — confirming then fails the missing-step gate.
 */
function seedExecutedSteps(s: Setup, statuses: { hold?: string; email?: string } = { hold: "succeeded", email: "succeeded" }): void {
  const insert = (key: string, status: string): void => {
    s.store.db.prepare(`INSERT INTO action_executions
      (id, proposed_action_id, proposal_version, idempotency_key, attempt, status, started_at, completed_at)
      VALUES ($id, $actionId, $version, $key, 1, $status, $started, $completed)`).run({
      $id: randomUUID(),
      $actionId: s.actionId,
      $version: s.version,
      $key: key,
      $status: status,
      $started: NOW,
      $completed: status === "pending" ? null : NOW,
    });
  };
  if (statuses.hold) insert(holdOperationKey(s.actionId, s.version), statuses.hold);
  if (statuses.email) insert(emailOperationKey(s.actionId, s.version), statuses.email);
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
    seedExecutedSteps(s);
    const readiness = await readinessForBooking(s.deps, s.bookingId);
    assert.equal(readiness.decision.ready, true);
    assert.equal(readiness.decision.liveReady, true);
    assert.equal(readiness.decision.provenance, "live");
    // The demo/live marker is derived from the evidence, not hardcoded.
    assert.equal(readiness.demo, false);

    const response = await confirmBooking(s.deps, confirmInput(s));
    assert.equal(response.confirmedBooking, true);
    assert.equal(response.command.status, "confirmed");
    assert.equal(response.demo, false);
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
    seedExecutedSteps(s);
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
    seedExecutedSteps(s);
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
    assert.equal(readiness.demo, true);

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

test("handoff requires a live approval and confirmed binding; GET is read-only, POST builds numbered revisions", async () => {
  const s = setup();
  try {
    seedLiveEvidence(s);
    seedExecutedSteps(s);

    // Approved but not yet confirmed → preliminary, and no revision exists.
    const pre = await handoffForBooking(s.deps, s.bookingId);
    assert.equal(pre.state, "preliminary");
    assert.equal(pre.revision, null);
    assert.ok(pre.reason?.includes("not confirmed"));

    await confirmBooking(s.deps, confirmInput(s));

    // GET is read-only: repeated reads never create revisions.
    const read = await handoffForBooking(s.deps, s.bookingId);
    assert.equal(read.state, "ready");
    assert.equal(read.revision, null);
    assert.equal(read.demo, false);
    assert.equal(read.handoff?.binding.proposalVersion, s.version);
    assert.equal(read.handoff?.binding.proposalFingerprint, s.fingerprint);
    assert.equal(read.handoff?.ready, true);
    assert.deepEqual(read.handoff?.services.map((svc) => svc.name), ["Plated dinner"]);
    assert.deepEqual(read.handoff?.responsibilities.map((entry) => entry.party), ["House captain"]);
    assert.equal(read.handoff?.event.guestCount, 80);
    const readAgain = await handoffForBooking(s.deps, s.bookingId);
    assert.equal(readAgain.revision, null);

    // POST builds numbered revisions; GET then reports the latest.
    const built = await recordHandoff(s.deps, s.bookingId);
    assert.equal(built.revision, 1);
    const builtAgain = await recordHandoff(s.deps, s.bookingId);
    assert.equal(builtAgain.revision, 2);
    const afterBuild = await handoffForBooking(s.deps, s.bookingId);
    assert.equal(afterBuild.revision, 2);
  } finally {
    s.cleanup();
  }
});

test("handoff is explicitly blocked when the proposal has no live approval", async () => {
  const s = setup();
  try {
    seedLiveEvidence(s);
    s.store.db.prepare("UPDATE approvals SET status = 'invalidated' WHERE proposed_action_id = $id").run({ $id: s.actionId });
    const view = await handoffForBooking(s.deps, s.bookingId);
    assert.equal(view.state, "blocked");
    assert.equal(view.handoff, null);
    assert.equal(view.revision, null);
    assert.match(view.reason ?? "", /no live owner approval/i);
    // A blocked build persists nothing.
    const built = await recordHandoff(s.deps, s.bookingId);
    assert.equal(built.state, "blocked");
    assert.equal(built.revision, null);
  } finally {
    s.cleanup();
  }
});

test("restart persistence: decisions, commands, and handoff revisions survive a new store connection", async () => {
  const s = setup();
  try {
    seedLiveEvidence(s);
    seedExecutedSteps(s);
    await confirmBooking(s.deps, confirmInput(s));
    await recordHandoff(s.deps, s.bookingId);
    s.store.close();

    const reopened = new GatherStore(s.path);
    const delivery2 = new DeliveryStore(reopened.db);
    const deps2: BookingDeliveryDeps = { ...s.deps, store: reopened, delivery: delivery2 };
    const replay = await confirmBooking(deps2, confirmInput(s));
    assert.equal(replay.command.status, "confirmed");
    assert.match(replay.note, /replay/i);
    assert.equal(reopened.getBooking(s.bookingId).status, "confirmed");
    const built = await recordHandoff(deps2, s.bookingId);
    assert.equal(built.revision, 2);
    const read = await handoffForBooking(deps2, s.bookingId);
    assert.equal(read.revision, 2);
    assert.equal(read.state, "ready");
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

test("confirm requires succeeded hold AND email executions for the exact approved version", async () => {
  const s = setup();
  try {
    seedLiveEvidence(s);
    // No executions at all — the reproduced defect: everything else verified,
    // but the approved steps never ran. Confirmation must refuse.
    await assert.rejects(
      confirmBooking(s.deps, confirmInput(s, "cmd-none")),
      (error: unknown) => error instanceof ServiceError && error.code === "CONFLICT" && /hold/i.test(error.message),
    );
    assert.notEqual(s.store.getBooking(s.bookingId).status, "confirmed");

    // Hold succeeded but the email step never ran — still refused.
    seedExecutedSteps(s, { hold: "succeeded" });
    await assert.rejects(
      confirmBooking(s.deps, confirmInput(s, "cmd-no-email")),
      (error: unknown) => error instanceof ServiceError && error.code === "CONFLICT" && /email/i.test(error.message),
    );
    assert.notEqual(s.store.getBooking(s.bookingId).status, "confirmed");
  } finally {
    s.cleanup();
  }
});

test("pending, failed, and uncertain step executions all refuse confirmation", async () => {
  for (const statuses of [
    { hold: "succeeded", email: "pending" },
    { hold: "succeeded", email: "uncertain" },
    { hold: "succeeded", email: "partial" },
    { hold: "failed", email: "succeeded" },
  ]) {
    const s = setup();
    try {
      seedLiveEvidence(s);
      seedExecutedSteps(s, statuses);
      const emailPending = statuses.email === "pending" || statuses.email === "uncertain" || statuses.email === "partial";
      await assert.rejects(
        confirmBooking(s.deps, confirmInput(s)),
        (error: unknown) =>
          error instanceof ServiceError &&
          error.code === "CONFLICT" &&
          error.retryable === emailPending,
      );
      assert.notEqual(s.store.getBooking(s.bookingId).status, "confirmed");
    } finally {
      s.cleanup();
    }
  }
});

test("executions for a superseded version never satisfy the current proposal", async () => {
  const s = setup();
  try {
    seedLiveEvidence(s);
    // Executions exist for v1 only — then the proposal is replaced (v2).
    seedExecutedSteps(s);
    s.store.replaceProposedAction(s.actionId, { kind: "create_provisional_hold", payload: payload(), sourceReferences: [liveRef("proposal://v2")] });
    const v2 = s.store.getProposedAction(s.actionId);
    s.store.approveProposedAction(s.actionId, "test-owner");
    // Re-bind the evidence to the new version.
    s.delivery.recordAcceptance({
      businessId: s.businessId,
      bookingId: s.bookingId,
      proposalVersion: v2.proposalVersion,
      proposalFingerprint: v2.proposalFingerprint,
      acceptedAt: "2030-05-01T10:00:00.000Z",
      sourceRefs: [liveRef("acceptance://v2")],
    });
    s.delivery.recordResourceCommitment({
      businessId: s.businessId,
      bookingId: s.bookingId,
      resourceId: "room-a",
      proposalVersion: v2.proposalVersion,
      proposalFingerprint: v2.proposalFingerprint,
      status: "committed",
      startAt: "2030-06-12T16:00:00.000Z",
      endAt: "2030-06-13T00:00:00.000Z",
      observedAt: "2030-05-01T11:30:00.000Z",
      sourceRefs: [liveRef("registry://v2")],
    });
    await assert.rejects(
      confirmBooking(s.deps, {
        bookingId: s.bookingId,
        proposedActionId: s.actionId,
        proposalVersion: v2.proposalVersion,
        proposalFingerprint: v2.proposalFingerprint,
        confirmKey: "cmd-v2",
      }),
      (error: unknown) => error instanceof ServiceError && error.code === "CONFLICT" && /no hold execution|no email execution/i.test(error.message),
    );
    assert.notEqual(s.store.getBooking(s.bookingId).status, "confirmed");
  } finally {
    s.cleanup();
  }
});

test("an expired in-progress lease is reclaimable exactly once", async () => {
  const s = setup();
  try {
    const requestHash = confirmRequestHash(confirmInput(s));
    const base = {
      confirmKey: "cmd-lease",
      bookingId: s.bookingId,
      proposedActionId: s.actionId,
      proposalVersion: s.version,
      proposalFingerprint: s.fingerprint,
      requestHash,
      leaseMs: 120_000,
    };
    const first = s.delivery.reserveConfirmCommand({ ...base, nowMs: Date.parse(NOW) });
    assert.equal(first.kind, "owned");
    // Expire the lease: a later caller reclaims it.
    s.delivery.db.prepare("UPDATE delivery_confirm_commands SET updated_at = $t WHERE confirm_key = 'cmd-lease'").run({
      $t: new Date(Date.parse(NOW) - 200_000).toISOString(),
    });
    const reclaimed = s.delivery.reserveConfirmCommand({ ...base, nowMs: Date.parse(NOW) });
    assert.equal(reclaimed.kind, "owned");
    // Align the reclaimed row's persisted timestamp with the injected clock:
    // reserveConfirmCommand writes wall-clock updated_at while the test clock
    // is fixed at NOW.
    s.delivery.db.prepare("UPDATE delivery_confirm_commands SET updated_at = $t WHERE confirm_key = 'cmd-lease'").run({ $t: NOW });
    // The reclaimed row is live again: the next caller sees in-progress.
    const next = s.delivery.reserveConfirmCommand({ ...base, nowMs: Date.parse(NOW) });
    assert.equal(next.kind, "in_progress");
  } finally {
    s.cleanup();
  }
});

/**
 * Mid-await drift harness: the injected availability provider mutates the
 * store exactly once while proofs are being verified, deterministically
 * reproducing the evaluation/commit race the handoff paths must fence.
 */
function driftingCalendar(s: Setup, mutate: () => void): CalendarAvailabilityReader {
  const inner = coveringCalendar(false);
  let fired = false;
  return {
    async checkAvailability(request: CheckAvailabilityRequest): Promise<ConnectorResult<CheckAvailabilityResponse>> {
      if (!fired) {
        fired = true;
        mutate();
      }
      return inner.checkAvailability(request);
    },
  };
}

function handoffRowCount(s: Setup, actionId?: string): number {
  const found = actionId
    ? s.delivery.db.prepare("SELECT COUNT(*) AS n FROM delivery_handoffs WHERE proposed_action_id = $id").get({ $id: actionId })
    : s.delivery.db.prepare("SELECT COUNT(*) AS n FROM delivery_handoffs").get();
  return (found as { n: number }).n;
}

/** Setup driven to a confirmed booking whose handoff evaluates ready. */
async function readySetup(): Promise<Setup> {
  const s = setup();
  seedLiveEvidence(s);
  seedExecutedSteps(s);
  const confirmed = await confirmBooking(s.deps, confirmInput(s));
  assert.equal(confirmed.confirmedBooking, true);
  return s;
}

test("handoff drift: mid-await approval invalidation blocks POST with nothing persisted", async () => {
  const s = await readySetup();
  try {
    const baseline = await recordHandoff(s.deps, s.bookingId);
    assert.equal(baseline.state, "ready");
    assert.equal(baseline.revision, 1);
    s.deps.calendar = driftingCalendar(s, () => {
      s.store.db.prepare("UPDATE approvals SET status = 'invalidated' WHERE proposed_action_id = $id").run({ $id: s.actionId });
    });
    const drifted = await recordHandoff(s.deps, s.bookingId);
    assert.equal(drifted.state, "blocked");
    assert.equal(drifted.handoff, null);
    assert.equal(drifted.revision, null);
    assert.match(drifted.reason ?? "", /invalidated/);
    assert.equal(handoffRowCount(s), 1);
    // GET after the drift reports the live blocked truth, never the old revision.
    const read = await handoffForBooking(s.deps, s.bookingId);
    assert.equal(read.state, "blocked");
    assert.equal(read.handoff, null);
    assert.equal(read.revision, null);
  } finally {
    s.cleanup();
  }
});

test("handoff drift: mid-await proposal replacement never persists the old view", async () => {
  const s = await readySetup();
  try {
    await recordHandoff(s.deps, s.bookingId);
    s.deps.calendar = driftingCalendar(s, () => {
      s.store.replaceProposedAction(s.actionId, { kind: "create_provisional_hold", payload: payload(), sourceReferences: [liveRef("proposal://drift")] });
    });
    const drifted = await recordHandoff(s.deps, s.bookingId);
    assert.equal(drifted.state, "blocked");
    assert.equal(drifted.handoff, null);
    assert.equal(drifted.revision, null);
    assert.match(drifted.reason ?? "", /proposal version changed/);
    // Exactly the baseline revision persists; no row carries the new version.
    assert.equal(handoffRowCount(s), 1);
    const newVersionRows = s.delivery.db.prepare("SELECT COUNT(*) AS n FROM delivery_handoffs WHERE proposal_version != $v").get({ $v: s.version });
    assert.equal((newVersionRows as { n: number }).n, 0);
  } finally {
    s.cleanup();
  }
});

test("handoff drift: a brand-new mid-await action never receives the old handoff", async () => {
  const s = await readySetup();
  try {
    await recordHandoff(s.deps, s.bookingId);
    let newActionId = "";
    s.deps.calendar = driftingCalendar(s, () => {
      newActionId = s.store.createProposedAction({
        bookingId: s.bookingId,
        kind: "create_provisional_hold",
        payload: payload(),
        sourceReferences: [liveRef("proposal://new-action")],
      }).id;
    });
    const drifted = await recordHandoff(s.deps, s.bookingId);
    assert.equal(drifted.state, "blocked");
    assert.equal(drifted.handoff, null);
    assert.match(drifted.reason ?? "", /proposed action changed/);
    assert.ok(newActionId.length > 0);
    assert.equal(handoffRowCount(s, newActionId), 0);
    assert.equal(handoffRowCount(s), 1);
  } finally {
    s.cleanup();
  }
});

test("handoff drift: mid-await booking cancel blocks POST with nothing persisted", async () => {
  const s = await readySetup();
  try {
    await recordHandoff(s.deps, s.bookingId);
    s.deps.calendar = driftingCalendar(s, () => {
      s.store.updateBookingStatus(s.bookingId, "cancelled");
    });
    const drifted = await recordHandoff(s.deps, s.bookingId);
    assert.equal(drifted.state, "blocked");
    assert.equal(drifted.handoff, null);
    assert.equal(drifted.revision, null);
    assert.match(drifted.reason ?? "", /booking status changed/);
    assert.equal(handoffRowCount(s), 1);
    assert.equal(s.store.getBooking(s.bookingId).status, "cancelled");
  } finally {
    s.cleanup();
  }
});

test("handoff drift: mid-await evidence change blocks POST with nothing persisted", async () => {
  const s = await readySetup();
  try {
    await recordHandoff(s.deps, s.bookingId);
    s.deps.calendar = driftingCalendar(s, () => {
      s.delivery.recordAcceptance({
        businessId: s.businessId,
        bookingId: s.bookingId,
        proposalVersion: s.version,
        proposalFingerprint: s.fingerprint,
        acceptedAt: "2030-04-30T11:00:00.000Z",
        sourceRefs: [liveRef("acceptance://late")],
      });
    });
    const drifted = await recordHandoff(s.deps, s.bookingId);
    assert.equal(drifted.state, "blocked");
    assert.equal(drifted.handoff, null);
    assert.equal(drifted.revision, null);
    assert.match(drifted.reason ?? "", /evidence changed/);
    assert.equal(handoffRowCount(s), 1);
  } finally {
    s.cleanup();
  }
});

test("GET pairs a revision only with byte-identical persisted content, never an old number", async () => {
  const s = await readySetup();
  try {
    const built = await recordHandoff(s.deps, s.bookingId);
    assert.equal(built.revision, 1);
    // Fresh GET with no drift reports the matching persisted revision.
    const matching = await handoffForBooking(s.deps, s.bookingId);
    assert.equal(matching.state, "ready");
    assert.equal(matching.revision, 1);
    // Replace the proposal with different services and approve it: the fresh
    // view is an unpersisted preview of the new content, not revision 1.
    const altered = { ...payload(), services: [{ name: "Late-night snacks" }] };
    s.store.replaceProposedAction(s.actionId, { kind: "create_provisional_hold", payload: altered, sourceReferences: [liveRef("proposal://v2")] });
    const v2 = s.store.getProposedAction(s.actionId);
    s.store.approveProposedAction(s.actionId, "test-owner");
    const before = handoffRowCount(s);
    const preview = await handoffForBooking(s.deps, s.bookingId);
    assert.equal(preview.revision, null);
    assert.deepEqual(preview.handoff?.services.map((svc) => svc.name), ["Late-night snacks"]);
    assert.equal(preview.handoff?.binding.proposalVersion, v2.proposalVersion);
    // GET persisted nothing: row count and the old revision are untouched.
    assert.equal(handoffRowCount(s), before);
    const latest = s.delivery.latestHandoff(s.actionId);
    assert.equal(latest?.revision, 1);
  } finally {
    s.cleanup();
  }
});

test("exported handoff views carry exactly the DTO fields, never internal binding", async () => {
  const s = await readySetup();
  try {
    for (const view of [await handoffForBooking(s.deps, s.bookingId), await recordHandoff(s.deps, s.bookingId)]) {
      assert.ok(!("binding" in view), "internal binding must not leak into exported DTOs");
      assert.ok(!("collecting" in view), "verifier internals must not leak into exported DTOs");
      assert.ok(view.handoff !== null);
    }
  } finally {
    s.cleanup();
  }
});

test("microtask-scheduled evidence mutation from verifier completion blocks POST", async () => {
  const s = await readySetup();
  try {
    await recordHandoff(s.deps, s.bookingId);
    const inner = coveringCalendar(false);
    let fired = false;
    s.deps.calendar = {
      async checkAvailability(request: CheckAvailabilityRequest): Promise<ConnectorResult<CheckAvailabilityResponse>> {
        const result = await inner.checkAvailability(request);
        if (!fired) {
          fired = true;
          // Land just after this collection returns: the mutation runs on
          // the microtask queue before evaluation finishes, so the drift
          // revalidation must catch it.
          queueMicrotask(() => {
            s.delivery.recordAcceptance({
              businessId: s.businessId,
              bookingId: s.bookingId,
              proposalVersion: s.version,
              proposalFingerprint: s.fingerprint,
              acceptedAt: "2030-04-30T12:00:00.000Z",
              acceptedBy: "customer@example.test",
              sourceRefs: [liveRef("acceptance://microtask")],
            });
          });
        }
        return result;
      },
    };
    const drifted = await recordHandoff(s.deps, s.bookingId);
    assert.equal(drifted.state, "blocked");
    assert.equal(drifted.handoff, null);
    assert.equal(drifted.revision, null);
    assert.match(drifted.reason ?? "", /evidence changed/);
    assert.equal(handoffRowCount(s), 1, "nothing new persisted");
  } finally {
    s.cleanup();
  }
});

test("evidence mutation at the transaction boundary blocks persist inside the transaction", async () => {
  const s = await readySetup();
  try {
    await recordHandoff(s.deps, s.bookingId);
    const original = s.delivery.transaction.bind(s.delivery);
    s.delivery.transaction = (<T>(work: () => T): T => {
      // Models a writer landing exactly between evaluation and commit
      // (cross-process or a future await): the in-transaction evidence
      // revalidation must refuse before insert.
      s.delivery.savePolicy({
        businessId: s.businessId,
        conditions: [
          { kind: "customer_acceptance", required: true },
          { kind: "deposit", required: true, deposit: { requiredAmountCents: 99999, currency: "USD" } },
        ],
      });
      return original(work);
    }) as typeof s.delivery.transaction;
    try {
      const drifted = await recordHandoff(s.deps, s.bookingId);
      assert.equal(drifted.state, "blocked");
      assert.equal(drifted.handoff, null);
      assert.equal(drifted.revision, null);
      assert.match(drifted.reason ?? "", /evidence changed/);
      assert.equal(handoffRowCount(s), 1, "nothing new persisted");
    } finally {
      s.delivery.transaction = original;
    }
  } finally {
    s.cleanup();
  }
});
