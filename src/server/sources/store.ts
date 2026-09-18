import type { DatabaseSync } from "node:sqlite";
import type {
  SourceChannel,
  SourceCoverage,
  SourceEvent,
  SourceEventKind,
} from "./types.ts";

type SqlRow = Record<string, unknown>;

function row(value: unknown): SqlRow {
  if (!value || typeof value !== "object") throw new Error("Expected a SQLite row");
  return value as SqlRow;
}

function nowIso(): string {
  return new Date().toISOString();
}

export type SourceRecordStatus = "active" | "deleted" | "stale";

/**
 * One durable source record per provider object in scope (C03).
 * `text` is the cached source body; on deletion it is purged (NULL) while
 * the tombstone row — key, version, provenance fields, timestamps — stays
 * so existing commitments remain explainable.
 */
export interface SourceRecordRow {
  sourceKey: string;
  accountId: string;
  businessId: string;
  channel: SourceChannel;
  externalId: string;
  threadId?: string;
  version: string;
  contentHash: string;
  parserVersion: string;
  observedAt: string;
  receivedAt?: string;
  status: SourceRecordStatus;
  /** Purged (NULL) on tombstone — never retained for deleted sources. */
  text?: string;
  /**
   * Envelope extras needed to replay an emission faithfully after a crash
   * (sender evidence, completeness, provenance). Not an authority field.
   */
  meta?: { senderEvidence?: { from?: string; labelIds: string[] }; complete?: boolean; issues?: string[]; provenance?: unknown[] };
  createdAt: string;
  updatedAt: string;
}

export interface ScanStateRow {
  accountId: string;
  scopeFingerprint: string;
  cursor?: string;
  /** Persisted history window — expansion survives restart. */
  windowDays: number;
  coverage: SourceCoverage;
  updatedAt: string;
}

export interface ExcludedRecordRow {
  accountId: string;
  scopeFingerprint: string;
  channel: SourceChannel;
  externalId: string;
  threadId?: string;
  receivedAt?: string;
}

/**
 * Source-pipeline tables on the SHARED Gather database — same file as
 * intake, ledger and identity (C03: "commit source versions and cursor
 * progress together in the existing database"). No second store. Event
 * rows form a durable outbox: they are committed with the cursor and
 * marked delivered only after the consumer acknowledges, so a crash
 * between emit and commit replays invalidations instead of losing them.
 */
export class SourceSyncStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS source_records (
        source_key TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        business_id TEXT NOT NULL,
        channel TEXT NOT NULL CHECK (channel IN ('inbox','sent','document','calendar')),
        external_id TEXT NOT NULL,
        thread_id TEXT,
        version TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        parser_version TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        received_at TEXT,
        status TEXT NOT NULL CHECK (status IN ('active','deleted','stale')),
        text TEXT,
        meta_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS source_content_cache (
        content_hash TEXT NOT NULL,
        parser_version TEXT NOT NULL,
        text TEXT NOT NULL,
        byte_len INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (content_hash, parser_version)
      );
      CREATE TABLE IF NOT EXISTS source_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT NOT NULL,
        business_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('versioned','deleted','revoked')),
        source_key TEXT NOT NULL,
        version TEXT,
        delivered INTEGER NOT NULL DEFAULT 0,
        emitted_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS source_scan_state (
        account_id TEXT NOT NULL,
        scope_fingerprint TEXT NOT NULL,
        cursor TEXT,
        window_days INTEGER NOT NULL,
        coverage_json TEXT NOT NULL,
        state TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (account_id, scope_fingerprint)
      );
      CREATE TABLE IF NOT EXISTS source_exclusions (
        account_id TEXT NOT NULL,
        scope_fingerprint TEXT NOT NULL,
        channel TEXT NOT NULL,
        external_id TEXT NOT NULL,
        thread_id TEXT,
        received_at TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (account_id, scope_fingerprint, channel, external_id)
      );
      CREATE INDEX IF NOT EXISTS idx_source_records_account ON source_records(account_id, channel, status);
      CREATE INDEX IF NOT EXISTS idx_source_events_delivery ON source_events(account_id, delivered);
    `);
  }

  /** Run `fn` inside one IMMEDIATE transaction (record+cursor atomicity). */
  inTransaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Best-effort; surface the original failure.
      }
      throw error;
    }
  }

  /**
   * Insert or refresh a record. Returns `changed: false` when the stored
   * (contentHash, parserVersion) already matches — the stable-key dedupe
   * that avoids rescanning/re-emitting unchanged records. A stale row is
   * reactivated by observation (reconnection requires revalidation: the
   * provider must actually return the record again).
   */
  upsertRecord(input: {
    sourceKey: string;
    accountId: string;
    businessId: string;
    channel: SourceChannel;
    externalId: string;
    threadId?: string;
    version: string;
    contentHash: string;
    parserVersion: string;
    observedAt: string;
    receivedAt?: string;
    text: string;
    meta?: SourceRecordRow["meta"];
  }): { record: SourceRecordRow; changed: boolean } {
    const timestamp = nowIso();
    const existing = this.getRecord(input.sourceKey);
    const unchanged =
      existing !== undefined &&
      // A stale (revoked) record re-observed by the provider is revalidation:
      // it re-emits so the consumer can un-invalidate, never auto-unstales.
      existing.status === "active" &&
      existing.contentHash === input.contentHash &&
      existing.parserVersion === input.parserVersion;
    if (unchanged) {
      this.db.prepare(
        "UPDATE source_records SET status = 'active', observed_at = $observed, updated_at = $at WHERE source_key = $key",
      ).run({ $observed: input.observedAt, $at: timestamp, $key: input.sourceKey });
      return { record: this.getRecord(input.sourceKey)!, changed: false };
    }
    this.db.prepare(
      `INSERT INTO source_records
        (source_key, account_id, business_id, channel, external_id, thread_id, version, content_hash,
         parser_version, observed_at, received_at, status, text, meta_json, created_at, updated_at)
       VALUES ($key, $account, $business, $channel, $external, $thread, $version, $hash,
         $parser, $observed, $received, 'active', $text, $meta, $at, $at)
       ON CONFLICT (source_key) DO UPDATE SET
         version = excluded.version, content_hash = excluded.content_hash,
         parser_version = excluded.parser_version, observed_at = excluded.observed_at,
         received_at = excluded.received_at, status = 'active', text = excluded.text,
         meta_json = excluded.meta_json, updated_at = excluded.updated_at`,
    ).run({
      $key: input.sourceKey,
      $account: input.accountId,
      $business: input.businessId,
      $channel: input.channel,
      $external: input.externalId,
      $thread: input.threadId ?? null,
      $version: input.version,
      $hash: input.contentHash,
      $parser: input.parserVersion,
      $observed: input.observedAt,
      $received: input.receivedAt ?? null,
      $text: input.text,
      $meta: input.meta === undefined ? null : JSON.stringify(input.meta),
      $at: timestamp,
    });
    return { record: this.getRecord(input.sourceKey)!, changed: true };
  }

  getRecord(sourceKey: string): SourceRecordRow | undefined {
    const found = this.db.prepare("SELECT * FROM source_records WHERE source_key = $key").get({ $key: sourceKey });
    return found === undefined ? undefined : toRecord(row(found));
  }

  listRecords(accountId: string, filter: { channel?: SourceChannel; status?: SourceRecordStatus } = {}): SourceRecordRow[] {
    const rows = this.db.prepare(
      `SELECT * FROM source_records WHERE account_id = $account
        AND ($channel IS NULL OR channel = $channel)
        AND ($status IS NULL OR status = $status)
       ORDER BY observed_at, source_key`,
    ).all({ $account: accountId, $channel: filter.channel ?? null, $status: filter.status ?? null });
    return rows.map((value) => toRecord(row(value)));
  }

  /**
   * Deletion tombstone: purges the cached body (and the shared content-
   * cache entry when no other live record references it) while keeping
   * key/version/provenance so commitments stay explainable. Returns false
   * when the record was already gone.
   */
  tombstone(sourceKey: string, at?: string): boolean {
    const existing = this.getRecord(sourceKey);
    if (existing === undefined || existing.status === "deleted") return false;
    const timestamp = at ?? nowIso();
    const result = this.db.prepare(
      "UPDATE source_records SET status = 'deleted', text = NULL, updated_at = $at WHERE source_key = $key AND status != 'deleted'",
    ).run({ $at: timestamp, $key: sourceKey });
    this.purgeCacheIfUnreferenced(existing.contentHash, existing.parserVersion);
    return Number(result.changes) === 1;
  }

  /**
   * Revocation: dependent knowledge becomes unusable immediately, but the
   * record is NOT deleted — reconnection requires revalidation, not
   * automatic unstaling. Returns the affected source keys.
   */
  markStale(accountId: string, channel?: SourceChannel, at?: string): string[] {
    const timestamp = at ?? nowIso();
    const affected = this.db.prepare(
      `SELECT source_key FROM source_records WHERE account_id = $account AND status = 'active'
        AND ($channel IS NULL OR channel = $channel)`,
    ).all({ $account: accountId, $channel: channel ?? null }).map((value) => String(row(value).source_key));
    this.db.prepare(
      `UPDATE source_records SET status = 'stale', updated_at = $at
       WHERE account_id = $account AND status = 'active' AND ($channel IS NULL OR channel = $channel)`,
    ).run({ $account: accountId, $channel: channel ?? null, $at: timestamp });
    return affected;
  }

  /** Content/parser-version cache (C03): unchanged content is never re-parsed. */
  cacheGet(contentHash: string, parserVersion: string): string | undefined {
    const found = this.db.prepare(
      "SELECT text FROM source_content_cache WHERE content_hash = $hash AND parser_version = $parser",
    ).get({ $hash: contentHash, $parser: parserVersion });
    return found === undefined ? undefined : String(row(found).text);
  }

  cachePut(contentHash: string, parserVersion: string, text: string): void {
    this.db.prepare(
      `INSERT INTO source_content_cache (content_hash, parser_version, text, byte_len, updated_at)
       VALUES ($hash, $parser, $text, $bytes, $at)
       ON CONFLICT (content_hash, parser_version) DO UPDATE SET text = excluded.text, byte_len = excluded.byte_len, updated_at = excluded.updated_at`,
    ).run({
      $hash: contentHash,
      $parser: parserVersion,
      $text: text,
      $bytes: Buffer.byteLength(text, "utf-8"),
      $at: nowIso(),
    });
  }

  /** Drop a cache entry once no live record still references it. */
  purgeCacheIfUnreferenced(contentHash: string, parserVersion: string): void {
    const stillUsed = this.db.prepare(
      "SELECT 1 FROM source_records WHERE content_hash = $hash AND parser_version = $parser AND status != 'deleted' LIMIT 1",
    ).get({ $hash: contentHash, $parser: parserVersion });
    if (stillUsed === undefined) {
      this.db.prepare(
        "DELETE FROM source_content_cache WHERE content_hash = $hash AND parser_version = $parser",
      ).run({ $hash: contentHash, $parser: parserVersion });
    }
  }

  /** Append one durable event (outbox row; delivered = 0 until acked). */
  appendEvent(input: {
    accountId: string;
    businessId: string;
    kind: SourceEventKind;
    sourceKey: string;
    version?: string;
    emittedAt?: string;
  }): SourceEvent {
    const timestamp = input.emittedAt ?? nowIso();
    this.db.prepare(
      `INSERT INTO source_events (account_id, business_id, kind, source_key, version, delivered, emitted_at)
       VALUES ($account, $business, $kind, $key, $version, 0, $at)`,
    ).run({
      $account: input.accountId,
      $business: input.businessId,
      $kind: input.kind,
      $key: input.sourceKey,
      $version: input.version ?? null,
      $at: timestamp,
    });
    const seq = Number(this.db.prepare("SELECT last_insert_rowid() AS seq").get()!.seq);
    return { seq, kind: input.kind, accountId: input.accountId, businessId: input.businessId, sourceKey: input.sourceKey, ...(input.version === undefined ? {} : { version: input.version }), emittedAt: timestamp };
  }

  /** Events committed but not yet delivered to the consumer (replay on restart). */
  listUndelivered(accountId: string, limit = 500): SourceEvent[] {
    const rows = this.db.prepare(
      "SELECT * FROM source_events WHERE account_id = $account AND delivered = 0 ORDER BY seq LIMIT $limit",
    ).all({ $account: accountId, $limit: limit });
    return rows.map((value) => toEvent(row(value)));
  }

  markDelivered(seq: number): void {
    this.db.prepare("UPDATE source_events SET delivered = 1 WHERE seq = $seq").run({ $seq: seq });
  }

  listEvents(accountId: string, limit = 200): SourceEvent[] {
    const rows = this.db.prepare(
      "SELECT * FROM source_events WHERE account_id = $account ORDER BY seq DESC LIMIT $limit",
    ).all({ $account: accountId, $limit: limit });
    return rows.map((value) => toEvent(row(value)));
  }

  /** Read committed scan state for one (account, scope) — restart resume. */
  getScanState(accountId: string, scopeFingerprint: string): ScanStateRow | undefined {
    const found = this.db.prepare(
      "SELECT * FROM source_scan_state WHERE account_id = $account AND scope_fingerprint = $fp",
    ).get({ $account: accountId, $fp: scopeFingerprint });
    return found === undefined ? undefined : toScanState(row(found));
  }

  listScanStates(accountId: string): ScanStateRow[] {
    const rows = this.db.prepare(
      "SELECT * FROM source_scan_state WHERE account_id = $account ORDER BY updated_at DESC",
    ).all({ $account: accountId });
    return rows.map((value) => toScanState(row(value)));
  }

  /**
   * Commit cursor progress, coverage and the applied window together —
   * callers place this inside inTransaction with the record writes so a
   * crash never separates emitted versions from the resume point.
   */
  putScanState(input: {
    accountId: string;
    scopeFingerprint: string;
    cursor?: string;
    windowDays: number;
    coverage: SourceCoverage;
  }): void {
    this.db.prepare(
      `INSERT INTO source_scan_state (account_id, scope_fingerprint, cursor, window_days, coverage_json, state, updated_at)
       VALUES ($account, $fp, $cursor, $window, $coverage, $state, $at)
       ON CONFLICT (account_id, scope_fingerprint) DO UPDATE SET
         cursor = excluded.cursor, window_days = excluded.window_days,
         coverage_json = excluded.coverage_json, state = excluded.state, updated_at = excluded.updated_at`,
    ).run({
      $account: input.accountId,
      $fp: input.scopeFingerprint,
      $cursor: input.cursor ?? null,
      $window: input.windowDays,
      $coverage: JSON.stringify(input.coverage),
      $state: input.coverage.state,
      $at: nowIso(),
    });
  }

  /**
   * Record an observed-but-out-of-window record (durable evidence for
   * expansion; bounded by the caller to MAX_EXCLUDED_SAMPLES per scope).
   */
  addExclusion(input: {
    accountId: string;
    scopeFingerprint: string;
    channel: SourceChannel;
    externalId: string;
    threadId?: string;
    receivedAt?: string;
  }): void {
    this.db.prepare(
      `INSERT OR IGNORE INTO source_exclusions
        (account_id, scope_fingerprint, channel, external_id, thread_id, received_at, created_at)
       VALUES ($account, $fp, $channel, $external, $thread, $received, $at)`,
    ).run({
      $account: input.accountId,
      $fp: input.scopeFingerprint,
      $channel: input.channel,
      $external: input.externalId,
      $thread: input.threadId ?? null,
      $received: input.receivedAt ?? null,
      $at: nowIso(),
    });
  }

  listExclusions(accountId: string, scopeFingerprint: string, channel?: SourceChannel): ExcludedRecordRow[] {
    const rows = this.db.prepare(
      `SELECT * FROM source_exclusions WHERE account_id = $account AND scope_fingerprint = $fp
        AND ($channel IS NULL OR channel = $channel) ORDER BY received_at, external_id`,
    ).all({ $account: accountId, $fp: scopeFingerprint, $channel: channel ?? null });
    return rows.map((value) => ({
      accountId: String(row(value).account_id),
      scopeFingerprint: String(row(value).scope_fingerprint),
      channel: String(row(value).channel) as SourceChannel,
      externalId: String(row(value).external_id),
      ...(row(value).thread_id ? { threadId: String(row(value).thread_id) } : {}),
      ...(row(value).received_at ? { receivedAt: String(row(value).received_at) } : {}),
    }));
  }

  removeExclusion(accountId: string, scopeFingerprint: string, channel: SourceChannel, externalId: string): void {
    this.db.prepare(
      `DELETE FROM source_exclusions WHERE account_id = $account AND scope_fingerprint = $fp
        AND channel = $channel AND external_id = $external`,
    ).run({ $account: accountId, $fp: scopeFingerprint, $channel: channel, $external: externalId });
  }

  countExclusions(accountId: string, scopeFingerprint: string): number {
    const found = this.db.prepare(
      "SELECT COUNT(*) AS n FROM source_exclusions WHERE account_id = $account AND scope_fingerprint = $fp",
    ).get({ $account: accountId, $fp: scopeFingerprint });
    return Number(row(found).n);
  }
}

function toRecord(value: SqlRow): SourceRecordRow {
  return {
    sourceKey: String(value.source_key),
    accountId: String(value.account_id),
    businessId: String(value.business_id),
    channel: String(value.channel) as SourceChannel,
    externalId: String(value.external_id),
    threadId: value.thread_id ? String(value.thread_id) : undefined,
    version: String(value.version),
    contentHash: String(value.content_hash),
    parserVersion: String(value.parser_version),
    observedAt: String(value.observed_at),
    receivedAt: value.received_at ? String(value.received_at) : undefined,
    status: String(value.status) as SourceRecordStatus,
    text: value.text === null || value.text === undefined ? undefined : String(value.text),
    meta: parseMeta(value.meta_json),
    createdAt: String(value.created_at),
    updatedAt: String(value.updated_at),
  };
}

function parseMeta(raw: unknown): SourceRecordRow["meta"] {
  if (raw === null || raw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(String(raw));
    return typeof parsed === "object" && parsed !== null ? (parsed as SourceRecordRow["meta"]) : undefined;
  } catch {
    return undefined;
  }
}

function toEvent(value: SqlRow): SourceEvent {
  return {
    seq: Number(value.seq),
    kind: String(value.kind) as SourceEventKind,
    accountId: String(value.account_id),
    businessId: String(value.business_id),
    sourceKey: String(value.source_key),
    version: value.version ? String(value.version) : undefined,
    emittedAt: String(value.emitted_at),
  };
}

function toScanState(value: SqlRow): ScanStateRow {
  let coverage: SourceCoverage;
  try {
    coverage = JSON.parse(String(value.coverage_json)) as SourceCoverage;
  } catch {
    throw new Error(`source_scan_state row ${String(value.scope_fingerprint)} has undecodable coverage`);
  }
  return {
    accountId: String(value.account_id),
    scopeFingerprint: String(value.scope_fingerprint),
    cursor: value.cursor ? String(value.cursor) : undefined,
    windowDays: Number(value.window_days),
    coverage,
    updatedAt: String(value.updated_at),
  };
}
