import { DatabaseSync } from "node:sqlite";
import { lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Installation singleton lease (ADR-001 / C01, shared minimal API for
 * ADR-002/009). One row in <install-root>/.runtime/installation.sqlite marks
 * which process currently runs the installation and in which mode.
 *
 * Rules: a live foreign PID is never auto-cleared — acquisition refuses and
 * reports the holder. A dead holder is fenced: the takeover is recorded in
 * lease_events with evidence (dead PID, prior heartbeat) instead of silently
 * cleared. Release requires the caller's token so a process can never drop
 * another's lease.
 */

export interface LeaseHolder {
  pid: number;
  token: string;
  mode: string;
  acquiredAt: string;
  heartbeatAt: string;
}

export interface LeaseStatus {
  held: boolean;
  holder?: LeaseHolder;
  /** True when the holder PID is still alive on this machine. */
  alive: boolean;
}

export type LeaseAcquire =
  | { acquired: true; token: string; fencedDeadPid?: number }
  | { acquired: false; holder: LeaseHolder };

const DB_FILE = "installation.sqlite";

function openDb(runtimeDir: string): DatabaseSync {
  try {
    if (lstatSync(runtimeDir).isSymbolicLink()) {
      throw new Error(`refusing symlinked runtime directory: ${runtimeDir}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  mkdirSync(runtimeDir, { recursive: true });
  const db = new DatabaseSync(join(runtimeDir, DB_FILE));
  db.exec(`
    CREATE TABLE IF NOT EXISTS installation_lease (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      pid INTEGER NOT NULL,
      token TEXT NOT NULL,
      mode TEXT NOT NULL,
      acquired_at TEXT NOT NULL,
      heartbeat_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS lease_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      event TEXT NOT NULL,
      pid INTEGER,
      detail TEXT
    );
  `);
  return db;
}

function recordEvent(db: DatabaseSync, event: string, pid: number | null, detail: string): void {
  db.prepare("INSERT INTO lease_events (at, event, pid, detail) VALUES (?, ?, ?, ?)").run(
    new Date().toISOString(),
    event,
    pid,
    detail,
  );
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readHolder(db: DatabaseSync): LeaseHolder | undefined {
  const row = db.prepare("SELECT * FROM installation_lease WHERE id = 1").get() as
    | Record<string, unknown>
    | undefined;
  if (!row) return undefined;
  return {
    pid: Number(row.pid),
    token: String(row.token),
    mode: String(row.mode),
    acquiredAt: String(row.acquired_at),
    heartbeatAt: String(row.heartbeat_at),
  };
}

/**
 * Attempt to take the installation lease. A live holder is reported and the
 * lease is left alone; a dead holder is fenced (logged) and replaced. Returns
 * the caller's token on success.
 */
export function acquireInstallLease(runtimeDir: string, mode: string, token: string): LeaseAcquire {
  const db = openDb(runtimeDir);
  try {
    const now = new Date().toISOString();
    const holder = readHolder(db);
    if (holder) {
      if (pidAlive(holder.pid)) {
        return { acquired: false, holder };
      }
      recordEvent(
        db,
        "fenced-dead-pid",
        holder.pid,
        `dead holder fenced (mode=${holder.mode}, acquired=${holder.acquiredAt}, heartbeat=${holder.heartbeatAt})`,
      );
      db.prepare("DELETE FROM installation_lease WHERE id = 1 AND token = ?").run(holder.token);
      const deadPid = holder.pid;
      db.prepare("INSERT INTO installation_lease (id, pid, token, mode, acquired_at, heartbeat_at) VALUES (1, ?, ?, ?, ?, ?)").run(
        process.pid,
        token,
        mode,
        now,
        now,
      );
      recordEvent(db, "acquired", process.pid, `mode=${mode}`);
      return { acquired: true, token, fencedDeadPid: deadPid };
    }
    db.prepare("INSERT INTO installation_lease (id, pid, token, mode, acquired_at, heartbeat_at) VALUES (1, ?, ?, ?, ?, ?)").run(
      process.pid,
      token,
      mode,
      now,
      now,
    );
    recordEvent(db, "acquired", process.pid, `mode=${mode}`);
    return { acquired: true, token };
  } finally {
    db.close();
  }
}

/** Release the lease; only the token holder can drop it. */
export function releaseInstallLease(runtimeDir: string, token: string): boolean {
  const db = openDb(runtimeDir);
  try {
    const result = db.prepare("DELETE FROM installation_lease WHERE id = 1 AND token = ?").run(token);
    const released = Number(result.changes) === 1;
    if (released) recordEvent(db, "released", process.pid, "clean release");
    return released;
  } finally {
    db.close();
  }
}

/** Heartbeat: only the holder's token may renew; returns false otherwise. */
export function heartbeatInstallLease(runtimeDir: string, token: string): boolean {
  const db = openDb(runtimeDir);
  try {
    const result = db
      .prepare("UPDATE installation_lease SET heartbeat_at = ? WHERE id = 1 AND token = ?")
      .run(new Date().toISOString(), token);
    return Number(result.changes) === 1;
  } finally {
    db.close();
  }
}

/**
 * Fence a dead holder without taking the lease — used by reset/import paths
 * that must not run the app but need the dead holder recorded as evidence.
 * Returns the fenced PID, or undefined when nothing dead was held.
 */
export function fenceDeadInstallLease(runtimeDir: string): number | undefined {
  const db = openDb(runtimeDir);
  try {
    const holder = readHolder(db);
    if (!holder || pidAlive(holder.pid)) return undefined;
    recordEvent(
      db,
      "fenced-dead-pid",
      holder.pid,
      `dead holder fenced (mode=${holder.mode}, acquired=${holder.acquiredAt}, heartbeat=${holder.heartbeatAt})`,
    );
    db.prepare("DELETE FROM installation_lease WHERE id = 1 AND token = ?").run(holder.token);
    return holder.pid;
  } finally {
    db.close();
  }
}

/** Current lease status; alive reflects the holder PID's liveness now. */
export function installLeaseStatus(runtimeDir: string): LeaseStatus {
  const db = openDb(runtimeDir);
  try {
    const holder = readHolder(db);
    if (!holder) return { held: false, alive: false };
    return { held: true, holder, alive: pidAlive(holder.pid) };
  } finally {
    db.close();
  }
}

/** Fencing/acquire/release history — evidence for later ADRs and debugging. */
export function leaseEvents(runtimeDir: string): Array<{ at: string; event: string; pid: number | null; detail: string }> {
  const db = openDb(runtimeDir);
  try {
    const rows = db.prepare("SELECT * FROM lease_events ORDER BY id").all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      at: String(row.at),
      event: String(row.event),
      pid: row.pid === null || row.pid === undefined ? null : Number(row.pid),
      detail: String(row.detail ?? ""),
    }));
  } finally {
    db.close();
  }
}
