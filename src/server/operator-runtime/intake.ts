import type { InquiryMessage, InquiryThread } from "../../connectors/contracts.ts";
import { proposeBookingIdentity } from "../../identity/service.ts";
import type { IdentityHints } from "../../identity/service.ts";
import type { CoordinationLedger } from "../../coordination/ledger.ts";
import type { GatherStore } from "../sqlite-store.ts";
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

/**
 * One intake sweep: poll → atomically persist the raw batch → drain in
 * observed order → commit the cursor only after the drain completes →
 * re-drive previously parked items. Replies are detected by actual
 * chronology and direction (never thread length): a message is a reply
 * only when an earlier, non-own message precedes it; own outbound mail is
 * recorded as skipped, never ingested as a customer reply. Ambiguous
 * identity parks items as needs_decision without auto-linking, and parked
 * items drain later once the owner resolves them — the mailbox never
 * stalls on them.
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
  // Re-drive older parked items (previous batches, post-restart, or newly
  // owner-resolved) — but never items this sweep just handled.
  const handled = new Set(intake.listItems(batch.id).map((item) => item.id));
  const resumed = await resumeParkedItems(deps, intake, handled);
  base.drained += resumed.drained;
  base.duplicates += resumed.duplicates;
  base.needsDecision.push(...resumed.needsDecision);
  if (drained.failed + resumed.failed === 0) {
    intake.markBatch(batch.id, "drained");
    if (poll.data.nextCursor !== undefined) {
      intake.commitCursor(deps.accountId, poll.data.nextCursor, undefined);
      base.cursorCommitted = true;
    }
  } else {
    intake.markBatch(batch.id, "failed");
    base.error = `${drained.failed + resumed.failed} item(s) failed to drain; cursor not committed`;
  }
  return base;
}

async function drainBatch(
  deps: IntakeDeps,
  intake: OperatorIntakeStore,
  batchId: string,
): Promise<{ drained: number; duplicates: number; needsDecision: string[]; failed: number }> {
  // Provider order is chronological; the stable sort keeps it. Replies stay
  // after the inquiries they answer so the ledger observes inquiry-then-
  // reply and suppresses answered followups.
  const items = intake.listItems(batchId);
  let drained = 0;
  let duplicates = 0;
  let failed = 0;
  const needsDecision: string[] = [];
  for (const item of items) {
    try {
      const outcome = await drainItem(deps, intake, item);
      if (outcome === "duplicate") {
        duplicates += 1;
      } else if (outcome === "needs_decision") {
        drained += 1;
        needsDecision.push(item.messageId);
      } else {
        drained += 1;
      }
    } catch (error) {
      failed += 1;
      intake.updateItem(item.id, { status: "failed", error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { drained, duplicates, needsDecision, failed };
}

/**
 * Re-drive previously parked items (needs_decision after owner resolution,
 * failed after restart) even when the latest poll returned nothing new.
 * Bounded per sweep; still-parked items simply wait for the next pass.
 */
async function resumeParkedItems(
  deps: IntakeDeps,
  intake: OperatorIntakeStore,
  excludeItemIds: Set<string> = new Set(),
): Promise<{ drained: number; duplicates: number; needsDecision: string[]; failed: number }> {
  const parked = intake.listParked(deps.accountId, 50).filter((item) => !excludeItemIds.has(item.id));
  let drained = 0;
  let duplicates = 0;
  let failed = 0;
  const needsDecision: string[] = [];
  for (const item of parked) {
    try {
      const outcome = await drainItem(deps, intake, item);
      if (outcome === "duplicate") {
        duplicates += 1;
      } else if (outcome === "needs_decision") {
        needsDecision.push(item.messageId);
      } else {
        drained += 1;
      }
    } catch (error) {
      failed += 1;
      intake.updateItem(item.id, { status: "failed", error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { drained, duplicates, needsDecision, failed };
}

interface ThreadView {
  thread: InquiryThread;
  mine?: InquiryMessage;
  mineIndex: number;
}

async function loadThread(deps: IntakeDeps, item: IntakeItemRecord): Promise<ThreadView | undefined> {
  if (item.threadId === undefined || deps.threads === undefined) return undefined;
  const thread = await deps.threads.readThread(item.threadId);
  if (thread === undefined) return undefined;
  const mineIndex = thread.messages.findIndex((message) => message.id === item.messageId);
  if (mineIndex < 0) return { thread, mine: undefined, mineIndex: -1 };
  return { thread, mine: thread.messages[mineIndex], mineIndex };
}

async function drainItem(deps: IntakeDeps, intake: OperatorIntakeStore, item: IntakeItemRecord): Promise<"drained" | "duplicate" | "needs_decision"> {
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

  // Account scope resolves from the store's connected_accounts table first,
  // then the injected connections directory (independently owned lane).
  // Unknown accounts stay denied; they never silently bind.
  const directory = deps.connections;
  const proposed = proposeBookingIdentity(store, {
    components: {
      provider: "gmail",
      accountId: deps.accountId,
      businessId: deps.businessId,
      sourceKind: "email",
      externalId: item.messageId,
      threadId: item.threadId ?? "",
    },
    hints,
    ...(directory === undefined ? {} : {
      accounts: {
        getAccount: (accountId: string) => {
          const entry = directory.getConnection(accountId);
          return entry === undefined ? undefined : { businessId: entry.businessId, provider: entry.provider };
        },
      },
    }),
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
      intake.updateItem(item.id, {
        status: "failed",
        bookingId: proposed.bookingId,
        sourceKey: proposed.sourceKey,
        error: `dedupe conflict: ${error.message}`,
      });
      return "drained";
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
