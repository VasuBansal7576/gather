/**
 * ADR-010 booking lifecycle and follow-ups (010-A01..A04).
 *
 * Scripted tests over simulated/demo providers only. Every fixture is
 * fictional and stays labeled; no live provider or credential is touched.
 * Reference business mirror: Hall capacity 100, $50/guest, $1,000 minimum,
 * USD, no invented taxes/fees.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createDemoConnectors } from "../src/connectors/demo.ts";
import type { CalendarAvailabilityReader } from "../src/connectors/contracts.ts";
import { GatherStore } from "../src/server/sqlite-store.ts";
import { DurableDemoCalendar, DurableDemoEmail } from "../src/server/durable-demo-connectors.ts";
import { KnowledgeService } from "../src/knowledge/index.ts";
import { CoordinationLedger } from "../src/coordination/ledger.ts";
import {
  approveAndExecute,
  cancelBookingWithReleasePlan,
  findReusableHold,
  holdOperationKey,
  emailOperationKey,
  retryFailedSteps,
  type BookingServiceDeps,
} from "../src/server/booking-service.ts";
import {
  intakeSyncHealth,
  resumeAndReconcile,
} from "../src/server/operator-runtime/due-work.ts";
import { OperatorIntakeStore } from "../src/server/operator-runtime/store.ts";
import {
  prepareFreshInquiry,
  type OperatorDeps,
} from "../src/server/business-operator/index.ts";

const START = "2030-06-12T17:00:00.000Z";
const END = "2030-06-12T23:00:00.000Z";
const EXPIRES = "2030-06-13T23:00:00.000Z";
const CAL = "demo-calendar-001";
const NOW = "2030-01-01T00:00:00.000Z";
const OWNER = "lifecycle-owner";

const SRC = (locator: string) => [{ kind: "document" as const, locator, label: locator, fictional: true as const }];
const FIX = (locator: string) => [{ kind: "fixture" as const, locator, fictional: true as const }];

function fakeReader(slots: { startAt: string; endAt: string; available: boolean }[]): CalendarAvailabilityReader {
  return {
    checkAvailability: async (request: { operationKey: string; calendarId: string; startAt: string; endAt: string }) => {
      const provenance = [{ kind: "calendar" as const, locator: `fake-calendar://${request.calendarId}`, fictional: true as const }];
      return {
        status: "succeeded",
        metadata: {
          operationKey: request.operationKey,
          mode: { mode: "demo" as const, label: "DEMO ONLY", fictional: true as const },
          simulated: true,
          sourceReferences: provenance,
        },
        data: {
          slots: slots.map((slot, index) => ({
            slotId: `slot-${index}`,
            calendarId: request.calendarId,
            startAt: slot.startAt,
            endAt: slot.endAt,
            available: slot.available,
            sourceReferences: provenance,
          })),
          provenance,
        },
      };
    },
  } as unknown as CalendarAvailabilityReader;
}

interface World {
  dir: string;
  store: GatherStore;
  deps: OperatorDeps;
  bookingDeps: BookingServiceDeps;
  businessId: string;
  holdCalls: string[];
  cleanup: () => void;
}

function coverAll() {
  return [{ startAt: "2030-06-12T00:00:00.000Z", endAt: "2030-06-14T00:00:00.000Z", available: true }];
}

function world(): World {
  const dir = mkdtempSync(join(tmpdir(), "gather-lifecycle-"));
  const store = new GatherStore(join(dir, "gather.sqlite"));
  const connectors = createDemoConnectors({
    calendarSlots: [{
      slotId: "demo-cover", calendarId: CAL,
      startAt: "2030-06-12T00:00:00.000Z", endAt: "2030-06-14T00:00:00.000Z", available: true,
      sourceReferences: [{ kind: "fixture" as const, locator: "demo://cal/cover", fictional: true as const }],
    }],
    nowMs: () => Date.parse(NOW),
  });
  const holdCalls: string[] = [];
  const innerCalendar = new DurableDemoCalendar(store, connectors.calendar, () => Date.parse(NOW));
  const bookingDeps: BookingServiceDeps = {
    store,
    calendar: {
      checkAvailability: (req) => innerCalendar.checkAvailability(req),
      createProvisionalHold: async (req) => {
        holdCalls.push(req.operationKey);
        return innerCalendar.createProvisionalHold(req);
      },
      reconcileProvisionalHold: (req) => innerCalendar.reconcileProvisionalHold(req),
    },
    email: new DurableDemoEmail(store, connectors.email),
    ownerId: OWNER,
    now: () => NOW,
  };
  const businessId = store.createBusiness({ name: "Fictional Glasshouse", timezone: "America/New_York" }).id;
  store.upsertConnectedAccount({ id: "acct-1", businessId, provider: "other", displayName: "Test", status: "connected" });
  return {
    dir, store, bookingDeps, businessId, holdCalls,
    deps: { store, booking: bookingDeps, ownerId: OWNER, availability: fakeReader(coverAll()) },
    cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

/** Reference commercial facts: $50/guest, $1,000 floor, USD, capacity 100. */
function confirmReference(w: World, unitCents: number | null = 5000): void {
  const svc = new KnowledgeService(w.store);
  const facts: { key: string; subjectId?: string; value: Record<string, unknown> }[] = [
    { key: "space", subjectId: "hall", value: { spaceId: "hall", name: "Hall", capacityMin: 1, capacityMax: 100 } },
    { key: "price_line", subjectId: "package", value: { lineId: "package", label: "Event package", pricingBasis: "per_guest", unitCents } },
    { key: "pricing_bounds", value: { currency: "USD", floorCents: 100000, costsComplete: false } },
    { key: "policy", subjectId: "no-concessions", value: { policyId: "no-concessions", statement: "No concessions on event packages", effect: "allow" } },
    { key: "service", subjectId: "dinner", value: { serviceId: "dinner", label: "Dinner", available: true } },
  ];
  for (const fact of facts) {
    const candidate = svc.intakeCandidate({
      businessId: w.businessId, ...fact, confidence: "probable", sourceReferences: SRC("demo://kb/" + fact.key),
    });
    svc.confirmCandidate({ businessId: w.businessId, actor: { kind: "owner", id: OWNER }, candidateId: candidate.id });
  }
}

function inquiryContent(w: World, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    inquiryId: "inq-010-1", businessId: w.businessId, eventType: "dinner",
    startAt: START, endAt: END, guestCount: 40, serviceRequirements: ["dinner"],
    sourceReferences: SRC("demo://inq/010-1"),
    ...overrides,
  };
}

function identityFor(w: World, externalId: string, threadId = "thread-010"): { components: never; hints?: never } {
  return {
    components: {
      provider: "email", accountId: "acct-1", businessId: w.businessId,
      sourceKind: "email", externalId, threadId,
    },
  } as unknown as { components: never; hints?: never };
}

function emailBody(tag: string) {
  return { to: ["guest@example.test"], subject: `DEMO ONLY fictional offer ${tag}`, body: `DEMO ONLY fictional hold ${tag}.` };
}

/* ---------------- 010-A01: deterministic pricing ---------------- */

test("010-A01: 40 guests at the reference $50 rate produces $2,000 with cited policy", async () => {
  const w = world();
  try {
    confirmReference(w);
    const result = await prepareFreshInquiry(w.deps, {
      businessId: w.businessId,
      identity: identityFor(w, "msg-a01"),
      inquiry: inquiryContent(w),
      calendarId: CAL,
      expiresAt: EXPIRES,
      email: emailBody("a01"),
    });
    assert.equal(result.outcome, "prepared");
    if (result.outcome !== "prepared") return;
    const primary = result.prepare.offer.primaryOffer;
    assert.ok(primary, "a feasible primary offer is prepared");
    assert.equal(primary.totalCents, 200000, "40 guests x $50.00 = $2,000.00");
    assert.equal(primary.currency, "USD");
    const consequences = primary.consequences.join("\n");
    assert.match(consequences, /\$2,000\.00/, "the exact total is stated");
    assert.match(consequences, /Pricing boundary:/, "the commercial boundary is stated, not assumed");
    assert.ok(
      primary.sources.some((source) => source.locator === "demo://kb/pricing_bounds"),
      "the $1,000-minimum pricing-bounds policy fact is cited in offer provenance",
    );
    assert.ok(result.prepare.proposal, "the feasible offer persists to an exact proposal");
  } finally {
    w.cleanup();
  }
});

test("010-A01: missing price/currency blocks or asks rather than fabricating a total", async () => {
  const w = world();
  try {
    confirmReference(w, null);
    const result = await prepareFreshInquiry(w.deps, {
      businessId: w.businessId,
      identity: identityFor(w, "msg-a01b"),
      inquiry: inquiryContent(w, { inquiryId: "inq-010-1b" }),
      calendarId: CAL,
      expiresAt: EXPIRES,
      email: emailBody("a01b"),
    });
    assert.equal(result.outcome, "prepared");
    if (result.outcome !== "prepared") return;
    const primary = result.prepare.offer.offers.find((offer) => offer.rank === "primary");
    assert.ok(!primary || primary.totalCents === null, "no total is invented from an unknown unit price");
    assert.ok(result.prepare.offer.ownerDecisions.length > 0, "the gap becomes an explicit owner decision");
    assert.equal(result.prepare.proposal, null, "nothing unpriced persists to an executable proposal");
    assert.ok(result.prepare.missingForProposal.length > 0, "the block is explained item by item");
  } finally {
    w.cleanup();
  }
});

/* ---------------- 010-A02: identity ---------------- */

test("010-A02: weak identity hints require an owner decision; exact replay never duplicates", async () => {
  const w = world();
  try {
    confirmReference(w);
    // Two existing bookings share contact/date evidence with the new message.
    for (const [name, date] of [["Fictional Shaw dinner", START], ["Fictional Shaw reception", START]] as const) {
      w.store.createBooking({
        businessId: w.businessId, eventName: name, status: "inquiry", startAt: date, endAt: END,
        notes: "contact: sam.shaw@example.test", sourceReferences: FIX("demo://seed"),
      });
    }
    const before = w.store.listBookings(w.businessId).length;
    const ambiguous = await prepareFreshInquiry(w.deps, {
      businessId: w.businessId,
      identity: {
        ...identityFor(w, "msg-a02"),
        hints: { senderEmail: "sam.shaw@example.test", eventDate: "2030-06-12" },
      } as never,
      inquiry: inquiryContent(w, { inquiryId: "inq-010-2" }),
      calendarId: CAL,
      expiresAt: EXPIRES,
      email: emailBody("a02"),
    });
    assert.equal(ambiguous.outcome, "needs_decision", "weak hints block booking-specific writes");
    assert.equal(w.store.listBookings(w.businessId).length, before, "no booking is created or merged on hints");

    // Unambiguous fresh message: created once ...
    const first = await prepareFreshInquiry(w.deps, {
      businessId: w.businessId,
      identity: identityFor(w, "msg-a02-fresh", "thread-fresh"),
      inquiry: inquiryContent(w, { inquiryId: "inq-010-2b" }),
      calendarId: CAL,
      expiresAt: EXPIRES,
      email: emailBody("a02b"),
    });
    assert.equal(first.outcome, "prepared");
    if (first.outcome !== "prepared") return;
    // ... and an exact replay of the same provider message re-links.
    const replay = await prepareFreshInquiry(w.deps, {
      businessId: w.businessId,
      identity: identityFor(w, "msg-a02-fresh", "thread-fresh"),
      inquiry: inquiryContent(w, { inquiryId: "inq-010-2b" }),
      calendarId: CAL,
      expiresAt: EXPIRES,
      email: emailBody("a02b"),
    });
    assert.equal(replay.outcome, "prepared");
    if (replay.outcome !== "prepared") return;
    assert.equal(replay.bookingId, first.bookingId, "replay links the same booking");
    assert.equal(
      w.store.listBookings(w.businessId).filter((booking) => booking.eventName.includes("inq-010-2b")).length,
      1,
      "no duplicate booking is created on replay",
    );
  } finally {
    w.cleanup();
  }
});

/* ---------------- 010-A03: hold lifecycle ---------------- */

test("010-A03: price-only v2 reuses the verified hold; changed windows need explicit replacement", async () => {
  const w = world();
  try {
    confirmReference(w);
    const first = await prepareFreshInquiry(w.deps, {
      businessId: w.businessId,
      identity: identityFor(w, "msg-a03"),
      inquiry: inquiryContent(w, { inquiryId: "inq-010-3" }),
      calendarId: CAL,
      expiresAt: EXPIRES,
      email: emailBody("v1"),
    });
    assert.equal(first.outcome, "prepared");
    if (first.outcome !== "prepared") return;
    const action1 = first.prepare.proposal!.action;
    const approved1 = await approveAndExecute(w.bookingDeps, {
      bookingId: first.bookingId, proposedActionId: action1.id,
      proposalVersion: action1.proposalVersion, proposalFingerprint: action1.proposalFingerprint,
    });
    assert.equal(w.holdCalls.length, 1, "v1 creates the hold");
    assert.equal(approved1.email?.execution.status, "succeeded");

    // Price-only v2: same window, new email copy.
    const second = await prepareFreshInquiry(w.deps, {
      businessId: w.businessId,
      identity: identityFor(w, "msg-a03"),
      inquiry: inquiryContent(w, { inquiryId: "inq-010-3" }),
      calendarId: CAL,
      expiresAt: EXPIRES,
      email: emailBody("v2-price-only"),
    });
    assert.equal(second.outcome, "prepared");
    if (second.outcome !== "prepared") return;
    const action2 = second.prepare.proposal!.action;
    assert.notEqual(action2.id, action1.id, "the revision persists as a new proposal action");
    const approved2 = await approveAndExecute(w.bookingDeps, {
      bookingId: second.bookingId, proposedActionId: action2.id,
      proposalVersion: action2.proposalVersion, proposalFingerprint: action2.proposalFingerprint,
    });
    assert.equal(w.holdCalls.length, 1, "price-only v2 yields no second hold");
    assert.equal(approved2.email?.execution.status, "succeeded", "only the newly approved email action is created");
    assert.match(approved2.note, /reused verified hold/, "reuse is stated in the receipt note");
    assert.equal(
      w.store.getExecutionByIdempotencyKey(holdOperationKey(action2.id, action2.proposalVersion)),
      undefined,
      "no hold row is fabricated under the v2 key",
    );
    const reuse = findReusableHold(w.store, first.bookingId, {
      startAt: START, endAt: END, expiresAt: EXPIRES, calendarId: CAL,
      emailTo: ["guest@example.test"], emailSubject: "x", emailBody: "y",
    }, Date.parse(NOW), action2.id);
    assert.ok(reuse, "the verified hold remains discoverable for reuse");

    // Changed window without authority is refused; the old hold is preserved.
    const moved = w.store.createProposedAction({
      bookingId: first.bookingId,
      kind: "create_provisional_hold",
      payload: {
        startAt: "2030-06-13T17:00:00.000Z", endAt: "2030-06-13T23:00:00.000Z",
        expiresAt: EXPIRES, calendarId: CAL,
        emailTo: ["guest@example.test"], emailSubject: "moved", emailBody: "moved date",
      },
      sourceReferences: FIX("demo://moved"),
    });
    await assert.rejects(
      () => approveAndExecute(w.bookingDeps, {
        bookingId: first.bookingId, proposedActionId: moved.id,
        proposalVersion: moved.proposalVersion, proposalFingerprint: moved.proposalFingerprint,
      }),
      /replacesHoldOperationKey/,
      "date change without explicit replacement authority is refused",
    );
    assert.equal(w.holdCalls.length, 1, "no second hold is added silently");

    // The same change WITH explicit release authority proceeds as replacement.
    const priorKey = holdOperationKey(action1.id, action1.proposalVersion);
    const movedWithAuthority = w.store.createProposedAction({
      bookingId: first.bookingId,
      kind: "create_provisional_hold",
      payload: {
        startAt: "2030-06-13T17:00:00.000Z", endAt: "2030-06-13T23:00:00.000Z",
        expiresAt: EXPIRES, calendarId: CAL,
        emailTo: ["guest@example.test"], emailSubject: "moved", emailBody: "moved date",
        replacesHoldOperationKey: priorKey, releaseAuthorizedBy: OWNER,
      },
      sourceReferences: FIX("demo://moved-authorized"),
    });
    const approvedMove = await approveAndExecute(w.bookingDeps, {
      bookingId: first.bookingId, proposedActionId: movedWithAuthority.id,
      proposalVersion: movedWithAuthority.proposalVersion, proposalFingerprint: movedWithAuthority.proposalFingerprint,
    });
    assert.equal(w.holdCalls.length, 2, "authorized replacement creates the new hold");
    assert.match(approvedMove.note, /Superseded hold/, "the superseded hold gets a release advisory");
    assert.equal(
      w.store.getExecutionByIdempotencyKey(priorKey)?.status,
      "succeeded",
      "the old receipt is preserved, never silently replaced",
    );
  } finally {
    w.cleanup();
  }
});

test("010-A03: confirmed and cancelled states are never demoted by replay", async () => {
  const w = world();
  try {
    confirmReference(w);
    const first = await prepareFreshInquiry(w.deps, {
      businessId: w.businessId,
      identity: identityFor(w, "msg-a03c"),
      inquiry: inquiryContent(w, { inquiryId: "inq-010-3c" }),
      calendarId: CAL,
      expiresAt: EXPIRES,
      email: emailBody("terminal"),
    });
    assert.equal(first.outcome, "prepared");
    if (first.outcome !== "prepared") return;
    const action = first.prepare.proposal!.action;
    await approveAndExecute(w.bookingDeps, {
      bookingId: first.bookingId, proposedActionId: action.id,
      proposalVersion: action.proposalVersion, proposalFingerprint: action.proposalFingerprint,
    });
    assert.equal(w.store.getBooking(first.bookingId).status, "provisional_hold");

    // A confirmed booking is not talked back down by retry/replay.
    w.store.updateBookingStatus(first.bookingId, "confirmed");
    await retryFailedSteps(w.bookingDeps, action.id);
    assert.equal(w.store.getBooking(first.bookingId).status, "confirmed", "confirmed is terminal against replay");

    // Cancellation blocks unsent work and offers hold release instead.
    const plan = cancelBookingWithReleasePlan(w.store, first.bookingId, Date.parse(NOW));
    assert.equal(plan.booking.status, "cancelled");
    assert.equal(plan.releasePlan.length, 1, "the surviving hold gets a release plan");
    assert.match(plan.note, /cannot be undone/, "sent email is honestly out of scope");
    const next = w.store.createProposedAction({
      bookingId: first.bookingId,
      kind: "create_provisional_hold",
      payload: {
        startAt: START, endAt: END, expiresAt: EXPIRES, calendarId: CAL,
        emailTo: ["guest@example.test"], emailSubject: "late", emailBody: "too late",
      },
      sourceReferences: FIX("demo://late"),
    });
    await assert.rejects(
      () => approveAndExecute(w.bookingDeps, {
        bookingId: first.bookingId, proposedActionId: next.id,
        proposalVersion: next.proposalVersion, proposalFingerprint: next.proposalFingerprint,
      }),
      /cancelled/,
      "cancelled bookings refuse new execution",
    );
  } finally {
    w.cleanup();
  }
});

/* ---------------- 010-A04: replies, follow-ups, takeover ---------------- */

function tempLedger(): { path: string; db: DatabaseSync; ledger: CoordinationLedger; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "gather-010a04-"));
  const path = join(dir, "gather.sqlite");
  const db = new DatabaseSync(path);
  return { path, db, ledger: new CoordinationLedger(db), cleanup: () => { try { db.close(); } catch { /* closed */ } rmSync(dir, { recursive: true, force: true }); } };
}

test("010-A04: a reply before the due follow-up suppresses it across restart", () => {
  const first = tempLedger();
  const dueAt = "2030-04-02T10:00:00.000Z"; // 24h default after 04-01T10:00
  try {
    const inquiry = first.ledger.ingestEvent({
      dedupeKey: "evt-inq-1", kind: "inquiry", bookingId: "booking-a04",
      sourceId: "thread-1", sourceKind: "email", observedAt: "2030-04-01T10:00:00.000Z",
    });
    assert.equal(inquiry.createdWaiting.length, 1);
    assert.equal(inquiry.createdWaiting[0]?.dueAt, dueAt, "default follow-up draft lands 24h after the inquiry");
    // Restart: close and reopen the same database before the reply lands.
    first.db.close();
    const secondDb = new DatabaseSync(first.path);
    try {
      const second = new CoordinationLedger(secondDb);
      assert.equal(second.listDueWork({ nowIso: "2030-04-03T10:00:00.000Z", bookingId: "booking-a04" }).length, 1);
      const reply = second.ingestEvent({
        dedupeKey: "evt-reply-1", kind: "reply", bookingId: "booking-a04",
        sourceId: "msg-2", sourceKind: "email", observedAt: "2030-04-02T09:00:00.000Z",
      });
      assert.deepEqual(reply.suppressedWaitingIds, [inquiry.createdWaiting[0]!.id]);
      assert.equal(second.listDueWork({ nowIso: "2030-04-03T10:00:00.000Z", bookingId: "booking-a04" }).length, 0);
      const claim = second.claimDueWork({ ids: [inquiry.createdWaiting[0]!.id], claimedBy: "worker", nowIso: "2030-04-03T10:00:00.000Z" });
      assert.deepEqual(claim.claimed, [], "suppressed work is never handed out after restart");
    } finally {
      secondDb.close();
    }
  } finally {
    first.cleanup();
  }
});

test("010-A04: pause/takeover/resume reconciles external changes and never refreshes approvals", async () => {
  const w = world();
  try {
    confirmReference(w);
    // Email connector that loses the send response: the step stays honestly uncertain.
    const uncertainEmail = {
      sendEmail: async (req: { operationKey: string }) => ({
        status: "uncertain" as const,
        metadata: {
          operationKey: req.operationKey,
          mode: { mode: "demo" as const, label: "DEMO ONLY", fictional: true as const },
          simulated: true as const,
          sourceReferences: FIX("demo://mail/uncertain"),
        },
        error: { kind: "timeout_after_success" as const, message: "response lost after dispatch", retryable: true as const },
      }),
      reconcileSentEmail: async (req: { operationKey: string }) => ({
        status: "failed" as const,
        metadata: {
          operationKey: req.operationKey,
          mode: { mode: "demo" as const, label: "DEMO ONLY", fictional: true as const },
          simulated: true as const,
          sourceReferences: FIX("demo://mail/uncertain"),
        },
        error: { kind: "not_found" as const, message: "no provider evidence yet", retryable: true as const },
      }),
    };
    const partialDeps: BookingServiceDeps = { ...w.bookingDeps, email: uncertainEmail as never };
    const first = await prepareFreshInquiry(w.deps, {
      businessId: w.businessId,
      identity: identityFor(w, "msg-a04t"),
      inquiry: inquiryContent(w, { inquiryId: "inq-010-4t" }),
      calendarId: CAL,
      expiresAt: EXPIRES,
      email: emailBody("takeover"),
    });
    assert.equal(first.outcome, "prepared");
    if (first.outcome !== "prepared") return;
    const action = first.prepare.proposal!.action;
    const approved = await approveAndExecute(partialDeps, {
      bookingId: first.bookingId, proposedActionId: action.id,
      proposalVersion: action.proposalVersion, proposalFingerprint: action.proposalFingerprint,
    });
    assert.equal(approved.email?.execution.status, "uncertain", "lost send response stays uncertain");
    const approvalsBefore = w.store.listApprovals(action.id).length;

    // Shared-database ledger: follow-up opens, owner pauses, an external
    // customer reply lands mid-pause, then a SECOND owner takes over.
    const ledger = new CoordinationLedger(w.store.db);
    const inquiry = ledger.ingestEvent({
      dedupeKey: "evt-inq-t1", kind: "inquiry", bookingId: first.bookingId,
      sourceId: "thread-t", sourceKind: "email", observedAt: "2030-04-01T10:00:00.000Z",
    });
    ledger.applyOwnerControl({ dedupeKey: "ctrl-pause-t", kind: "pause", bookingId: first.bookingId, attestedBy: OWNER });
    ledger.ingestEvent({
      dedupeKey: "evt-reply-t", kind: "reply", bookingId: first.bookingId,
      sourceId: "msg-t2", sourceKind: "email", observedAt: "2030-04-02T09:00:00.000Z",
    });
    const runtimeDeps = {
      store: w.store, ledger, booking: partialDeps, accountId: "acct-1", businessId: w.businessId,
      inbox: { provenance: { simulated: true, label: "test" } },
      now: () => NOW,
    } as never;
    const resumed = await resumeAndReconcile(runtimeDeps, {
      bookingId: first.bookingId, attestedBy: "second-owner", dedupeKey: "ctrl-resume-t",
    });
    assert.deepEqual(resumed.resumedWaitingIds, [inquiry.createdWaiting[0]!.id], "paused work reopens on resume");
    assert.deepEqual(resumed.reconciledExecutionIds, [], "no provider evidence appeared, so nothing heals");
    assert.equal(resumed.stillUncertainExecutionIds.length, 1, "the uncertain send stays uncertain, never replayed blindly");
    assert.equal(resumed.approvalsRefreshed, false, "resume never mints freshness");
    assert.equal(resumed.liveApprovalPresent, true, "the pre-pause approval is re-read as-is");
    assert.equal(w.store.listApprovals(action.id).length, approvalsBefore, "no approval row is added or refreshed by resume");
    // The mid-pause reply still answers the follow-up after resume.
    const claim = ledger.claimDueWork({
      ids: [inquiry.createdWaiting[0]!.id], claimedBy: "worker", nowIso: "2030-04-03T10:00:00.000Z",
    });
    assert.deepEqual(claim.claimed, [], "external changes survive takeover; the answered follow-up is not handed out");
  } finally {
    w.cleanup();
  }
});

test("010-A04: stale intake sync is reported instead of acted on", () => {
  const w = world();
  try {
    const runtimeDeps = {
      store: w.store, accountId: "acct-1", businessId: w.businessId,
      inbox: { provenance: { simulated: true, label: "test" } },
    } as never;
    assert.equal(intakeSyncHealth(runtimeDeps).healthy, true, "nothing observed yet means nothing stale");
    new OperatorIntakeStore(w.store.db).recordFailure("acct-1", "poll", "boom: connection refused");
    const health = intakeSyncHealth(runtimeDeps);
    assert.equal(health.healthy, false, "a failed sync with no drained batch blocks follow-up progress");
    assert.match(health.reason, /boom/, "the reason names the recorded failure");
  } finally {
    w.cleanup();
  }
});
test("010-A04: one default draft only; opt-out suppresses dispatch", () => {
  const fx = tempLedger();
  try {
    const one = fx.ledger.ingestEvent({
      dedupeKey: "evt-inq-1", kind: "inquiry", bookingId: "booking-a04b",
      sourceId: "thread-1", sourceKind: "email", observedAt: "2030-04-01T10:00:00.000Z",
    });
    const two = fx.ledger.ingestEvent({
      dedupeKey: "evt-inq-2", kind: "inquiry", bookingId: "booking-a04b",
      sourceId: "thread-2", sourceKind: "email", observedAt: "2030-04-05T10:00:00.000Z",
    });
    assert.equal((two.createdWaiting[0]?.detail as Record<string, unknown>).repeatDraft, true,
      "further auto drafts are marked: a new owner decision is needed to act on them");
    void one;

    // Opt-out reply suppresses at ingest and at claim time.
    const optOut = fx.ledger.ingestEvent({
      dedupeKey: "evt-reply-opt", kind: "reply", bookingId: "booking-a04b",
      sourceId: "msg-3", sourceKind: "email", observedAt: "2030-04-06T10:00:00.000Z",
      payload: { optOut: true },
    });
    assert.ok(optOut.suppressedWaitingIds.length >= 1);
    assert.equal(fx.ledger.isOptedOut("booking-a04b"), true);
    const three = fx.ledger.ingestEvent({
      dedupeKey: "evt-inq-3", kind: "inquiry", bookingId: "booking-a04b",
      sourceId: "thread-3", sourceKind: "email", observedAt: "2030-04-07T10:00:00.000Z",
    });
    const claim = fx.ledger.claimDueWork({
      ids: [three.createdWaiting[0]!.id], claimedBy: "worker", nowIso: "2030-04-09T10:00:00.000Z",
    });
    assert.deepEqual(claim.claimed, [], "opted-out follow-ups are never handed out");
    assert.deepEqual(claim.suppressedIds, [three.createdWaiting[0]!.id]);
  } finally {
    fx.cleanup();
  }
});
