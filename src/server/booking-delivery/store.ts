import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  AcceptanceRecord,
  ConfirmationPolicy,
  DepositReceipt,
  OperationalHandoff,
  OwnerWaiver,
  ReadinessDecision,
  ResourceCommitment,
} from "../../delivery/contracts.ts";
import { assertConditionConfig } from "../../delivery/contracts.ts";

/**
 * Delivery-side persistence for the guarded confirmation service.
 *
 * Owns its own tables on the SAME SQLite handle the shared GatherStore uses
 * (same file, same durability story) without editing shared store code.
 * Every persisted row carries its business scope and attributable source
 * references; trusted-resolver evidence is ingested here and read back
 * through the DeliveryVerifiers host boundary, never trusted from request
 * payloads.
 */

type SqlRow = Record<string, unknown>;

function row<T extends SqlRow>(value: unknown): T {
  if (!value || typeof value !== "object") throw new Error("Expected a SQLite row");
  return value as T;
}

function now(): string {
  return new Date().toISOString();
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  return JSON.parse(value) as T;
}

export type ConfirmCommandStatus = "in_progress" | "confirmed" | "blocked" | "failed";

export interface ConfirmCommand {
  confirmKey: string;
  bookingId: string;
  proposedActionId: string;
  proposalVersion: number;
  proposalFingerprint: string;
  requestHash: string;
  status: ConfirmCommandStatus;
  response?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type CommandReservation =
  | { kind: "owned"; command: ConfirmCommand }
  | { kind: "replay"; command: ConfirmCommand }
  | { kind: "conflict"; command: ConfirmCommand }
  | { kind: "in_progress"; command: ConfirmCommand };

export interface PersistedHandoff {
  proposedActionId: string;
  revision: number;
  bookingId: string;
  proposalVersion: number;
  proposalFingerprint: string;
  handoff: OperationalHandoff;
  createdAt: string;
}

export class DeliveryStore {
  readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS delivery_policies (
        business_id TEXT PRIMARY KEY,
        conditions_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS delivery_acceptance (
        id TEXT PRIMARY KEY,
        business_id TEXT NOT NULL,
        booking_id TEXT NOT NULL,
        proposal_version INTEGER NOT NULL,
        proposal_fingerprint TEXT NOT NULL,
        accepted_at TEXT NOT NULL,
        accepted_by TEXT,
        revoked INTEGER NOT NULL DEFAULT 0,
        source_refs_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_delivery_acceptance_scope ON delivery_acceptance(business_id, booking_id);
      CREATE TABLE IF NOT EXISTS delivery_deposit_receipts (
        id TEXT PRIMARY KEY,
        business_id TEXT NOT NULL,
        booking_id TEXT NOT NULL,
        receipt_id TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        currency TEXT NOT NULL,
        status TEXT NOT NULL,
        refunded_cents INTEGER,
        observed_at TEXT NOT NULL,
        source_refs_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_delivery_receipts_scope ON delivery_deposit_receipts(business_id, booking_id);
      CREATE TABLE IF NOT EXISTS delivery_resource_commitments (
        id TEXT PRIMARY KEY,
        business_id TEXT NOT NULL,
        booking_id TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        proposal_version INTEGER NOT NULL,
        proposal_fingerprint TEXT NOT NULL,
        status TEXT NOT NULL,
        start_at TEXT NOT NULL,
        end_at TEXT NOT NULL,
        responsible TEXT,
        observed_at TEXT NOT NULL,
        source_refs_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_delivery_resources_scope ON delivery_resource_commitments(business_id, booking_id);
      CREATE TABLE IF NOT EXISTS delivery_waivers (
        id TEXT PRIMARY KEY,
        business_id TEXT NOT NULL,
        booking_id TEXT NOT NULL,
        condition TEXT NOT NULL,
        proposal_version INTEGER NOT NULL,
        proposal_fingerprint TEXT NOT NULL,
        waived_by TEXT NOT NULL,
        waived_at TEXT NOT NULL,
        reason TEXT NOT NULL,
        source_refs_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS delivery_decisions (
        id TEXT PRIMARY KEY,
        booking_id TEXT NOT NULL,
        proposed_action_id TEXT NOT NULL,
        proposal_version INTEGER NOT NULL,
        proposal_fingerprint TEXT NOT NULL,
        ready INTEGER NOT NULL,
        live_ready INTEGER NOT NULL,
        provenance TEXT NOT NULL,
        decision_json TEXT NOT NULL,
        evaluated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_delivery_decisions_scope ON delivery_decisions(proposed_action_id, proposal_version);
      CREATE TABLE IF NOT EXISTS delivery_confirm_commands (
        confirm_key TEXT PRIMARY KEY,
        booking_id TEXT NOT NULL,
        proposed_action_id TEXT NOT NULL,
        proposal_version INTEGER NOT NULL,
        proposal_fingerprint TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('in_progress', 'confirmed', 'blocked', 'failed')),
        response_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS delivery_handoffs (
        proposed_action_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        booking_id TEXT NOT NULL,
        proposal_version INTEGER NOT NULL,
        proposal_fingerprint TEXT NOT NULL,
        handoff_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (proposed_action_id, revision)
      );
    `);
  }

  // ---------- Policy ----------

  savePolicy(policy: ConfirmationPolicy): void {
    if (!Array.isArray(policy.conditions) || policy.conditions.length === 0) {
      throw new Error("confirmation policy must carry a non-empty conditions array");
    }
    policy.conditions.forEach(assertConditionConfig);
    this.db.prepare(`INSERT INTO delivery_policies (business_id, conditions_json, updated_at)
      VALUES ($businessId, $conditions, $timestamp)
      ON CONFLICT(business_id) DO UPDATE SET conditions_json = excluded.conditions_json, updated_at = excluded.updated_at`).run({
      $businessId: policy.businessId,
      $conditions: JSON.stringify(policy.conditions),
      $timestamp: now(),
    });
  }

  getPolicy(businessId: string): ConfirmationPolicy | undefined {
    const found = this.db.prepare("SELECT conditions_json FROM delivery_policies WHERE business_id = $businessId").get({ $businessId: businessId });
    if (!found) return undefined;
    return { businessId, conditions: parseJson(row(found).conditions_json, []) };
  }

  // ---------- Trusted evidence ingestion (attributable, scoped) ----------

  recordAcceptance(record: Omit<AcceptanceRecord, "resolver"> & { businessId: string }): AcceptanceRecord {
    this.db.prepare(`INSERT INTO delivery_acceptance
      (id, business_id, booking_id, proposal_version, proposal_fingerprint, accepted_at, accepted_by, revoked, source_refs_json)
      VALUES ($id, $businessId, $bookingId, $version, $fingerprint, $acceptedAt, $acceptedBy, $revoked, $refs)`).run({
      $id: randomUUID(), $businessId: record.businessId, $bookingId: record.bookingId,
      $version: record.proposalVersion, $fingerprint: record.proposalFingerprint,
      $acceptedAt: record.acceptedAt, $acceptedBy: record.acceptedBy ?? null,
      $revoked: record.revoked ? 1 : 0, $refs: JSON.stringify(record.sourceRefs),
    });
    return { resolver: "acceptance_record", ...record };
  }

  listAcceptance(businessId: string, bookingId: string): AcceptanceRecord[] {
    const rows = this.db.prepare("SELECT * FROM delivery_acceptance WHERE business_id = $b AND booking_id = $k ORDER BY accepted_at").all({ $b: businessId, $k: bookingId });
    return rows.map((item) => {
      const value = row(item);
      return {
        resolver: "acceptance_record" as const,
        bookingId: String(value.booking_id),
        proposalVersion: Number(value.proposal_version),
        proposalFingerprint: String(value.proposal_fingerprint),
        acceptedAt: String(value.accepted_at),
        acceptedBy: value.accepted_by ? String(value.accepted_by) : undefined,
        revoked: Number(value.revoked) === 1,
        sourceRefs: parseJson(value.source_refs_json, []),
      };
    });
  }

  recordDepositReceipt(receipt: Omit<DepositReceipt, "resolver"> & { businessId: string }): DepositReceipt {
    this.db.prepare(`INSERT INTO delivery_deposit_receipts
      (id, business_id, booking_id, receipt_id, amount_cents, currency, status, refunded_cents, observed_at, source_refs_json)
      VALUES ($id, $businessId, $bookingId, $receiptId, $amount, $currency, $status, $refunded, $observedAt, $refs)`).run({
      $id: randomUUID(), $businessId: receipt.businessId, $bookingId: receipt.bookingId,
      $receiptId: receipt.receiptId, $amount: receipt.amountCents, $currency: receipt.currency,
      $status: receipt.status, $refunded: receipt.refundedCents ?? null,
      $observedAt: receipt.observedAt, $refs: JSON.stringify(receipt.sourceRefs),
    });
    return { resolver: "deposit_ledger", ...receipt };
  }

  listDepositReceipts(businessId: string, bookingId: string): DepositReceipt[] {
    const rows = this.db.prepare("SELECT * FROM delivery_deposit_receipts WHERE business_id = $b AND booking_id = $k ORDER BY observed_at").all({ $b: businessId, $k: bookingId });
    return rows.map((item) => {
      const value = row(item);
      return {
        resolver: "deposit_ledger" as const,
        bookingId: String(value.booking_id),
        receiptId: String(value.receipt_id),
        amountCents: Number(value.amount_cents),
        currency: String(value.currency),
        status: value.status as DepositReceipt["status"],
        refundedCents: value.refunded_cents === null ? undefined : Number(value.refunded_cents),
        observedAt: String(value.observed_at),
        sourceRefs: parseJson(value.source_refs_json, []),
      };
    });
  }

  recordResourceCommitment(commit: Omit<ResourceCommitment, "resolver"> & { businessId: string }): ResourceCommitment {
    this.db.prepare(`INSERT INTO delivery_resource_commitments
      (id, business_id, booking_id, resource_id, proposal_version, proposal_fingerprint, status, start_at, end_at, responsible, observed_at, source_refs_json)
      VALUES ($id, $businessId, $bookingId, $resourceId, $version, $fingerprint, $status, $startAt, $endAt, $responsible, $observedAt, $refs)`).run({
      $id: randomUUID(), $businessId: commit.businessId, $bookingId: commit.bookingId,
      $resourceId: commit.resourceId, $version: commit.proposalVersion, $fingerprint: commit.proposalFingerprint,
      $status: commit.status, $startAt: commit.startAt, $endAt: commit.endAt,
      $responsible: commit.responsible ?? null, $observedAt: commit.observedAt,
      $refs: JSON.stringify(commit.sourceRefs),
    });
    return { resolver: "resource_registry", ...commit };
  }

  listResourceCommitments(businessId: string, bookingId: string, resourceIds: string[]): ResourceCommitment[] {
    if (resourceIds.length === 0) return [];
    const placeholders = resourceIds.map((_, index) => `$r${index}`).join(", ");
    const params: Record<string, string> = { $b: businessId, $k: bookingId };
    resourceIds.forEach((id, index) => {
      params[`$r${index}`] = id;
    });
    const rows = this.db.prepare(`SELECT * FROM delivery_resource_commitments
      WHERE business_id = $b AND booking_id = $k AND resource_id IN (${placeholders}) ORDER BY observed_at`).all(params);
    return rows.map((item) => {
      const value = row(item);
      return {
        resolver: "resource_registry" as const,
        bookingId: String(value.booking_id),
        resourceId: String(value.resource_id),
        proposalVersion: Number(value.proposal_version),
        proposalFingerprint: String(value.proposal_fingerprint),
        status: value.status as ResourceCommitment["status"],
        startAt: String(value.start_at),
        endAt: String(value.end_at),
        responsible: value.responsible ? String(value.responsible) : undefined,
        observedAt: String(value.observed_at),
        sourceRefs: parseJson(value.source_refs_json, []),
      };
    });
  }

  recordWaiver(waiver: Omit<OwnerWaiver, "resolver">): OwnerWaiver {
    this.db.prepare(`INSERT INTO delivery_waivers
      (id, business_id, booking_id, condition, proposal_version, proposal_fingerprint, waived_by, waived_at, reason, source_refs_json)
      VALUES ($id, $businessId, $bookingId, $condition, $version, $fingerprint, $waivedBy, $waivedAt, $reason, $refs)`).run({
      $id: randomUUID(), $businessId: waiver.businessId, $bookingId: waiver.bookingId,
      $condition: waiver.condition, $version: waiver.proposalVersion, $fingerprint: waiver.proposalFingerprint,
      $waivedBy: waiver.waivedBy, $waivedAt: waiver.waivedAt, $reason: waiver.reason,
      $refs: JSON.stringify(waiver.sourceRefs),
    });
    return { resolver: "owner_authority", ...waiver };
  }

  listWaivers(businessId: string, bookingId: string): OwnerWaiver[] {
    const rows = this.db.prepare("SELECT * FROM delivery_waivers WHERE business_id = $b AND booking_id = $k ORDER BY waived_at").all({ $b: businessId, $k: bookingId });
    return rows.map((item) => {
      const value = row(item);
      return {
        resolver: "owner_authority" as const,
        businessId: String(value.business_id),
        bookingId: String(value.booking_id),
        condition: value.condition as OwnerWaiver["condition"],
        proposalVersion: Number(value.proposal_version),
        proposalFingerprint: String(value.proposal_fingerprint),
        waivedBy: String(value.waived_by),
        waivedAt: String(value.waived_at),
        reason: String(value.reason),
        sourceRefs: parseJson(value.source_refs_json, []),
      };
    });
  }

  // ---------- Decisions ----------

  insertDecision(decision: ReadinessDecision, proposedActionId: string, decisionId?: string): string {
    const id = decisionId ?? randomUUID();
    this.db.prepare(`INSERT INTO delivery_decisions
      (id, booking_id, proposed_action_id, proposal_version, proposal_fingerprint, ready, live_ready, provenance, decision_json, evaluated_at)
      VALUES ($id, $bookingId, $actionId, $version, $fingerprint, $ready, $liveReady, $provenance, $json, $evaluatedAt)`).run({
      $id: id, $bookingId: decision.binding.bookingId, $actionId: proposedActionId,
      $version: decision.binding.proposalVersion, $fingerprint: decision.binding.proposalFingerprint,
      $ready: decision.ready ? 1 : 0, $liveReady: decision.liveReady ? 1 : 0,
      $provenance: decision.provenance, $json: JSON.stringify(decision),
      $evaluatedAt: decision.evaluatedAt,
    });
    return id;
  }

  getDecision(id: string): ReadinessDecision | undefined {
    const found = this.db.prepare("SELECT decision_json FROM delivery_decisions WHERE id = $id").get({ $id: id });
    return found ? parseJson<ReadinessDecision>(row(found).decision_json, undefined as unknown as ReadinessDecision) : undefined;
  }

  latestDecisionForAction(actionId: string, proposalVersion: number): ReadinessDecision | undefined {
    const found = this.db.prepare(`SELECT decision_json FROM delivery_decisions
      WHERE proposed_action_id = $actionId AND proposal_version = $version
      ORDER BY evaluated_at DESC LIMIT 1`).get({ $actionId: actionId, $version: proposalVersion });
    return found ? parseJson<ReadinessDecision>(row(found).decision_json, undefined as unknown as ReadinessDecision) : undefined;
  }

  // ---------- Confirm commands (idempotent, once-only) ----------

  /**
   * Reserve a confirm command by its caller-chosen key. A completed command
   * with the same request hash replays its persisted response canonically;
   * the same key bound to different inputs conflicts; a live in-progress
   * command reports concurrency instead of double-confirming. An
   * in-progress command whose lease expired is reclaimable (its owner
   * crashed or leaked).
   */
  reserveConfirmCommand(input: {
    confirmKey: string;
    bookingId: string;
    proposedActionId: string;
    proposalVersion: number;
    proposalFingerprint: string;
    requestHash: string;
    leaseMs: number;
    nowMs: number;
  }): CommandReservation {
    const existing = this.getConfirmCommand(input.confirmKey);
    if (existing) {
      if (existing.requestHash !== input.requestHash) return { kind: "conflict", command: existing };
      if (existing.status !== "in_progress") return { kind: "replay", command: existing };
      const leaseExpires = Date.parse(existing.updatedAt) + input.leaseMs;
      if (leaseExpires > input.nowMs) return { kind: "in_progress", command: existing };
      // Expired in-progress command: reclaim only if this caller's conditional
      // update actually landed. A competing reclaimer that committed first
      // changes updated_at, so this update matches zero rows — that caller must
      // not report ownership; re-read and classify the winner's row instead.
      const reclaimed = this.db.prepare(`UPDATE delivery_confirm_commands SET updated_at = $timestamp
        WHERE confirm_key = $key AND status = 'in_progress' AND updated_at = $stale`).run({
        $timestamp: now(), $key: input.confirmKey, $stale: existing.updatedAt,
      });
      const current = this.getConfirmCommand(input.confirmKey);
      if (!current) throw new Error("Confirm command vanished during lease reclaim");
      if (reclaimed.changes === 0) {
        if (current.requestHash !== input.requestHash) return { kind: "conflict", command: current };
        return current.status === "in_progress" ? { kind: "in_progress", command: current } : { kind: "replay", command: current };
      }
      return { kind: "owned", command: current };
    }
    const timestamp = now();
    const inserted = this.db.prepare(`INSERT INTO delivery_confirm_commands
      (confirm_key, booking_id, proposed_action_id, proposal_version, proposal_fingerprint, request_hash, status, created_at, updated_at)
      VALUES ($key, $bookingId, $actionId, $version, $fingerprint, $hash, 'in_progress', $timestamp, $timestamp)
      ON CONFLICT(confirm_key) DO NOTHING`).run({
      $key: input.confirmKey, $bookingId: input.bookingId, $actionId: input.proposedActionId,
      $version: input.proposalVersion, $fingerprint: input.proposalFingerprint,
      $hash: input.requestHash, $timestamp: timestamp,
    });
    if (inserted.changes === 0) {
      const winner = this.getConfirmCommand(input.confirmKey);
      if (!winner) throw new Error("Confirm command raced but no winner row is visible");
      if (winner.requestHash !== input.requestHash) return { kind: "conflict", command: winner };
      return winner.status === "in_progress" ? { kind: "in_progress", command: winner } : { kind: "replay", command: winner };
    }
    return { kind: "owned", command: this.getConfirmCommand(input.confirmKey) as ConfirmCommand };
  }

  getConfirmCommand(confirmKey: string): ConfirmCommand | undefined {
    const found = this.db.prepare("SELECT * FROM delivery_confirm_commands WHERE confirm_key = $key").get({ $key: confirmKey });
    if (!found) return undefined;
    const value = row(found);
    return {
      confirmKey: String(value.confirm_key),
      bookingId: String(value.booking_id),
      proposedActionId: String(value.proposed_action_id),
      proposalVersion: Number(value.proposal_version),
      proposalFingerprint: String(value.proposal_fingerprint),
      requestHash: String(value.request_hash),
      status: value.status as ConfirmCommandStatus,
      response: parseJson<Record<string, unknown> | undefined>(value.response_json, undefined),
      createdAt: String(value.created_at),
      updatedAt: String(value.updated_at),
    };
  }

  /**
   * Finish a command inside the caller's transaction. The status transition
   * is conditional on the command still being in_progress — a lease-expired
   * reclaim or a replay winner can never be overwritten.
   */
  finishConfirmCommand(confirmKey: string, status: Exclude<ConfirmCommandStatus, "in_progress">, response: Record<string, unknown>): void {
    const updated = this.db.prepare(`UPDATE delivery_confirm_commands
      SET status = $status, response_json = $response, updated_at = $timestamp
      WHERE confirm_key = $key AND status = 'in_progress'`).run({
      $status: status, $response: JSON.stringify(response), $timestamp: now(), $key: confirmKey,
    });
    if (updated.changes === 0) {
      throw new Error("Confirm command is no longer owned by this caller; refusing to record its outcome");
    }
  }

  // ---------- Handoffs ----------

  insertHandoffRevision(proposedActionId: string, handoff: OperationalHandoff): PersistedHandoff {
    const revisionRow = this.db.prepare(`SELECT COALESCE(MAX(revision), 0) + 1 AS revision
      FROM delivery_handoffs WHERE proposed_action_id = $actionId`).get({ $actionId: proposedActionId });
    const revision = Number(row(revisionRow).revision);
    const timestamp = now();
    this.db.prepare(`INSERT INTO delivery_handoffs
      (proposed_action_id, revision, booking_id, proposal_version, proposal_fingerprint, handoff_json, created_at)
      VALUES ($actionId, $revision, $bookingId, $version, $fingerprint, $json, $timestamp)`).run({
      $actionId: proposedActionId, $revision: revision, $bookingId: handoff.binding.bookingId,
      $version: handoff.binding.proposalVersion, $fingerprint: handoff.binding.proposalFingerprint,
      $json: JSON.stringify(handoff), $timestamp: timestamp,
    });
    return {
      proposedActionId,
      revision,
      bookingId: handoff.binding.bookingId,
      proposalVersion: handoff.binding.proposalVersion,
      proposalFingerprint: handoff.binding.proposalFingerprint,
      handoff,
      createdAt: timestamp,
    };
  }

  latestHandoff(actionId: string): PersistedHandoff | undefined {
    const found = this.db.prepare(`SELECT * FROM delivery_handoffs
      WHERE proposed_action_id = $actionId ORDER BY revision DESC LIMIT 1`).get({ $actionId: actionId });
    if (!found) return undefined;
    const value = row(found);
    return {
      proposedActionId: String(value.proposed_action_id),
      revision: Number(value.revision),
      bookingId: String(value.booking_id),
      proposalVersion: Number(value.proposal_version),
      proposalFingerprint: String(value.proposal_fingerprint),
      handoff: parseJson(value.handoff_json, {} as OperationalHandoff),
      createdAt: String(value.created_at),
    };
  }

  // ---------- Transaction boundary ----------

  /**
   * Run `work` inside a single IMMEDIATE transaction. Commit only when the
   * work returns; any throw rolls the whole unit back — the booking status,
   * persisted decision, and command row move together or not at all.
   */
  transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Already rolled back.
      }
      throw error;
    }
  }
}
