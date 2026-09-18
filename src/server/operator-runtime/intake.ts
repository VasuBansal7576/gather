import type { InquiryMessage, InquiryThread } from "../../connectors/contracts.ts";
import { proposeBookingIdentity } from "../../identity/service.ts";
import type { IdentityHints } from "../../identity/service.ts";
import { buildSourceKey, decodeSourceKey } from "../../identity/source-key.ts";
import { ensureBookingIdentityTables, getActiveIdentityLink } from "../../identity/store.ts";
import type { CoordinationLedger } from "../../coordination/ledger.ts";
import type { GatherStore } from "../sqlite-store.ts";
import { ServiceError } from "../booking-service.ts";
import {
  evaluateDomainGate,
  type DomainClassifier,
  type DomainGateInput,
} from "../../intake/gate.ts";
import { IntakeDomainStore } from "../../intake/store.ts";
import { OperatorIntakeStore } from "./store.ts";
import type {
  IntakeItemRecord,
  OperatorRuntimeDeps,
  SweepReport,
} from "./types.ts";

/** Thread bodies for identity hints and reply detection. Reuses the reviewed Gmail thread reader by composition. */
export interface ThreadReaderPort {
  readThread(threadId: string): Promise<InquiryThread | undefined>;
  readonly provenance: { simulated: boolean; label: string };
}

export interface IntakeDeps extends OperatorRuntimeDeps {
  threads?: ThreadReaderPort;
  /** Account-owned sender addresses; their messages are never customer replies. */
  ownAddresses?: string[];
  /**
   * ADR-003 event-domain gate for NEW inquiries (unlinked, first-in-thread
   * messages). Replies and already-linked items are correlated traffic and
   * bypass the gate. Absent → every unlinked inquiry parks as needs_review
   * (fail-closed: no classifier is never permission). Prepared mode wires
   * the scripted classifier; a live classifier is an injected adapter whose
   * unknown/unavailable verdicts also park for review.
   */
  domainGate?: DomainClassifier;
  /**
   * Host-owned acceptance validator. It runs before the new-inquiry gate so
   * a signed token reply in a new thread can supply booking correlation;
   * token-looking text without a validated result is ignored.
   */
  acceptance?: (input: { message: InquiryMessage; thread?: InquiryThread }) => Promise<{
    outcome: "accepted" | "review" | "ignored";
    bookingId?: string;
    reason?: string;
  }>;
}

function nowIso(deps: IntakeDeps): string {
  return deps.now ? deps.now() : new Date().toISOString();
}

function addressOf(from: string): string | undefined {
  const match = /<([^<>@\s]+@[^<>@\s]+)>/.exec(from);
  if (match?.[1]) return match[1].toLowerCase();
  const plain = from.trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+$/.test(plain) ? plain : undefined;
}

function isOwnMessage(deps: IntakeDeps, from: string): boolean {
  const sender = addressOf(from);
  if (sender === undefined || deps.ownAddresses === undefined) return false;
  return deps.ownAddresses.some((own) => own.toLowerCase() === sender);
}

function receivedMs(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/** Simulation derives from the injected wiring, never a caller boolean. */
function isSimulated(deps: IntakeDeps, pollMode: string | undefined): boolean {
  return deps.inbox.provenance.simulated || pollMode !== "live";
}

/** Bounded retries before a failed item dead-letters — parked work never wedges intake. */
export const MAX_INTAKE_ATTEMPTS = 5;

/**
 * One intake sweep: poll → atomically persist the raw batch → drain in
 * observed order → commit the cursor → re-drive previously parked items.
 *
 * Watermark model: the cursor is the durable CAPTURE watermark. Every
 * polled change is persisted to `intake_items` atomically before any
 * processing, and each (account, messageId) owns exactly one canonical
 * row forever — replays dedupe to it instead of minting new rows, so a
 * permanently failing source can never wedge the cursor or grow failed
 * rows unboundedly. Processing outcome lives per-item: unsettled rows
 * ('received'/'linked'), 'needs_decision', and 'failed' rows inside the
 * retry budget re-drive on later sweeps; items that exhaust
 * MAX_INTAKE_ATTEMPTS dead-letter (terminal, owner-visible, never
 * auto-retried). Replies are detected by actual chronology and direction
 * (never thread length): a message is a reply only when an earlier,
 * non-own message precedes it; own outbound mail is recorded as skipped,
 * never ingested as a customer reply. Ambiguous identity parks items as
 * needs_decision without auto-linking.
 */
export async function runIntakeSweep(deps: IntakeDeps): Promise<SweepReport> {
  const intake = new OperatorIntakeStore(deps.store.db);
  const checkpoint = intake.getCursor(deps.accountId);
  const poll = await deps.inbox.pollInbox(`gather:intake:${deps.accountId}:${nowIso(deps)}`, {
    ...(checkpoint === undefined ? {} : { cursor: checkpoint.cursor }),
  });
  const simulation = isSimulated(deps, poll.status === "succeeded" ? poll.metadata.mode.mode : undefined);
  const base: SweepReport = {
    simulation,
    accountId: deps.accountId,
    polled: 0,
    persisted: 0,
    drained: 0,
    duplicates: 0,
    needsDecision: [],
    cursorCommitted: false,
    resetRequired: false,
    resumedDrained: 0,
    resumedFailed: 0,
    deadLettered: [],
  };
  if (poll.status !== "succeeded") {
    intake.recordFailure(deps.accountId, "poll", poll.error.message);
    return { ...base, error: poll.error.message };
  }
  if (poll.data.resetRequired) {
    // Durably clear the dead cursor so the next sweep full-syncs
    // cursor-less instead of replaying expiry forever.
    intake.clearCursor(deps.accountId);
    intake.recordFailure(deps.accountId, "poll", "inbox cursor expired; cleared for cursor-less full sync");
    return { ...base, resetRequired: true };
  }
  const changes = poll.data.changes;
  base.polled = changes.length;
  const observedAt = nowIso(deps);
  const batch = intake.persistBatch({
    accountId: deps.accountId,
    providerHistoryId: undefined,
    nextCursor: poll.data.nextCursor,
    items: changes.map((change) => ({ messageId: change.messageId, threadId: change.threadId, observedAt })),
    simulation,
  });
  base.batchId = batch.id;
  base.persisted = batch.itemCount;
  const drained = await drainBatch(deps, intake, batch.id);
  base.drained = drained.drained;
  base.duplicates = drained.duplicates;
  base.needsDecision.push(...drained.needsDecision);
  base.deadLettered.push(...drained.deadLettered);
  // The batch is durably captured: commit the cursor regardless of
  // processing outcome. Failed items are parked with a retry budget, so
  // the watermark never depends on whether a source message is healthy.
  intake.markBatch(batch.id, drained.failed === 0 ? "drained" : "failed");
  if (poll.data.nextCursor !== undefined) {
    intake.commitCursor(deps.accountId, poll.data.nextCursor, undefined);
    base.cursorCommitted = true;
  }
  if (drained.failed > 0) {
    base.error = `${drained.failed} item(s) failed to drain; parked for bounded retry`;
  }
  // Re-drive parked items (crash-stranded, owner-resolved, retried
  // failures) — but never items this sweep just handled.
  const handled = new Set(intake.listItems(batch.id).map((item) => item.id));
  const resumed = await resumeParkedItems(deps, intake, handled);
  base.resumedDrained = resumed.drained;
  base.resumedFailed = resumed.failed;
  base.duplicates += resumed.duplicates;
  base.needsDecision.push(...resumed.needsDecision);
  base.deadLettered.push(...resumed.deadLettered);
  // Crash recovery bookkeeping: settle batches whose items all resolved.
  intake.settleReceivedBatches(deps.accountId);
  return base;
}

async function drainBatch(
  deps: IntakeDeps,
  intake: OperatorIntakeStore,
  batchId: string,
): Promise<{ drained: number; duplicates: number; needsDecision: string[]; failed: number; deadLettered: string[] }> {
  // Provider order is chronological; the stable sort keeps it. Replies stay
  // after the inquiries they answer so the ledger observes inquiry-then-
  // reply and suppresses answered followups.
  const items = intake.listItems(batchId);
  let drained = 0;
  let duplicates = 0;
  let failed = 0;
  const needsDecision: string[] = [];
  const deadLettered: string[] = [];
  for (const item of items) {
    try {
      const outcome = await drainItem(deps, intake, item);
      if (outcome === "duplicate") {
        duplicates += 1;
      } else if (outcome === "needs_decision") {
        drained += 1;
        needsDecision.push(item.messageId);
      } else if (outcome === "dead") {
        deadLettered.push(item.messageId);
      } else {
        drained += 1;
      }
    } catch (error) {
      failed += 1;
      if (markItemFailed(intake, item, error)) deadLettered.push(item.messageId);
    }
  }
  return { drained, duplicates, needsDecision, failed, deadLettered };
}

/**
 * Record a failed drain attempt against the canonical item row: the
 * retry budget ticks up, and an item that exhausts it dead-letters
 * (terminal, surfaced via listDeadLettered/health — never retried and
 * never silently dropped).
 */
function markItemFailed(intake: OperatorIntakeStore, item: IntakeItemRecord, error: unknown): boolean {
  intake.bumpAttempts(item.id);
  const dead = item.attempts + 1 >= MAX_INTAKE_ATTEMPTS;
  intake.updateItem(item.id, {
    status: "failed",
    error: error instanceof Error ? error.message : String(error),
    dead,
  });
  return dead;
}

/**
 * Re-drive previously parked items (crash-stranded 'received'/'linked',
 * 'needs_decision' awaiting owner resolution, retryable 'failed') even
 * when the latest poll returned nothing new. Bounded per sweep; items
 * that exhaust their retry budget dead-letter instead of retrying
 * forever, and dead-lettered items are never touched again.
 */
async function resumeParkedItems(
  deps: IntakeDeps,
  intake: OperatorIntakeStore,
  excludeItemIds: Set<string> = new Set(),
): Promise<{ drained: number; duplicates: number; needsDecision: string[]; failed: number; deadLettered: string[] }> {
  const parked = intake.listParked(deps.accountId, 50).filter((item) => !excludeItemIds.has(item.id));
  let drained = 0;
  let duplicates = 0;
  let failed = 0;
  const needsDecision: string[] = [];
  const deadLettered: string[] = [];
  for (const item of parked) {
    try {
      const outcome = await drainItem(deps, intake, item);
      if (outcome === "duplicate") {
        duplicates += 1;
      } else if (outcome === "needs_decision") {
        needsDecision.push(item.messageId);
      } else if (outcome === "dead") {
        deadLettered.push(item.messageId);
      } else {
        drained += 1;
      }
    } catch (error) {
      failed += 1;
      if (markItemFailed(intake, item, error)) deadLettered.push(item.messageId);
    }
  }
  return { drained, duplicates, needsDecision, failed, deadLettered };
}

interface ThreadView {
  thread: InquiryThread;
  mine?: InquiryMessage;
  mineIndex: number;
}

/**
 * Owner-controlled re-arm of one dead-lettered intake item. Host API only —
 * deliberately NOT an MCP tool, so no model-invokable retry surface exists
 * anywhere in this lane.
 *
 * Identity is validated three ways before anything moves: the canonical
 * (account, message) row must exist under this runtime's account, its
 * batch must belong to the same account, and the business must match —
 * via the decoded source key when linked, via the linked booking when
 * present, or via the connected-account record pinning this account to
 * this business for never-linked rows. Anything else (unknown message,
 * live item, foreign account/business) fails without touching state.
 *
 * The re-arm flips exactly one row from dead to retryable and preserves
 * everything else: attempts, error text, and history are untouched, no
 * rows are created, and no cursor checkpoint is read or written (so no
 * unrelated cursor can rewind). The next sweep re-drives the item through
 * the normal drain — ledger dedupe keys still prevent double ingestion —
 * and a repeated failure dead-letters again immediately against the
 * preserved attempt count. No bulk endpoint exists: one validated message
 * per call, never an arbitrary retry, and no approval, link, or control
 * is granted as a side effect.
 */
export function retryDeadLetteredItem(
  deps: Pick<IntakeDeps, "store" | "accountId" | "businessId">,
  input: { messageId: string },
): IntakeItemRecord {
  const intake = new OperatorIntakeStore(deps.store.db);
  const item = intake.findItemByMessage(deps.accountId, input.messageId);
  if (!item) {
    throw new ServiceError("NOT_FOUND", `No intake item for message ${input.messageId} under account ${deps.accountId}; only captured items can be retried`, false);
  }
  let batchAccount: string;
  try {
    batchAccount = intake.getBatch(item.batchId).accountId;
  } catch {
    throw new ServiceError("NOT_FOUND", `Intake item ${item.id} names an unknown batch; refusing to guess its scope`, false);
  }
  if (batchAccount !== deps.accountId) {
    throw new ServiceError("INVALID_REQUEST", `Intake item ${item.id} belongs to account ${batchAccount}, not ${deps.accountId}`, false);
  }
  if (!item.dead) {
    throw new ServiceError("INVALID_REQUEST", `Intake item ${item.id} is ${item.status}, not dead-lettered; live retry flow is untouched`, false);
  }
  if (item.sourceKey !== undefined) {
    let keyBusiness: string;
    try {
      keyBusiness = decodeSourceKey(item.sourceKey).businessId;
    } catch {
      throw new ServiceError("INVALID_REQUEST", `Intake item ${item.id} carries an undecodable source key; refusing to re-arm`, false);
    }
    if (keyBusiness !== deps.businessId) {
      throw new ServiceError("INVALID_REQUEST", `Intake item ${item.id} is bound to business ${keyBusiness}, not ${deps.businessId}`, false);
    }
  } else if (item.bookingId !== undefined) {
    let bookingBusiness: string;
    try {
      bookingBusiness = deps.store.getBooking(item.bookingId).businessId;
    } catch {
      throw new ServiceError("INVALID_REQUEST", `Intake item ${item.id} names an unknown booking; refusing to re-arm`, false);
    }
    if (bookingBusiness !== deps.businessId) {
      throw new ServiceError("INVALID_REQUEST", `Intake item ${item.id} is bound to business ${bookingBusiness}, not ${deps.businessId}`, false);
    }
  } else {
    let pinned: string | undefined;
    try {
      pinned = deps.store.getConnectedAccount(deps.accountId).businessId;
    } catch {
      pinned = undefined;
    }
    if (pinned !== deps.businessId) {
      throw new ServiceError("INVALID_REQUEST", `Intake item ${item.id} was never linked and account ${deps.accountId} has no connected-account pin to business ${deps.businessId}; refusing to re-arm`, false);
    }
  }
  const rearmed = deps.store.db.prepare("UPDATE intake_items SET dead = 0 WHERE id = $id AND dead = 1").run({ $id: item.id });
  if (rearmed.changes !== 1) {
    throw new ServiceError("INVALID_REQUEST", `Intake item ${item.id} is no longer dead-lettered`, false);
  }
  return { ...item, dead: false };
}

async function loadThread(deps: IntakeDeps, item: IntakeItemRecord): Promise<ThreadView | undefined> {
  if (item.threadId === undefined || deps.threads === undefined) return undefined;
  const thread = await deps.threads.readThread(item.threadId);
  if (thread === undefined) return undefined;
  const mineIndex = thread.messages.findIndex((message) => message.id === item.messageId);
  if (mineIndex < 0) return { thread, mine: undefined, mineIndex: -1 };
  return { thread, mine: thread.messages[mineIndex], mineIndex };
}

async function drainItem(deps: IntakeDeps, intake: OperatorIntakeStore, item: IntakeItemRecord): Promise<"drained" | "duplicate" | "needs_decision" | "dead"> {
  const store: GatherStore = deps.store;
  const ledger: CoordinationLedger = deps.ledger;

  const view = await loadThread(deps, item);
  const mine = view?.mine;
  // Own outbound mail is never a customer reply: record and skip it so our
  // own messages can neither suppress followups nor mint inquiry events.
  if (mine !== undefined && isOwnMessage(deps, mine.from)) {
    intake.updateItem(item.id, { status: "skipped", error: "own outbound message" });
    return "drained";
  }

  let hints: IdentityHints = {};
  let kind: "inquiry" | "reply" = "inquiry";
  let observedAt = item.observedAt;
  const ownMessage = view?.mine;
  if (ownMessage !== undefined && view !== undefined && view.mineIndex >= 0) {
    const mine = ownMessage;
    const first = view.thread.messages[0];
    if (first !== undefined) {
      const sender = addressOf(first.from);
      if (sender !== undefined) hints = { ...hints, senderEmail: sender };
      if (first.subject) hints = { ...hints, eventName: first.subject };
    }
    observedAt = mine.receivedAt || observedAt;
    // Chronology + direction: only a strictly earlier, non-own message
    // makes this one a reply. Later messages, unparseable timestamps, and
    // own mail never count — thread length alone proves nothing.
    const mineMs = receivedMs(mine.receivedAt);
    const earlier = view.thread.messages.filter((message, index) => {
      if (message.id === mine.id || isOwnMessage(deps, message.from)) return false;
      if (mineMs === undefined) return index < view.mineIndex;
      const otherMs = receivedMs(message.receivedAt);
      return otherMs !== undefined && otherMs < mineMs;
    });
    if (earlier.length > 0) kind = "reply";
  }

  // Acceptance is a scoped host validator, not an identity hint. Run it for
  // every inbound message before the new-inquiry classifier; an ignored token
  // candidate falls through normally and never grants booking authority.
  if (view?.mine !== undefined && deps.acceptance !== undefined) {
    const acceptance = await deps.acceptance({ message: view.mine, ...(view.thread === undefined ? {} : { thread: view.thread }) });
    if (acceptance.outcome === "accepted" && acceptance.bookingId !== undefined) {
      intake.updateItem(item.id, { status: "ingested", bookingId: acceptance.bookingId, error: undefined });
      return "drained";
    }
    if (acceptance.outcome === "review") {
      intake.updateItem(item.id, { status: "needs_decision", ...(acceptance.reason === undefined ? {} : { error: acceptance.reason }) });
      return "needs_decision";
    }
  }

  // Account scope resolves from the store's connected_accounts table first,
  // then the injected connections directory (independently owned lane).
  // Unknown accounts stay denied; they never silently bind.
  const directory = deps.connections;
  const accounts = directory === undefined ? undefined : {
    getAccount: (accountId: string) => {
      const entry = directory.getConnection(accountId);
      return entry === undefined ? undefined : { businessId: entry.businessId, provider: entry.provider };
    },
  };
  const components = {
    provider: "gmail" as const,
    accountId: deps.accountId,
    businessId: deps.businessId,
    sourceKind: "email" as const,
    externalId: item.messageId,
    threadId: item.threadId ?? "",
  };

  // ADR-003 domain gate, applied only to NEW inquiries: messages already
  // bound to a booking (active link) or sitting in reply position are
  // correlated traffic and bypass it. Unlinked inquiries are classified
  // before identity proposal so unrelated mail never reaches the booking
  // lane — no ledger event, no booking write, no identity noise. A
  // needs_review item still opens its identity decision so the owner's
  // resolution path stays live while it waits.
  if (kind === "inquiry") {
    ensureBookingIdentityTables(store);
    const linked = getActiveIdentityLink(store, buildSourceKey(components));
    if (!linked) {
      const gateInput: DomainGateInput | undefined = view?.mine === undefined ? undefined : {
        messageId: item.messageId,
        subject: view.mine.subject,
        body: view.mine.body,
        from: view.mine.from,
        sourceTag: deps.inbox.provenance.label,
      };
      const gate = await evaluateDomainGate(deps.domainGate, gateInput);
      const simulated = deps.inbox.provenance.simulated || (deps.threads?.provenance.simulated ?? true);
      new IntakeDomainStore(store.db).record({
        accountId: deps.accountId,
        messageId: item.messageId,
        sourceTag: deps.inbox.provenance.label,
        decision: gate.decision,
        classifier: gate.classifierId,
        simulated,
      });
      const reason = gate.decision.reasons[0] ?? "domain gate decision";
      if (gate.decision.outcome === "unrelated") {
        intake.updateItem(item.id, { status: "skipped", error: `not an event inquiry: ${reason}` });
        return "drained";
      }
      if (gate.decision.outcome === "needs_review") {
        const proposed = proposeBookingIdentity(store, {
          components,
          hints,
          ...(accounts === undefined ? {} : { accounts }),
        });
        if (proposed.outcome !== "linked") {
          intake.updateItem(item.id, {
            status: "needs_decision",
            bookingId: undefined,
            sourceKey: proposed.sourceKey,
            error: `domain review: ${reason}`,
          });
          return "needs_decision";
        }
        // A verified/owner link landed between the check and propose:
        // correlated traffic bypasses the gate and ingests normally below.
      }
      // eligible: fall through to the normal identity/ledger flow. Missing
      // qualification fields ride the durable domain decision row.
    }
  }

  const proposed = proposeBookingIdentity(store, {
    components,
    hints,
    ...(accounts === undefined ? {} : { accounts }),
  });
  intake.updateItem(item.id, { status: "linked", bookingId: proposed.outcome === "linked" ? proposed.bookingId : undefined, sourceKey: proposed.sourceKey });
  if (proposed.outcome !== "linked") {
    // Ambiguous identity requires an owner decision: the open decision from
    // propose stays pending, nothing auto-links, nothing ingests.
    intake.updateItem(item.id, { status: "needs_decision", bookingId: undefined, sourceKey: proposed.sourceKey });
    return "needs_decision";
  }
  // Stable account+message identity (no mutable inferred kind): the same
  // provider message can never ingest twice even if reclassified later.
  // A content conflict on reuse throws in the ledger and is recorded as a
  // visible failure, never silently merged.
  const dedupeKey = `gather:intake:${deps.accountId}:${item.messageId}`;
  let ingested;
  try {
    ingested = ledger.ingestEvent({
      dedupeKey,
      kind,
      bookingId: proposed.bookingId,
      sourceId: item.messageId,
      sourceKind: "email",
      observedAt,
      payload: {
        threadId: item.threadId ?? null,
        sourceKey: proposed.sourceKey,
        ...(kind === "reply" ? { inReplyToThread: true } : {}),
      },
    });
  } catch (error) {
    if (error instanceof Error && /dedupe key reuse with different content/.test(error.message)) {
      // Content conflicts are permanent: dead-letter immediately instead
      // of burning the retry budget on a doomed ingest.
      intake.updateItem(item.id, {
        status: "failed",
        bookingId: proposed.bookingId,
        sourceKey: proposed.sourceKey,
        error: `dedupe conflict: ${error.message}`,
        dead: true,
      });
      return "dead";
    }
    throw error;
  }
  intake.updateItem(item.id, {
    status: "ingested",
    bookingId: proposed.bookingId,
    sourceKey: proposed.sourceKey,
    ledgerEventId: ingested.eventId,
  });
  return ingested.duplicate ? "duplicate" : "drained";
}
