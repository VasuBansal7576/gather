/**
 * ADR-006 wiring for the deferred ADR-011 live inbound mailbox callback
 * (composition of existing ports — no new authority, no new scheduler).
 *
 * The intake sweep already routes every inbound message through an optional
 * host-owned `acceptance` validator before the new-inquiry gate. This module
 * builds that validator for the live path from the reviewed pieces:
 * `processAcceptanceReply` (exact token/version/sender/expiry checks),
 * the delivery token store, the durable current-proposal pointer, and the
 * persisted email provider receipt as the original offer-send proof.
 *
 * Fail-closed rules:
 * - No token candidate in the body → "ignored" (normal gating continues).
 * - No signing keyring, no token record, or any ambiguity → "ignored" or
 *   "review", never "accepted".
 * - `providerAuthenticated` is true only for messages arriving through the
 *   authorized connected-account poll (connector-attested transport) with a
 *   parseable sender. Transport attestation is the connector's claim, not
 *   message content; full C02 senderEvidence (mailbox/auth status + provider
 *   record locator) rides on the Gmail port's authenticated API read.
 * - `originalOfferReceipt` requires the persisted provider receipt for the
 *   token's exact action email step — a missing record is review, never
 *   acceptance.
 */

import type { InquiryMessage, InquiryThread } from "../../connectors/contracts.ts";
import type { IntakeDeps } from "../operator-runtime/intake.ts";
import { emailOperationKey } from "../booking-service.ts";
import { DeliveryStore } from "../booking-delivery/store.ts";
import {
  configuredAcceptanceKeyring,
  processAcceptanceReply,
  type AcceptanceKeyring,
} from "../acceptance/index.ts";
import type { GatherStore } from "../sqlite-store.ts";

export type LiveAcceptanceValidator = NonNullable<IntakeDeps["acceptance"]>;

export interface LiveAcceptanceCallbackDeps {
  store: GatherStore;
  /** Explicit keyring; absent → every message is ignored (fail closed). */
  keyring?: AcceptanceKeyring;
  /** True only when the sweep poll is live connector-attested mail. */
  liveTransport: boolean;
  now?: () => string;
}

function addressOf(from: string): string | undefined {
  const match = /<([^<>@\s]+@[^<>@\s]+)>/.exec(from);
  if (match?.[1]) return match[1];
  const plain = from.trim();
  return /^[^@\s]+@[^@\s]+$/.test(plain) ? plain : undefined;
}

function tokenCandidate(body: string): string | undefined {
  const match = /gather-token=([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/.exec(body);
  return match?.[1];
}

/**
 * Build the live inbound acceptance validator. Pure composition: it reads
 * durable rows and calls the reviewed `processAcceptanceReply`; it mints
 * no authority of its own.
 */
export function createLiveAcceptanceValidator(deps: LiveAcceptanceCallbackDeps): LiveAcceptanceValidator {
  return async (input: { message: InquiryMessage; thread?: InquiryThread }) => {
    const candidate = tokenCandidate(input.message.body);
    // No token-looking content: ordinary traffic, fall through to the gate.
    // A token-looking string alone grants no identity or authority.
    if (candidate === undefined) return { outcome: "ignored" };
    const keyring = deps.keyring ?? configuredAcceptanceKeyring();
    if (keyring === undefined) return { outcome: "ignored" };
    // Pre-parse only to scope durable lookups (booking, current offer,
    // original send receipt). Validation itself stays inside
    // processAcceptanceReply; nothing here pre-approves.
    const separator = candidate.indexOf(".");
    if (separator < 1) return { outcome: "ignored" };
    const { createHash } = await import("node:crypto");
    const delivery = new DeliveryStore(deps.store.db);
    const token = delivery.getAcceptanceToken(createHash("sha256").update(candidate.slice(0, separator)).digest("hex"));
    if (!token) return { outcome: "ignored" };
    let currentAction;
    try {
      currentAction = deps.store.getCurrentProposalAction(token.bookingId);
    } catch {
      return { outcome: "review", reason: "Acceptance token names an unknown booking" };
    }
    if (!currentAction) return { outcome: "review", reason: "Acceptance token names a booking with no current proposal" };
    const sender = addressOf(input.message.from);
    const acceptedAt = deps.now ? deps.now() : new Date().toISOString();
    const outcome = processAcceptanceReply(
      delivery,
      {
        body: input.message.body,
        sender: sender ?? "",
        // Connector-attested live transport plus a parseable sender. The
        // exact-sender match is enforced inside processAcceptanceReply; an
        // unparseable sender fails there, never here by assumption.
        providerAuthenticated: deps.liveTransport && sender !== undefined,
        originalOfferReceipt:
          deps.store.getProviderReceipt(emailOperationKey(currentAction.id, currentAction.proposalVersion)) !== undefined,
        currentOffer: {
          bookingId: currentAction.bookingId,
          proposalVersion: currentAction.proposalVersion,
          proposalFingerprint: currentAction.proposalFingerprint,
        },
        sourceRefs: input.message.sourceReferences,
        acceptedAt,
      },
      keyring,
    );
    if (outcome.status === "accepted") return { outcome: "accepted", bookingId: outcome.record.bookingId };
    if (outcome.status === "review") return { outcome: "review", reason: outcome.reason };
    return { outcome: "ignored" };
  };
}

/**
 * Gate for wiring the callback into bootstrap: live transport only, never
 * prepared fixtures. The caller (runtime composition) passes liveTransport
 * true only when the live gate for the selected profile passes; prepared
 * installs wire nothing and their token-looking fixtures stay inert.
 */
export function liveAcceptanceWired(input: { mode: string; liveGatePasses: boolean }): boolean {
  return input.mode === "live" && input.liveGatePasses;
}
