import { createHash } from "node:crypto";
import type {
  ConnectorResult,
  InquiryThread,
  ReadInquiryThreadRequest,
  RetrieveDocumentRequest,
  RetrieveDocumentResponse,
  SourceReference,
} from "../../connectors/contracts.ts";
import type {
  InboxDelta,
  PollInboxOptions,
} from "../../connectors/google/incremental.ts";
import type {
  BoundedThreadResponse,
  ReadMessageMetadataRequest,
  ReadMessageMetadataResponse,
} from "../../connectors/google/gmail.ts";
import type {
  ReadDocumentMetadataRequest,
  ReadDocumentMetadataResponse,
} from "../../connectors/google/documents.ts";
import { buildSourceKey, decodeSourceKey } from "../../identity/source-key.ts";
import type { IdentityComponents } from "../../identity/source-key.ts";
import { ServiceError } from "../booking-service.ts";
import type { GatherStore } from "../sqlite-store.ts";
import { SourceSyncStore, type SourceRecordRow } from "./store.ts";
import {
  DEFAULT_SCAN_LIMIT,
  DEFAULT_WINDOW_DAYS,
  HISTORY_WINDOW_DAYS,
  MAX_EXCLUDED_SAMPLES,
  SOURCE_FETCH_CONCURRENCY,
  type BoundSourcePort,
  type CoverageState,
  type ScanOptions,
  type ScanResult,
  type SourceChannel,
  type SourceCoverage,
  type SourceEvent,
  type SourceKnowledgeConsumer,
  type SourceReadResult,
  type SourceRecordEnvelope,
  type SourceScope,
} from "./types.ts";

/**
 * Progressive source pipeline (ADR-007 / C03).
 *
 * Turns the existing Google read adapters into a resumable scan over a
 * declared, owner-visible scope: recent inbox and sent threads, explicit
 * Drive document ids, and a declared calendar (which the current adapters
 * cannot enumerate — recorded as an honest exclusion). Every emitted
 * record is a C02 envelope with stable source-key identity, provider
 * version, content hash and provenance; source versions, cursor progress
 * and coverage commit together in the shared database, and
 * deletion/revocation events go through a durable outbox that is flushed
 * BEFORE any dependent work.
 *
 * Knowledge is an injected consumer port — this module records envelopes
 * and invalidations only; nothing here mints a confirmed business fact.
 */

export interface SourceInboxPort {
  pollInbox(operationKey: string, options: PollInboxOptions): Promise<ConnectorResult<InboxDelta>>;
  readonly provenance: { simulated: boolean; label: string };
}

/** Bounded thread read (bodies + completeness flags) for one thread id. */
export interface SourceThreadPort {
  readThreadBounded(request: ReadInquiryThreadRequest): Promise<ConnectorResult<BoundedThreadResponse>>;
  readonly provenance: { simulated: boolean; label: string };
}

/** Metadata-only message read used to apply the window before body fetches. */
export interface SourceMetadataPort {
  readMessageMetadata(request: ReadMessageMetadataRequest): Promise<ConnectorResult<ReadMessageMetadataResponse>>;
  readonly provenance: { simulated: boolean; label: string };
}

export interface SourceDocumentPort {
  readDocumentMetadata(request: ReadDocumentMetadataRequest): Promise<ConnectorResult<ReadDocumentMetadataResponse>>;
  retrieveDocument(request: RetrieveDocumentRequest): Promise<ConnectorResult<RetrieveDocumentResponse>>;
  readonly provenance: { simulated: boolean; label: string };
}

export interface SourcePipelineDeps {
  store: GatherStore;
  /** Stable account identity this pipeline is bound to (never a userId alias). */
  accountId: string;
  businessId: string;
  provider?: string;
  inbox: SourceInboxPort;
  threads: SourceThreadPort;
  metadata: SourceMetadataPort;
  documents?: SourceDocumentPort;
  /** Injected knowledge consumer — a recording stand-in in this ADR. */
  consumer: SourceKnowledgeConsumer;
  /** Parser/extraction version for the content cache key. */
  parserVersion?: string;
  now?: () => string;
}

const CURSOR_PREFIX = "gsc.";
const CURSOR_VERSION = 1;
const DEFAULT_PARSER_VERSION = "source-text/1";

interface ScanCursor {
  fp: string;
  /** Per-partition poller cursor (opaque ghi.* token). */
  mail?: string;
}

function encodeScanCursor(cursor: ScanCursor): string {
  const payload: Record<string, unknown> = { v: CURSOR_VERSION, fp: cursor.fp };
  if (cursor.mail !== undefined) payload.mail = cursor.mail;
  return `${CURSOR_PREFIX}${Buffer.from(JSON.stringify(payload), "utf-8").toString("base64url")}`;
}

function decodeScanCursor(raw: string): ScanCursor | undefined {
  if (!raw.startsWith(CURSOR_PREFIX)) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw.slice(CURSOR_PREFIX.length), "base64url").toString("utf-8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const value = parsed as Record<string, unknown>;
    if (value.v !== CURSOR_VERSION || typeof value.fp !== "string" || value.fp.length === 0) return undefined;
    const cursor: ScanCursor = { fp: value.fp };
    if (value.mail !== undefined) {
      if (typeof value.mail !== "string") return undefined;
      cursor.mail = value.mail;
    }
    return cursor;
  } catch {
    return undefined;
  }
}

/**
 * Scope identity for cursor binding and durable state. `windowDays` and
 * `priorityThreadIds` are deliberately excluded: history expansion and a
 * changing set of active threads must not invalidate committed progress.
 */
export function scopeFingerprint(scope: {
  accountId: string;
  businessId: string;
  documentIds?: string[];
  includeSent?: boolean;
  query?: string;
  calendarId?: string;
}): string {
  const material = JSON.stringify({
    accountId: scope.accountId,
    businessId: scope.businessId,
    documentIds: [...(scope.documentIds ?? [])].sort(),
    includeSent: scope.includeSent ?? true,
    query: scope.query ?? null,
    calendarId: scope.calendarId ?? null,
  });
  return createHash("sha256").update(material).digest("hex").slice(0, 24);
}

function contentHashOf(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

/** Bounded fan-out: at most SOURCE_FETCH_CONCURRENCY (2) fetches in flight. */
async function mapBounded<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const bound = Math.max(1, Math.min(limit, SOURCE_FETCH_CONCURRENCY));
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(bound, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

interface NormalizedScope {
  accountId: string;
  businessId: string;
  windowDays: number;
  documentIds: string[];
  includeSent: boolean;
  query?: string;
  priorityThreadIds: Set<string>;
  calendarId?: string;
}

interface PartitionOutcome {
  state: CoverageState;
  observed: number;
  detail?: string;
  truncated: boolean;
  progressed: boolean;
  pages: number;
}

interface PendingRecord {
  sourceKey: string;
  channel: SourceChannel;
  externalId: string;
  threadId?: string;
  version: string;
  contentHash: string;
  receivedAt?: string;
  observedAt: string;
  text: string;
  meta: SourceRecordRow["meta"];
}

export class SourcePipeline {
  private readonly deps: SourcePipelineDeps;
  private readonly sync: SourceSyncStore;

  constructor(deps: SourcePipelineDeps) {
    this.deps = deps;
    this.sync = new SourceSyncStore(deps.store.db);
  }

  private now(): string {
    return this.deps.now ? this.deps.now() : new Date().toISOString();
  }

  private provider(): string {
    return this.deps.provider ?? "google";
  }

  private parserVersion(): string {
    return this.deps.parserVersion ?? DEFAULT_PARSER_VERSION;
  }

  private simulated(): boolean {
    return (
      this.deps.inbox.provenance.simulated ||
      this.deps.threads.provenance.simulated ||
      this.deps.metadata.provenance.simulated ||
      (this.deps.documents?.provenance.simulated ?? false)
    );
  }

  private mode(): "prepared" | "live" {
    return this.simulated() ? "prepared" : "live";
  }

  private sourceKey(channel: SourceChannel, externalId: string, threadId?: string): string {
    const sourceKind = channel === "document" ? "document" : channel === "calendar" ? "calendar" : "email";
    return buildSourceKey({
      provider: this.provider(),
      accountId: this.deps.accountId,
      businessId: this.deps.businessId,
      sourceKind,
      externalId,
      threadId: threadId ?? "",
    });
  }

  private normalizeScope(scope: SourceScope): NormalizedScope {
    if (scope.accountId !== this.deps.accountId || scope.businessId !== this.deps.businessId) {
      throw new ServiceError(
        "DENIED",
        "Source scope is bound to this installation's account and business; cross-account or cross-business reads are denied",
        false,
      );
    }
    const documentIds = [...new Set(scope.documentIds ?? [])].sort();
    if (documentIds.some((id) => id.trim().length === 0)) {
      throw new ServiceError("INVALID_REQUEST", "documentIds must be non-empty explicit Drive ids", false);
    }
    return {
      accountId: scope.accountId,
      businessId: scope.businessId,
      windowDays: scope.windowDays ?? DEFAULT_WINDOW_DAYS,
      documentIds,
      includeSent: scope.includeSent ?? true,
      ...(scope.query === undefined ? {} : { query: scope.query }),
      priorityThreadIds: new Set(scope.priorityThreadIds ?? []),
      ...(scope.calendarId === undefined ? {} : { calendarId: scope.calendarId }),
    };
  }

  /** Deliver every committed-but-undelivered event; invalidations precede work. */
  private async flushOutbox(): Promise<void> {
    for (const event of this.sync.listUndelivered(this.deps.accountId)) {
      await this.deliverEvent(event);
      this.sync.markDelivered(event.seq);
    }
  }

  /**
   * Outbox delivery: versioned events re-emit the durable record's stored
   * envelope fields (identical after a crash); deletion/revocation events
   * invalidate by key. A deleted or purged record never re-emits.
   */
  private async deliverEvent(event: SourceEvent): Promise<void> {
    if (event.kind === "versioned") {
      const record = this.sync.getRecord(event.sourceKey);
      if (record === undefined || record.status === "deleted" || record.text === undefined) return;
      await this.deps.consumer.ingestSource(this.toEnvelope(record));
      return;
    }
    await this.deps.consumer.invalidateSource(event.sourceKey, event.kind);
  }

  private toEnvelope(record: SourceRecordRow): SourceRecordEnvelope {
    const meta = record.meta ?? {};
    return {
      sourceKey: record.sourceKey,
      provider: this.provider(),
      accountId: record.accountId,
      channel: record.channel,
      externalId: record.externalId,
      ...(record.threadId === undefined ? {} : { threadId: record.threadId }),
      observedAt: record.observedAt,
      ...(record.receivedAt === undefined ? {} : { receivedAt: record.receivedAt }),
      contentVersion: record.version,
      contentHash: record.contentHash,
      parserVersion: record.parserVersion,
      text: record.text ?? "",
      attachments: [],
      ...(meta.senderEvidence === undefined ? {} : { senderEvidence: meta.senderEvidence }),
      complete: meta.complete ?? true,
      issues: meta.issues ?? [],
      provenance: (meta.provenance ?? []) as SourceReference[],
      simulated: this.simulated(),
      mode: this.mode(),
    };
  }

  /**
   * The C03 scan port. Each partition commits its record versions and
   * cursor progress atomically; a failed or truncated partition degrades
   * coverage honestly instead of claiming a completed empty scan.
   */
  async scan(scope: SourceScope, options: ScanOptions = {}): Promise<ScanResult> {
    const normalized = this.normalizeScope(scope);
    const fp = scopeFingerprint(normalized);
    const limit = options.limit ?? DEFAULT_SCAN_LIMIT;
    if (!Number.isInteger(limit) || limit < 1) {
      throw new ServiceError("INVALID_REQUEST", "scan limit must be a positive integer", false);
    }
    const persisted = this.sync.getScanState(normalized.accountId, fp);
    // The persisted window wins when the caller did not name one: history
    // expansion is durable state, not a per-call hint.
    const windowDays = scope.windowDays ?? persisted?.windowDays ?? normalized.windowDays;
    const windowStart = new Date(Date.parse(this.now()) - windowDays * 86_400_000).toISOString();

    let cursor: ScanCursor = { fp };
    if (options.cursor !== undefined) {
      const decoded = decodeScanCursor(options.cursor);
      // Incompatible cursor scope is rejected, never silently adopted.
      if (decoded === undefined || decoded.fp !== fp) {
        throw new ServiceError("INVALID_REQUEST", "Scan cursor is bound to a different scope; start a cursor-less scan", false);
      }
      cursor = decoded;
    } else if (persisted?.cursor !== undefined) {
      const decoded = decodeScanCursor(persisted.cursor);
      if (decoded !== undefined && decoded.fp === fp) cursor = decoded;
    }

    const coverage: SourceCoverage = {
      accountId: normalized.accountId,
      businessId: normalized.businessId,
      scopeFingerprint: fp,
      state: "running",
      windowDays,
      windowStart,
      partitions: [],
      completedPages: 0,
      observedRecords: 0,
      emittedRecords: 0,
      excluded: { count: 0, sampled: [], truncated: false },
      ...(persisted?.coverage.lastSuccessAt === undefined ? {} : { lastSuccessAt: persisted.coverage.lastSuccessAt }),
    };
    this.sync.putScanState({
      accountId: normalized.accountId,
      scopeFingerprint: fp,
      cursor: encodeScanCursor(cursor),
      windowDays,
      coverage,
    });

    // Invalidations and any crash-stranded emissions flush BEFORE work.
    await this.flushOutbox();

    const emitted: SourceRecordEnvelope[] = [];
    const emittedEvents: SourceEvent[] = [];
    let exhausted = true;

    // Re-bucket durable exclusions under the effective window: expansion
    // promotes them into the fetch set without a provider listing.
    const promoted = this.sync.inTransaction(() => this.promoteExclusions(normalized, fp, windowStart));

    const mail = await this.scanMailPartition(normalized, fp, cursor, windowStart, promoted, emitted, emittedEvents, limit);
    coverage.partitions.push({ channel: "inbox", state: mail.state, observed: mail.observed, ...(mail.detail === undefined ? {} : { detail: mail.detail }) });
    coverage.completedPages += mail.pages;
    exhausted &&= !mail.truncated && mail.state === "complete";

    // A partition with no scope membership is absent, not "succeeded" —
    // otherwise a failed mail scan would read as partial instead of failed.
    if (normalized.documentIds.length > 0) {
      const docs = await this.scanDocumentPartition(normalized, fp, emitted, emittedEvents);
      coverage.partitions.push({ channel: "document", state: docs.state, observed: docs.observed, ...(docs.detail === undefined ? {} : { detail: docs.detail }) });
      exhausted &&= docs.state === "complete";
    }

    if (normalized.calendarId !== undefined) {
      // The adapters expose freeBusy/hold reconciliation, not event
      // enumeration — declared in scope, honestly excluded from scanning.
      coverage.partitions.push({
        channel: "calendar",
        state: "complete",
        observed: 0,
        detail: `calendar ${normalized.calendarId} is bound for fresh availability checks; event enumeration is not a supported read surface`,
      });
      this.sync.inTransaction(() => {
        this.sync.addExclusion({
          accountId: normalized.accountId,
          scopeFingerprint: fp,
          channel: "calendar",
          externalId: normalized.calendarId!,
        });
      });
    }

    // Coverage verdict: a scan where nothing succeeded is failed; one with
    // progress plus a failed/truncated partition is partial. Failed never
    // reports as a completed (possibly empty) scan.
    const realPartitions = coverage.partitions.filter((partition) => partition.channel !== "calendar");
    const allFailed = realPartitions.length > 0 && realPartitions.every((partition) => partition.state === "failed");
    const anyFailure = realPartitions.some((partition) => partition.state === "failed");
    coverage.state = allFailed ? "failed" : anyFailure || !exhausted ? "partial" : "complete";
    if (coverage.state === "complete") coverage.lastSuccessAt = this.now();
    const excludedRows = this.sync.countExclusions(normalized.accountId, fp);
    const sampled = this.sync.listExclusions(normalized.accountId, fp).slice(0, 20).map((item) => item.externalId);
    coverage.excluded = { count: excludedRows, sampled, truncated: excludedRows > sampled.length };
    coverage.observedRecords = coverage.partitions.reduce((total, partition) => total + partition.observed, 0);
    coverage.emittedRecords = emitted.length;

    const nextCursor = encodeScanCursor(cursor);
    this.sync.putScanState({
      accountId: normalized.accountId,
      scopeFingerprint: fp,
      cursor: nextCursor,
      windowDays,
      coverage,
    });

    return { records: emitted, events: emittedEvents, nextCursor, coverage, exhausted };
  }

  /**
   * Mail partition: poll deltas/snapshot, apply the declared window via
   * provider metadata (internalDate, never sender-supplied Date headers),
   * then fetch bodies for in-window and active-priority threads under the
   * bounded fetch concurrency.
   */
  private async scanMailPartition(
    scope: NormalizedScope,
    fp: string,
    cursor: ScanCursor,
    windowStart: string,
    promoted: Array<{ externalId: string; threadId?: string }>,
    emitted: SourceRecordEnvelope[],
    emittedEvents: SourceEvent[],
    limit: number,
  ): Promise<PartitionOutcome> {
    const out: PartitionOutcome = { state: "complete", observed: 0, truncated: false, progressed: false, pages: 0 };
    const opKey = `gather:source:scan:${scope.accountId}`;
    // Channels whose population this poll's listing actually covers.
    const reconciledChannels: SourceChannel[] =
      scope.query === undefined ? ["inbox", "sent"]
      : scope.query === "in:inbox" ? ["inbox"]
      : scope.query === "in:sent" ? ["sent"]
      : [];
    // Stale (revoked) records cannot be revalidated by a delta — the
    // provider produced no new history for them. A forced full sync makes
    // reconnection revalidate them and reconciles absence to tombstones.
    const hasStale = this.sync
      .listRecords(scope.accountId, { status: "stale" })
      .some((record) => reconciledChannels.includes(record.channel));
    // A cursor-less poll (or an expired-cursor rescan) is a full listing:
    // messages absent from a COMPLETE snapshot no longer exist at the
    // provider, which lets us tombstone deletions that predate the window
    // the cursor can observe.
    let listedSnapshot = cursor.mail === undefined || hasStale;
    const poll = await this.deps.inbox.pollInbox(`${opKey}:mail`, {
      ...(listedSnapshot ? {} : { cursor: cursor.mail }),
      ...(scope.query === undefined ? {} : { query: scope.query }),
      maxMessages: limit,
    });
    if (poll.status !== "succeeded") {
      return this.partitionFailure(scope, "inbox", poll.error.kind, poll.error.message, out, emittedEvents);
    }
    let delta = poll.data;
    if (delta.resetRequired) {
      // Dead cursor: bounded rescan with stable-key dedupe, never data loss.
      const rescan = await this.deps.inbox.pollInbox(`${opKey}:mail:rescan`, {
        ...(scope.query === undefined ? {} : { query: scope.query }),
        maxMessages: limit,
      });
      if (rescan.status !== "succeeded") {
        return this.partitionFailure(scope, "inbox", rescan.error.kind, rescan.error.message, out, emittedEvents);
      }
      if (rescan.data.resetRequired) {
        return this.partitionFailure(scope, "inbox", "transport_error", "inbox rescan still reports an expired cursor", out, emittedEvents);
      }
      delta = rescan.data;
      listedSnapshot = true;
      out.detail = "mail cursor expired; bounded rescan ran with stable-key dedupe";
    }
    out.pages += delta.pages;
    if (delta.truncated) {
      out.truncated = true;
      out.state = "partial";
      out.detail = "provider page/message bounds hit; resume with the returned cursor";
    }
    if (delta.nextCursor !== undefined) cursor.mail = delta.nextCursor;

    // 1) Deletions invalidate BEFORE any new record work.
    for (const change of delta.deleted) {
      const target = this.findRecordByExternalId(scope.accountId, change.messageId);
      if (target === undefined || target.status === "deleted") continue;
      const event = this.sync.inTransaction(() => {
        this.sync.tombstone(target.sourceKey);
        return this.sync.appendEvent({
          accountId: scope.accountId,
          businessId: scope.businessId,
          kind: "deleted",
          sourceKey: target.sourceKey,
          version: target.version,
        });
      });
      emittedEvents.push(event);
      await this.deliverEvent(event);
      this.sync.markDelivered(event.seq);
      out.progressed = true;
    }

    // 1b) Snapshot reconciliation: a COMPLETE listing is authoritative for
    // existence — previously-active records absent from it were deleted
    // before the cursor window could observe the deletion record. Only
    // reconcile channels the listing actually covered (a label-scoped poll
    // sees only its own population).
    if (listedSnapshot && !delta.truncated) {
      if (reconciledChannels.length > 0) {
        const present = new Set(delta.changes.map((change) => change.messageId));
        for (const record of this.sync.listRecords(scope.accountId)) {
          if (record.status === "deleted" || !reconciledChannels.includes(record.channel)) continue;
          if (present.has(record.externalId)) continue;
          const event = this.sync.inTransaction(() => {
            this.sync.tombstone(record.sourceKey);
            return this.sync.appendEvent({
              accountId: scope.accountId,
              businessId: scope.businessId,
              kind: "deleted",
              sourceKey: record.sourceKey,
              version: record.version,
            });
          });
          emittedEvents.push(event);
          await this.deliverEvent(event);
          this.sync.markDelivered(event.seq);
          out.progressed = true;
        }
      }
    }

    // 2) Window bucketing on provider metadata; priority threads bypass it.
    const candidates = [...delta.changes];
    for (const item of promoted) {
      if (!candidates.some((change) => change.messageId === item.externalId)) {
        candidates.push({ messageId: item.externalId, ...(item.threadId === undefined ? {} : { threadId: item.threadId }) });
      }
    }
    const isPriority = (threadId: string | undefined) => threadId !== undefined && scope.priorityThreadIds.has(threadId);
    candidates.sort((left, right) => Number(isPriority(right.threadId)) - Number(isPriority(left.threadId)));

    const metas = await mapBounded(candidates, SOURCE_FETCH_CONCURRENCY, async (change) => ({
      change,
      result: await this.deps.metadata.readMessageMetadata({ operationKey: `${opKey}:meta:${change.messageId}`, messageId: change.messageId }),
    }));

    const toFetch: Array<{
      messageId: string;
      threadId?: string;
      historyId?: string;
      from?: string;
      labelIds: string[];
      channel: SourceChannel;
    }> = [];
    const exclusions: Array<{ externalId: string; threadId?: string; receivedAt?: string; channel: SourceChannel }> = [];
    const metaFailures: string[] = [];
    for (const { change, result } of metas) {
      if (result.status !== "succeeded") {
        metaFailures.push(`${change.messageId}:${result.error.kind}`);
        continue;
      }
      const meta = result.data.message;
      const sent = meta.labelIds.includes("SENT");
      const channel: SourceChannel = sent ? "sent" : "inbox";
      const inWindow = meta.receivedAt === undefined || meta.receivedAt >= windowStart || isPriority(meta.threadId);
      if ((sent && !scope.includeSent) || !inWindow) {
        exclusions.push({
          externalId: meta.messageId,
          ...(meta.threadId === undefined ? {} : { threadId: meta.threadId }),
          ...(meta.receivedAt === undefined ? {} : { receivedAt: meta.receivedAt }),
          channel,
        });
        continue;
      }
      toFetch.push({
        messageId: meta.messageId,
        ...(meta.threadId === undefined ? {} : { threadId: meta.threadId }),
        ...(change.historyId === undefined ? {} : { historyId: change.historyId }),
        ...(meta.from === undefined ? {} : { from: meta.from }),
        labelIds: meta.labelIds,
        channel,
      });
    }
    if (metaFailures.length > 0) {
      out.state = "partial";
      out.truncated = true;
      out.detail = `${metaFailures.length} metadata read(s) failed (${metaFailures.slice(0, 3).join(", ")}); those records retry next scan`;
    }

    this.sync.inTransaction(() => {
      for (const item of exclusions) {
        if (this.sync.countExclusions(scope.accountId, fp) >= MAX_EXCLUDED_SAMPLES) break;
        this.sync.addExclusion({
          accountId: scope.accountId,
          scopeFingerprint: fp,
          channel: item.channel,
          externalId: item.externalId,
          ...(item.threadId === undefined ? {} : { threadId: item.threadId }),
          ...(item.receivedAt === undefined ? {} : { receivedAt: item.receivedAt }),
        });
      }
    });

    // 3) Bounded body fetches (two at a time), threads fetched once each.
    const threadCache = new Map<string, { thread: InquiryThread; issues: Map<string, string[]>; provenance: SourceReference[] }>();
    const fetched = await mapBounded(toFetch, SOURCE_FETCH_CONCURRENCY, async (item) => {
      if (item.threadId === undefined) return { item, entry: undefined, failed: "missing threadId" };
      const cached = threadCache.get(item.threadId);
      if (cached !== undefined) return { item, entry: cached, failed: undefined };
      const result = await this.deps.threads.readThreadBounded({ operationKey: `${opKey}:thread:${item.threadId}`, threadId: item.threadId });
      if (result.status !== "succeeded") return { item, entry: undefined, failed: result.error.kind };
      const issues = new Map<string, string[]>();
      for (const message of result.data.completeness.messages) {
        issues.set(message.messageId, message.issues);
      }
      const entry = { thread: result.data.thread, issues, provenance: result.data.provenance };
      threadCache.set(item.threadId, entry);
      return { item, entry, failed: undefined };
    });

    const pending: PendingRecord[] = [];
    let fetchFailures = 0;
    const observedAt = this.now();
    for (const { item, entry, failed } of fetched) {
      if (entry === undefined) {
        fetchFailures += 1;
        void failed;
        continue;
      }
      // Emit every message in the fetched thread: sent replies and earlier
      // context ride the same stable keys, so sent-thread correlation works
      // by shared threadId and a rescan never re-emits unchanged content.
      for (const message of entry.thread.messages) {
        const channel: SourceChannel = item.channel;
        const issues = entry.issues.get(message.id) ?? [];
        pending.push({
          sourceKey: this.sourceKey(channel, message.id, entry.thread.threadId),
          channel,
          externalId: message.id,
          threadId: entry.thread.threadId,
          version: message.id === item.messageId && item.historyId !== undefined ? item.historyId : contentHashOf(message.body),
          contentHash: contentHashOf(message.body),
          ...(message.receivedAt === undefined || message.receivedAt === "" ? {} : { receivedAt: message.receivedAt }),
          observedAt,
          text: message.body,
          meta: {
            senderEvidence: { ...(item.from === undefined ? {} : { from: item.from }), labelIds: item.labelIds },
            complete: issues.length === 0,
            issues,
            provenance: entry.provenance,
          },
        });
      }
    }
    if (fetchFailures > 0) {
      out.state = "partial";
      out.truncated = true;
      out.detail = `${fetchFailures} thread read(s) failed; parked records retry next scan`;
    }

    // 4) Commit record versions + cursor together, then deliver the outbox.
    const committed = this.sync.inTransaction(() => {
      const events: SourceEvent[] = [];
      for (const record of pending) {
        const upserted = this.sync.upsertRecord({
          sourceKey: record.sourceKey,
          accountId: scope.accountId,
          businessId: scope.businessId,
          channel: record.channel,
          externalId: record.externalId,
          ...(record.threadId === undefined ? {} : { threadId: record.threadId }),
          version: record.version,
          contentHash: record.contentHash,
          parserVersion: this.parserVersion(),
          observedAt: record.observedAt,
          ...(record.receivedAt === undefined ? {} : { receivedAt: record.receivedAt }),
          text: record.text,
          meta: record.meta,
        });
        if (!upserted.changed) continue; // stable-key + content/parser dedupe
        this.sync.cachePut(record.contentHash, this.parserVersion(), record.text);
        events.push(this.sync.appendEvent({
          accountId: scope.accountId,
          businessId: scope.businessId,
          kind: "versioned",
          sourceKey: record.sourceKey,
          version: record.version,
        }));
      }
      return events;
    });
    for (const event of committed) {
      emittedEvents.push(event);
      const record = this.sync.getRecord(event.sourceKey);
      if (record !== undefined && record.text !== undefined) {
        const envelope = this.toEnvelope(record);
        await this.deps.consumer.ingestSource(envelope);
        emitted.push(envelope);
      }
      this.sync.markDelivered(event.seq);
    }
    out.observed = candidates.length;
    out.progressed = out.progressed || committed.length > 0;
    return out;
  }

  /**
   * Document partition: owner-selected explicit ids only. Metadata gives
   * the provider version for change detection; a 404 is the provider's
   * deletion signal (tombstone + purge + invalidation event).
   */
  private async scanDocumentPartition(
    scope: NormalizedScope,
    fp: string,
    emitted: SourceRecordEnvelope[],
    emittedEvents: SourceEvent[],
  ): Promise<PartitionOutcome> {
    const out: PartitionOutcome = { state: "complete", observed: 0, truncated: false, progressed: false, pages: 0 };
    if (scope.documentIds.length === 0) return out;
    if (this.deps.documents === undefined) {
      out.state = "partial";
      out.detail = "no document retriever is wired; selected documents are excluded";
      this.sync.inTransaction(() => {
        for (const id of scope.documentIds) {
          this.sync.addExclusion({ accountId: scope.accountId, scopeFingerprint: fp, channel: "document", externalId: id });
        }
      });
      return out;
    }
    const documents = this.deps.documents;
    const opKey = `gather:source:scan:${scope.accountId}`;
    const observedAt = this.now();

    const metas = await mapBounded(scope.documentIds, SOURCE_FETCH_CONCURRENCY, async (documentId) => ({
      documentId,
      result: await documents.readDocumentMetadata({ operationKey: `${opKey}:docmeta:${documentId}`, documentId }),
    }));

    // Deletion signals invalidate before any new document work.
    const retrievable: Array<{ documentId: string; version?: string; modifiedTime?: string }> = [];
    const failures: string[] = [];
    for (const { documentId, result } of metas) {
      if (result.status === "succeeded") {
        const doc = result.data.document;
        if (doc.canDownload === false) {
          this.sync.inTransaction(() => {
            this.sync.addExclusion({ accountId: scope.accountId, scopeFingerprint: fp, channel: "document", externalId: documentId });
          });
          continue;
        }
        retrievable.push({
          documentId,
          ...(doc.version === undefined ? {} : { version: doc.version }),
          ...(doc.modifiedTime === undefined ? {} : { modifiedTime: doc.modifiedTime }),
        });
        continue;
      }
      if (result.error.kind === "not_found") {
        const key = this.sourceKey("document", documentId);
        const existing = this.sync.getRecord(key);
        if (existing !== undefined && existing.status !== "deleted") {
          const event = this.sync.inTransaction(() => {
            this.sync.tombstone(key);
            return this.sync.appendEvent({
              accountId: scope.accountId,
              businessId: scope.businessId,
              kind: "deleted",
              sourceKey: key,
              version: existing.version,
            });
          });
          emittedEvents.push(event);
          await this.deliverEvent(event);
          this.sync.markDelivered(event.seq);
          out.progressed = true;
        }
        continue;
      }
      if (result.error.kind === "access_revoked" || result.error.kind === "authorization_denied") {
        return this.partitionFailure(scope, "document", result.error.kind, result.error.message, out, emittedEvents);
      }
      failures.push(`${documentId}:${result.error.kind}`);
    }

    const bodies = await mapBounded(retrievable, SOURCE_FETCH_CONCURRENCY, async (doc) => ({
      doc,
      result: await documents.retrieveDocument({ operationKey: `${opKey}:doc:${doc.documentId}`, documentId: doc.documentId }),
    }));
    const pending: PendingRecord[] = [];
    for (const { doc, result } of bodies) {
      if (result.status !== "succeeded") {
        failures.push(`${doc.documentId}:${result.error.kind}`);
        continue;
      }
      const record = result.data.document;
      const hash = contentHashOf(record.text);
      pending.push({
        sourceKey: this.sourceKey("document", doc.documentId),
        channel: "document",
        externalId: doc.documentId,
        version: doc.version ?? hash,
        contentHash: hash,
        ...(doc.modifiedTime === undefined ? {} : { receivedAt: doc.modifiedTime }),
        observedAt,
        text: record.text,
        meta: { provenance: result.data.provenance },
      });
    }
    const committed = this.sync.inTransaction(() => {
      const events: SourceEvent[] = [];
      for (const record of pending) {
        const upserted = this.sync.upsertRecord({
          sourceKey: record.sourceKey,
          accountId: scope.accountId,
          businessId: scope.businessId,
          channel: record.channel,
          externalId: record.externalId,
          version: record.version,
          contentHash: record.contentHash,
          parserVersion: this.parserVersion(),
          observedAt: record.observedAt,
          ...(record.receivedAt === undefined ? {} : { receivedAt: record.receivedAt }),
          text: record.text,
          meta: record.meta,
        });
        if (!upserted.changed) continue;
        this.sync.cachePut(record.contentHash, this.parserVersion(), record.text);
        events.push(this.sync.appendEvent({
          accountId: scope.accountId,
          businessId: scope.businessId,
          kind: "versioned",
          sourceKey: record.sourceKey,
          version: record.version,
        }));
      }
      return events;
    });
    for (const event of committed) {
      emittedEvents.push(event);
      const record = this.sync.getRecord(event.sourceKey);
      if (record !== undefined && record.text !== undefined) {
        const envelope = this.toEnvelope(record);
        await this.deps.consumer.ingestSource(envelope);
        emitted.push(envelope);
      }
      this.sync.markDelivered(event.seq);
    }
    if (failures.length > 0) {
      out.state = "partial";
      out.truncated = true;
      out.detail = `${failures.length} document read(s) failed (${failures.slice(0, 3).join(", ")}); they retry next scan`;
    }
    out.progressed = out.progressed || committed.length > 0;
    return out;
  }

  /**
   * Access loss on a partition: dependent knowledge is unusable
   * immediately — active records stale out and revocation events are
   * committed — but bodies stay until an explicit disconnect/delete
   * purges them. Reconnection requires revalidation, never unstaling.
   */
  private async partitionFailure(
    scope: NormalizedScope,
    channel: SourceChannel,
    kind: string,
    message: string,
    out: PartitionOutcome,
    emittedEvents: SourceEvent[],
  ): Promise<PartitionOutcome> {
    out.state = "failed";
    out.detail = `${kind}: ${message}`;
    if (kind !== "access_revoked" && kind !== "authorization_denied") return out;
    const staled = this.sync.inTransaction(() => {
      const keys = this.sync.markStale(scope.accountId, channel);
      return keys.map((sourceKey) =>
        this.sync.appendEvent({ accountId: scope.accountId, businessId: scope.businessId, kind: "revoked", sourceKey }),
      );
    });
    // Revocations are invalidations: deliver them before any later work.
    for (const event of staled) {
      emittedEvents.push(event);
      await this.deliverEvent(event);
      this.sync.markDelivered(event.seq);
    }
    out.detail = `${kind}: ${message}; ${staled.length} record(s) invalidated pending revalidation`;
    return out;
  }

  /**
   * Re-bucket durable exclusions under the effective window. Returns the
   * records now inside it (their exclusion rows are consumed) — expansion
   * recovery for "older/excluded sample finds omissions" (007-A03).
   */
  private promoteExclusions(
    scope: NormalizedScope,
    fp: string,
    windowStart: string,
  ): Array<{ externalId: string; threadId?: string }> {
    const promoted: Array<{ externalId: string; threadId?: string }> = [];
    for (const channel of ["inbox", "sent"] as const) {
      for (const item of this.sync.listExclusions(scope.accountId, fp, channel)) {
        const inWindow = item.receivedAt === undefined
          || item.receivedAt >= windowStart
          || (item.threadId !== undefined && scope.priorityThreadIds.has(item.threadId));
        if (!inWindow || (channel === "sent" && !scope.includeSent)) continue;
        this.sync.removeExclusion(scope.accountId, fp, channel, item.externalId);
        promoted.push({ externalId: item.externalId, ...(item.threadId === undefined ? {} : { threadId: item.threadId }) });
      }
    }
    return promoted;
  }

  /** Locate a stored record by provider id regardless of its channel key. */
  private findRecordByExternalId(accountId: string, externalId: string): SourceRecordRow | undefined {
    return this.sync.listRecords(accountId).find((record) => record.externalId === externalId && record.status !== "deleted");
  }

  /**
   * C03 read port. The decoded source key must bind this account and
   * business — cross-scope reads are denied, never resolved. Deleted
   * records return their tombstone, not a body.
   */
  async read(sourceKey: string): Promise<SourceReadResult> {
    let components: IdentityComponents;
    try {
      components = decodeSourceKey(sourceKey);
    } catch {
      throw new ServiceError("INVALID_REQUEST", "Malformed source key", false);
    }
    if (components.accountId !== this.deps.accountId || components.businessId !== this.deps.businessId) {
      throw new ServiceError("DENIED", "Source key is bound to a different account or business; cross-scope reads are denied", false);
    }
    const record = this.sync.getRecord(sourceKey);
    if (record === undefined) {
      throw new ServiceError("NOT_FOUND", "No source record exists for this key", false);
    }
    if (record.status === "deleted") {
      return { sourceKey, version: record.version, content: "", observedAt: record.observedAt, status: "deleted" };
    }
    return { sourceKey, version: record.version, content: record.text ?? "", observedAt: record.observedAt, status: "active" };
  }

  /**
   * Explicit disconnect: every record tombstones (bodies purged, minimal
   * tombstones retained), cursors clear so reconnection full-syncs, and
   * deletion events emit for the consumer before further work.
   */
  async disconnect(): Promise<{ tombstoned: number }> {
    const events = this.sync.inTransaction(() => {
      const active = this.sync.listRecords(this.deps.accountId).filter((record) => record.status !== "deleted");
      const emitted = active.map((record) => {
        this.sync.tombstone(record.sourceKey);
        return this.sync.appendEvent({
          accountId: this.deps.accountId,
          businessId: this.deps.businessId,
          kind: "deleted",
          sourceKey: record.sourceKey,
          version: record.version,
        });
      });
      for (const state of this.sync.listScanStates(this.deps.accountId)) {
        this.sync.putScanState({
          accountId: this.deps.accountId,
          scopeFingerprint: state.scopeFingerprint,
          cursor: undefined,
          windowDays: state.windowDays,
          coverage: { ...state.coverage, state: "failed", detail: "account disconnected; source bodies purged, reconnection requires revalidation" },
        });
      }
      return emitted;
    });
    for (const event of events) {
      await this.deliverEvent(event);
      this.sync.markDelivered(event.seq);
    }
    return { tombstoned: events.length };
  }
}

/**
 * Bind the pipeline to its host-declared scope. The owner-visible initial
 * scope (documents, sent inclusion, query, calendar) is wiring config;
 * the window is durable state so expansion survives restart.
 */
export function createBoundSourcePort(
  deps: SourcePipelineDeps,
  config: {
    documentIds?: string[];
    includeSent?: boolean;
    query?: string;
    calendarId?: string;
    initialWindowDays?: number;
    /** Host-supplied active-thread lookup (linked intake threads). */
    priorityThreads?: () => string[];
  },
): BoundSourcePort {
  const pipeline = new SourcePipeline(deps);
  const sync = new SourceSyncStore(deps.store.db);
  const buildScope = (windowDays?: number): SourceScope => ({
    accountId: deps.accountId,
    businessId: deps.businessId,
    ...(windowDays === undefined ? {} : { windowDays }),
    ...(config.documentIds === undefined ? {} : { documentIds: config.documentIds }),
    ...(config.includeSent === undefined ? {} : { includeSent: config.includeSent }),
    ...(config.query === undefined ? {} : { query: config.query }),
    ...(config.calendarId === undefined ? {} : { calendarId: config.calendarId }),
    priorityThreadIds: config.priorityThreads?.() ?? [],
  });
  const fp = scopeFingerprint(buildScope());
  return {
    scan: (options) => pipeline.scan(buildScope(), { ...(options?.limit === undefined ? {} : { limit: options.limit }) }),
    expandHistory: async (windows = 1) => {
      const persisted = sync.getScanState(deps.accountId, fp);
      const base = persisted?.windowDays ?? config.initialWindowDays ?? DEFAULT_WINDOW_DAYS;
      return pipeline.scan(buildScope(base + HISTORY_WINDOW_DAYS * Math.max(1, windows)));
    },
    read: (sourceKey) => pipeline.read(sourceKey),
    coverage: () => sync.listScanStates(deps.accountId).map((state) => state.coverage),
  };
}
