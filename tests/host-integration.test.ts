import assert from "node:assert/strict";
import { test } from "node:test";
import { createDemoConnectors } from "../src/connectors/demo.ts";
import { adaptWorkspace } from "../src/host/adapter.ts";
import {
  approveAndExecute,
  emailOperationKey,
  getWorkspace,
  reconcileExecution,
  retryFailedSteps,
  ServiceError,
  type BookingServiceDeps,
} from "../src/server/booking-service.ts";
import { demoFixtureSlots, seedDemoFixtures } from "../src/server/demo-fixtures.ts";
import { DurableDemoCalendar, DurableDemoEmail } from "../src/server/durable-demo-connectors.ts";
import type { WorkspaceDTO } from "../src/server/dto.ts";
import { GatherStore } from "../src/server/sqlite-store.ts";

function makeDeps(): BookingServiceDeps {
  const store = new GatherStore(":memory:");
  const connectors = createDemoConnectors({ calendarSlots: demoFixtureSlots() });
  const deps: BookingServiceDeps = {
    store,
    calendar: new DurableDemoCalendar(store, connectors.calendar),
    email: new DurableDemoEmail(store, connectors.email),
    ownerId: "test-owner",
    now: () => new Date().toISOString(),
  };
  seedDemoFixtures(store);
  return deps;
}

function adapted(deps: BookingServiceDeps): ReturnType<typeof adaptWorkspace> {
  const workspace: WorkspaceDTO = getWorkspace(deps.store, { ownerId: deps.ownerId });
  return adaptWorkspace(workspace as unknown as Parameters<typeof adaptWorkspace>[0]);
}

test("workspace adapts persisted demo bookings with exact proposal identity", () => {
  const deps = makeDeps();
  const view = adapted(deps);
  assert.equal(view.dataMode, "demo");
  assert.equal(view.bookings.length, 2);
  const clara = view.bookings[0];
  assert.equal(clara.status, "proposal-ready");
  assert.equal(clara.detail.proposal.id, "demo-proposal-clara-v1");
  assert.equal(clara.detail.proposal.version, 1);
  assert.match(clara.detail.proposal.fingerprint, /^[0-9a-f]{16,}$/);
  // Exact consequences are inspectable before approving.
  assert.equal(clara.detail.proposal.consequences.length, 3);
  assert.ok(clara.detail.proposal.consequences.some((step) => step.includes("Recheck availability")));
  assert.ok(clara.detail.proposal.consequences.some((step) => step.includes("provisional hold")));
});

test("exact approval produces provisional hold + separate email receipt, never confirmed", async () => {
  const deps = makeDeps();
  const before = adapted(deps);
  const clara = before.bookings[0];
  const identity = {
    bookingId: clara.id,
    proposedActionId: clara.detail.proposal.id,
    proposalVersion: clara.detail.proposal.version,
    proposalFingerprint: clara.detail.proposal.fingerprint,
  };
  const response = await approveAndExecute(deps, identity);
  assert.equal(response.confirmedBooking, false);
  assert.equal(response.booking.status, "provisional_hold");
  assert.equal(response.hold.execution.status, "succeeded");
  assert.equal(response.email?.execution.status, "succeeded");

  const after = adapted(deps);
  const updated = after.bookings.find((booking) => booking.id === clara.id);
  assert.equal(updated?.status, "provisional-hold");
  assert.equal(updated?.statusLabel, "Provisional hold");
  const receipts = updated?.detail.receipts ?? [];
  assert.equal(receipts.length, 2);
  assert.ok(receipts.every((receipt) => receipt.status === "succeeded"));
  assert.deepEqual(receipts.map((receipt) => receipt.label).sort(), ["Offer email", "Provisional hold"]);
  assert.equal(after.pendingApprovals.length, 0);
});

test("repeated approval reuses receipts and stale version is rejected", async () => {
  const deps = makeDeps();
  const view = adapted(deps);
  const clara = view.bookings[0];
  const identity = {
    bookingId: clara.id,
    proposedActionId: clara.detail.proposal.id,
    proposalVersion: clara.detail.proposal.version,
    proposalFingerprint: clara.detail.proposal.fingerprint,
  };
  const first = await approveAndExecute(deps, identity);
  const second = await approveAndExecute(deps, identity);
  // A repeated approval reuses the same step executions — nothing is resent.
  assert.equal(second.hold.execution.id, first.hold.execution.id);
  assert.equal(second.email?.execution.id, first.email?.execution.id);
  const executions = adapted(deps).bookings[0].detail.receipts ?? [];
  assert.equal(executions.length, 2);

  // Wrong version and wrong fingerprint are both rejected as stale.
  await assert.rejects(
    approveAndExecute(deps, { ...identity, proposalVersion: identity.proposalVersion + 1 }),
    (error: unknown) => error instanceof ServiceError && error.code === "STALE_PROPOSAL",
  );
  await assert.rejects(
    approveAndExecute(deps, { ...identity, proposalFingerprint: "0".repeat(64) }),
    (error: unknown) => error instanceof ServiceError && error.code === "STALE_PROPOSAL",
  );
});

test("uncertain email exposes reconcile recovery and heals to succeeded", async () => {
  const deps = makeDeps();
  const { store } = deps;
  const emailKey = emailOperationKey("demo-proposal-maya-v1", 1);

  // Simulate the real crash case: the provider write completed (its durable
  // receipt exists) but the response was lost, leaving the execution row
  // uncertain — exactly what reconcile is for. The step reservation requires
  // a live approval, so record one first (the approve call below re-approves
  // idempotently).
  store.approveProposedAction("demo-proposal-maya-v1", "test-owner");
  const reservation = store.reserveStepExecution("demo-proposal-maya-v1", 1, emailKey, {
    claimToken: "crash-sim",
    leaseMs: 120_000,
    nowMs: Date.now(),
  });
  const uncertain = store.markExecutionUncertain(
    reservation.execution.id,
    "Simulated lost provider response: outcome unknown until reconciled",
    { claimToken: "crash-sim" },
  );
  assert.equal(uncertain.status, "uncertain");
  store.saveProviderReceipt("email", emailKey, {
    sentEmail: {
      messageId: "demo-message-lost",
      operationKey: emailKey,
      to: ["maya-guest@example.test"],
      cc: [],
      subject: "DEMO ONLY: your Glasshouse launch proposal",
      body: "DEMO ONLY simulated offer for the fictional product launch on 2026-10-23.",
      sentAt: new Date().toISOString(),
      sourceReferences: [],
    },
    provenance: [],
  });

  const view = adapted(deps);
  const maya = view.bookings.find((booking) => booking.id === "demo-booking-maya-02");
  assert.ok(maya);
  // Approval halts honestly: the hold runs, then the uncertain email step
  // refuses to execute until reconciled.
  await assert.rejects(
    approveAndExecute(deps, {
      bookingId: maya.id,
      proposedActionId: maya.detail.proposal.id,
      proposalVersion: maya.detail.proposal.version,
      proposalFingerprint: maya.detail.proposal.fingerprint,
    }),
    (error: unknown) => error instanceof ServiceError && error.code === "RECONCILE_REQUIRED",
  );

  const uncertainView = adapted(deps);
  const uncertainBooking = uncertainView.bookings.find((booking) => booking.id === maya.id);
  const receipts = uncertainBooking?.detail.receipts ?? [];
  const holdReceipt = receipts.find((receipt) => receipt.label === "Provisional hold");
  const emailReceipt = receipts.find((receipt) => receipt.status === "uncertain");
  assert.equal(holdReceipt?.status, "succeeded");
  assert.ok(emailReceipt);
  assert.equal(emailReceipt.recoveryLabel, "Reconcile outcome");
  assert.equal(emailReceipt.executionId, uncertain.id);
  assert.match(emailReceipt.detail ?? "", /lost provider response/i);

  // Retry is refused while the step is uncertain.
  await assert.rejects(
    retryFailedSteps(deps, maya.detail.proposal.id),
    (error: unknown) => error instanceof ServiceError && error.code === "RECONCILE_REQUIRED",
  );

  const healed = await reconcileExecution(deps, emailReceipt.executionId);
  assert.equal(healed.execution.status, "succeeded");
  const healedView = adapted(deps);
  const healedBooking = healedView.bookings.find((booking) => booking.id === maya.id);
  assert.equal(healedBooking?.status, "provisional-hold");
  assert.ok(healedBooking?.detail.receipts?.every((receipt) => receipt.status === "succeeded"));
});
