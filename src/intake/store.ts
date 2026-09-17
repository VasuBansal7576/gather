import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { DomainGateDecision, DomainOutcome } from "./gate.ts";

type SqlRow = Record<string, unknown>;

function row(value: unknown): SqlRow {
  if (!value || typeof value !== "object") throw new Error("Expected a SQLite row");
  return value as SqlRow;
}

function nowIso(): string {
  return new Date().toISOString();
}

export interface DomainDecisionRecord {
  id: string;
  accountId: string;
  messageId: string;
  sourceTag: string;
  outcome: DomainOutcome;
  decision: DomainGateDecision;
  /** Classifier identity behind the decision ("none" when none ran). */
  classifier: string;
  simulated: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ComposedMessageRecord {
  id: string;
  businessId: string;
  accountId: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  receivedAt: string;
  sourceTag: string;
  contentHash: string;
  simulated: boolean;
  createdAt: string;
}

/**
 * Stable dedupe identity for a composed message: the same sender+subject+
 * body under the same composer account is the same composed mail, so a
 * replayed submit returns the durable row instead of minting a duplicate.
 * The source tag is carried on the row, keeping prepared-composer evidence
 * distinct from provider mail forever.
 */
export function composedContentHash(input: { from: string; subject: string; body: string }): string {
  const material = JSON.stringify({
    from: input.from.trim().toLowerCase(),
    subject: input.subject,
    body: input.body,
  });
  return createHash("sha256").update(material).digest("hex");
}

/**
 * ADR-003 durable records for the domain gate, on the SHARED Gather
 * database (no second store). Two tables, both created lazily:
 * - intake_domain_decisions: one row per (account, message) — the gate's
 *   recorded outcome, reasons and missing fields, replayable and
 *   owner-visible.
 * - intake_composed_messages: prepared-mode composer mail, deduped by
 *   (account, content hash). Fictional by construction — every row is
 *   labelled simulated and its own source tag.
 *
 * Every method owns its own statement; record() uses INSERT ... ON
 * CONFLICT upsert so concurrent sweeps and re-drives converge on one row
 * per message instead of growing duplicates.
 */
export class IntakeDomainStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS intake_domain_decisions (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        source_tag TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('eligible', 'unrelated', 'needs_review')),
        reasons_json TEXT NOT NULL,
        missing_json TEXT NOT NULL,
        extracted_json TEXT NOT NULL,
        classifier TEXT NOT NULL,
        simulated INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (account_id, message_id)
      );
      CREATE TABLE IF NOT EXISTS intake_composed_messages (
        id TEXT PRIMARY KEY,
        business_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        from_addr TEXT NOT NULL,
        to_addr TEXT NOT NULL,
        subject TEXT NOT NULL,
        body TEXT NOT NULL,
        received_at TEXT NOT NULL,
        source_tag TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        simulated INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        UNIQUE (account_id, content_hash)
      );
      CREATE INDEX IF NOT EXISTS idx_domain_decisions_account ON intake_domain_decisions(account_id, outcome);
    `);
  }

  /** Upsert the durable gate decision for one (account, message). */
  record(input: {
    accountId: string;
    messageId: string;
    sourceTag: string;
    decision: DomainGateDecision;
    classifier: string;
    simulated: boolean;
    at?: string;
  }): DomainDecisionRecord {
    const timestamp = input.at ?? nowIso();
    const existing = this.get(input.accountId, input.messageId);
    const id = existing?.id ?? `dd_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    this.db.prepare(
      `INSERT INTO intake_domain_decisions
        (id, account_id, message_id, source_tag, outcome, reasons_json, missing_json, extracted_json, classifier, simulated, created_at, updated_at)
       VALUES ($id, $account, $message, $tag, $outcome, $reasons, $missing, $extracted, $classifier, $sim, $at, $at)
       ON CONFLICT (account_id, message_id) DO UPDATE SET
        source_tag = excluded.source_tag, outcome = excluded.outcome,
        reasons_json = excluded.reasons_json, missing_json = excluded.missing_json,
        extracted_json = excluded.extracted_json, classifier = excluded.classifier,
        simulated = excluded.simulated, updated_at = excluded.updated_at`,
    ).run({
      $id: id,
      $account: input.accountId,
      $message: input.messageId,
      $tag: input.sourceTag,
      $outcome: input.decision.outcome,
      $reasons: JSON.stringify(input.decision.reasons),
      $missing: JSON.stringify(input.decision.missingFields),
      $extracted: JSON.stringify(input.decision.extracted),
      $classifier: input.classifier,
      $sim: input.simulated ? 1 : 0,
      $at: timestamp,
    });
    return this.get(input.accountId, input.messageId)!;
  }

  get(accountId: string, messageId: string): DomainDecisionRecord | undefined {
    const found = this.db.prepare(
      "SELECT * FROM intake_domain_decisions WHERE account_id = $account AND message_id = $message",
    ).get({ $account: accountId, $message: messageId });
    return found === undefined ? undefined : toDecision(row(found));
  }

  /** Decisions for one account, newest first, optionally filtered by outcome. */
  list(accountId: string, outcome?: DomainOutcome, limit = 100): DomainDecisionRecord[] {
    const rows = outcome === undefined
      ? this.db.prepare(
          "SELECT * FROM intake_domain_decisions WHERE account_id = $account ORDER BY updated_at DESC, message_id LIMIT $limit",
        ).all({ $account: accountId, $limit: limit })
      : this.db.prepare(
          "SELECT * FROM intake_domain_decisions WHERE account_id = $account AND outcome = $outcome ORDER BY updated_at DESC, message_id LIMIT $limit",
        ).all({ $account: accountId, $outcome: outcome, $limit: limit });
    return rows.map((value) => toDecision(row(value)));
  }

  counts(accountId: string): Record<DomainOutcome, number> {
    const rows = this.db.prepare(
      "SELECT outcome, COUNT(*) AS n FROM intake_domain_decisions WHERE account_id = $account GROUP BY outcome",
    ).all({ $account: accountId });
    const out: Record<DomainOutcome, number> = { eligible: 0, unrelated: 0, needs_review: 0 };
    for (const value of rows) {
      const item = row(value);
      out[String(item.outcome) as DomainOutcome] = Number(item.n);
    }
    return out;
  }

  /**
   * Persist one composed prepared-mode message. Source-tagged dedupe:
   * (account, content hash) is unique, so resubmitting identical mail
   * returns the existing row with duplicate:true instead of a second row.
   */
  recordComposed(input: {
    businessId: string;
    accountId: string;
    from: string;
    to: string;
    subject: string;
    body: string;
    receivedAt: string;
    sourceTag: string;
  }): { message: ComposedMessageRecord; duplicate: boolean } {
    const hash = composedContentHash(input);
    const existing = this.db.prepare(
      "SELECT * FROM intake_composed_messages WHERE account_id = $account AND content_hash = $hash",
    ).get({ $account: input.accountId, $hash: hash });
    if (existing !== undefined) {
      return { message: toComposed(row(existing)), duplicate: true };
    }
    const id = `cm_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const timestamp = nowIso();
    this.db.prepare(
      `INSERT INTO intake_composed_messages
        (id, business_id, account_id, from_addr, to_addr, subject, body, received_at, source_tag, content_hash, simulated, created_at)
       VALUES ($id, $business, $account, $from, $to, $subject, $body, $received, $tag, $hash, 1, $at)`,
    ).run({
      $id: id,
      $business: input.businessId,
      $account: input.accountId,
      $from: input.from,
      $to: input.to,
      $subject: input.subject,
      $body: input.body,
      $received: input.receivedAt,
      $tag: input.sourceTag,
      $hash: hash,
      $at: timestamp,
    });
    return { message: this.getComposed(id)!, duplicate: false };
  }

  getComposed(id: string): ComposedMessageRecord | undefined {
    const found = this.db.prepare("SELECT * FROM intake_composed_messages WHERE id = $id").get({ $id: id });
    return found === undefined ? undefined : toComposed(row(found));
  }
}

function toDecision(value: SqlRow): DomainDecisionRecord {
  const parsed = <T>(raw: unknown, fallback: T): T => {
    try {
      return JSON.parse(String(raw)) as T;
    } catch {
      return fallback;
    }
  };
  return {
    id: String(value.id),
    accountId: String(value.account_id),
    messageId: String(value.message_id),
    sourceTag: String(value.source_tag),
    outcome: String(value.outcome) as DomainOutcome,
    decision: {
      outcome: String(value.outcome) as DomainOutcome,
      reasons: parsed(value.reasons_json, [] as string[]),
      missingFields: parsed(value.missing_json, [] as string[]),
      extracted: parsed(value.extracted_json, { dateHints: [] } as DomainGateDecision["extracted"]),
    },
    classifier: String(value.classifier),
    simulated: Number(value.simulated) === 1,
    createdAt: String(value.created_at),
    updatedAt: String(value.updated_at),
  };
}

function toComposed(value: SqlRow): ComposedMessageRecord {
  return {
    id: String(value.id),
    businessId: String(value.business_id),
    accountId: String(value.account_id),
    from: String(value.from_addr),
    to: String(value.to_addr),
    subject: String(value.subject),
    body: String(value.body),
    receivedAt: String(value.received_at),
    sourceTag: String(value.source_tag),
    contentHash: String(value.content_hash),
    simulated: Number(value.simulated) === 1,
    createdAt: String(value.created_at),
  };
}
