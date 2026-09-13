import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { GatherStore } from "../src/server/sqlite-store.ts";

// Clearly fictional fixture data. It is never presented as a connected integration.
const fixtureSource = {
  kind: "fixture" as const,
  locator: "fixture://fictional/sample-inquiry-001",
  label: "Fictional sample inquiry",
  fictional: true,
};

function fixtureStore(): { store: GatherStore; bookingId: string; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), "gather-test-"));
  const store = new GatherStore(join(directory, "gather.sqlite"));
  const business = store.createBusiness({ name: "Fictional Cedar Hall", timezone: "America/New_York" });
  const booking = store.createBooking({ businessId: business.id, eventName: "Fictional rehearsal dinner", sourceReferences: [fixtureSource] });
  return { store, bookingId: booking.id, cleanup: () => { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test("repeated approval and execution do not repeat an action", () => {
  const { store, bookingId, cleanup } = fixtureStore();
  try {
    const action = store.createProposedAction({ bookingId, kind: "send_offer", payload: { totalCents: 120000 }, sourceReferences: [fixtureSource] });
    const firstApproval = store.approveProposedAction(action.id, "fictional-owner");
    const repeatedApproval = store.approveProposedAction(action.id, "fictional-owner");
    assert.equal(repeatedApproval.id, firstApproval.id);
    assert.equal(store.listApprovals(action.id).length, 1);

    let calls = 0;
    const firstExecution = store.executeApprovedAction(action.id, () => {
      calls += 1;
      return { status: "succeeded", result: { fixtureMessageId: "fictional-message-001" } };
    });
    const repeatedExecution = store.executeApprovedAction(action.id, () => {
      calls += 1;
      return { status: "succeeded" };
    });
    assert.equal(calls, 1);
    assert.equal(repeatedExecution.id, firstExecution.id);
    assert.equal(repeatedExecution.status, "succeeded");
  } finally {
    cleanup();
  }
});

test("changing a proposal invalidates its exact-version approval", () => {
  const { store, bookingId, cleanup } = fixtureStore();
  try {
    const action = store.createProposedAction({ bookingId, kind: "send_offer", payload: { totalCents: 120000 }, sourceReferences: [fixtureSource] });
    const oldApproval = store.approveProposedAction(action.id, "fictional-owner");
    const changed = store.replaceProposedAction(action.id, { kind: "send_offer", payload: { totalCents: 125000 }, sourceReferences: [fixtureSource] });
    assert.equal(changed.proposalVersion, 2);
    assert.notEqual(changed.proposalFingerprint, action.proposalFingerprint);
    assert.equal(store.getApproval(oldApproval.id).status, "invalidated");
    assert.throws(() => store.executeApprovedAction(action.id, () => ({ status: "succeeded" })), /exact current proposal version/);

    const newApproval = store.approveProposedAction(action.id, "fictional-owner");
    assert.notEqual(newApproval.id, oldApproval.id);
    assert.equal(newApproval.proposalVersion, 2);
    assert.equal(store.listApprovals(action.id).length, 2);
  } finally {
    cleanup();
  }
});

test("uncertain and partial outcomes are durable and require reconciliation", () => {
  const { store, bookingId, cleanup } = fixtureStore();
  try {
    const action = store.createProposedAction({ bookingId, kind: "create_provisional_hold", payload: { date: "2030-05-18" }, sourceReferences: [fixtureSource] });
    store.approveProposedAction(action.id, "fictional-owner");
    let calls = 0;
    const uncertain = store.executeApprovedAction(action.id, () => {
      calls += 1;
      throw new Error("fixture timeout after request");
    });
    assert.equal(uncertain.status, "uncertain");
    const repeated = store.executeApprovedAction(action.id, () => {
      calls += 1;
      return { status: "succeeded" };
    });
    assert.equal(repeated.id, uncertain.id);
    assert.equal(calls, 1);
    assert.equal(store.reconcileActionExecution(uncertain.id, { status: "failed", error: "fixture confirmed not applied" }).status, "failed");
    const retry = store.executeApprovedAction(action.id, () => {
      calls += 1;
      return { status: "partial", result: { hold: "created", notification: "not sent" } };
    });
    assert.equal(retry.status, "partial");
    assert.equal(calls, 2);
    assert.equal(store.reconcileActionExecution(retry.id, { status: "succeeded", result: { reconciled: true } }).status, "succeeded");
  } finally {
    cleanup();
  }
});

test("records survive closing and reopening the local SQLite database", () => {
  const directory = mkdtempSync(join(tmpdir(), "gather-persist-"));
  const path = join(directory, "gather.sqlite");
  const first = new GatherStore(path);
  const business = first.createBusiness({ name: "Fictional Oak Room", timezone: "UTC" });
  first.close();
  const second = new GatherStore(path);
  try {
    const booking = second.createBooking({ businessId: business.id, eventName: "Fictional persisted booking", sourceReferences: [fixtureSource] });
    const action = second.createProposedAction({ bookingId: booking.id, kind: "update_booking", payload: { status: "provisional_hold" }, sourceReferences: [fixtureSource] });
    second.approveProposedAction(action.id, "fictional-owner");
    assert.equal(second.getProposedAction(action.id).proposalVersion, 1);
  } finally {
    second.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
