import type { InquiryThread } from "../../connectors/contracts.ts";
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
}

export interface IntakeDeps extends OperatorRuntimeDeps {
  threads?: ThreadReaderPort;
}

function nowIso(deps: IntakeDeps): string {
  return deps.now ? deps.now() : new Date().toISOString();
}

function addressOf(from: string): string | undefined {
  const match = /<([^<>@\s]+@[^<>@\s]+)>/.exec(from);
  if (match?.[1]) return match[1];
  const plain = from.trim();
  return /^[^@\s]+@[^@\s]+$/.test(plain) ? plain : undefined;
}

/**
 * One intake sweep: poll → atomically persist the raw batch → drain in
 * observed order → commit the cursor only after the drain completes.
 * Replies are drained before followups can act because items keep provider
 * order (stable sort by observed time) and the ledger suppresses
 * reply-answered followups at claim time; ambiguous identity parks items
 * as needs_decision without auto-linking. At-least-once throughout:
 * ledger dedupeKeys and identity source keys make replays safe.
 */
export async function runIntakeSweep(deps: IntakeDeps): Promise<SweepReport> {
  const intake = new OperatorIntakeStore(deps.store.db);
  const base: SweepReport = {
    simulation: deps.simulation,
    accountId: deps.accountId,
    polled: 0,
    persisted: 0,
    drained: 0,
    duplicates: 0,
    needsDecision: [],
    cursorCommitted: false,
    resetRequired: false,
  };
  const checkpoint = intake.getCursor(deps.accountId);
  const poll = await deps.inbox.pollInbox(`gather:intake:${deps.accountId}:${nowIso(deps)}`, {
    ...(checkpoint === undefined ? {} : { cursor: checkpoint.cursor }),
  });
  if (poll.status !== "succeeded") {
    intake.recordFailure(deps.accountId, "poll", poll.status === "failed" ? poll.error.message : "unknown poll failure");
    return { ...base, error: poll.status === "failed" ? poll.error.message : "poll failed" };
  }
  if (poll.data.resetRequired) {
    // Cursor dead: full-sync on the next sweep (cursor-less poll). Nothing
    // is persisted and nothing advances.
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
    simulation: deps.simulation,
  });
  base.batchId = batch.id;
  base.persisted = batch.itemCount;
  const drained = await drainBatch(deps, intake, batch.id);
  base.drained = drained.drained;
  base.duplicates = drained.duplicates;
  base.needsDecision = drained.needsDecision;
  if (drained.failed === 0) {
    intake.markBatch(batch.id, "drained");
    if (poll.data.nextCursor !== undefined) {
      intake.commitCursor(deps.accountId, poll.data.nextCursor, undefined);
      base.cursorCommitted = true;
    }
  } else {
    intake.markBatch(batch.id, "failed");
    base.error = `${drained.failed} item(s) failed to drain; cursor not committed`;
  }
  return base;
}

async function drainBatch(
  deps: IntakeDeps,
  intake: OperatorIntakeStore,
  batchId: string,
): Promise<{ drained: number; duplicates: number; needsDecision: string[]; failed: number }> {
  // Provider order is chronological; the stable sort keeps it while grouping
  // nothing — replies stay after the inquiries they answer so the ledger
  // observes inquiry-then-reply and suppresses answered followups.
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

async function drainItem(deps: IntakeDeps, intake: OperatorIntakeStore, item: IntakeItemRecord): Promise<"drained" | "duplicate" | "needs_decision"> {
  const store: GatherStore = deps.store;
  const ledger: CoordinationLedger = deps.ledger;

  let hints: IdentityHints = {};
  let kind: "inquiry" | "reply" = "inquiry";
  let observedAt = item.observedAt;
  if (item.threadId !== undefined && deps.threads !== undefined) {
    const thread = await deps.threads.readThread(item.threadId);
    if (thread !== undefined) {
      const first = thread.messages[0];
      const mine = thread.messages.find((message) => message.id === item.messageId);
      if (first !== undefined) {
        const sender = addressOf(first.from);
        if (sender !== undefined) hints = { ...hints, senderEmail: sender };
        if (first.subject) hints = { ...hints, eventName: first.subject };
      }
      if (mine !== undefined) {
        observedAt = mine.receivedAt || observedAt;
        // A thread already holding earlier messages makes this one a reply;
        // the ledger then suppresses the answered followup at claim time.
        const earlier = thread.messages.filter((message) => message.id !== item.messageId);
        if (earlier.length > 0) kind = "reply";
      }
    }
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
  const dedupeKey = `gather:intake:${deps.accountId}:${item.messageId}:${kind}`;
  const ingested = ledger.ingestEvent({
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
  intake.updateItem(item.id, {
    status: "ingested",
    bookingId: proposed.bookingId,
    sourceKey: proposed.sourceKey,
    ledgerEventId: ingested.eventId,
  });
  return ingested.duplicate ? "duplicate" : "drained";
}
