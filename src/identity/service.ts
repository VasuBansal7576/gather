import type { GatherStore } from "../server/sqlite-store.ts";
import {
  appendIdentityAudit,
  ensureBookingIdentityTables,
  fingerprintCandidates,
  getActiveIdentityLink,
  getIdentityLink,
  getOpenIdentityDecision,
  openOrReuseIdentityDecision,
  resolveDecisionIfOpen,
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

/**
 * Trusted host-side account registry. When the store holds no
 * connected_accounts row for a source key's account id, this port is the
 * ONLY alternative source of truth: an account unknown to both is denied,
 * never silently bound.
 */
export interface IdentityAccountRegistry {
  getAccount(accountId: string): { businessId: string; provider: string } | undefined;
}

/**
 * The owner actor for identity decisions. `kind: "owner"` marks a
 * host-server-derived identity (e.g. the configured GATHER_OWNER_ID
 * principal); a bare string lifted from message text cannot satisfy this —
 * raw message owner ids grant no authority.
 */
export interface IdentityOwnerActor {
  kind: "owner";
  id: string;
}

export type ProposeIdentityResult =
  | {
      outcome: "linked";
      sourceKey: string;
      bookingId: string;
      origin: IdentityLinkRow["origin"];
      provenanceMode: ProvenanceMode;
      /** Current binding revision — pass to unlink/correction as the reviewed target. */
      linkRevision: number;
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
  mode: Exclude<ProvenanceMode, "owner">;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(name: string, value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new IdentityError("INVALID_REQUEST", `${name} requires a non-empty string`);
  }
  return value;
}

function requireOwnerActor(value: unknown): IdentityOwnerActor {
  if (!isRecord(value) || value.kind !== "owner" || typeof value.id !== "string" || value.id.trim().length === 0) {
    throw new IdentityError(
      "INVALID_REQUEST",
      "Owner decisions require a host-server owner actor ({ kind: 'owner', id }); message-claimed identities grant no authority",
    );
  }
  return { kind: "owner", id: value.id.trim() };
}

function bookingBusinessId(store: GatherStore, bookingId: string): string {
  try {
    return store.getBooking(bookingId).businessId;
  } catch {
    throw new IdentityError("NOT_FOUND", `Booking not found: ${bookingId}`);
  }
}

/**
 * Resolve the account id to its scope: the store's connected_accounts table
 * is primary; a trusted host registry port is the only fallback. Unknown or
 * unreadable accounts return undefined — callers MUST deny, not assume.
 */
function connectedAccountBusiness(
  store: GatherStore,
  accountId: string,
  registry?: IdentityAccountRegistry,
): { businessId: string; provider: string } | undefined {
  try {
    const account = store.getConnectedAccount(accountId);
    return { businessId: account.businessId, provider: account.provider };
  } catch {
    return registry?.getAccount(accountId);
  }
}

/**
 * Enforce business/account scope shared by every binding path. A source key
 * from one business or account can never bind a booking from another, and an
 * account neither the store nor the trusted registry can read is denied —
 * unknown identity is never assumed safe.
 */
function requireScope(
  store: GatherStore,
  key: IdentityComponents,
  bookingId: string,
  bookingBusiness: string,
  registry?: IdentityAccountRegistry,
): void {
  if (bookingBusiness !== key.businessId) {
    throw new IdentityError(
      "CROSS_BUSINESS",
      `Cross-business link denied: source key belongs to business ${key.businessId} but booking ${bookingId} belongs to ${bookingBusiness}`,
    );
  }
  const account = connectedAccountBusiness(store, key.accountId, registry);
  if (!account) {
    throw new IdentityError(
      "CROSS_ACCOUNT",
      `Unknown or unreadable account ${key.accountId}: bindings require a connected account or an explicit trusted host account registry entry`,
    );
  }
  if (account.businessId !== key.businessId) {
    throw new IdentityError(
      "CROSS_ACCOUNT",
      `Cross-account link denied: account ${key.accountId} belongs to business ${account.businessId}, not ${key.businessId}`,
    );
  }
  if (account.provider !== "other" && account.provider !== key.provider) {
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
 * - A durable ACTIVE link for the exact source key resolves immediately —
 *   after the same scope check as every binding path, so a link whose
 *   account became unknown or foreign cannot resolve.
 * - Anything else returns `needs_decision` with deterministic candidates and
 *   an open owner decision (versioned + fingerprinted). Weak hints and
 *   untrusted message claims NEVER auto-merge: even a single weak candidate
 *   requires explicit owner resolution.
 */
export function proposeBookingIdentity(
  store: GatherStore,
  input: { components: IdentityComponents; hints?: IdentityHints; accounts?: IdentityAccountRegistry },
): ProposeIdentityResult {
  ensureBookingIdentityTables(store);
  const sourceKey = buildSourceKey(input.components);
  const key = decodeSourceKey(sourceKey);
  const active = getActiveIdentityLink(store, sourceKey);
  if (active) {
    const business = bookingBusinessId(store, active.bookingId);
    requireScope(store, key, active.bookingId, business, input.accounts);
    return {
      outcome: "linked",
      sourceKey,
      bookingId: active.bookingId,
      origin: active.origin,
      provenanceMode: active.provenanceMode,
      linkRevision: active.linkRevision,
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
 *
 * The link row and its audit row commit in ONE transaction under BEGIN
 * IMMEDIATE: the current link state is re-read under the write lock, and a
 * failed audit insert rolls the link back instead of leaving an
 * un-audited binding behind.
 */
export function recordVerifiedIdentityLink(
  store: GatherStore,
  input: {
    components: IdentityComponents;
    bookingId: string;
    receipt: VerifiedReceipt;
    actor?: string;
    accounts?: IdentityAccountRegistry;
  },
): IdentityLinkRow {
  ensureBookingIdentityTables(store);
  const key = decodeSourceKey(buildSourceKey(input.components));
  const sourceKey = buildSourceKey(key);
  const bookingId = requireNonEmptyString("bookingId", input.bookingId);
  if (!isRecord(input.receipt)) {
    throw new IdentityError("INVALID_REQUEST", "Verified receipt requires an explicit receipt object");
  }
  const operationKey = requireNonEmptyString("receipt.operationKey", input.receipt.operationKey);
  if (input.receipt.mode !== "demo" && input.receipt.mode !== "live") {
    throw new IdentityError("INVALID_REQUEST", "Verified receipt requires an explicit provenance mode ('demo' or 'live')");
  }
  const business = bookingBusinessId(store, bookingId);
  requireScope(store, key, bookingId, business, input.accounts);
  const timestamp = new Date().toISOString();
  store.db.exec("BEGIN IMMEDIATE");
  try {
    // Re-read under the write lock: another writer may have bound the key
    // between the earlier validation and now.
    const existing = getIdentityLink(store, sourceKey);
    if (existing && existing.status === "active") {
      // Idempotent ONLY for a byte-identical receipt: same booking, same
      // provider operation key, same provenance mode. A different receipt
      // replaying the same booking is a mismatched identity, not a duplicate.
      if (
        existing.bookingId === bookingId &&
        existing.receiptOperationKey === operationKey &&
        existing.provenanceMode === input.receipt.mode
      ) {
        store.db.exec("COMMIT");
        return existing;
      }
      throw new IdentityError(
        "CONFLICT",
        existing.bookingId === bookingId
          ? `Mismatched receipt identity: source key already bound to booking ${bookingId} via operation ${existing.receiptOperationKey ?? "none"} (${existing.provenanceMode}); refusing replay of ${operationKey} (${input.receipt.mode})`
          : `Source key is already bound to booking ${existing.bookingId} (status ${existing.status}); conflicting verified binding for ${bookingId} refused — resolve via owner decision`,
      );
    }
    if (existing) {
      throw new IdentityError(
        "CONFLICT",
        `Source key is already bound to booking ${existing.bookingId} (status ${existing.status}); conflicting verified binding for ${bookingId} refused — resolve via owner decision`,
      );
    }
    try {
      store.db.prepare(
        `INSERT INTO booking_identity_links
          (source_key, booking_id, business_id, account_id, provider, origin, provenance_mode, receipt_operation_key, status, link_revision, created_at, updated_at)
         VALUES ($key, $booking, $business, $account, $provider, 'verified_receipt', $mode, $receipt, 'active', 1, $at, $at)`,
      ).run({
        $key: sourceKey,
        $booking: bookingId,
        $business: key.businessId,
        $account: key.accountId,
        $provider: key.provider,
        $mode: input.receipt.mode,
        $receipt: operationKey,
        $at: timestamp,
      });
    } catch (error) {
      if (isConcurrencyConflict(error)) {
        throw new IdentityError(
          "CONFLICT",
          `Concurrent link conflict for this source key: another writer bound it first; refusing binding for ${bookingId}`,
        );
      }
      throw error;
    }
    appendIdentityAudit(store, {
      sourceKey,
      action: "verified_link",
      bookingId,
      actor: input.actor ?? "host-verified-receipt",
      reason: `Bound via ${input.receipt.mode} provider-correlated receipt ${operationKey}`,
      linkRevision: 1,
    });
    store.db.exec("COMMIT");
  } catch (error) {
    try {
      store.db.exec("ROLLBACK");
    } catch {
      // Already rolled back; surface the original failure.
    }
    throw error;
  }
  const winner = getIdentityLink(store, sourceKey);
  if (!winner || winner.bookingId !== bookingId) {
    throw new IdentityError(
      "CONFLICT",
      `Concurrent link conflict: source key was bound by another writer; refusing ${bookingId}`,
    );
  }
  return winner;
}

/**
 * Bind (or correct) a source key from an explicit, trusted OWNER resolution.
 * The caller presents the open decision's exact candidate version +
 * fingerprint; stale, cross-business, or cross-account resolutions are
 * rejected — all validated atomically inside BEGIN IMMEDIATE so a decision
 * superseded between review and write cannot slip through. Unlike the
 * verified path, this path MAY correct an existing active binding; the
 * change is preserved in audit history, never by deleting the old record.
 * A correction to a different booking clears the obsolete provider receipt:
 * a receipt that proved booking A must not appear to prove booking B, and
 * the owner's assertion is recorded with 'owner' provenance — authoritative
 * but not provider-verified.
 *
 * `actor` must be a host-server owner actor ({ kind: 'owner', id }) such as
 * the configured owner principal; request- or message-supplied identities
 * are not accepted here.
 */
export function recordOwnerIdentityDecision(
  store: GatherStore,
  input: {
    sourceKey: string;
    chosenBookingId: string;
    actor: IdentityOwnerActor;
    candidateVersion: number;
    candidateFingerprint: string;
    accounts?: IdentityAccountRegistry;
  },
): IdentityLinkRow {
  ensureBookingIdentityTables(store);
  let key: IdentityComponents;
  try {
    key = decodeSourceKey(requireNonEmptyString("sourceKey", input.sourceKey));
  } catch {
    throw new IdentityError("INVALID_REQUEST", "Owner decision requires a well-formed source key");
  }
  const actor = requireOwnerActor(input.actor);
  const chosenBookingId = requireNonEmptyString("chosenBookingId", input.chosenBookingId);
  if (typeof input.candidateVersion !== "number" || !Number.isInteger(input.candidateVersion) || input.candidateVersion < 1) {
    throw new IdentityError("INVALID_REQUEST", "Owner decision requires the reviewed candidateVersion (positive integer)");
  }
  requireNonEmptyString("candidateFingerprint", input.candidateFingerprint);
  const timestamp = new Date().toISOString();
  store.db.exec("BEGIN IMMEDIATE");
  try {
    // Re-read the open decision under the write lock: the version and
    // fingerprint the owner reviewed must still be current.
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
    const business = bookingBusinessId(store, chosenBookingId);
    requireScope(store, key, chosenBookingId, business, input.accounts);
    const allowed: string[] = JSON.parse(open.candidateIdsJson) as string[];
    if (allowed.length > 0 && !allowed.includes(chosenBookingId)) {
      throw new IdentityError(
        "INVALID_REQUEST",
        `Chosen booking ${chosenBookingId} is not among the resolved v${open.candidateVersion} candidates`,
      );
    }
    const existing = getIdentityLink(store, input.sourceKey);
    if (existing && existing.status === "active" && existing.bookingId === chosenBookingId) {
      if (!resolveDecisionIfOpen(store, open.id, chosenBookingId, actor.id)) {
        throw new IdentityError("STALE_DECISION", "Owner decision was already resolved by a concurrent writer");
      }
      appendIdentityAudit(store, {
        sourceKey: input.sourceKey,
        action: "decision_resolved",
        bookingId: chosenBookingId,
        actor: actor.id,
        reason: `Owner confirmed existing v${open.candidateVersion}/${open.candidateFingerprint.slice(0, 12)} binding`,
      });
      store.db.exec("COMMIT");
      const current = getIdentityLink(store, input.sourceKey);
      if (!current) throw new IdentityError("NOT_FOUND", "Identity link vanished during owner confirmation");
      return current;
    }
    if (existing) {
      const correctsBooking = existing.bookingId !== chosenBookingId;
      const nextRevision = existing.linkRevision + 1;
      store.db.prepare(
        `UPDATE booking_identity_links SET booking_id = $booking, business_id = $business, account_id = $account,
          provider = $provider, origin = 'owner_resolution', status = 'active',
          provenance_mode = $mode, receipt_operation_key = $receipt, link_revision = $rev, updated_at = $at WHERE source_key = $key`,
      ).run({
        $booking: chosenBookingId,
        $business: key.businessId,
        $account: key.accountId,
        $provider: key.provider,
        // A different booking voids the prior provider receipt's proof: the
        // receipt stays attributable to the old record in audit, never to B.
        $mode: correctsBooking ? "owner" : existing.provenanceMode,
        $receipt: correctsBooking ? null : existing.receiptOperationKey ?? null,
        $rev: nextRevision,
        $at: timestamp,
        $key: input.sourceKey,
      });
      appendIdentityAudit(store, {
        sourceKey: input.sourceKey,
        action: existing.status === "active" ? "correction" : "owner_link",
        bookingId: chosenBookingId,
        actor: actor.id,
        reason:
          existing.status === "active"
            ? `Owner corrected binding ${existing.bookingId} -> ${chosenBookingId} at v${open.candidateVersion}/${open.candidateFingerprint.slice(0, 12)} (prior record preserved in audit${correctsBooking ? "; provider receipt cleared as obsolete" : ""})`
            : `Owner bound after unlink at v${open.candidateVersion}/${open.candidateFingerprint.slice(0, 12)} (prior record preserved in audit)`,
        linkRevision: nextRevision,
      });
    } else {
      store.db.prepare(
        `INSERT INTO booking_identity_links
          (source_key, booking_id, business_id, account_id, provider, origin, provenance_mode, receipt_operation_key, status, link_revision, created_at, updated_at)
         VALUES ($key, $booking, $business, $account, $provider, 'owner_resolution', 'owner', NULL, 'active', 1, $at, $at)`,
      ).run({
        $key: input.sourceKey,
        $booking: chosenBookingId,
        $business: key.businessId,
        $account: key.accountId,
        $provider: key.provider,
        $at: timestamp,
      });
      appendIdentityAudit(store, {
        sourceKey: input.sourceKey,
        action: "owner_link",
        bookingId: chosenBookingId,
        actor: actor.id,
        reason: `Owner bound at v${open.candidateVersion}/${open.candidateFingerprint.slice(0, 12)}`,
        linkRevision: 1,
      });
    }
    if (!resolveDecisionIfOpen(store, open.id, chosenBookingId, actor.id)) {
      throw new IdentityError("STALE_DECISION", "Owner decision was already resolved by a concurrent writer");
    }
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
 * transition stays in the audit log.
 *
 * `expectedLinkRevision` is the reviewed-binding guard: it is REQUIRED and
 * must equal the link's current monotonic `linkRevision`. Revising to a
 * different booking bumps the revision, so a caller that reviewed A, then
 * saw the binding move A -> B -> A, cannot apply a stale correction — the
 * booking alone is not the binding's identity.
 * `expectedBookingId` must equal the currently bound booking whenever a
 * `replacementBookingId` is given. A correction to a different booking
 * clears the obsolete provider receipt and records 'owner' provenance; the
 * receipt that proved booking A never appears to prove booking B.
 */
export function unlinkIdentityLink(
  store: GatherStore,
  input: {
    sourceKey: string;
    actor: IdentityOwnerActor;
    reason: string;
    expectedLinkRevision: number;
    expectedBookingId?: string;
    replacementBookingId?: string;
    accounts?: IdentityAccountRegistry;
  },
): IdentityLinkRow {
  ensureBookingIdentityTables(store);
  let key: IdentityComponents;
  try {
    key = decodeSourceKey(requireNonEmptyString("sourceKey", input.sourceKey));
  } catch {
    throw new IdentityError("INVALID_REQUEST", "Unlink requires a well-formed source key");
  }
  const actor = requireOwnerActor(input.actor);
  requireNonEmptyString("reason", input.reason);
  if (
    typeof input.expectedLinkRevision !== "number" ||
    !Number.isInteger(input.expectedLinkRevision) ||
    input.expectedLinkRevision < 1
  ) {
    throw new IdentityError(
      "INVALID_REQUEST",
      "Unlink/correction requires the reviewed expectedLinkRevision (positive integer)",
    );
  }
  if (input.expectedBookingId !== undefined) {
    requireNonEmptyString("expectedBookingId", input.expectedBookingId);
  }
  if (input.replacementBookingId !== undefined) {
    requireNonEmptyString("replacementBookingId", input.replacementBookingId);
    if (input.expectedBookingId === undefined) {
      throw new IdentityError(
        "INVALID_REQUEST",
        "A link correction must name the reviewed target: expectedBookingId is required with replacementBookingId",
      );
    }
  }
  const timestamp = new Date().toISOString();
  store.db.exec("BEGIN IMMEDIATE");
  try {
    const active = getActiveIdentityLink(store, input.sourceKey);
    if (!active) throw new IdentityError("NOT_FOUND", "No active identity link for this source key");
    if (active.linkRevision !== input.expectedLinkRevision) {
      throw new IdentityError(
        "STALE_DECISION",
        `Reviewed link is stale: expected link revision ${input.expectedLinkRevision} but the binding is at revision ${active.linkRevision}; re-read and review the current link`,
      );
    }
    if (input.expectedBookingId !== undefined && input.expectedBookingId !== active.bookingId) {
      throw new IdentityError(
        "STALE_DECISION",
        `Reviewed link is stale: expected target ${input.expectedBookingId} but the active binding is ${active.bookingId}; re-read and review the current link`,
      );
    }
    const nextRevision = active.linkRevision + 1;
    if (input.replacementBookingId !== undefined) {
      const business = bookingBusinessId(store, input.replacementBookingId);
      requireScope(store, key, input.replacementBookingId, business, input.accounts);
      store.db.prepare(
        `UPDATE booking_identity_links SET booking_id = $booking, origin = 'owner_resolution',
          provenance_mode = 'owner', receipt_operation_key = NULL, link_revision = $rev, updated_at = $at WHERE source_key = $key`,
      ).run({ $booking: input.replacementBookingId, $rev: nextRevision, $at: timestamp, $key: input.sourceKey });
      appendIdentityAudit(store, {
        sourceKey: input.sourceKey,
        action: "correction",
        bookingId: input.replacementBookingId,
        actor: actor.id,
        reason: `${input.reason} (corrected ${active.bookingId} -> ${input.replacementBookingId}; provider receipt cleared as obsolete, prior binding preserved in audit)`,
        linkRevision: nextRevision,
      });
    } else {
      store.db.prepare(
        "UPDATE booking_identity_links SET status = 'unlinked', link_revision = $rev, updated_at = $at WHERE source_key = $key",
      ).run({
        $rev: nextRevision,
        $at: timestamp,
        $key: input.sourceKey,
      });
      appendIdentityAudit(store, {
        sourceKey: input.sourceKey,
        action: "unlink",
        bookingId: active.bookingId,
        actor: actor.id,
        reason: input.reason,
        linkRevision: nextRevision,
      });
    }
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
  if (!current) throw new IdentityError("NOT_FOUND", "Identity link vanished during unlink");
  return current;
}
