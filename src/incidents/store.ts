import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  MAX_INCIDENT_ATTEMPTS,
  dedupeKeyFor,
  isCatalogActionId,
  type CatalogActionId,
  type Incident,
  type IncidentAttempt,
  type IncidentDiagnosis,
  type IncidentSource,
  type IncidentStatus,
  type IncidentSymptom,
} from "./types.ts";

type SqlRow = Record<string, unknown>;

function row(value: unknown): SqlRow {
  if (!value || typeof value !== "object") throw new Error("Expected a SQLite row");
  return value as SqlRow;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Additive incidents schema. Called from the central GatherStore
 * constructor (ADR-004 owns central store writes this wave) and from the
 * IncidentStore constructor, so both paths converge idempotently.
 */
export function ensureIncidentSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS incidents (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL CHECK (source IN ('intent_failure', 'health', 'deadletter', 'fault_injection')),
      dedupe_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('open', 'recovering', 'recovered', 'blocked')),
      symptom_json TEXT NOT NULL,
      diagnosis_json TEXT,
      blocked_reason TEXT,
      resumed_intent_id TEXT,
      remaining_impact TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS incident_attempts (
      id TEXT PRIMARY KEY,
      incident_id TEXT NOT NULL REFERENCES incidents(id),
      n INTEGER NOT NULL,
      action TEXT NOT NULL,
      precondition_ok INTEGER NOT NULL,
      verification_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (incident_id, n)
    );
    CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status);
  `);
}

export interface EmitIncidentInput {
  source: IncidentSource;
  symptom: IncidentSymptom;
  operation?: string;
}

/**
 * Durable incident store over the shared database. Owns exactly the two
 * incident tables above — every other table belongs to its own ADR.
 */
export class IncidentStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    ensureIncidentSchema(db);
  }

  /**
   * Emit or deduplicate: the same affected resource/operation + signature
   * reuses the open incident (C09 dedup). A recovered/blocked incident with
   * the same key stays settled — a genuinely new failure emits a new
   * incident with a suffixed key so history is never rewritten.
   */
  emit(input: EmitIncidentInput): { incident: Incident; duplicate: boolean } {
    const base = dedupeKeyFor(input.symptom.resource, input.operation ?? input.symptom.operation, input.symptom.signature);
    const open = this.db.prepare("SELECT id FROM incidents WHERE dedupe_key = $key AND status IN ('open', 'recovering')").get({ $key: base });
    if (open) {
      return { incident: this.get(String(row(open).id)), duplicate: true };
    }
    const settled = this.db.prepare("SELECT COUNT(*) AS n FROM incidents WHERE dedupe_key LIKE $prefix").get({ $prefix: `${base}%` });
    const count = Number(row(settled).n ?? 0);
    const key = count === 0 ? base : `${base}#${count + 1}`;
    const timestamp = nowIso();
    const id = `inc_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    this.db.prepare(
      `INSERT INTO incidents (id, source, dedupe_key, status, symptom_json, created_at, updated_at)
       VALUES ($id, $source, $key, 'open', $symptom, $at, $at)`,
    ).run({ $id: id, $source: input.source, $key: key, $symptom: JSON.stringify(input.symptom), $at: timestamp });
    return { incident: this.get(id), duplicate: false };
  }

  get(id: string): Incident {
    const found = this.db.prepare("SELECT * FROM incidents WHERE id = $id").get({ $id: id });
    if (!found) throw new Error(`Incident not found: ${id}`);
    return this.toIncident(row(found));
  }

  list(status?: IncidentStatus): Incident[] {
    const rows = status === undefined
      ? this.db.prepare("SELECT * FROM incidents ORDER BY created_at").all()
      : this.db.prepare("SELECT * FROM incidents WHERE status = $status ORDER BY created_at").all({ $status: status });
    return rows.map((value) => this.toIncident(row(value)));
  }

  setDiagnosis(id: string, diagnosis: IncidentDiagnosis): Incident {
    if (!isCatalogActionId(diagnosis.selectedAction)) {
      throw new Error(`Unknown catalog action: ${String((diagnosis as { selectedAction?: unknown }).selectedAction)}`);
    }
    this.db.prepare("UPDATE incidents SET diagnosis_json = $diagnosis, status = 'recovering', updated_at = $at WHERE id = $id").run({
      $diagnosis: JSON.stringify(diagnosis), $at: nowIso(), $id: id,
    });
    return this.get(id);
  }

  /** Record one bounded attempt; the 3-attempt cap is enforced here. */
  recordAttempt(id: string, input: { action: CatalogActionId; preconditionOk: boolean; verification: IncidentAttempt["verification"] }): Incident {
    const incident = this.get(id);
    if (incident.attempts.length >= MAX_INCIDENT_ATTEMPTS) {
      throw new Error(`Incident ${id} exhausted its ${MAX_INCIDENT_ATTEMPTS} bounded attempts; mark it blocked instead`);
    }
    const timestamp = nowIso();
    this.db.prepare(
      `INSERT INTO incident_attempts (id, incident_id, n, action, precondition_ok, verification_json, created_at)
       VALUES ($id, $incident, $n, $action, $pre, $verification, $at)`,
    ).run({
      $id: `att_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
      $incident: id, $n: incident.attempts.length + 1, $action: input.action,
      $pre: input.preconditionOk ? 1 : 0, $verification: JSON.stringify(input.verification), $at: timestamp,
    });
    const ok = input.preconditionOk && input.verification.ok;
    this.db.prepare("UPDATE incidents SET status = $status, updated_at = $at WHERE id = $id").run({
      $status: ok ? "recovered" : "recovering", $at: timestamp, $id: id,
    });
    return this.get(id);
  }

  markBlocked(id: string, reason: string, remainingImpact?: string): Incident {
    const timestamp = nowIso();
    this.db.prepare("UPDATE incidents SET status = 'blocked', blocked_reason = $reason, remaining_impact = $impact, updated_at = $at WHERE id = $id").run({
      $reason: reason, $impact: remainingImpact ?? null, $at: timestamp, $id: id,
    });
    return this.get(id);
  }

  markResumed(id: string, intentId: string): Incident {
    this.db.prepare("UPDATE incidents SET resumed_intent_id = $intent, updated_at = $at WHERE id = $id").run({
      $intent: intentId, $at: nowIso(), $id: id,
    });
    return this.get(id);
  }

  private toIncident(value: SqlRow): Incident {
    const attempts = this.db.prepare("SELECT * FROM incident_attempts WHERE incident_id = $id ORDER BY n").all({ $id: String(value.id) });
    return {
      id: String(value.id),
      source: value.source as Incident["source"],
      symptom: JSON.parse(String(value.symptom_json)) as IncidentSymptom,
      dedupeKey: String(value.dedupe_key),
      status: value.status as IncidentStatus,
      diagnosis: value.diagnosis_json ? (JSON.parse(String(value.diagnosis_json)) as IncidentDiagnosis) : undefined,
      attempts: attempts.map((entry) => {
        const item = row(entry);
        return {
          id: String(item.id),
          incidentId: String(item.incident_id),
          n: Number(item.n),
          action: String(item.action) as CatalogActionId,
          preconditionOk: Number(item.precondition_ok) === 1,
          verification: JSON.parse(String(item.verification_json)) as IncidentAttempt["verification"],
          createdAt: String(item.created_at),
        };
      }),
      blockedReason: value.blocked_reason ? String(value.blocked_reason) : undefined,
      resumedIntentId: value.resumed_intent_id ? String(value.resumed_intent_id) : undefined,
      remainingImpact: value.remaining_impact ? String(value.remaining_impact) : undefined,
      createdAt: String(value.created_at),
      updatedAt: String(value.updated_at),
    };
  }
}
