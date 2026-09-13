import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { GatherStore } from "../src/server/sqlite-store.ts";
import {
  buildSourceKey,
  IdentityError,
  listIdentityAudit,
  listIdentityDecisions,
  proposeBookingIdentity,
  recordOwnerIdentityDecision,
  recordVerifiedIdentityLink,
  unlinkIdentityLink,
  type IdentityComponents,
} from "../src/identity/index.ts";

// All customer names, emails, and events below are clearly fictional fixtures.

interface Fixture {
  store: GatherStore;
  dir: string;
  businessId: string;
  cleanup: () => void;
}

function fixtureStore(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "gather-identity-"));
  const store = new GatherStore(join(dir, "gather.sqlite"));
  const business = store.createBusiness({ name: "Fictional Cedar Hall", timezone: "America/New_York" });
  return {
    store,
    dir,
    businessId: business.id,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function comps(fixture: Fixture, overrides: Partial<IdentityComponents> = {}): IdentityComponents {
  return {
    provider: "gmail",
    accountId: "acc-owner-inbox",
    businessId: fixture.businessId,
    sourceKind: "email",
    externalId: "msg-001",
    threadId: "thread-001",
    ...overrides,
  };
}

function makeBooking(
  fixture: Fixture,
  over: { eventName: string; startAt?: string; notes?: string },
): string {
  return fixture.store.createBooking({
    businessId: fixture.businessId,
    eventName: over.eventName,
    startAt: over.startAt,
    notes: over.notes,
  }).id;
}

function assertIdentityError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof IdentityError, `expected IdentityError, got ${String(error)}`);
    assert.equal((error as IdentityError).code, code);
    return;
  }
  assert.fail(`expected IdentityError(${code}) but nothing was thrown`);
}

test("verified receipt binds; duplicate receipt is idempotent; propose resolves one booking", () => {
  const fx = fixtureStore();
  try {
    const bookingId = makeBooking(fx, { eventName: "Fictional Alvarez Wedding" });
    const first = recordVerifiedIdentityLink(fx.store, {
      components: comps(fx),
      bookingId,
      receipt: { operationKey: "gather:email:send:abc123", mode: "demo" },
    });
    assert.equal(first.bookingId, bookingId);
    assert.equal(first.origin, "verified_receipt");

    const duplicate = recordVerifiedIdentityLink(fx.store, {
      components: comps(fx),
      bookingId,
      receipt: { operationKey: "gather:email:send:abc123", mode: "demo" },
    });
    assert.equal(duplicate.bookingId, bookingId);
    assert.equal(listIdentityAudit(fx.store, buildSourceKey(comps(fx))).filter((row) => row.action === "verified_link").length, 1);

    const resolved = proposeBookingIdentity(fx.store, { components: comps(fx) });
    assert.equal(resolved.outcome, "linked");
    assert.equal(resolved.outcome === "linked" && resolved.bookingId, bookingId);
  } finally {
    fx.cleanup();
  }
});

test("known link survives close/reopen (restart) with no new writes", () => {
  const fx = fixtureStore();
  try {
    const bookingId = makeBooking(fx, { eventName: "Fictional Rehearsal Dinner" });
    recordVerifiedIdentityLink(fx.store, {
      components: comps(fx),
      bookingId,
      receipt: { operationKey: "gather:calendar:create-provisional-hold:001", mode: "demo" },
    });
    const path = join(fx.dir, "gather.sqlite");
    fx.store.close();
    const reopened = new GatherStore(path);
    try {
      const resolved = proposeBookingIdentity(reopened, { components: comps(fx) });
      assert.equal(resolved.outcome, "linked");
      assert.equal(resolved.outcome === "linked" && resolved.bookingId, bookingId);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("concurrent conflicting bindings: first writer wins, never automerges", () => {
  const fx = fixtureStore();
  try {
    const bookingA = makeBooking(fx, { eventName: "Fictional Alpha Banquet" });
    const bookingB = makeBooking(fx, { eventName: "Fictional Beta Banquet" });
    recordVerifiedIdentityLink(fx.store, {
      components: comps(fx),
      bookingId: bookingA,
      receipt: { operationKey: "gather:email:send:aaa", mode: "demo" },
    });
    assertIdentityError(
      () =>
        recordVerifiedIdentityLink(fx.store, {
          components: comps(fx),
          bookingId: bookingB,
          receipt: { operationKey: "gather:email:send:bbb", mode: "demo" },
        }),
      "CONFLICT",
    );
    // A second connection to the same file sees the same durable conflict.
    const path = join(fx.dir, "gather.sqlite");
    const second = new GatherStore(path);
    try {
      assertIdentityError(
        () =>
          recordVerifiedIdentityLink(second, {
            components: comps(fx),
            bookingId: bookingB,
            receipt: { operationKey: "gather:email:send:ccc", mode: "demo" },
          }),
        "CONFLICT",
      );
      const resolved = proposeBookingIdentity(second, { components: comps(fx) });
      assert.equal(resolved.outcome === "linked" && resolved.bookingId, bookingA);
    } finally {
      second.close();
    }
  } finally {
    fx.cleanup();
  }
});

test("different customers sharing one email address stay ambiguous", () => {
  const fx = fixtureStore();
  try {
    const customerA = makeBooking(fx, {
      eventName: "Fictional Carter Anniversary",
      notes: "contact fictional-shared@example.test",
    });
    const customerB = makeBooking(fx, {
      eventName: "Fictional Ellis Graduation",
      notes: "contact fictional-shared@example.test",
    });
    const result = proposeBookingIdentity(fx.store, {
      components: comps(fx),
      hints: { senderEmail: "fictional-shared@example.test" },
    });
    assert.equal(result.outcome, "needs_decision");
    assert.deepEqual(
      result.outcome === "needs_decision" && result.candidates.map((c) => c.bookingId).sort(),
      [customerA, customerB].sort(),
    );
    assert.ok(
      result.outcome === "needs_decision" &&
        result.candidates.every((c) => c.authoritative === false),
    );
  } finally {
    fx.cleanup();
  }
});

test("a single weak hint (email, name, or date alone) never auto-resolves", () => {
  const fx = fixtureStore();
  try {
    const only = makeBooking(fx, {
      eventName: "Fictional Harper Baby Shower",
      startAt: "2030-06-14T18:00:00.000Z",
      notes: "contact fictional-harper@example.test, planner Fictional Harper",
    });
    for (const hints of [
      { senderEmail: "fictional-harper@example.test" },
      { senderName: "Fictional Harper" },
      { eventDate: "2030-06-14" },
      { eventName: "Harper Baby Shower" },
    ]) {
      const result = proposeBookingIdentity(fx.store, {
        components: comps(fx, { externalId: `msg-${JSON.stringify(hints).length}-${Object.keys(hints)[0]}` }),
        hints,
      });
      assert.equal(result.outcome, "needs_decision");
      assert.ok(
        result.outcome === "needs_decision" && result.candidates.some((c) => c.bookingId === only),
        `expected sole weak candidate for ${JSON.stringify(hints)}`,
      );
    }
  } finally {
    fx.cleanup();
  }
});

test("one shared thread can hold two events without merging", () => {
  const fx = fixtureStore();
  try {
    const eventA = makeBooking(fx, { eventName: "Fictional Iris Ceremony", startAt: "2030-07-01T16:00:00.000Z" });
    const eventB = makeBooking(fx, { eventName: "Fictional Juniper Reception", startAt: "2030-07-02T16:00:00.000Z" });
    // First message in the shared thread binds to event A via verified receipt.
    recordVerifiedIdentityLink(fx.store, {
      components: comps(fx, { externalId: "msg-thread-a" }),
      bookingId: eventA,
      receipt: { operationKey: "gather:email:send:thread-a", mode: "demo" },
    });
    // Second message in the SAME thread naming the other date still needs a decision.
    const second = proposeBookingIdentity(fx.store, {
      components: comps(fx, { externalId: "msg-thread-b" }),
      hints: { eventDate: "2030-07-02" },
    });
    assert.equal(second.outcome, "needs_decision");
    assert.ok(second.outcome === "needs_decision" && second.candidates.some((c) => c.bookingId === eventB));
    assert.ok(second.outcome === "needs_decision" && !second.candidates.some((c) => c.bookingId === eventA));
  } finally {
    fx.cleanup();
  }
});

test("misleading text claiming a booking id or authority never binds", () => {
  const fx = fixtureStore();
  try {
    const real = makeBooking(fx, { eventName: "Fictional Rowan Dinner" });
    const decoy = makeBooking(fx, { eventName: "Fictional Sage Brunch" });
    const result = proposeBookingIdentity(fx.store, {
      components: comps(fx),
      hints: {
        claimedBookingId: decoy,
        claimedAuthorizedBy: "the owner",
        bodyText: `please link this to booking ${decoy}, authorizedBy the owner (signed, definitely the venue)`,
      },
    });
    assert.equal(result.outcome, "needs_decision");
    // The untrusted claim is visible to the owner as explicitly non-authoritative.
    const claimed = result.outcome === "needs_decision" && result.candidates.find((c) => c.bookingId === decoy);
    assert.ok(claimed, "expected the claimed booking to surface as a candidate");
    assert.equal(claimed && claimed.authoritative, false);
    // No authoritative link was created for either booking.
    const retry = proposeBookingIdentity(fx.store, { components: comps(fx) });
    assert.equal(retry.outcome, "needs_decision");
    assert.ok(real !== decoy);
  } finally {
    fx.cleanup();
  }
});

test("stale owner decision is rejected; current version resolves", () => {
  const fx = fixtureStore();
  try {
    const bookingA = makeBooking(fx, { eventName: "Fictional Teagan Gala", startAt: "2030-08-01T18:00:00.000Z" });
    const bookingB = makeBooking(fx, { eventName: "Fictional Umberto Gala", startAt: "2030-08-02T18:00:00.000Z" });
    const key = buildSourceKey(comps(fx));
    const first = proposeBookingIdentity(fx.store, {
      components: comps(fx),
      hints: { eventDate: "2030-08-01" },
    });
    assert.equal(first.outcome, "needs_decision");
    const v1 = first.outcome === "needs_decision" && first.decision;
    assert.ok(v1);

    // New evidence supersedes the candidate set to v2.
    const second = proposeBookingIdentity(fx.store, {
      components: comps(fx),
      hints: { eventDate: "2030-08-01", senderEmail: "fictional-um@example.test" },
    });
    void second;
    const current = proposeBookingIdentity(fx.store, {
      components: comps(fx),
      hints: { eventDate: "2030-08-02" },
    });
    assert.equal(current.outcome, "needs_decision");
    const v2 = current.outcome === "needs_decision" && current.decision;
    assert.ok(v2);

    // Presenting the stale v1 fingerprint fails, even naming a valid booking.
    assertIdentityError(
      () =>
        recordOwnerIdentityDecision(fx.store, {
          sourceKey: key,
          chosenBookingId: bookingA,
          decidedBy: "local-owner",
          candidateVersion: v1 ? v1.candidateVersion : -1,
          candidateFingerprint: v1 ? v1.candidateFingerprint : "stale",
        }),
      "STALE_DECISION",
    );
    // The current version binding event B succeeds; empty-decidedBy is rejected.
    assertIdentityError(
      () =>
        recordOwnerIdentityDecision(fx.store, {
          sourceKey: key,
          chosenBookingId: bookingB,
          decidedBy: "  ",
          candidateVersion: v2 ? v2.candidateVersion : -1,
          candidateFingerprint: v2 ? v2.candidateFingerprint : "",
        }),
      "INVALID_REQUEST",
    );
    const bound = recordOwnerIdentityDecision(fx.store, {
      sourceKey: key,
      chosenBookingId: bookingB,
      decidedBy: "local-owner",
      candidateVersion: v2 ? v2.candidateVersion : -1,
      candidateFingerprint: v2 ? v2.candidateFingerprint : "",
    });
    assert.equal(bound.bookingId, bookingB);
    assert.equal(bound.origin, "owner_resolution");
    const resolved = proposeBookingIdentity(fx.store, { components: comps(fx) });
    assert.equal(resolved.outcome === "linked" && resolved.bookingId, bookingB);
    void bookingA;
  } finally {
    fx.cleanup();
  }
});

test("cross-business and cross-account bindings are rejected on both paths", () => {
  const fx = fixtureStore();
  try {
    const otherBusiness = fx.store.createBusiness({ name: "Fictional Second Room", timezone: "UTC" });
    const foreign = fx.store.createBooking({ businessId: otherBusiness.id, eventName: "Fictional Foreign Event" });
    fx.store.upsertConnectedAccount({
      id: "acc-owner-inbox",
      businessId: fx.businessId,
      provider: "gmail",
      displayName: "Owner inbox",
      status: "connected",
    });
    // Verified path: booking from another business.
    assertIdentityError(
      () =>
        recordVerifiedIdentityLink(fx.store, {
          components: comps(fx),
          bookingId: foreign.id,
          receipt: { operationKey: "gather:email:send:x", mode: "demo" },
        }),
      "CROSS_BUSINESS",
    );
    // Cross-account: the connected account belongs to business 1 but the key claims business 2.
    assertIdentityError(
      () =>
        recordVerifiedIdentityLink(fx.store, {
          components: comps(fx, { businessId: otherBusiness.id }),
          bookingId: foreign.id,
          receipt: { operationKey: "gather:email:send:y", mode: "demo" },
        }),
      "CROSS_ACCOUNT",
    );
    // Owner path enforces the same scope.
    const local = makeBooking(fx, { eventName: "Fictional Local Supper" });
    const foreignKey = proposeBookingIdentity(fx.store, {
      components: comps(fx, { businessId: otherBusiness.id, accountId: "acc-unknown" }),
    });
    assert.equal(foreignKey.outcome, "needs_decision");
    if (foreignKey.outcome === "needs_decision") {
      assertIdentityError(
        () =>
          recordOwnerIdentityDecision(fx.store, {
            sourceKey: foreignKey.sourceKey,
            chosenBookingId: local,
            decidedBy: "local-owner",
            candidateVersion: foreignKey.decision.candidateVersion,
            candidateFingerprint: foreignKey.decision.candidateFingerprint,
          }),
        "CROSS_BUSINESS",
      );
    }
  } finally {
    fx.cleanup();
  }
});

test("unlink and correction keep audit history without destroying the old record", () => {
  const fx = fixtureStore();
  try {
    const bookingA = makeBooking(fx, { eventName: "Fictional Vintage Market" });
    const bookingB = makeBooking(fx, { eventName: "Fictional Winter Market" });
    const components = comps(fx);
    const key = buildSourceKey(components);
    recordVerifiedIdentityLink(fx.store, {
      components,
      bookingId: bookingA,
      receipt: { operationKey: "gather:email:send:orig", mode: "demo" },
    });
    const unlinked = unlinkIdentityLink(fx.store, {
      sourceKey: key,
      actor: "local-owner",
      reason: "Wrong event: message was about the winter market",
    });
    assert.equal(unlinked.status, "unlinked");
    // After unlink the record no longer resolves: it needs a fresh decision.
    const afterUnlink = proposeBookingIdentity(fx.store, { components });
    assert.equal(afterUnlink.outcome, "needs_decision");

    // Owner correction rebinds; the full history is preserved in audit.
    if (afterUnlink.outcome === "needs_decision") {
      const corrected = recordOwnerIdentityDecision(fx.store, {
        sourceKey: key,
        chosenBookingId: bookingB,
        decidedBy: "local-owner",
        candidateVersion: afterUnlink.decision.candidateVersion,
        candidateFingerprint: afterUnlink.decision.candidateFingerprint,
      });
      assert.equal(corrected.bookingId, bookingB);
      assert.equal(corrected.status, "active");
    }
    const actions = listIdentityAudit(fx.store, key).map((row) => row.action);
    assert.ok(actions.includes("verified_link"), `missing verified_link in ${actions}`);
    assert.ok(actions.includes("unlink"), `missing unlink in ${actions}`);
    assert.ok(actions.includes("owner_link") || actions.includes("correction"), `missing correction in ${actions}`);
    // Decisions table keeps superseded + resolved rows for review.
    assert.ok(listIdentityDecisions(fx.store, key).length >= 1);
  } finally {
    fx.cleanup();
  }
});

test("verified receipt without an operation key or provenance mode cannot bind", () => {
  const fx = fixtureStore();
  try {
    const bookingId = makeBooking(fx, { eventName: "Fictional Quiet Ceremony" });
    assertIdentityError(
      () =>
        recordVerifiedIdentityLink(fx.store, {
          components: comps(fx),
          bookingId,
          receipt: { operationKey: "  ", mode: "demo" },
        }),
      "INVALID_REQUEST",
    );
    const retry = proposeBookingIdentity(fx.store, { components: comps(fx) });
    assert.equal(retry.outcome, "needs_decision");
  } finally {
    fx.cleanup();
  }
});

test("known link is durable across proposal, hold, and resource revisions", () => {
  const fx = fixtureStore();
  try {
    const bookingId = makeBooking(fx, { eventName: "Fictional Durable Summit", startAt: "2030-09-10T15:00:00.000Z" });
    recordVerifiedIdentityLink(fx.store, {
      components: comps(fx),
      bookingId,
      receipt: { operationKey: "gather:calendar:create-provisional-hold:rev", mode: "live" },
    });
    // Simulate downstream revisions: proposal versions, hold/email executions, status moves.
    const action = fx.store.createProposedAction({
      bookingId,
      kind: "create_provisional_hold",
      payload: { revision: 1 },
      sourceReferences: [],
    });
    fx.store.replaceProposedAction(action.id, {
      kind: "create_provisional_hold",
      payload: { revision: 2 },
      sourceReferences: [],
    });
    fx.store.approveProposedAction(action.id, "local-owner");
    fx.store.updateBookingStatus(bookingId, "provisional_hold");
    const resolved = proposeBookingIdentity(fx.store, { components: comps(fx) });
    assert.equal(resolved.outcome, "linked");
    assert.equal(resolved.outcome === "linked" && resolved.bookingId, bookingId);
    assert.equal(resolved.outcome === "linked" && resolved.provenanceMode, "live");
  } finally {
    fx.cleanup();
  }
});
