import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { issueAcceptanceToken, processAcceptanceReply } from "../src/server/acceptance/index.ts";
import { composeAcceptanceLink } from "../src/server/business-operator/operator.ts";
import { DeliveryStore } from "../src/server/booking-delivery/store.ts";
import { buildHandoff } from "../src/delivery/handoff.ts";
import { evaluateReadiness } from "../src/delivery/readiness.ts";

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

test("011-A03 accepted evidence remains provisional until required evidence is present", () => {
  const { db, store } = setup();
  const source = { kind: "email" as const, locator: "fixture://accepted", fictional: true };
  const proposal = { bookingId: "booking", businessId: "biz", proposalVersion: 2, proposalFingerprint: "fp-2", kind: "create_provisional_hold", payload: { startAt: "2026-10-01T10:00:00Z", endAt: "2026-10-01T12:00:00Z", services: [{ name: "Dinner" }], responsibilities: [{ party: "Owner", task: "Staff" }] }, sourceReferences: [source] };
  const booking = { id: "booking", businessId: "biz", status: "provisional_hold", eventName: "Dinner", startAt: "2026-10-01T10:00:00Z", endAt: "2026-10-01T12:00:00Z", sourceReferences: [source] };
  const decision = evaluateReadiness({ nowIso: "2026-09-18T10:00:00Z", businessId: "biz", booking, proposal, policy: { businessId: "biz", conditions: [{ kind: "customer_acceptance", required: true }, { kind: "resource_commitment", required: true, resources: { requiredResourceIds: ["room"] } }] }, evidence: [{ resolver: "acceptance_record", bookingId: "booking", proposalVersion: 2, proposalFingerprint: "fp-2", acceptedAt: "2026-09-18T09:00:00Z", sourceRefs: [source] }] });
  assert.equal(decision.ready, false);
  assert.match(decision.blockedBy.join(";"), /resource_commitment:missing/);
  const handoff = buildHandoff({ decision, booking, proposal });
  assert.equal(handoff.ready, false);
  assert.match(handoff.outstanding.join(";"), /resource_commitment/);
  db.close();
});

test("011-A04 handoff stays bound to accepted version and price correction cannot rewrite it", () => {
  const { db, store } = setup();
  const source = { kind: "email" as const, locator: "fixture://accepted", fictional: true };
  const base = { bookingId: "booking", businessId: "biz", proposalVersion: 2, proposalFingerprint: "fp-2", kind: "create_provisional_hold", payload: { totalCents: 10000, services: [{ name: "Dinner" }], responsibilities: [{ party: "Owner", task: "Staff" }] }, sourceReferences: [source] };
  const booking = { id: "booking", businessId: "biz", status: "provisional_hold", eventName: "Dinner", sourceReferences: [source] };
  const decision = { binding: { businessId: "biz", bookingId: "booking", proposalVersion: 2, proposalFingerprint: "fp-2" }, evaluatedAt: "2026-09-18T10:00:00Z", conditions: [{ kind: "customer_acceptance" as const, required: true, status: "verified" as const, detail: "accepted", evidence: [source], waived: false }], ready: true, liveReady: false, provenance: "demo" as const, blockedBy: [], ignoredRawSignals: 0, rejectedEvidence: [] };
  const handoff = buildHandoff({ decision, booking, proposal: base });
  assert.equal((handoff as unknown as { binding: { proposalFingerprint: string } }).binding.proposalFingerprint, "fp-2");
  assert.throws(() => buildHandoff({ decision, booking, proposal: { ...base, proposalVersion: 3, proposalFingerprint: "fp-3", payload: { ...base.payload, totalCents: 12000 } } }), /binding mismatch/i);
  db.close();
});

test("acceptance-link composition labels the send step and binds exact action identity", () => {
  const { db } = setup();
  const store = new DeliveryStore(db);
  const result = composeAcceptanceLink({ store: { db } as never, acceptanceKeyring: keyring }, { bookingId: "booking", proposalVersion: 2, proposalFingerprint: "fp-2", payload: {} }, { businessId: "biz", customerEmail: "customer@example.test", mailbox: "owner@example.test", issuedAt: "2026-09-18T10:00:00Z", expiresAt: "2026-09-18T11:00:00Z" });
  assert.equal(result.label, "Accept by email");
  assert.match(result.explanation, /send/i);
  assert.doesNotMatch(result.mailto, /10000|customer@example/);
  db.close();
});
