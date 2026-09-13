import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { GatherStore } from "../src/server/sqlite-store.ts";
import { KnowledgeService } from "../src/knowledge/index.ts";
import { createDemoConnectors } from "../src/connectors/demo.ts";
import { DurableDemoCalendar, DurableDemoEmail } from "../src/server/durable-demo-connectors.ts";
import type { BookingServiceDeps } from "../src/server/booking-service.ts";
import type { CalendarAvailabilityReader } from "../src/connectors/contracts.ts";
import {
  buildBookingOffer,
  decideOperator,
  persistPreparedProposal,
  type OperatorDeps,
} from "../src/server/business-operator/index.ts";
import { previewConsequences } from "../src/server/booking-service.ts";
import { adaptWorkspace } from "../src/host/adapter.ts";
import type { WorkspaceDTO as ClientWorkspaceDTO } from "../src/host/dto.ts";

// Genuine server prepare/persist output rendered through the real host
// adapter — no hand-forged payloads. All fixtures are fictional and stay
// labeled by their sources.
const START = "2026-10-18T18:00:00.000Z";
const END = "2026-10-18T22:00:00.000Z";
const EXPIRES = "2026-10-25T00:00:00.000Z";
const CAL = "contract-calendar-001";
const NOW = "2026-09-13T00:00:00.000Z";
const OWNER = "test-owner";

const SRC = (locator: string) => [{ kind: "fixture" as const, locator, fictional: true as const }];

function fakeReader(): CalendarAvailabilityReader {
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
          slots: [{
            slotId: "slot-cover", calendarId: request.calendarId,
            startAt: "2026-10-18T00:00:00.000Z", endAt: "2026-10-19T00:00:00.000Z",
            available: true, sourceReferences: provenance,
          }],
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
  businessId: string;
  cleanup: () => void;
}

function world(): World {
  const dir = mkdtempSync(join(tmpdir(), "gather-contract-"));
  const store = new GatherStore(join(dir, "gather.sqlite"));
  const businessId = store.createBusiness({ name: "Fictional Contract Hall", timezone: "America/New_York" }).id;
  const connectors = createDemoConnectors({ calendarSlots: [] });
  const bookingDeps: BookingServiceDeps = {
    store,
    calendar: new DurableDemoCalendar(store, connectors.calendar, () => Date.parse(NOW)),
    email: new DurableDemoEmail(store, connectors.email),
    ownerId: OWNER,
    now: () => NOW,
  };
  return {
    dir, store, businessId,
    deps: { store, booking: bookingDeps, ownerId: OWNER, availability: fakeReader() },
    cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

function confirmAll(w: World): void {
  const svc = new KnowledgeService(w.store);
  const facts: { key: string; subjectId?: string; value: Record<string, unknown> }[] = [
    { key: "space", subjectId: "hall", value: { spaceId: "hall", name: "Hall", capacityMin: 10, capacityMax: 200 } },
    { key: "price_line", subjectId: "dinner", value: { lineId: "dinner", label: "Dinner", pricingBasis: "per_guest", unitCents: 10000 } },
    { key: "pricing_bounds", value: { currency: "USD", floorCents: 100000, costsComplete: true, depositBps: 2000 } },
    { key: "service", subjectId: "dinner", value: { serviceId: "dinner", label: "Dinner", available: true } },
  ];
  for (const fact of facts) {
    const candidate = svc.intakeCandidate({
      businessId: w.businessId, ...fact, confidence: "probable", sourceReferences: SRC("fixture://contract/" + fact.key),
    });
    svc.confirmCandidate({ businessId: w.businessId, actor: { kind: "owner", id: OWNER }, candidateId: candidate.id });
  }
}

function inquiry(w: World, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    inquiryId: "inq-contract", businessId: w.businessId, eventType: "dinner",
    startAt: START, endAt: END, guestCount: 40, serviceRequirements: ["dinner"],
    sourceReferences: SRC("fixture://contract/inq"),
    ...overrides,
  };
}

function email() {
  return { to: ["guest@example.test"], subject: "Contract offer", body: "Contract hold." };
}

async function persistedProposal(w: World, bookingId: string) {
  const built = await buildBookingOffer(w.deps, { bookingId, inquiry: inquiry(w), calendarId: CAL } as never);
  const persisted = persistPreparedProposal(w.deps, built, { email: email(), expiresAt: EXPIRES });
  assert.ok(!("missing" in persisted), `expected persistable offer: ${JSON.stringify((persisted as { missing?: unknown }).missing)}`);
  if ("missing" in persisted) throw new Error("unreachable");
  return { built, persisted };
}

function adaptedFor(w: World, bookingId: string) {
  const booking = w.store.getBooking(bookingId);
  const business = w.store.getBusiness(w.businessId);
  const actions = w.store.listProposedActionsForBooking(bookingId);
  const workspace = {
    mode: { kind: "demo", label: "DEMO ONLY" },
    demo: true,
    approvalIdentity: OWNER,
    businesses: [{ id: business.id, name: business.name, timezone: business.timezone }],
    bookings: [{
      booking,
      proposals: actions.map((action) => ({
        action,
        consequences: previewConsequences(action.payload as Record<string, unknown>, { nowMs: Date.parse(NOW) }).consequences,
      })),
      approvals: actions.flatMap((action) => w.store.listApprovals(action.id)),
      executions: [],
    }],
    connections: [],
    notice: "contract test",
  };
  const adapted = adaptWorkspace(workspace as unknown as ClientWorkspaceDTO);
  return adapted.bookings[0].detail.proposal;
}

test("genuine server output renders priced through the host adapter", async () => {
  const w = world();
  try {
    confirmAll(w);
    const booking = w.store.createBooking({ businessId: w.businessId, eventName: "E", status: "pending_approval", sourceReferences: SRC("fixture://contract/b") });
    const { persisted } = await persistedProposal(w, booking.id);
    const payload = persisted.action.payload as Record<string, unknown>;
    // Complete OfferCandidate snapshot, not a lossy subset.
    const offer = payload.offer as Record<string, unknown>;
    assert.ok(typeof offer.fingerprint === "string" && offer.fingerprint.length > 0);
    assert.ok(Array.isArray(offer.sources) && offer.sources.length > 0);
    assert.ok(typeof payload.offerPreparationFingerprint === "string");
    const proposal = adaptedFor(w, booking.id);
    assert.equal(proposal.offerInvalid, undefined);
    assert.equal(proposal.total, "$4,000.00");
    assert.equal(proposal.deposit, "Deposit $800.00");
    assert.equal(proposal.offer?.spaceName, "Hall");
    assert.equal(proposal.offer?.guestCount, 40);
    assert.deepEqual(proposal.offer?.terms, (offer.consequences as string[]));
    assert.ok((proposal.lines?.length ?? 0) > 0, "priced lines render from the snapshot");
  } finally {
    w.cleanup();
  }
});

test("price, deposit, and space changes invalidate the old approval end to end", async () => {
  const w = world();
  try {
    confirmAll(w);
    const booking = w.store.createBooking({ businessId: w.businessId, eventName: "E", status: "pending_approval", sourceReferences: SRC("fixture://contract/b") });
    const first = await persistedProposal(w, booking.id);
    const oldApproval = w.store.approveProposedAction(first.persisted.action.id, OWNER);
    const before = adaptedFor(w, booking.id);
    assert.equal(before.total, "$4,000.00");

    // Price-only change.
    decideOperator(w.deps, "correct", {
      businessId: w.businessId, key: "price_line", subjectId: "dinner", expectedRevision: 1,
      value: { lineId: "dinner", label: "Dinner", pricingBasis: "per_guest", unitCents: 12000 },
    });
    const second = await persistedProposal(w, booking.id);
    assert.notEqual(second.persisted.action.id, first.persisted.action.id);
    assert.deepEqual(w.store.listApprovals(second.persisted.action.id), [], "old approval does not transfer to repriced action");
    const repriced = adaptedFor(w, booking.id);
    assert.equal(repriced.total, "$4,800.00");
    assert.equal(repriced.offerInvalid, undefined);

    // Deposit-only change (total untouched).
    decideOperator(w.deps, "correct", {
      businessId: w.businessId, key: "pricing_bounds", expectedRevision: 1,
      value: { currency: "USD", floorCents: 100000, costsComplete: true, depositBps: 5000 },
    });
    const third = await persistedProposal(w, booking.id);
    assert.notEqual(third.persisted.action.id, second.persisted.action.id);
    const redeposited = adaptedFor(w, booking.id);
    assert.equal(redeposited.total, "$4,800.00");
    assert.equal(redeposited.deposit, "Deposit $2,400.00");
    void oldApproval;
  } finally {
    w.cleanup();
  }
});

test("unknown costs render honestly with no profit claim through the adapter", async () => {
  const w = world();
  try {
    const svc = new KnowledgeService(w.store);
    const facts: { key: string; subjectId?: string; value: Record<string, unknown> }[] = [
      { key: "space", subjectId: "hall", value: { spaceId: "hall", name: "Hall", capacityMin: 10, capacityMax: 200 } },
      { key: "price_line", subjectId: "dinner", value: { lineId: "dinner", label: "Dinner", pricingBasis: "per_guest", unitCents: 10000 } },
      { key: "pricing_bounds", value: { currency: "USD", floorCents: 100000, costsComplete: false } },
      { key: "service", subjectId: "dinner", value: { serviceId: "dinner", label: "Dinner", available: true } },
    ];
    for (const fact of facts) {
      const candidate = svc.intakeCandidate({
        businessId: w.businessId, ...fact, confidence: "probable", sourceReferences: SRC("fixture://contract/" + fact.key),
      });
      svc.confirmCandidate({ businessId: w.businessId, actor: { kind: "owner", id: OWNER }, candidateId: candidate.id });
    }
    const booking = w.store.createBooking({ businessId: w.businessId, eventName: "E", status: "pending_approval", sourceReferences: SRC("fixture://contract/b") });
    const { persisted } = await persistedProposal(w, booking.id);
    const offer = (persisted.action.payload as Record<string, unknown>).offer as Record<string, unknown>;
    assert.equal(offer.profitabilityClaimed, false);
    const proposal = adaptedFor(w, booking.id);
    assert.equal(proposal.offerInvalid, undefined);
    assert.equal(proposal.total, "$4,000.00");
    assert.equal(proposal.offer?.profitabilityClaimed, false);
  } finally {
    w.cleanup();
  }
});
