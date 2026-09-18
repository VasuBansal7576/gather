import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { issueAcceptanceToken, processAcceptanceReply } from "../src/server/acceptance/index.ts";
import { DeliveryStore } from "../src/server/booking-delivery/store.ts";

const refs = [{ kind: "email" as const, locator: "fixture://acceptance/reply", fictional: true }];
const keyring = { activeVersion: "v1", keys: { v1: "test-only-signing-key" } };
const input = {
  businessId: "biz", bookingId: "booking", proposalVersion: 2, proposalFingerprint: "fp-2",
  authorizedSender: "Customer@Example.test", mailbox: "owner@example.test",
  issuedAt: "2026-09-18T10:00:00.000Z", expiresAt: "2026-09-18T11:00:00.000Z", keyVersion: "v1",
};
function setup(): { db: DatabaseSync; store: DeliveryStore } {
  const db = new DatabaseSync(":memory:");
  return { db, store: new DeliveryStore(db) };
}
function reply(body: string, changes: Record<string, unknown> = {}): Parameters<typeof processAcceptanceReply>[1] {
  return {
    body, sender: "customer@example.test", providerAuthenticated: true, originalOfferReceipt: true,
    currentOffer: { bookingId: "booking", proposalVersion: 2, proposalFingerprint: "fp-2" }, sourceRefs: refs,
    acceptedAt: "2026-09-18T10:30:00.000Z", ...changes,
  };
}

test("011-A01 mailto opening does not accept, but a verified new-thread token reply does", () => {
  const { db, store } = setup();
  const issued = issueAcceptanceToken(store, input, keyring);
  assert.match(issued.mailto, /^mailto:owner@example\.test\?/);
  assert.equal(store.listAcceptance("biz", "booking").length, 0);
  const accepted = processAcceptanceReply(store, reply(decodeURIComponent(issued.mailto).match(/gather-token=[^&]+/)?.[0] ?? ""), keyring);
  assert.equal(accepted.status, "accepted");
  assert.equal(store.listAcceptance("biz", "booking").length, 1);
  db.close();
});

test("011-A02 rejects tamper, forwarding, expiry and replay while duplicate replay is idempotent", () => {
  const { db, store } = setup();
  const issued = issueAcceptanceToken(store, input, keyring);
  const body = decodeURIComponent(issued.mailto).match(/gather-token=[^&]+/)?.[0] ?? "";
  assert.equal(processAcceptanceReply(store, reply(body.replace(/.$/, "x")), keyring).status, "rejected");
  assert.equal(processAcceptanceReply(store, reply(body, { sender: "stranger@example.test" }), keyring).status, "rejected");
  const first = processAcceptanceReply(store, reply(body), keyring);
  const second = processAcceptanceReply(store, reply(body), keyring);
  assert.equal(first.status, "accepted");
  assert.equal(second.status, "accepted");
  if (first.status === "accepted" && second.status === "accepted") assert.equal(first.record.acceptedAt, second.record.acceptedAt);
  const expired = issueAcceptanceToken(store, { ...input, proposalVersion: 3, proposalFingerprint: "fp-3", expiresAt: "2026-09-18T10:01:00.000Z" }, keyring);
  const expiredBody = decodeURIComponent(expired.mailto).match(/gather-token=[^&]+/)?.[0] ?? "";
  assert.equal(processAcceptanceReply(store, reply(expiredBody), keyring).status, "rejected");
  db.close();
});

test("plain yes is review-only and reissue supersedes the previous token", () => {
  const { db, store } = setup();
  assert.equal(processAcceptanceReply(store, reply("yes"), keyring).status, "review");
  const first = issueAcceptanceToken(store, input, keyring);
  const second = issueAcceptanceToken(store, input, keyring);
  const firstBody = decodeURIComponent(first.mailto).match(/gather-token=[^&]+/)?.[0] ?? "";
  assert.equal(processAcceptanceReply(store, reply(firstBody), keyring).status, "rejected");
  const secondBody = decodeURIComponent(second.mailto).match(/gather-token=[^&]+/)?.[0] ?? "";
  assert.equal(processAcceptanceReply(store, reply(secondBody), keyring).status, "accepted");
  db.close();
});
