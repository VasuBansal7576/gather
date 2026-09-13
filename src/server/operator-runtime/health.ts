import type { OperatorHealth, OperatorRuntimeDeps } from "./types.ts";
import { OperatorIntakeStore } from "./store.ts";

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
  const waitingByStatus: Record<string, number> = {};
  try {
    const rows = db.prepare("SELECT status, COUNT(*) AS n FROM coord_waiting GROUP BY status").all() as Array<Record<string, unknown>>;
    for (const item of rows) {
      waitingByStatus[String(item.status)] = Number(item.n);
    }
  } catch {
    // Ledger tables absent (standalone stages): report empty, not failure.
  }
  let pausedBookings: string[] = [];
  try {
    const rows = db.prepare("SELECT booking_id FROM coord_control WHERE state = 'paused'").all() as Array<Record<string, unknown>>;
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
  return {
    simulation,
    generatedAt: nowIso(deps),
    accounts: [
      {
        accountId: deps.accountId,
        cursorCommitted: cursor !== undefined,
        lastSweepAt: latest?.updatedAt,
        lastError: failures[0]?.message,
        connectionStatus: connection?.status,
      },
    ],
    waitingByStatus,
    pausedBookings,
    failures: failures.map((failure) => ({ scope: failure.scope, message: failure.message, at: failure.at })),
    scheduler: { registered: false, status: "pending-registration" },
    lastSweep: undefined,
    lastDueWork: undefined,
  };
}
