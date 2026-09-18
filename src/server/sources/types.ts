import type { SourceReference } from "../../connectors/contracts.ts";

/**
 * C03 source-synchronization contracts (ADR-007).
 *
 * The source port turns provider reads (Gmail history, explicit Drive
 * documents) into durable C02 intake envelopes plus source-version and
 * deletion events. Everything emitted is evidence, never authority: no
 * record here is a confirmed business fact, and sender-supplied content
 * can never widen scope or grant approval.
 *
 * Port contract (C03):
 *   scan(scope, cursor, limit) -> {records, nextCursor, coverage, exhausted}
 *   read(sourceKey)            -> {version, content, observedAt}
 * plus incremental deletion/revocation events delivered through the same
 * durable event log the scan emits.
 */

/** Owner-visible scan partitions. */
export type SourceChannel = "inbox" | "sent" | "document" | "calendar";

/** C03 defaults: 30-day window, pages of 100 records. */
export const DEFAULT_WINDOW_DAYS = 30;
export const DEFAULT_SCAN_LIMIT = 100;
export const HISTORY_WINDOW_DAYS = 30;
/** Bound on provider fetches running at once (C03: two source fetches). */
export const SOURCE_FETCH_CONCURRENCY = 2;
/** Cap on durably retained excluded-record samples per scope. */
export const MAX_EXCLUDED_SAMPLES = 1000;

/**
 * Declared initial scope. The fingerprint excludes `windowDays` and
 * `priorityThreadIds`: they are scheduling policy/hints, not scope
 * identity, so history expansion and changing active threads never
 * invalidate a committed cursor.
 */
export interface SourceScope {
  accountId: string;
  businessId: string;
  /** History window in days (default 30). Expansion adds 30-day steps. */
  windowDays?: number;
  /** Owner-selected Drive document ids (explicit IDs only, never a scan). */
  documentIds?: string[];
  /** Include the sent mailbox partition for sent-context correlation. */
  includeSent?: boolean;
  /**
   * Exact mail scope: absent (unfiltered) or a single system-label filter
   * — the same boundary `GmailInboxPoller` enforces. Anything else is
   * rejected rather than silently broadened.
   */
  query?: string;
  /** Active-thread ids fetched/emitted first and exempt from the window. */
  priorityThreadIds?: string[];
  /**
   * Authorized calendar id. Declared in coverage, but event enumeration is
   * not a supported adapter surface — it lands in `exclusions` honestly.
   */
  calendarId?: string;
}

/**
 * C02 intake envelope emitted per source record. `text` is raw source
 * content — evidence only. `senderEvidence` is connector-attested mailbox
 * status (labels, provider thread/message locators), never message-claimed
 * authority.
 */
export interface SourceRecordEnvelope {
  sourceKey: string;
  provider: string;
  accountId: string;
  channel: SourceChannel;
  externalId: string;
  threadId?: string;
  observedAt: string;
  receivedAt?: string;
  /** Provider version marker, or content hash when the provider has none. */
  contentVersion: string;
  contentHash: string;
  /** Parser/extraction version this envelope was produced under. */
  parserVersion: string;
  text: string;
  attachments: Array<{ name: string; mimeType?: string }>;
  senderEvidence?: { from?: string; labelIds: string[] };
  /** Bounded-reader completeness: false means "decide, do not assume". */
  complete: boolean;
  issues: string[];
  provenance: SourceReference[];
  simulated: boolean;
  mode: "prepared" | "live";
}

export type SourceEventKind = "versioned" | "deleted" | "revoked";

/**
 * Durable source event. Deletion/revocation events are emitted to the
 * consumer BEFORE subsequent dependent work; the row is committed with the
 * scan cursor and delivered via the outbox until acknowledged.
 */
export interface SourceEvent {
  seq: number;
  kind: SourceEventKind;
  accountId: string;
  businessId: string;
  sourceKey: string;
  version?: string;
  emittedAt: string;
}

export type CoverageState = "running" | "partial" | "complete" | "failed";

export interface PartitionCoverage {
  channel: SourceChannel;
  state: CoverageState;
  /** e.g. "in:sent", "3 documents", "calendar events not enumerable". */
  detail?: string;
  observed: number;
}

export interface SourceCoverage {
  accountId: string;
  businessId: string;
  /** Stable identity of the declared scope (window/priority excluded). */
  scopeFingerprint: string;
  state: CoverageState;
  /** Effective history window applied this scan. */
  windowDays: number;
  /** ISO edge of the applied window (undefined = no date bound). */
  windowStart?: string;
  partitions: PartitionCoverage[];
  /** Provider pages read this scan. */
  completedPages: number;
  /** Records observed in scope this scan. */
  observedRecords: number;
  /** Envelopes newly emitted this scan. */
  emittedRecords: number;
  /**
   * Records seen but outside the window/scope — counted, with a bounded
   * sample of ids retained so history expansion can recover them.
   */
  excluded: { count: number; sampled: string[]; truncated: boolean };
  lastSuccessAt?: string;
  detail?: string;
}

export interface ScanOptions {
  /** Pipeline cursor from a previous scan; absent resumes durable state. */
  cursor?: string;
  /** Max records emitted this scan (default 100). */
  limit?: number;
}

export interface ScanResult {
  /** Envelopes newly emitted this scan (post-dedupe). */
  records: SourceRecordEnvelope[];
  /** Source events emitted this scan (deletions/revocations first). */
  events: SourceEvent[];
  /** Durable resume point; persists even on partial/failed scans. */
  nextCursor?: string;
  coverage: SourceCoverage;
  /** True only when every in-scope partition drained without truncation. */
  exhausted: boolean;
}

export interface SourceReadResult {
  sourceKey: string;
  version: string;
  content: string;
  observedAt: string;
  status: "active" | "deleted";
}

/**
 * The injected knowledge consumer (ADR-008 territory owns a real one).
 * This ADR wires a recording test consumer; the port is the boundary, not
 * an implementation. `invalidateSource` calls arrive before any dependent
 * work and before the records that follow them in the same scan.
 */
export interface SourceKnowledgeConsumer {
  ingestSource(record: SourceRecordEnvelope): void | Promise<void>;
  invalidateSource(sourceKey: string, reason: SourceEventKind): void | Promise<void>;
}

/** Host-facing bound port: scope is server-derived, never caller input. */
export interface BoundSourcePort {
  scan(options?: { limit?: number }): Promise<ScanResult>;
  /** Widen the persisted window by N 30-day steps and rescan. */
  expandHistory(windows?: number): Promise<ScanResult>;
  read(sourceKey: string): Promise<SourceReadResult>;
  /** Persisted coverage rows for this account (latest first). */
  coverage(): SourceCoverage[];
}
