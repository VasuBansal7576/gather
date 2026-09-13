import type { GatherStore } from "../server/sqlite-store.ts";
import {
  appendIdentityAudit,
  ensureBookingIdentityTables,
  fingerprintCandidates,
  getActiveIdentityLink,
  getIdentityLink,
  getOpenIdentityDecision,
  markDecisionResolved,
  openOrReuseIdentityDecision,
  type IdentityLinkRow,
  type ProvenanceMode,
} from "./store.ts";
import { buildSourceKey, decodeSourceKey, type IdentityComponents } from "./source-key.ts";

export type { IdentityComponents, IdentityLinkRow, ProvenanceMode };
export { buildSourceKey, decodeSourceKey, fingerprintCandidates };

/**
 * Source-observed hints. These are WEAK evidence: sender email/name/date
 * alone are never sufficient to bind a booking (different customers share an
 * email address; one thread can hold several events). Free-text claims
 * (`claimedBookingId`, `claimedAuthorizedBy`, `bodyText`) are UNTRUSTED and
 * can never create an authoritative link — they only surface as explicitly
 * non-authoritative candidates so the owner can see what the message claims.
 */
export interface IdentityHints {
  senderEmail?: string;
  senderName?: string;
  /** ISO date (YYYY-MM-DD prefix is compared against booking start dates). */
  eventDate?: string;
  eventName?: string;
  /** Untrusted: a message claiming a Gather booking id. Never authoritative. */
  claimedBookingId?: string;
  /** Untrusted: a message claiming an authorizer. Never authoritative. */
  claimedAuthorizedBy?: string;
  /** Untrusted free text. Never authoritative. */
  bodyText?: string;
}

export interface IdentityCandidate {
  bookingId: string;
  reasons: string[];
  /** Candidates are never authoritative; only verified receipts / owner decisions bind. */
  authoritative: false;
}

export type ProposeIdentityResult =
  | {
      outcome: "linked";
      sourceKey: string;
      bookingId: string;
      origin: IdentityLinkRow["origin"];
      provenanceMode: ProvenanceMode;
    }
  | {
      outcome: "needs_decision";
      sourceKey: string;
      candidates: IdentityCandidate[];
      decision: { id: string; candidateVersion: number; candidateFingerprint: string };
    };

export type IdentityErrorCode =
  | "CONFLICT"
  | "STALE_DECISION"
  | "CROSS_BUSINESS"
  | "CROSS_ACCOUNT"
  | "INVALID_REQUEST"
  | "NOT_FOUND";

export class IdentityError extends Error {
  readonly code: IdentityErrorCode;
  constructor(code: IdentityErrorCode, message: string) {
    super(message);
    this.name = "IdentityError";
    this.code = code;
  }
}

/** Host-verified, provider-correlated receipt. Only this (or an owner decision) can bind. */
export interface VerifiedReceipt {
  /** Stable provider operation key correlating the observed record (e.g. hold/email operation key). */
  operationKey: string;
  /** Demo receipts are simulated fixtures; live receipts are real provider state. Never conflated. */
  mode: ProvenanceMode;
}

function bookingBusinessId(store: GatherStore, bookingId: string): string {
  try {
    return store.getBooking(bookingId).businessId;
  } catch {
    throw new IdentityError("NOT_FOUND", `Booking not found: ${bookingId}`);
  }
}

function connectedAccountBusiness(store: GatherStore, accountId: string): { businessId: string; provider: string } | undefined {
  try {
    const account = store.getConnectedAccount(accountId);
    return { businessId: account.businessId, provider: account.provider };
  } catch {
    // Unknown accounts are allowed: the link still records the caller's
    // account id, and owner resolution stays scoped to the source key.
    return undefined;
  }
}

/**
 * Enforce business/account scope shared by both binding paths. A source key
 * from one business or account can never bind a booking from another.
 */
function requireScope(
  store: GatherStore,
  key: IdentityComponents,
  bookingId: string,
  bookingBusiness: string,
): void {
  if (bookingBusiness !== key.businessId) {
    throw new IdentityError(
      "CROSS_BUSINESS",
      `Cross-business link denied: source key belongs to business ${key.businessId} but booking ${bookingId} belongs to ${bookingBusiness}`,
    );
  }
  const account = connectedAccountBusiness(store, key.accountId);
  if (account && account.businessId !== key.businessId) {
    throw new IdentityError(
      "CROSS_ACCOUNT",
      `Cross-account link denied: account ${key.accountId} belongs to business ${account.businessId}, not ${key.businessId}`,
    );
  }
  if (account && account.provider !== "other" && account.provider !== key.provider) {
    throw new IdentityError(
      "INVALID_REQUEST",
      `Provider mismatch: account ${key.accountId} is a "${account.provider}" account, not "${key.provider}"`,
    );
  }
}

function tokens(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 4);
}

/**
 * Deterministic candidate collection over bookings in the SAME business.
 * Sorted by booking id. Weak hints only nominate; they never resolve.
 */
export function findCandidates(
  store: GatherStore,
  businessId: string,
  hints: IdentityHints = {},
): IdentityCandidate[] {
  const byId = new Map<string, Set<string>>();
  const touch = (bookingId: string, reason: string): void => {
    const reasons = byId.get(bookingId) ?? new Set<string>();
    reasons.add(reason);
    byId.set(bookingId, reasons);
  };
  const bookings = [...store.listBookings(businessId)].sort((left, right) => left.id.localeCompare(right.id));
  const knownIds = new Set(bookings.map((booking) => booking.id));

  const senderEmail = hints.senderEmail?.trim().toLowerCase();
  if (senderEmail) {
    for (const booking of bookings) {
      if ((booking.notes ?? "").toLowerCase().includes(senderEmail)) touch(booking.id, "contact-email-weak");
    }
  }
  const senderName = hints.senderName?.trim().toLowerCase();
  if (senderName) {
    for (const nameToken of tokens(senderName)) {
      for (const booking of bookings) {
        const haystack = `${booking.eventName} ${booking.notes ?? ""}`.toLowerCase();
        if (haystack.includes(nameToken)) touch(booking.id, "contact-name-weak");
      }
    }
  }
  const eventDate = hints.eventDate?.trim().slice(0, 10);
  if (eventDate && /^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
    for (const booking of bookings) {
      if (booking.startAt?.slice(0, 10) === eventDate) touch(booking.id, "event-date-weak");
    }
  }
  if (hints.eventName?.trim()) {
    const hintTokens = new Set(tokens(hints.eventName));
    for (const booking of bookings) {
      if (tokens(booking.eventName).some((token) => hintTokens.has(token))) touch(booking.id, "event-name-weak");
    }
  }
  // Untrusted claim: surfaced so the owner sees what the message ASSERTS, but
  // flagged non-authoritative and never sufficient to link on its own.
  const claimed = hints.claimedBookingId?.trim();
  if (claimed && knownIds.has(claimed)) {
    touch(claimed, "untrusted-claim (message-asserted booking id; not authoritative)");
  }
  if (hints.claimedAuthorizedBy?.trim() || hints.bodyText?.includes("authorizedBy")) {
    for (const id of knownIds) {
      if (byId.has(id)) touch(id, "untrusted-authorizer-text (never grants authority)");
    }
  }
  return [...byId.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([bookingId, reasons]) => ({ bookingId, reasons: [...reasons].sort(), authoritative: false as const }));
}

/**
 * Resolve one provider-side record to its booking.
 *
 * - A durable ACTIVE link for the exact source key resolves immediately.
 * - Anything else returns `needs_decision` with deterministic candidates and
 *   an open owner decision (versioned + fingerprinted). Weak hints and
 *   untrusted message claims NEVER auto-merge: even a single weak candidate
 *   requires explicit owner resolution.
 */
export function proposeBookingIdentity(
  store: GatherStore,
  input: { components: IdentityComponents; hints?: IdentityHints },
): ProposeIdentityResult {
  ensureBookingIdentityTables(store);
  const sourceKey = buildSourceKey(input.components);
  const active = getActiveIdentityLink(store, sourceKey);
  if (active) {
    return {
      outcome: "linked",
      sourceKey,
      bookingId: active.bookingId,
      origin: active.origin,
      provenanceMode: active.provenanceMode,
    };
  }
  const candidates = findCandidates(store, input.components.businessId, input.hints ?? {});
  const decision = openOrReuseIdentityDecision(
    store,
    sourceKey,
    candidates.map((candidate) => candidate.bookingId),
  );
  return {
    outcome: "needs_decision",
    sourceKey,
    candidates,
    decision: {
      id: decision.id,
      candidateVersion: decision.candidateVersion,
      candidateFingerprint: decision.candidateFingerprint,
    },
  };
}

function isConcurrencyConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint|already exists|database is locked|database table is locked|busy|BUSY/i.test(message);
}

/**
 * Bind a source key from a HOST-VERIFIED, provider-correlated receipt
 * (e.g. a durable hold/email receipt whose operation key the host observed
 * at the provider, or a host-fetched provider record id). Untrusted message
 * content must never reach this function: there is deliberately no parameter
 * for it. First writer wins; any conflicting binding throws CONFLICT and
 * never silently merges or overwrites — including rows left by unlink
 * history, which require owner resolution to revisit.
 */
export function recordVerifiedIdentityLink(
  store: GatherStore,
  input: { components: IdentityComponents; bookingId: string; receipt: VerifiedReceipt; actor?: string },
): IdentityLinkRow {
  ensureBookingIdentityTables(store);
  const key = decodeSourceKey(buildSourceKey(input.components));
  const sourceKey = buildSourceKey(key);
  if (!input.receipt?.operationKey?.trim()) {
    throw new IdentityError("INVALID_REQUEST", "Verified receipt requires a non-empty provider operation key");
  }
  if (input.receipt.mode !== "demo" && input.receipt.mode !== "live") {
    throw new IdentityError("INVALID_REQUEST", "Verified receipt requires an explicit provenance mode ('demo' or 'live')");
  }
  const business = bookingBusinessId(store, input.bookingId);
  requireScope(store, key, input.bookingId, business);
  const existing = getIdentityLink(store, sourceKey);
  if (existing && existing.bookingId === input.bookingId && existing.status === "active") return existing; // duplicate receipt: idempotent
  if (existing) {
    throw new IdentityError(
      "CONFLICT",
      `Source key is already bound to booking ${existing.bookingId} (status ${existing.status}); conflicting verified binding for ${input.bookingId} refused — resolve via owner decision`,
    );
  }
  const timestamp = new Date().toISOString();
  try {
    store.db.prepare(
      `INSERT INTO booking_identity_links
        (source_key, booking_id, business_id, account_id, provider, origin, provenance_mode, receipt_operation_key, status, created_at, updated_at)
       VALUES ($key, $booking, $business, $account, $provider, 'verified_receipt', $mode, $receipt, 'active', $at, $at)
       ON CONFLICT(source_key) DO NOTHING`,
    ).run({
      $key: sourceKey,
      $booking: input.bookingId,
      $business: key.businessId,
      $account: key.accountId,
      $provider: key.provider,
      $mode: input.receipt.mode,
      $receipt: input.receipt.operationKey,
      $at: timestamp,
    });
  } catch (error) {
    if (isConcurrencyConflict(error)) {
      throw new IdentityError(
        "CONFLICT",
        `Concurrent link conflict for this source key: another writer bound it first; refusing binding for ${input.bookingId}`,
      );
    }
    throw error;
  }
  const winner = getIdentityLink(store, sourceKey);
  if (!winner) {
    throw new IdentityError("CONFLICT", "Concurrent link conflict for this source key: another writer bound it first");
  }
  if (winner.bookingId !== input.bookingId) {
    throw new IdentityError(
      "CONFLICT",
      `Concurrent link conflict: source key was bound to ${winner.bookingId} by another writer; refusing ${input.bookingId}`,
    );
  }
  appendIdentityAudit(store, {
    sourceKey,
    action: "verified_link",
    bookingId: input.bookingId,
    actor: input.actor ?? "host-verified-receipt",
    reason: `Bound via ${input.receipt.mode} provider-correlated receipt ${input.receipt.operationKey}`,
  });
  return winner;
}

/**
 * Bind (or correct) a source key from an explicit, trusted OWNER resolution.
 * The caller presents the open decision's exact candidate version +
 * fingerprint; stale, cross-business, or cross-account resolutions are
 * rejected. Unlike the verified path, this path MAY correct an existing
 * active binding — the change is preserved in audit history, never by
 * deleting the old record.
 *
 * `decidedBy` must be server-derived (e.g. GATHER_OWNER_ID); request-supplied
 * identities and message-claimed authorizers are not accepted here.
 */
export function recordOwnerIdentityDecision(
  store: GatherStore,
  input: {
    sourceKey: string;
    chosenBookingId: string;
    decidedBy: string;
    candidateVersion: number;
    candidateFingerprint: string;
  },
): IdentityLinkRow {
  ensureBookingIdentityTables(store);
  let key: IdentityComponents;
  try {
    key = decodeSourceKey(input.sourceKey);
  } catch {
    throw new IdentityError("INVALID_REQUEST", "Owner decision requires a well-formed source key");
  }
  if (!input.decidedBy?.trim()) {
    throw new IdentityError("INVALID_REQUEST", "Owner decision requires a server-derived owner identity (decidedBy)");
  }
  const open = getOpenIdentityDecision(store, input.sourceKey);
  if (
    !open ||
    open.candidateVersion !== input.candidateVersion ||
    open.candidateFingerprint !== input.candidateFingerprint
  ) {
    throw new IdentityError(
      "STALE_DECISION",
      "Owner decision is stale: the candidate set changed since this resolution was reviewed; re-propose and review the current candidates",
    );
  }
  const business = bookingBusinessId(store, input.chosenBookingId);
  requireScope(store, key, input.chosenBookingId, business);
  const allowed: string[] = JSON.parse(open.candidateIdsJson) as string[];
  if (allowed.length > 0 && !allowed.includes(input.chosenBookingId)) {
    throw new IdentityError(
      "INVALID_REQUEST",
      `Chosen booking ${input.chosenBookingId} is not among the resolved v${open.candidateVersion} candidates`,
    );
  }
  const timestamp = new Date().toISOString();
  store.db.exec("BEGIN IMMEDIATE");
  try {
    const existing = getIdentityLink(store, input.sourceKey);
    if (existing && existing.status === "active" && existing.bookingId === input.chosenBookingId) {
      markDecisionResolved(store, open.id, input.chosenBookingId, input.decidedBy);
      store.db.exec("COMMIT");
      appendIdentityAudit(store, {
        sourceKey: input.sourceKey,
        action: "decision_resolved",
        bookingId: input.chosenBookingId,
        actor: input.decidedBy,
        reason: `Owner confirmed existing v${open.candidateVersion}/${open.candidateFingerprint.slice(0, 12)} binding`,
      });
      const current = getIdentityLink(store, input.sourceKey);
      if (!current) throw new IdentityError("NOT_FOUND", "Identity link vanished during owner confirmation");
      return current;
    }
    if (existing) {
      store.db.prepare(
        `UPDATE booking_identity_links SET booking_id = $booking, business_id = $business, account_id = $account,
          provider = $provider, origin = 'owner_resolution', status = 'active', updated_at = $at WHERE source_key = $key`,
      ).run({
        $booking: input.chosenBookingId,
        $business: key.businessId,
        $account: key.accountId,
        $provider: key.provider,
        $at: timestamp,
        $key: input.sourceKey,
      });
      appendIdentityAudit(store, {
        sourceKey: input.sourceKey,
        action: existing.status === "active" ? "correction" : "owner_link",
        bookingId: input.chosenBookingId,
        actor: input.decidedBy,
        reason:
          existing.status === "active"
            ? `Owner corrected binding ${existing.bookingId} -> ${input.chosenBookingId} at v${open.candidateVersion}/${open.candidateFingerprint.slice(0, 12)} (prior record preserved in audit)`
            : `Owner bound after unlink at v${open.candidateVersion}/${open.candidateFingerprint.slice(0, 12)} (prior record preserved in audit)`,
      });
    } else {
      store.db.prepare(
        `INSERT INTO booking_identity_links
          (source_key, booking_id, business_id, account_id, provider, origin, provenance_mode, receipt_operation_key, status, created_at, updated_at)
         VALUES ($key, $booking, $business, $account, $provider, 'owner_resolution', 'demo', NULL, 'active', $at, $at)`,
      ).run({
        $key: input.sourceKey,
        $booking: input.chosenBookingId,
        $business: key.businessId,
        $account: key.accountId,
        $provider: key.provider,
        $at: timestamp,
      });
      appendIdentityAudit(store, {
        sourceKey: input.sourceKey,
        action: "owner_link",
        bookingId: input.chosenBookingId,
        actor: input.decidedBy,
        reason: `Owner bound at v${open.candidateVersion}/${open.candidateFingerprint.slice(0, 12)}`,
      });
    }
    markDecisionResolved(store, open.id, input.chosenBookingId, input.decidedBy);
    store.db.exec("COMMIT");
  } catch (error) {
    try {
      store.db.exec("ROLLBACK");
    } catch {
      // Already rolled back; surface the original failure.
    }
    throw error;
  }
  const current = getIdentityLink(store, input.sourceKey);
  if (!current) throw new IdentityError("NOT_FOUND", "Identity link vanished during owner resolution");
  return current;
}

/**
 * Remove (or correct) an active binding without destroying history: the row
 * flips to `unlinked` (or moves to the replacement booking) and every
 * transition stays in the audit log. A replacement must stay in scope.
 */
export function unlinkIdentityLink(
  store: GatherStore,
  input: { sourceKey: string; actor: string; reason: string; replacementBookingId?: string },
): IdentityLinkRow {
  ensureBookingIdentityTables(store);
  let key: IdentityComponents;
  try {
    key = decodeSourceKey(input.sourceKey);
  } catch {
    throw new IdentityError("INVALID_REQUEST", "Unlink requires a well-formed source key");
  }
  if (!input.actor?.trim()) throw new IdentityError("INVALID_REQUEST", "Unlink requires an actor");
  if (!input.reason?.trim()) throw new IdentityError("INVALID_REQUEST", "Unlink requires a reason");
  const active = getActiveIdentityLink(store, input.sourceKey);
  if (!active) throw new IdentityError("NOT_FOUND", "No active identity link for this source key");
  const timestamp = new Date().toISOString();
  if (input.replacementBookingId !== undefined) {
    const business = bookingBusinessId(store, input.replacementBookingId);
    requireScope(store, key, input.replacementBookingId, business);
    store.db.prepare(
      `UPDATE booking_identity_links SET booking_id = $booking, origin = 'owner_resolution', updated_at = $at WHERE source_key = $key`,
    ).run({ $booking: input.replacementBookingId, $at: timestamp, $key: input.sourceKey });
    appendIdentityAudit(store, {
      sourceKey: input.sourceKey,
      action: "correction",
      bookingId: input.replacementBookingId,
      actor: input.actor,
      reason: `${input.reason} (corrected ${active.bookingId} -> ${input.replacementBookingId}; prior binding preserved in audit)`,
    });
  } else {
    store.db.prepare("UPDATE booking_identity_links SET status = 'unlinked', updated_at = $at WHERE source_key = $key").run({
      $at: timestamp,
      $key: input.sourceKey,
    });
    appendIdentityAudit(store, {
      sourceKey: input.sourceKey,
      action: "unlink",
      bookingId: active.bookingId,
      actor: input.actor,
      reason: input.reason,
    });
  }
  const current = getIdentityLink(store, input.sourceKey);
  if (!current) throw new IdentityError("NOT_FOUND", "Identity link vanished during unlink");
  return current;
}
