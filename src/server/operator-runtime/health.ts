import type { DatabaseSync } from "node:sqlite";
import type { OperatorHealth, OperatorRuntimeDeps } from "./types.ts";
import { OperatorIntakeStore } from "./store.ts";
import { getProactiveBinding } from "./automation.ts";

function nowIso(deps: OperatorRuntimeDeps): string {
  return deps.now ? deps.now() : new Date().toISOString();
}

/**
 * Monitoring health for the owner surface. Read-only: counts come from
 * plain SELECTs (no transactions opened here), paused bookings from the
 * ledger control table, failures from the durable intake failure log.
 */
export function operatorHealth(deps: OperatorRuntimeDeps): OperatorHealth {
  const intake = new OperatorIntakeStore(deps.store.db);
  const db = deps.store.db;
  // Waiting and paused aggregates are scoped to THIS business via the
  // bookings join (existing ledger inputs) — a per-account health response
  // must never leak foreign aggregates. Stages without the shared tables
  // report empty, not failure.
  const waitingByStatus: Record<string, number> = {};
  try {
    const rows = db.prepare(
      `SELECT w.status AS status, COUNT(*) AS n FROM coord_waiting w
       JOIN bookings b ON b.id = w.booking_id
       WHERE b.business_id = $biz GROUP BY w.status`,
    ).all({ $biz: deps.businessId }) as Array<Record<string, unknown>>;
    for (const item of rows) {
      waitingByStatus[String(item.status)] = Number(item.n);
    }
  } catch {
    // Ledger tables absent (standalone stages): report empty, not failure.
  }
  let pausedBookings: string[] = [];
  try {
    const rows = db.prepare(
      `SELECT c.booking_id AS booking_id FROM coord_control c
       JOIN bookings b ON b.id = c.booking_id
       WHERE c.state = 'paused' AND b.business_id = $biz`,
    ).all({ $biz: deps.businessId }) as Array<Record<string, unknown>>;
    pausedBookings = rows.map((item) => String(item.booking_id)).sort();
  } catch {
    pausedBookings = [];
  }
  const latest = intake.latestBatch(deps.accountId);
  const cursor = intake.getCursor(deps.accountId);
  const failures = intake.listFailures(deps.accountId, 10);
  const connection = deps.connections?.getConnection(deps.accountId);
  // Simulation derives from durable evidence (latest batch wiring), never a
  // caller flag; with no evidence yet, assume simulated rather than live.
  const simulation = intake.latestSimulation(deps.accountId);
  const base: OperatorHealth = {
    simulation,
    generatedAt: nowIso(deps),
    accounts: [
      {
        accountId: deps.accountId,
        cursorCommitted: cursor !== undefined,
        lastSweepAt: latest?.updatedAt,
        lastError: failures[0]?.message,
        connectionStatus: connection?.status,
        deadLettered: intake.listDeadLettered(deps.accountId, 100).length,
      },
    ],
    waitingByStatus,
    pausedBookings,
    failures: failures.map((failure) => ({ scope: failure.scope, message: failure.message, at: failure.at })),
    // Real scheduler state for THIS account's proactive binding — a
    // registered running/degraded binding must never report
    // "pending-registration", and an unwired one must never claim to run.
    scheduler: (() => {
      const binding = getProactiveBinding(deps.accountId);
      return binding
        ? { registered: true, status: binding.status }
        : { registered: false, status: "pending-registration" };
    })(),
    lastSweep: undefined,
    lastDueWork: undefined,
  };
  // ADR-004 owner-visible incident counts. Read-only; stages without the
  // incident tables report no summary rather than failing. Attached without
  // widening the shared OperatorHealth contract (no other ADR owns it).
  const summary = incidentSummary(deps.store.db);
  return summary ? Object.assign(base, { incidents: summary }) : base;
}

/** Open/recovering/recovered/blocked incident counts, or undefined when the schema is absent. */
export function incidentSummary(db: DatabaseSync): { open: number; recovering: number; recovered: number; blocked: number } | undefined {
  try {
    const rows = db.prepare("SELECT status AS status, COUNT(*) AS n FROM incidents GROUP BY status").all() as Array<Record<string, unknown>>;
    const summary = { open: 0, recovering: 0, recovered: 0, blocked: 0 };
    for (const item of rows) {
      const status = String(item.status);
      if (status in summary) summary[status as keyof typeof summary] = Number(item.n);
    }
    return summary;
  } catch {
    return undefined;
  }
}
