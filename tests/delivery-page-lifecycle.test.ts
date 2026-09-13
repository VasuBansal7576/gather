import assert from "node:assert/strict";
import test from "node:test";
import {
  confirmResultStillCurrent,
  DeliveryPageLifecycle,
  proposalKey,
} from "../src/delivery-owner/page-lifecycle.ts";
import { RequestEpoch } from "../src/delivery-owner/state.ts";

// Regression for the source-confirmed busy-state wedge in
// app/bookings/[bookingId]/delivery/page.tsx: onConfirm/onRecordHandoff
// shared one RequestEpoch with load(). Success awaited load() (which bumped
// the same epoch), so the operation's own finally `isCurrent(originalRun)`
// always failed and busy stayed true forever; load() also cleared the
// just-set confirm result.

test("shared-epoch bug reproduction: operation + load on one epoch wedges busy and clears the result", () => {
  const epoch = new RequestEpoch();
  let confirmBusy = false;
  let confirmResult: string | null = null;

  // onConfirm starts.
  const op = epoch.next();
  confirmBusy = true;
  // Success sets the result, then awaits load() sharing the same epoch.
  const confirmed = epoch.isCurrent(op);
  assert.equal(confirmed, true);
  confirmResult = "confirmed-ok";

  // load() bumps the shared epoch and (old behavior) clears the result.
  const loadRun = epoch.next();
  assert.equal(epoch.isCurrent(op), false); // op epoch already stale
  confirmResult = null; // old load() wiped the just-set result
  assert.equal(epoch.isCurrent(loadRun), true);

  // The operation finally checks its original run: stale, so busy sticks.
  if (epoch.isCurrent(op)) confirmBusy = false;
  assert.equal(confirmBusy, true);
  assert.equal(confirmResult, null);
});

test("fixed lifecycle: confirm success survives its post-confirm reload and busy settles", () => {
  const page = new DeliveryPageLifecycle();
  const booking = "booking-fixture-1";

  const op = page.beginConfirm(booking);
  let busy = true;
  // Success commits while current.
  assert.equal(page.isConfirmCurrent(booking, op), true);
  const result = "confirmed-ok";
  // Post-confirm reload carries its own load generation.
  const loadGen = page.beginLoad(booking);
  // The operation lifecycle is untouched by the load generation.
  assert.equal(page.isConfirmCurrent(booking, op), true);
  assert.equal(page.isLoadCurrent(booking, loadGen), true);
  // finally clears busy because the confirm generation is still current.
  if (page.isConfirmCurrent(booking, op)) busy = false;
  assert.equal(busy, false);
  assert.equal(result, "confirmed-ok");
});

test("fixed lifecycle: record-handoff success survives reload and busy settles", () => {
  const page = new DeliveryPageLifecycle();
  const booking = "booking-fixture-1";
  const op = page.beginRecord(booking);
  let busy = true;
  assert.equal(page.isRecordCurrent(booking, op), true);
  page.beginLoad(booking);
  assert.equal(page.isRecordCurrent(booking, op), true);
  if (page.isRecordCurrent(booking, op)) busy = false;
  assert.equal(busy, false);
});

test("reload invalidates a stale load: only the latest generation commits", () => {
  const page = new DeliveryPageLifecycle();
  const booking = "booking-fixture-1";
  const first = page.beginLoad(booking);
  const second = page.beginLoad(booking);
  assert.equal(page.isLoadCurrent(booking, first), false);
  assert.equal(page.isLoadCurrent(booking, second), true);
});

test("concurrent confirms: the first success/error/finally cannot mutate the second", () => {
  const page = new DeliveryPageLifecycle();
  const booking = "booking-fixture-1";
  const first = page.beginConfirm(booking);
  const second = page.beginConfirm(booking);
  assert.equal(page.isConfirmCurrent(booking, first), false);
  assert.equal(page.isConfirmCurrent(booking, second), true);
});

test("navigation: stale booking commits never touch the current booking", () => {
  const page = new DeliveryPageLifecycle();
  const opA = page.beginConfirm("booking-A");
  const loadA = page.beginLoad("booking-A");
  page.rebindBooking("booking-B");
  const opB = page.beginConfirm("booking-B");
  assert.equal(page.isConfirmCurrent("booking-A", opA), false);
  assert.equal(page.isLoadCurrent("booking-A", loadA), false);
  assert.equal(page.isConfirmCurrent("booking-B", opB), true);
  // A late finally for A must not clear B's busy flag.
  let busyB = true;
  if (page.isConfirmCurrent("booking-A", opA)) busyB = false;
  assert.equal(busyB, true);
  if (page.isConfirmCurrent("booking-B", opB)) busyB = false;
  assert.equal(busyB, false);
});

test("unmount: pending success/error/finally commit nothing", () => {
  const page = new DeliveryPageLifecycle();
  const op = page.beginConfirm("booking-fixture-1");
  const load = page.beginLoad("booking-fixture-1");
  page.unmount();
  assert.equal(page.isConfirmCurrent("booking-fixture-1", op), false);
  assert.equal(page.isLoadCurrent("booking-fixture-1", load), false);
  page.mount();
  assert.equal(page.isConfirmCurrent("booking-fixture-1", op), true);
});

test("proposal identity: result stays useful only for the same booking and exact proposal", () => {
  const current = { proposedActionId: "action-1", proposalVersion: 1, proposalFingerprint: "fp-1", kind: "create_provisional_hold" };
  assert.equal(proposalKey(undefined), "");
  assert.match(proposalKey(current), /action-1@v1#fp-1/);
  const key = proposalKey(current);
  assert.equal(confirmResultStillCurrent("bk", "bk", key, key), true);
  assert.equal(confirmResultStillCurrent("bk", "bk", key, proposalKey({ ...current, proposalVersion: 2 })), false);
  assert.equal(confirmResultStillCurrent("bk", "bk", key, proposalKey({ ...current, proposalFingerprint: "fp-2" })), false);
  assert.equal(confirmResultStillCurrent("bk", "other", key, key), false);
  assert.equal(confirmResultStillCurrent("bk", "bk", "", key), false);
});
