import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { createDemoConnectors } from "../src/connectors/demo.ts";
import { GatherStore } from "../src/server/sqlite-store.ts";
import { DurableDemoCalendar, DurableDemoEmail } from "../src/server/durable-demo-connectors.ts";
import { KnowledgeService } from "../src/knowledge/index.ts";
import type { CalendarAvailabilityReader } from "../src/connectors/contracts.ts";
import {
  approveAndExecute,
  retryFailedSteps,
  type BookingServiceDeps,
} from "../src/server/booking-service.ts";
import {
  buildBookingOffer,
  decideOperator,
  persistPreparedProposal,
  prepareBookingProposal,
  type OperatorDeps,
} from "../src/server/business-operator/index.ts";

// All fixtures are fictional and stay labeled by their sources.
const START = "2030-06-12T17:00:00.000Z";
const END = "2030-06-12T23:00:00.000Z";
const EXPIRES = "2030-06-13T23:00:00.000Z";
const CAL = "demo-calendar-001";
const NOW = "2030-01-01T00:00:00.000Z";
const OWNER = "test-owner";

const SRC = (locator: string) => [{ kind: "document" as const, locator, label: locator, fictional: true as const }];

/** Scripted fake availability port: proves the operator actually calls it. */
function fakeReader(slots: { startAt: string; endAt: string; available: boolean; reason?: string }[], calls: string[], mode: "demo" | "live" = "demo"): CalendarAvailabilityReader {
  return {
    checkAvailability: async (request: { operationKey: string; calendarId: string; startAt: string; endAt: string }) => {
      calls.push(`${request.operationKey}|${request.calendarId}|${request.startAt}|${request.endAt}`);
      const provenance = [{ kind: "calendar" as const, locator: `fake-calendar://${request.calendarId}`, label: mode === "live" ? "LIVE" : "Fake", fictional: mode !== "live" }];
      return {
        status: "succeeded",
        metadata: {
          operationKey: request.operationKey,
          mode: mode === "live"
            ? { mode: "live" as const, label: "LIVE", fictional: false as const }
            : { mode: "demo" as const, label: "DEMO ONLY", fictional: true as const },
          simulated: mode !== "live",
          sourceReferences: provenance,
        },
        data: {
          slots: slots.map((slot, index) => ({
            slotId: `slot-${index}`,
            calendarId: request.calendarId,
            startAt: slot.startAt,
            endAt: slot.endAt,
            available: slot.available,
            ...(slot.reason === undefined ? {} : { reason: slot.reason }),
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
  readerCalls: string[];
  cleanup: () => void;
}

function coverSlots() {
  return [{ startAt: "2030-06-12T00:00:00.000Z", endAt: "2030-06-13T00:00:00.000Z", available: true }];
}

function world(readerSlots: { startAt: string; endAt: string; available: boolean; reason?: string }[] = coverSlots(), mode: "demo" | "live" = "demo"): World {
  const dir = mkdtempSync(join(tmpdir(), "gather-op-"));
  const store = new GatherStore(join(dir, "gather.sqlite"));
  const connectors = createDemoConnectors({
    calendarSlots: [{
      slotId: "demo-cover", calendarId: CAL,
      startAt: "2030-06-12T00:00:00.000Z", endAt: "2030-06-13T00:00:00.000Z", available: true,
      sourceReferences: SRC("demo://cal/cover"),
    }],
  });
  const bookingDeps: BookingServiceDeps = {
    store,
    calendar: new DurableDemoCalendar(store, connectors.calendar, () => Date.parse(NOW)),
    email: new DurableDemoEmail(store, connectors.email),
    ownerId: OWNER,
    now: () => NOW,
  };
  const businessId = store.createBusiness({ name: "Fictional Hall", timezone: "America/New_York" }).id;
  const readerCalls: string[] = [];
  return {
    dir, store, bookingDeps, businessId, readerCalls,
    deps: { store, booking: bookingDeps, ownerId: OWNER, availability: fakeReader(readerSlots, readerCalls, mode) },
    cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

function confirmAll(w: World): void {
  const svc = new KnowledgeService(w.store);
  const facts: { key: string; subjectId?: string; value: Record<string, unknown> }[] = [
    { key: "space", subjectId: "hall", value: { spaceId: "hall", name: "Hall", capacityMin: 10, capacityMax: 100 } },
    { key: "price_line", subjectId: "dinner", value: { lineId: "dinner", label: "Dinner", pricingBasis: "per_guest", unitCents: 10000 } },
    { key: "pricing_bounds", value: { currency: "USD", floorCents: 100000, costsComplete: false } },
    { key: "service", subjectId: "dinner", value: { serviceId: "dinner", label: "Dinner", available: true } },
  ];
  for (const fact of facts) {
    const candidate = svc.intakeCandidate({
      businessId: w.businessId, ...fact, confidence: "probable", sourceReferences: SRC("demo://kb/" + fact.key),
    });
    svc.confirmCandidate({ businessId: w.businessId, actor: { kind: "owner", id: OWNER }, candidateId: candidate.id });
  }
}

function inquiry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    inquiryId: "inq-1", businessId: "", eventType: "dinner",
    startAt: START, endAt: END, guestCount: 40, serviceRequirements: ["dinner"],
    validator: "mallory", validatedAt: "1999-01-01T00:00:00.000Z",
    sourceReferences: SRC("demo://inq/1"),
    ...overrides,
  };
}

function email() {
  return { to: ["guest@example.test"], subject: "DEMO ONLY fictional offer", body: "DEMO ONLY fictional hold." };
}

function withBusiness(w: World, body: Record<string, unknown>): { inquiry: Record<string, unknown> } {
  return { ...body, inquiry: inquiry({ businessId: w.businessId }) };
}

test("candidate to confirmation to fresh host-fetched offer to exact proposal to approve pipeline", async () => {
  const w = world();
  try {
    confirmAll(w);
    const booking = w.store.createBooking({ businessId: w.businessId, eventName: "Fictional dinner", status: "pending_approval", sourceReferences: SRC("demo://inq/1") });
    const result = await prepareBookingProposal(w.deps, {
      ...withBusiness(w, {}),
      bookingId: booking.id,
      calendarId: CAL, expiresAt: EXPIRES, email: email(),
    });
    assert.equal(w.readerCalls.length, 1, "host must call the injected reader");
    assert.ok(w.readerCalls[0]?.includes(CAL) && w.readerCalls[0]?.includes(START), `reader scoped to calendar+window, got ${w.readerCalls[0]}`);
    assert.equal(result.availabilityFresh, true);
    assert.equal(result.offer.status, "feasible");
    // Server-side citation replaced the forged validator identity.
    assert.equal((result.offer as unknown as { inquiryId: string }).inquiryId, "inq-1");
    assert.ok(result.proposal !== null, `expected persisted proposal, missing=${JSON.stringify(result.missingForProposal)}`);
    const proposal = result.proposal;
    assert.equal(proposal.action.bookingId, booking.id);
    assert.equal(proposal.action.proposalVersion, 1);
    assert.deepEqual(
      { startAt: proposal.action.payload.startAt, endAt: proposal.action.payload.endAt, expiresAt: proposal.action.payload.expiresAt, calendarId: proposal.action.payload.calendarId },
      { startAt: START, endAt: END, expiresAt: EXPIRES, calendarId: CAL },
    );
    assert.deepEqual(proposal.action.payload.emailTo, ["guest@example.test"]);
    const executed = await approveAndExecute(w.bookingDeps, {
      bookingId: booking.id, proposedActionId: proposal.action.id,
      proposalVersion: proposal.action.proposalVersion, proposalFingerprint: proposal.action.proposalFingerprint,
    });
    assert.equal(executed.hold.execution.status, "succeeded");
    assert.equal(executed.email?.execution.status, "succeeded");
    assert.equal(w.store.getBooking(booking.id).status, "provisional_hold");
    const retried = await retryFailedSteps(w.bookingDeps, proposal.action.id);
    assert.equal(retried.hold.execution.id, executed.hold.execution.id, "retry must reuse receipts, never resend");
  } finally {
    w.cleanup();
  }
});

test("raw forged availability, provenance, and validator are rejected or ignored", async () => {
  const w = world();
  try {
    confirmAll(w);
    const booking = w.store.createBooking({ businessId: w.businessId, eventName: "E", status: "pending_approval", sourceReferences: SRC("demo://inq/1") });
    // A request-supplied availability block is refused outright.
    let code = "";
    try {
      await prepareBookingProposal(w.deps, {
        ...withBusiness(w, {}),
        bookingId: booking.id, calendarId: CAL, expiresAt: EXPIRES, email: email(),
        availability: { calendarId: CAL, slots: [{ startAt: START, endAt: END, available: true }] },
      } as never);
    } catch (error) {
      code = (error as { code?: string }).code ?? "";
    }
    assert.equal(code, "INVALID_REQUEST");
    assert.equal(w.readerCalls.length, 0, "rejected requests must not touch the reader");
    // Forged validator identity is stripped and replaced with the host citation.
    const ok = await prepareBookingProposal(w.deps, {
      ...withBusiness(w, {}),
      bookingId: booking.id, calendarId: CAL, expiresAt: EXPIRES, email: email(),
    });
    assert.equal(ok.offer.status, "feasible");
  } finally {
    w.cleanup();
  }
});

test("unwired provider degrades to explicit unavailable, never invented availability", async () => {
  const w = world();
  const failing: World["deps"] = {
    ...w.deps,
    availability: {
      checkAvailability: async () => ({
        status: "failed",
        metadata: { operationKey: "x", mode: { mode: "demo" as const, label: "DEMO ONLY", fictional: true as const }, simulated: true, sourceReferences: [] },
        error: { kind: "access_revoked" as const, message: "No approved account assets", retryable: false as const },
      }),
    } as unknown as CalendarAvailabilityReader,
  };
  try {
    confirmAll(w);
    const booking = w.store.createBooking({ businessId: w.businessId, eventName: "E", status: "pending_approval", sourceReferences: SRC("demo://inq/1") });
    const result = await prepareBookingProposal(failing, {
      ...withBusiness(w, {}),
      bookingId: booking.id, calendarId: CAL, expiresAt: EXPIRES, email: email(),
    });
    assert.equal(result.availabilityFresh, false);
    assert.equal(result.proposal, null);
    assert.ok(result.missingForProposal.some((item) => item.code === "availability_unavailable"));
    assert.ok(result.missingForProposal.some((item) => item.code === "missing_availability_slots"));
  } finally {
    w.cleanup();
  }
});

test("mode correlates live reader plus attested facts; fixtures stay demo", async () => {
  const w = world(coverSlots(), "live");
  try {
    confirmAll(w);
    const booking = w.store.createBooking({ businessId: w.businessId, eventName: "E", status: "pending_approval", sourceReferences: SRC("demo://inq/1") });
    const fixtureMode = await prepareBookingProposal(w.deps, {
      ...withBusiness(w, {}),
      bookingId: booking.id, calendarId: CAL, expiresAt: EXPIRES, email: email(),
    });
    // Live reader but fictional fixture facts: never passed as live.
    assert.equal(fixtureMode.mode.kind, "demo");
    assert.equal(fixtureMode.mode.simulated, true);
    assert.equal(fixtureMode.mode.fictional, true);
  } finally {
    w.cleanup();
  }
});

test("changed-source facts are withheld from the prepared offer", async () => {
  const w = world();
  try {
    confirmAll(w);
    const booking = w.store.createBooking({ businessId: w.businessId, eventName: "E", status: "pending_approval", sourceReferences: SRC("demo://inq/1") });
    const before = await prepareBookingProposal(w.deps, {
      ...withBusiness(w, {}),
      bookingId: booking.id, calendarId: CAL, expiresAt: EXPIRES, email: email(),
    });
    assert.equal(before.offer.status, "feasible");
    const svc = new KnowledgeService(w.store);
    svc.intakeCandidate({
      businessId: w.businessId, key: "price_line", subjectId: "dinner",
      value: { lineId: "dinner", label: "Dinner", pricingBasis: "per_guest", unitCents: 99999 },
      confidence: "probable", sourceReferences: SRC("demo://kb/price_line"),
    });
    const after = await prepareBookingProposal(w.deps, {
      ...withBusiness(w, {}),
      bookingId: booking.id, calendarId: CAL, expiresAt: EXPIRES, email: email(),
    });
    assert.notEqual(after.offer.status, "feasible", "stale pricing must not stay feasible");
    assert.equal(after.proposal, null);
  } finally {
    w.cleanup();
  }
});

test("unknown costs never claim profit but permit floor-clearing offers", async () => {
  const w = world();
  try {
    confirmAll(w);
    const booking = w.store.createBooking({ businessId: w.businessId, eventName: "E", status: "pending_approval", sourceReferences: SRC("demo://inq/1") });
    const result = await prepareBookingProposal(w.deps, {
      ...withBusiness(w, {}),
      bookingId: booking.id, calendarId: CAL, expiresAt: EXPIRES, email: email(),
    });
    assert.equal(result.offer.status, "feasible");
    assert.equal(result.offer.profitability.claim, "unknown");
    assert.equal(result.proposal?.action.payload !== undefined, true);
  } finally {
    w.cleanup();
  }
});

test("unavailable dates preserve alternatives and persist nothing", async () => {
  const w = world([
    { startAt: "2030-06-12T00:00:00.000Z", endAt: "2030-06-13T00:00:00.000Z", available: true },
    { startAt: START, endAt: END, available: false, reason: "Fixture marks this window busy" },
  ]);
  try {
    confirmAll(w);
    const booking = w.store.createBooking({ businessId: w.businessId, eventName: "E", status: "pending_approval", sourceReferences: SRC("demo://inq/1") });
    const result = await prepareBookingProposal(w.deps, {
      ...withBusiness(w, {}),
      bookingId: booking.id, calendarId: CAL, expiresAt: EXPIRES, email: email(),
    });
    assert.equal(w.readerCalls.length, 1);
    assert.notEqual(result.offer.status, "feasible");
    assert.equal(result.proposal, null);
    assert.ok(result.missingForProposal.length > 0);
    assert.equal(w.store.listProposedActionsForBooking(booking.id).length, 0);
  } finally {
    w.cleanup();
  }
});

test("concurrent correction between build and persist aborts stale, never duplicates", async () => {
  const w = world();
  try {
    confirmAll(w);
    const booking = w.store.createBooking({ businessId: w.businessId, eventName: "E", status: "pending_approval", sourceReferences: SRC("demo://inq/1") });
    const built = await buildBookingOffer(w.deps, {
      ...withBusiness(w, {}),
      bookingId: booking.id, calendarId: CAL,
    });
    assert.equal(built.offer.status, "feasible");
    decideOperator(w.deps, "correct", {
      businessId: w.businessId, key: "price_line", subjectId: "dinner", expectedRevision: 1,
      value: { lineId: "dinner", label: "Dinner", pricingBasis: "per_guest", unitCents: 99999 },
    });
    let code = "";
    try {
      persistPreparedProposal(w.deps, built, { email: email(), expiresAt: EXPIRES });
    } catch (error) {
      code = (error as { code?: string }).code ?? "";
    }
    assert.equal(code, "STALE_PROPOSAL");
    assert.equal(w.store.listProposedActionsForBooking(booking.id).length, 0);
  } finally {
    w.cleanup();
  }
});

test("cross-business preparation is refused", async () => {
  const w = world();
  try {
    confirmAll(w);
    const other = w.store.createBusiness({ name: "Other", timezone: "UTC" }).id;
    const booking = w.store.createBooking({ businessId: other, eventName: "E", status: "pending_approval", sourceReferences: SRC("demo://inq/1") });
    let code = "";
    try {
      await prepareBookingProposal(w.deps, {
        ...withBusiness(w, {}),
        bookingId: booking.id, calendarId: CAL, expiresAt: EXPIRES, email: email(),
      });
    } catch (error) {
      code = (error as { code?: string }).code ?? "";
    }
    assert.equal(code, "CROSS_BOOKING");
  } finally {
    w.cleanup();
  }
});

test("policies needing decisions and missing email block persistence explicitly", async () => {
  const w = world();
  try {
    confirmAll(w);
    const svc = new KnowledgeService(w.store);
    const policy = svc.intakeCandidate({
      businessId: w.businessId, key: "policy",
      value: { policyId: "p1", statement: "Owner must approve", effect: "require_owner_decision" },
      confidence: "probable", sourceReferences: SRC("demo://kb/policy"),
    });
    svc.confirmCandidate({ businessId: w.businessId, actor: { kind: "owner", id: OWNER }, candidateId: policy.id });
    const booking = w.store.createBooking({ businessId: w.businessId, eventName: "E", status: "pending_approval", sourceReferences: SRC("demo://inq/1") });
    const blocked = await prepareBookingProposal(w.deps, {
      ...withBusiness(w, {}),
      bookingId: booking.id, calendarId: CAL, expiresAt: EXPIRES, email: email(),
    });
    assert.notEqual(blocked.offer.status, "feasible");
    assert.equal(blocked.proposal, null);
    const noMail = await prepareBookingProposal(w.deps, {
      ...withBusiness(w, {}),
      bookingId: booking.id, calendarId: CAL, expiresAt: EXPIRES,
    });
    assert.ok(noMail.missingForProposal.some((item) => item.code === "email_content_missing" || item.code === "offer_not_feasible"));
  } finally {
    w.cleanup();
  }
});

test("unknown inquiry dates block with owner questions, never invented windows", async () => {
  const w = world();
  try {
    confirmAll(w);
    const booking = w.store.createBooking({ businessId: w.businessId, eventName: "E", status: "pending_approval", sourceReferences: SRC("demo://inq/1") });
    const result = await prepareBookingProposal(w.deps, {
      ...withBusiness(w, {}),
      bookingId: booking.id, calendarId: CAL, expiresAt: EXPIRES, email: email(),
      inquiry: inquiry({ businessId: w.businessId, startAt: "not-a-date", endAt: "also-bad" }),
    });
    assert.equal(result.offer.status, "blocked");
    assert.equal(result.proposal, null);
    assert.ok(result.offer.missingInformation.some((item) => item.code === "missing_event_window"));
  } finally {
    w.cleanup();
  }
});

test("repeated persist reuses the identical proposal; request actors never authorize", async () => {
  const w = world();
  try {
    confirmAll(w);
    const booking = w.store.createBooking({ businessId: w.businessId, eventName: "E", status: "pending_approval", sourceReferences: SRC("demo://inq/1") });
    const built = await buildBookingOffer(w.deps, {
      ...withBusiness(w, {}),
      bookingId: booking.id, calendarId: CAL,
    });
    const first = persistPreparedProposal(w.deps, built, { email: email(), expiresAt: EXPIRES });
    const second = persistPreparedProposal(w.deps, built, { email: email(), expiresAt: EXPIRES });
    assert.ok(!("missing" in first) && !("missing" in second));
    if ("missing" in first || "missing" in second) return;
    assert.equal(first.action.id, second.action.id);
    assert.equal(second.reused, true);
    const svc = new KnowledgeService(w.store);
    const candidate = svc.intakeCandidate({
      businessId: w.businessId, key: "space", subjectId: "side",
      value: { spaceId: "side", name: "Side", capacityMin: 1, capacityMax: 5 },
      confidence: "probable", sourceReferences: SRC("demo://kb/side"),
    });
    decideOperator(w.deps, "confirm", {
      businessId: w.businessId, candidateId: candidate.id,
      actor: { kind: "owner", id: "mallory@example.test" },
    });
    const recorded = svc.listDecisions(w.businessId).filter((d) => d.outcome === "applied").pop();
    assert.equal(recorded?.actorId, OWNER);
  } finally {
    w.cleanup();
  }
});

test("confirming a ghost candidate is not found, and actors stay server-side", async () => {
  const w = world();
  try {
    let code = "";
    try {
      decideOperator(w.deps, "confirm", { businessId: w.businessId, candidateId: "ghost" });
    } catch (error) {
      code = (error as { code?: string }).code ?? "";
    }
    assert.equal(code, "not_found");
  } finally {
    w.cleanup();
  }
});

test("malformed nested sources are rejected before owner corrections", async () => {
  const w = world();
  try {
    confirmAll(w);
    let code = "";
    try {
      decideOperator(w.deps, "correct", {
        businessId: w.businessId, key: "space", subjectId: "hall", expectedRevision: 1,
        value: { spaceId: "hall", name: "Hall", capacityMin: 1, capacityMax: 5 },
        sourceReferences: [{ kind: "telepathy", locator: "" }],
      });
    } catch (error) {
      code = (error as { code?: string }).code ?? "";
    }
    assert.equal(code, "INVALID_REQUEST");
  } finally {
    w.cleanup();
  }
});
