import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDemoConnectors } from "../src/connectors/demo.ts";
import { adaptWorkspace } from "../src/host/adapter.ts";
import { DtoValidationError, parseWorkspaceDTO, type WorkspaceDTO as ClientWorkspaceDTO } from "../src/host/dto.ts";
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

function baseWorkspace(): ClientWorkspaceDTO {
  return {
    mode: { kind: "demo", label: "DEMO ONLY" },
    demo: true,
    approvalIdentity: "test-owner",
    businesses: [
      { id: "biz-a", name: "Alpha Venue", timezone: "America/New_York" },
      { id: "biz-b", name: "Beta Venue", timezone: "Asia/Tokyo" },
    ],
    bookings: [],
    connections: [],
    notice: "test",
  };
}

function baseBooking(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    booking: {
      id: "bk-1",
      businessId: "biz-a",
      status: "pending_approval",
      eventName: "Test event",
      startAt: "2026-10-18T16:00:00.000Z",
      endAt: "2026-10-18T20:00:00.000Z",
      sourceReferences: [{ kind: "fixture", locator: "demo://fixture" }],
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
      ...overrides,
    },
    proposals: [
      {
        action: {
          id: "act-1",
          bookingId: "bk-1",
          kind: "create_provisional_hold",
          payload: {},
          proposalVersion: 2,
          proposalFingerprint: "f".repeat(64),
          sourceReferences: [],
          status: "proposed",
          createdAt: "2026-10-01T00:00:00.000Z",
          updatedAt: "2026-10-01T00:00:00.000Z",
        },
        consequences: null,
      },
    ],
    approvals: [],
    executions: [],
  };
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

test("the exact offer email is reviewable — to, subject, and full body", async () => {
  const deps = makeDeps();
  const view = adapted(deps);
  const clara = view.bookings[0];
  const preview = clara.detail.proposal.emailPreview;
  assert.ok(preview, "email preview should be present");
  assert.equal(preview.to, "clara-guest@example.test");
  assert.match(preview.subject, /Glasshouse dinner proposal/);
  assert.ok(preview.body.length > 20, "the full email body must be inspectable");
});

test("bookings map to their own business and timezone, never businesses[0]", () => {
  const workspace = baseWorkspace();
  const booking = baseBooking({ businessId: "biz-b" });
  (booking.booking as Record<string, unknown>).businessId = "biz-b";
  workspace.bookings = [booking] as unknown as ClientWorkspaceDTO["bookings"];
  const view = adaptWorkspace(workspace);
  assert.equal(view.bookings[0].venue, "Beta Venue");
  // 16:00Z is 01:00 next day in Tokyo — a wrong timezone would show 12:00 PM.
  assert.match(view.bookings[0].eventTime, /GMT\+9|JST/);
  // Every rendered timestamp carries an explicit timezone marker.
  assert.match(view.bookings[0].eventDate, /GMT\+9|JST/);
});

test("a pending step on an old version cannot block the new proposal", () => {
  const workspace = baseWorkspace();
  const booking = baseBooking();
  const staleExecution = {
    id: "exec-old",
    proposedActionId: "act-1",
    proposalVersion: 1, // older version than the displayed v2 proposal
    idempotencyKey: "gather:calendar:create-provisional-hold:old",
    status: "pending",
    startedAt: "2026-10-01T00:00:00.000Z",
  };
  (booking as Record<string, unknown>).executions = [staleExecution];
  workspace.bookings = [booking] as unknown as ClientWorkspaceDTO["bookings"];
  assert.deepEqual(adaptWorkspace(workspace).pendingApprovals, []);

  const currentExecution = { ...staleExecution, id: "exec-new", proposalVersion: 2 };
  (booking as Record<string, unknown>).executions = [currentExecution];
  const view = adaptWorkspace(workspace);
  assert.deepEqual(view.pendingApprovals, ["f".repeat(64)]);
  assert.equal(view.bookings[0].status, "waiting");
});

test("missing guest count and customer name stay absent, unknown kinds are unsupported", () => {
  const workspace = baseWorkspace();
  workspace.bookings = [baseBooking()] as unknown as ClientWorkspaceDTO["bookings"];
  workspace.connections = [
    { id: "conn-x", provider: "notion", displayName: "Notion", status: "connected", updatedAt: "2026-10-01T00:00:00.000Z" },
  ];
  const view = adaptWorkspace(workspace);
  assert.equal(view.bookings[0].guestCount, undefined);
  assert.equal(view.bookings[0].customerName, undefined);
  assert.equal(view.bookings[0].detail.proposal.sources.length, 0);
  const source = (view.bookings[0].detail.proposal.sources ?? [])[0];
  assert.equal(source, undefined);
  // Fixture booking source is not dressed up as a known type.
  const connection = view.connections[0];
  assert.equal(connection.provider, "unsupported");
  assert.equal(connection.connected, false);
  assert.match(connection.detail, /[Uu]nsupported/);
});

test("boundary validation rejects malformed mode, status, and demo correlation", () => {
  const workspace = baseWorkspace() as unknown as Record<string, unknown>;
  const badKind = { ...workspace, mode: { kind: "staging", label: "x" } };
  assert.throws(() => parseWorkspaceDTO(badKind), DtoValidationError);
  const liveDemo = { ...workspace, mode: { kind: "live", label: "x" }, demo: true };
  assert.throws(() => parseWorkspaceDTO(liveDemo), DtoValidationError);
  const demoFalse = { ...workspace, mode: { kind: "demo", label: "x" }, demo: false };
  assert.throws(() => parseWorkspaceDTO(demoFalse), DtoValidationError);
  const badExecution = baseWorkspace() as unknown as Record<string, unknown>;
  const booking = baseBooking();
  (booking as Record<string, unknown>).executions = [
    { id: "e", proposedActionId: "a", proposalVersion: 1, idempotencyKey: "k", status: "mystery", startedAt: "2026-01-01T00:00:00Z" },
  ];
  (badExecution as Record<string, unknown>).bookings = [booking];
  assert.throws(() => parseWorkspaceDTO(badExecution), DtoValidationError);
  const badBooking = baseBooking({ status: "half_booked" });
  const badStatus = baseWorkspace() as unknown as Record<string, unknown>;
  (badStatus as Record<string, unknown>).bookings = [badBooking];
  assert.throws(() => parseWorkspaceDTO(badStatus), DtoValidationError);
});

test("a send timeout after the hold still heals via the durable receipt", async () => {
  const timeoutKey = emailOperationKey("demo-proposal-clara-v1", 1);
  const store = new GatherStore(":memory:");
  const connectors = createDemoConnectors({
    calendarSlots: demoFixtureSlots(),
    timeoutAfterSuccessOperationKeys: [timeoutKey],
  });
  const deps: BookingServiceDeps = {
    store,
    calendar: new DurableDemoCalendar(store, connectors.calendar),
    email: new DurableDemoEmail(store, connectors.email),
    ownerId: "test-owner",
  };
  seedDemoFixtures(store);
  const view = adapted(deps);
  const clara = view.bookings[0];
  const response = await approveAndExecute(deps, {
    bookingId: clara.id,
    proposedActionId: clara.detail.proposal.id,
    proposalVersion: clara.detail.proposal.version,
    proposalFingerprint: clara.detail.proposal.fingerprint,
  });
  // The write completed at the provider before the timeout, so the inline
  // reconcile heals it — the owner sees an honest succeeded receipt.
  assert.equal(response.hold.execution.status, "succeeded");
  assert.equal(response.email?.execution.status, "succeeded");
  const after = adapted(deps);
  assert.ok(after.bookings[0].detail.receipts?.every((receipt) => receipt.status === "succeeded"));
});

test("a failed mutation still re-reads consistent workspace state", async () => {
  const deps = makeDeps();
  const view = adapted(deps);
  const clara = view.bookings[0];
  await assert.rejects(
    approveAndExecute(deps, {
      bookingId: clara.id,
      proposedActionId: clara.detail.proposal.id,
      proposalVersion: clara.detail.proposal.version + 9,
      proposalFingerprint: clara.detail.proposal.fingerprint,
    }),
    (error: unknown) => error instanceof ServiceError && error.code === "STALE_PROPOSAL",
  );
  // After the rejected mutation the workspace still reports the same state.
  const after = adapted(deps);
  assert.equal(after.bookings[0].status, "proposal-ready");
  assert.equal(after.bookings[0].detail.receipts?.length ?? 0, 0);
  assert.equal(after.bookings[0].detail.proposal.fingerprint, clara.detail.proposal.fingerprint);
});

// ---------- Authoritative offer snapshot (payload.offer) ----------

function offerSnapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    offerId: "offer-1",
    version: 1,
    rank: "primary",
    startAt: "2026-10-18T16:00:00.000Z",
    endAt: "2026-10-18T20:00:00.000Z",
    spaceId: "space-garden",
    spaceName: "Fictional Garden Room",
    guestCount: 80,
    currency: "USD",
    lines: [
      { lineId: "line-venue", label: "Venue hire", pricingBasis: "per_event", quantity: 1, unitCents: 250000, lineTotalCents: 250000, unknownUnit: false },
      { lineId: "line-dinner", label: "Plated dinner", pricingBasis: "per_guest", quantity: 80, unitCents: 9500, lineTotalCents: 760000, unknownUnit: false },
    ],
    totalCents: 1010000,
    totalKnown: true,
    depositCents: 252500,
    unknownCostIds: [],
    unknownPriceIds: [],
    profitabilityClaimed: true,
    consequences: ["50% deposit due on confirmation", "Final guest count due 7 days before the event"],
    sources: [{ kind: "fixture", locator: "demo://offer" }],
    fingerprint: "a".repeat(64),
    ...overrides,
  };
}

function bookingWithOffer(offer: unknown, extras: Record<string, unknown> = {}): Record<string, unknown> {
  const booking = baseBooking();
  const proposal = (booking as { proposals: { action: { payload: Record<string, unknown> } }[] }).proposals[0];
  proposal.action.payload = { offer, ...extras };
  return booking;
}

test("a valid offer snapshot renders exact priced lines, totals, space, and terms", () => {
  const workspace = baseWorkspace();
  workspace.bookings = [bookingWithOffer(offerSnapshot(), { offerPreparationFingerprint: "a".repeat(64) })] as unknown as ClientWorkspaceDTO["bookings"];
  const proposal = adaptWorkspace(workspace).bookings[0].detail.proposal;
  assert.equal(proposal.total, "$10,100.00");
  assert.equal(proposal.deposit, "Deposit $2,525.00");
  assert.equal(proposal.offerInvalid, undefined);
  assert.equal(proposal.offer?.spaceName, "Fictional Garden Room");
  assert.equal(proposal.offer?.guestCount, 80);
  assert.equal(proposal.offer?.preparationFingerprint, "a".repeat(64));
  assert.deepEqual(proposal.offer?.terms, ["50% deposit due on confirmation", "Final guest count due 7 days before the event"]);
  assert.deepEqual(
    proposal.lines.map((line) => [line.label, line.detail, line.amount]),
    [
      ["Venue hire", "1 × $2,500.00 per event", "$2,500.00"],
      ["Plated dinner", "80 × $95.00 per guest", "$7,600.00"],
    ],
  );
  // Approval still binds the action identity — never the offer snapshot.
  assert.equal(proposal.id, "act-1");
  assert.equal(proposal.version, 2);
});

test("unknown unit prices and unknown costs show honestly with no profit claim", () => {
  const workspace = baseWorkspace();
  workspace.bookings = [bookingWithOffer(offerSnapshot({
    lines: [
      { lineId: "line-venue", label: "Venue hire", pricingBasis: "per_event", quantity: 1, unitCents: 250000, lineTotalCents: 250000, unknownUnit: false },
      { lineId: "line-dinner", label: "Plated dinner", pricingBasis: "per_guest", quantity: 80, unitCents: null, lineTotalCents: null, unknownUnit: true },
    ],
    totalCents: null,
    totalKnown: false,
    depositCents: null,
    unknownCostIds: ["cost-staffing"],
    unknownPriceIds: ["line-dinner"],
    profitabilityClaimed: false,
  }))] as unknown as ClientWorkspaceDTO["bookings"];
  const proposal = adaptWorkspace(workspace).bookings[0].detail.proposal;
  assert.equal(proposal.total, "Total unknown");
  assert.equal(proposal.deposit, "Deposit not specified");
  assert.equal(proposal.offer?.profitabilityClaimed, false);
  assert.deepEqual(proposal.offer?.unknownCosts, ["cost-staffing"]);
  assert.deepEqual(proposal.offer?.unknownPrices, ["line-dinner"]);
  assert.equal(proposal.lines[1].detail.includes("unit price unknown"), true);
  assert.equal(proposal.lines[1].amount, "Unknown");
});

test("malformed, contradictory, or mismatched offers never render as priced or approvable", () => {
  const cases: Array<[string, unknown, Record<string, unknown>?]> = [
    ["non-finite total", offerSnapshot({ totalCents: Number.NaN })],
    ["non-integer cents", offerSnapshot({ totalCents: 100.5 })],
    ["bad currency", offerSnapshot({ currency: "usd" })],
    ["total/totalKnown contradiction", offerSnapshot({ totalCents: null })],
    ["profit claim with unknowns", offerSnapshot({ unknownCostIds: ["c1"] })],
    ["missing fingerprint", offerSnapshot({ fingerprint: undefined })],
    ["malformed line", offerSnapshot({ lines: [{ lineId: "l", label: "x" }] })],
    ["non-object offer", "not an offer"],
    ["malformed preparation fingerprint", offerSnapshot(), { offerPreparationFingerprint: "" }],
    ["empty lines", offerSnapshot({ lines: [] })],
    ["empty consequences", offerSnapshot({ consequences: [] })],
    ["empty sources", offerSnapshot({ sources: [] })],
    ["unsafe-integer total", offerSnapshot({ totalCents: Number.MAX_SAFE_INTEGER + 1 })],
  ];
  for (const [name, offer, extras] of cases) {
    const workspace = baseWorkspace();
    workspace.bookings = [bookingWithOffer(offer, extras)] as unknown as ClientWorkspaceDTO["bookings"];
    const proposal = adaptWorkspace(workspace).bookings[0].detail.proposal;
    assert.equal(proposal.offerInvalid, true, name);
    assert.equal(proposal.offer, undefined, name);
    assert.equal(proposal.total, "Not priced", name);
    assert.equal(proposal.deposit, "Not priced", name);
    assert.equal(proposal.lines.length, 0, name);
  }
});

test("distinct snapshot and preparation fingerprints validate as separate hashes", () => {
  // The candidate digest and the result-level preparation digest are
  // different values by construction; the adapter validates each
  // independently and never equates them. Binding the exact version stays
  // with the canonical action fingerprint at approval.
  const workspace = baseWorkspace();
  workspace.bookings = [bookingWithOffer(offerSnapshot(), { offerPreparationFingerprint: "b".repeat(64) })] as unknown as ClientWorkspaceDTO["bookings"];
  const proposal = adaptWorkspace(workspace).bookings[0].detail.proposal;
  assert.equal(proposal.offerInvalid, undefined);
  assert.equal(proposal.total, "$10,100.00");
  assert.equal(proposal.offer?.preparationFingerprint, "b".repeat(64));
});

test("a legacy proposal without an offer keeps the honest Not priced state", () => {
  const workspace = baseWorkspace();
  workspace.bookings = [baseBooking()] as unknown as ClientWorkspaceDTO["bookings"];
  const proposal = adaptWorkspace(workspace).bookings[0].detail.proposal;
  assert.equal(proposal.total, "Not priced");
  assert.equal(proposal.deposit, "Not priced");
  assert.equal(proposal.offer, undefined);
  assert.equal(proposal.offerInvalid, undefined);
});

test("an offer on an older proposal version never leaks onto the displayed latest", () => {
  const workspace = baseWorkspace();
  const booking = baseBooking();
  const proposals = (booking as { proposals: { action: Record<string, unknown>; consequences: null }[] }).proposals;
  proposals.push({
    action: {
      id: "act-2",
      bookingId: "bk-1",
      kind: "create_provisional_hold",
      payload: {}, // v3 carries no offer — the v2 offer must not leak
      proposalVersion: 3,
      proposalFingerprint: "e".repeat(64),
      sourceReferences: [],
      status: "proposed",
      createdAt: "2026-10-02T00:00:00.000Z",
      updatedAt: "2026-10-02T00:00:00.000Z",
    },
    consequences: null,
  });
  proposals[0].action.payload = { offer: offerSnapshot() };
  workspace.bookings = [booking] as unknown as ClientWorkspaceDTO["bookings"];
  const proposal = adaptWorkspace(workspace).bookings[0].detail.proposal;
  assert.equal(proposal.version, 3);
  assert.equal(proposal.offer, undefined);
  assert.equal(proposal.total, "Not priced");
});

// ---------- dataMode three-state chain: getWorkspace -> DTO -> adapt ----------

const LIVE_SRC = [{ kind: "calendar" as const, locator: "live-cal://slot-1" }];

function liveMeta(operationKey: string) {
  return { operationKey, mode: { mode: "live" as const, label: "LIVE" as const, fictional: false as const }, simulated: false as const, sourceReferences: LIVE_SRC };
}

/** Scripted live-shaped connectors (tests only): live metadata + non-fictional provenance. */
function liveConnectors() {
  const calendar = {
    checkAvailability: async (request: { operationKey: string }) => ({
      status: "succeeded" as const, metadata: liveMeta(request.operationKey),
      data: { slots: [{ slotId: "live-cover", calendarId: "demo-calendar-001", startAt: "2030-06-12T00:00:00.000Z", endAt: "2030-06-13T00:00:00.000Z", available: true, sourceReferences: LIVE_SRC }], provenance: LIVE_SRC },
    }),
    createProvisionalHold: async (request: { operationKey: string; bookingId: string; calendarId: string; startAt: string; endAt: string; expiresAt: string }) => ({
      status: "succeeded" as const, metadata: liveMeta(request.operationKey),
      data: {
        hold: { holdId: `live-hold-${request.operationKey}`, operationKey: request.operationKey, bookingId: request.bookingId, calendarId: request.calendarId, startAt: request.startAt, endAt: request.endAt, expiresAt: request.expiresAt, status: "provisional_hold", createdAt: "2030-01-01T00:00:00.000Z", sourceReferences: LIVE_SRC },
        provenance: LIVE_SRC,
      },
    }),
    reconcileProvisionalHold: async (request: { operationKey: string }) => ({
      status: "failed" as const, metadata: liveMeta(request.operationKey),
      error: { kind: "not_found" as const, message: "no live record", retryable: false as const },
    }),
  };
  const email = {
    sendEmail: async (request: { operationKey: string; to: string[]; subject: string; body: string }) => ({
      status: "succeeded" as const, metadata: liveMeta(request.operationKey),
      data: {
        sentEmail: { messageId: `live-msg-${request.operationKey}`, operationKey: request.operationKey, to: request.to, cc: [], subject: request.subject, body: request.body, sentAt: "2030-01-01T00:00:00.000Z", sourceReferences: LIVE_SRC },
        provenance: LIVE_SRC,
      },
    }),
    reconcileSentEmail: async (request: { operationKey: string }) => ({
      status: "failed" as const, metadata: liveMeta(request.operationKey),
      error: { kind: "not_found" as const, message: "no live record", retryable: false as const },
    }),
  };
  return { calendar, email };
}

function realWorld() {
  const dir = mkdtempSync(join(tmpdir(), "gather-host-"));
  const store = new GatherStore(join(dir, "gather.sqlite"));
  const businessId = store.createBusiness({ name: "Real Venue", timezone: "UTC" }).id;
  return { store, businessId, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function seedRealBooking(store: GatherStore, businessId: string, bookingId: string, actionId: string) {
  const booking = store.createBooking({
    id: bookingId, businessId, eventName: "Real guest event", status: "pending_approval",
    startAt: "2030-06-12T17:00:00.000Z", endAt: "2030-06-12T23:00:00.000Z",
    sourceReferences: [{ kind: "document", locator: "doc://real/booking" }],
  });
  const action = store.createProposedAction({
    id: actionId, bookingId: booking.id, kind: "create_provisional_hold",
    payload: {
      startAt: "2030-06-12T17:00:00.000Z", endAt: "2030-06-12T23:00:00.000Z",
      expiresAt: "2030-06-13T23:00:00.000Z", calendarId: "demo-calendar-001",
      emailTo: ["guest@example.test"], emailSubject: "Real hold", emailBody: "Real body.",
    },
    sourceReferences: [{ kind: "document", locator: "doc://real/proposal" }],
  });
  return { booking, action };
}

test("chain: real booking pending approval with connected account is 'unknown', never demo", () => {
  const w = realWorld();
  try {
    // A real (non-fixture) booking awaiting owner approval, plus a connected
    // provider account — but zero executed steps, so no live proof exists.
    seedRealBooking(w.store, w.businessId, "bk-real", "act-real");
    w.store.upsertConnectedAccount({
      id: "acct-1", businessId: w.businessId, provider: "gmail",
      displayName: "venue@gmail.com", status: "connected",
    });
    const server = getWorkspace(w.store, { ownerId: "test-owner" });
    assert.equal(server.mode.kind, "unknown", "server marker: real records without live proof");
    assert.equal(server.demo, false);
    // Full chain: server payload -> strict DTO parse -> host adapter.
    const parsed = parseWorkspaceDTO(JSON.parse(JSON.stringify(server)));
    assert.equal(parsed.mode.kind, "unknown", "DTO boundary preserves unknown");
    const view = adaptWorkspace(parsed);
    assert.equal(view.dataMode, "unknown",
      "the UI must show the unverified banner — never 'Demo data' on real records, never 'live' without proof");
    const real = view.bookings.find((booking) => booking.id === "bk-real");
    assert.ok(real, "the real booking is present in the workspace");
  } finally {
    w.cleanup();
  }
});

test("chain: mixed fixture + real workspace reports unknown, not demo", () => {
  const w = realWorld();
  try {
    seedRealBooking(w.store, w.businessId, "bk-real", "act-real");
    w.store.createBooking({
      id: "bk-fx", businessId: w.businessId, eventName: "Fixture event", status: "pending_approval",
      startAt: "2030-06-12T17:00:00.000Z", endAt: "2030-06-12T23:00:00.000Z",
      sourceReferences: [{ kind: "fixture", locator: "demo://fx", fictional: true }],
    });
    const parsed = parseWorkspaceDTO(JSON.parse(JSON.stringify(getWorkspace(w.store, { ownerId: "test-owner" }))));
    const view = adaptWorkspace(parsed);
    assert.equal(view.dataMode, "unknown", "a fixture among real records must not drag the workspace to demo");
  } finally {
    w.cleanup();
  }
});

test("chain: all-fixture workspace stays demo; fully live-proven workspace reads live", async () => {
  const w = realWorld();
  try {
    // Fixture-only workspace -> demo.
    w.store.createBooking({
      id: "bk-fx", businessId: w.businessId, eventName: "Fixture event", status: "pending_approval",
      startAt: "2030-06-12T17:00:00.000Z", endAt: "2030-06-12T23:00:00.000Z",
      sourceReferences: [{ kind: "fixture", locator: "demo://fx", fictional: true }],
    });
    const fixtureOnly = adaptWorkspace(parseWorkspaceDTO(JSON.parse(JSON.stringify(getWorkspace(w.store, { ownerId: "test-owner" })))));
    assert.equal(fixtureOnly.dataMode, "demo");

    // Real booking approved through live-proven connectors -> live.
    const live = liveConnectors();
    const { action } = seedRealBooking(w.store, w.businessId, "bk-real", "act-real");
    const deps: BookingServiceDeps = { store: w.store, calendar: live.calendar as never, email: live.email, ownerId: "test-owner", now: () => new Date().toISOString() };
    await approveAndExecute(deps, {
      bookingId: "bk-real", proposedActionId: action.id,
      proposalVersion: action.proposalVersion, proposalFingerprint: action.proposalFingerprint,
    });
    const parsed = parseWorkspaceDTO(JSON.parse(JSON.stringify(getWorkspace(w.store, { ownerId: "test-owner" }))));
    assert.equal(parsed.mode.kind, "live", "every succeeded step live-proven");
    const view = adaptWorkspace(parsed);
    assert.equal(view.dataMode, "live", "positive proof only — live never inferred");
    const real = view.bookings.find((booking) => booking.id === "bk-real");
    assert.ok(real?.detail.receipts?.some((receipt) => receipt.detail === "Done — provider receipt recorded"),
      "live-proven receipts carry the recorded label");
  } finally {
    w.cleanup();
  }
});

test("receipt labels: missing or malformed proof reads unverified, never simulated", () => {
  const base = baseWorkspace();
  base.mode = { kind: "unknown", label: "UNVERIFIED" };
  base.demo = false;
  const succeededNoProof = {
    id: "ex-1", proposedActionId: "act-1", proposalVersion: 2,
    idempotencyKey: "bk-1:hold:k", status: "succeeded", startedAt: "2026-10-01T00:00:00.000Z",
    completedAt: "2026-10-01T00:01:00.000Z",
  };
  const succeededBadProof = {
    ...succeededNoProof, id: "ex-2", idempotencyKey: "bk-1:send:k",
    result: { proof: { mode: "unknown", simulated: false, provenance: [] } },
  };
  const succeededSim = {
    ...succeededNoProof, id: "ex-3", idempotencyKey: "bk-1:send:k2",
    result: { proof: { mode: "demo", simulated: true, provenance: [{ kind: "fixture", locator: "demo://x", fictional: true }] } },
  };
  const dto = {
    ...base,
    bookings: [{ ...baseBooking(), executions: [succeededNoProof, succeededBadProof, succeededSim] }],
  };
  const parsed = parseWorkspaceDTO(dto);
  const view = adaptWorkspace(parsed);
  assert.equal(view.dataMode, "unknown");
  const receipts = view.bookings[0].detail.receipts ?? [];
  const byId = new Map(receipts.map((receipt) => [receipt.executionId, receipt.detail]));
  assert.equal(byId.get("ex-1"), "Done — provider receipt unverified", "proof-absent never claims simulated");
  assert.equal(byId.get("ex-2"), "Done — provider receipt unverified", "malformed/unknown-mode proof never claims simulated");
  assert.equal(byId.get("ex-3"), "Done — simulated provider receipt", "positive simulated proof stays labeled simulated");
});
