import { createHash, createHmac, randomBytes } from "node:crypto";
import type { SourceReference } from "../../domain/contracts.ts";
import type { AcceptanceRecord } from "../../delivery/contracts.ts";
import type { DeliveryStore, AcceptanceToken } from "../booking-delivery/store.ts";

export interface AcceptanceTokenInput {
  businessId: string;
  bookingId: string;
  proposalVersion: number;
  proposalFingerprint: string;
  authorizedSender: string;
  mailbox: string;
  issuedAt: string;
  expiresAt: string;
  keyVersion: string;
}

export interface AcceptanceKeyring { activeVersion: string; keys: Record<string, string>; }

/** Local host configuration; the signing secret is never returned to callers. */
export function configuredAcceptanceKeyring(): AcceptanceKeyring | undefined {
  const secret = process.env.GATHER_ACCEPTANCE_KEY?.trim();
  return secret ? { activeVersion: "env-v1", keys: { "env-v1": secret } } : undefined;
}

export interface AcceptanceReply {
  body: string;
  sender: string;
  providerAuthenticated: boolean;
  originalOfferReceipt: boolean;
  currentOffer: { bookingId: string; proposalVersion: number; proposalFingerprint: string };
  sourceRefs: SourceReference[];
  acceptedAt: string;
}

export type AcceptanceOutcome =
  | { status: "accepted"; record: AcceptanceRecord; token: AcceptanceToken }
  | { status: "review"; reason: string }
  | { status: "rejected"; reason: string };

function normalized(value: string): string { return value.trim().toLowerCase(); }
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function sign(handle: string, key: string): string { return createHmac("sha256", key).update(handle).digest("base64url"); }
function constantTimeEqual(left: string, right: string): boolean {
  return left.length === right.length && createHash("sha256").update(left).digest().equals(createHash("sha256").update(right).digest());
}
function tokenCandidate(body: string): string | undefined {
  const match = /gather-token=([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/.exec(body);
  return match?.[1];
}
function plainYes(body: string): boolean { return body.trim().toLowerCase() === "yes"; }

/** Issues an opaque mailto token. Binding data never enters the URL. */
export function issueAcceptanceToken(store: DeliveryStore, input: AcceptanceTokenInput, keyring: AcceptanceKeyring): { token: AcceptanceToken; mailto: string } {
  if (!/^[^@\s]+@[^@\s]+$/.test(normalized(input.mailbox))) throw new Error("Acceptance mailbox is invalid");
  if (input.keyVersion !== keyring.activeVersion) throw new Error("Acceptance token key version is not active");
  const key = keyring.keys[input.keyVersion];
  if (!key) throw new Error("Acceptance signing key is unavailable");
  const handle = randomBytes(24).toString("base64url");
  const token = `${handle}.${sign(handle, key)}`;
  const binding: AcceptanceToken = {
    id: randomBytes(16).toString("hex"), handleDigest: digest(handle), nonceDigest: digest(randomBytes(32).toString("base64url")),
    businessId: input.businessId, bookingId: input.bookingId, proposalVersion: input.proposalVersion,
    proposalFingerprint: input.proposalFingerprint, authorizedSender: normalized(input.authorizedSender),
    issuedAt: input.issuedAt, expiresAt: input.expiresAt, keyVersion: input.keyVersion,
  };
  store.issueAcceptanceToken(binding);
  const subject = encodeURIComponent("Acceptance reply");
  const body = encodeURIComponent(`Please reply with this token to accept: gather-token=${token}`);
  return { token: binding, mailto: `mailto:${normalized(input.mailbox)}?subject=${subject}&body=${body}` };
}

/** Verifies an inbound reply, then atomically consumes the token and records evidence. */
export function processAcceptanceReply(store: DeliveryStore, reply: AcceptanceReply, keyring: AcceptanceKeyring): AcceptanceOutcome {
  if (!reply.providerAuthenticated) return { status: "review", reason: "Provider authentication is absent or ambiguous" };
  if (!reply.originalOfferReceipt) return { status: "review", reason: "No verified original offer-send receipt" };
  const candidate = tokenCandidate(reply.body);
  if (candidate === undefined) {
    if (plainYes(reply.body)) return { status: "review", reason: "Plain yes requires exactly one unambiguous correlated offer" };
    return { status: "rejected", reason: "No acceptance token found" };
  }
  const separator = candidate.indexOf(".");
  if (separator < 1) return { status: "rejected", reason: "Malformed acceptance token" };
  const handle = candidate.slice(0, separator);
  const signature = candidate.slice(separator + 1);
  const tokenKeyVersion = keyring.activeVersion;
  const key = keyring.keys[tokenKeyVersion];
  if (!key || !constantTimeEqual(signature, sign(handle, key))) return { status: "rejected", reason: "Invalid or rotated acceptance token" };
  const token = store.getAcceptanceToken(digest(handle));
  if (!token) return { status: "rejected", reason: "Unknown acceptance token" };
  if (token.keyVersion !== tokenKeyVersion) return { status: "rejected", reason: "Acceptance token key version is no longer valid" };
  if (token.supersededAt !== undefined) return { status: "rejected", reason: "Acceptance token was superseded" };
  if (token.usedAt !== undefined) {
    const existing = store.acceptanceForToken(token.id);
    if (existing) return { status: "accepted", record: existing, token };
  }
  if (Date.parse(token.expiresAt) <= Date.parse(reply.acceptedAt)) return { status: "rejected", reason: "Acceptance token expired" };
  if (normalized(reply.sender) !== token.authorizedSender) return { status: "rejected", reason: "Acceptance token sender does not match authorized customer" };
  if (reply.currentOffer.bookingId !== token.bookingId || reply.currentOffer.proposalVersion !== token.proposalVersion || reply.currentOffer.proposalFingerprint !== token.proposalFingerprint) {
    return { status: "rejected", reason: "Acceptance token does not match the current offer" };
  }
  const record = store.consumeAcceptanceToken(token.id, digest(candidate), {
    businessId: token.businessId, bookingId: token.bookingId, proposalVersion: token.proposalVersion,
    proposalFingerprint: token.proposalFingerprint, acceptedAt: reply.acceptedAt, acceptedBy: token.authorizedSender, sourceRefs: reply.sourceRefs,
  });
  return { status: "accepted", record, token };
}
