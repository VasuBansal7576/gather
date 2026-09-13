#!/usr/bin/env node
/**
 * Gather local data backup / recovery (offline, built-in modules only).
 *
 *   node scripts/gather-data.mjs backup --db <path> --dest <new-path>
 *   node scripts/gather-data.mjs restore --snapshot <path> --dest <new-path>
 *
 * Source defaults to GATHER_DATABASE_PATH (else data/gather.sqlite, relative
 * to the repo root). Backup takes a consistent snapshot of a live database
 * with VACUUM INTO from a read-only connection (captures committed WAL
 * content without touching the source), verifies integrity, and publishes
 * atomically to an exclusive new destination. Restore validates a snapshot
 * and copies it to an exclusive new destination only: it never deletes,
 * replaces, or live-patches the original or current database. Selecting the
 * restored file (GATHER_DATABASE_PATH) is an explicit owner step performed
 * with the launcher stopped. No row contents are ever printed.
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const RESTRICTED_MODE = 0o600;

function fail(message) {
  process.stderr.write(`gather-data: error: ${message}\n`);
  process.exit(1);
}

/** Thrown for operational failures inside backup/restore so staging cleanup runs before exit. */
class DataError extends Error {}

function abort(message) {
  throw new DataError(message);
}

function usage() {
  return `Usage:
  node scripts/gather-data.mjs backup [--db <path>] --dest <new-path>
  node scripts/gather-data.mjs restore --snapshot <path> --dest <new-path>

Backup snapshots GATHER_DATABASE_PATH (or --db) to a new destination file.
Restore copies a validated snapshot to a new destination file; it never
touches the original or current database. Destinations must not exist.
`;
}

/** Refuse :memory: and blank paths. */
function requireFilePath(value, flag) {
  if (typeof value !== "string" || value.trim().length === 0) abort(`${flag} is required`);
  if (value.trim() === ":memory:") abort(`${flag} must be a filesystem path, not :memory:`);
  return value.trim();
}

/**
 * Canonicalize the destination: create missing parents, then resolve the
 * parent through the filesystem so platform indirections (e.g. macOS /tmp)
 * cannot hide the true location. The written and reported path is always
 * this canonical form, so a redirected write can never pass unnoticed.
 */
function canonicalDest(absTarget) {
  mkdirSync(dirname(absTarget), { recursive: true });
  let realParent;
  try {
    realParent = realpathSync(dirname(absTarget));
  } catch (error) {
    abort(`cannot resolve destination directory: ${error.message}`);
  }
  return join(realParent, basename(absTarget));
}

/** The target itself must be entirely absent (file, dir, or symlink all refuse). */
function requireAbsent(absTarget, what) {
  let st = null;
  try {
    st = lstatSync(absTarget);
  } catch (error) {
    if (error.code !== "ENOENT") abort(`cannot inspect ${what} ${absTarget}: ${error.message}`);
  }
  if (st !== null) {
    if (st.isSymbolicLink()) abort(`${what} is a symlink (refusing traversal): ${absTarget}`);
    abort(`${what} already exists (refusing to overwrite): ${absTarget}`);
  }
}

function requireSameFile(a, b, what) {
  if (a === b) abort(`${what} must differ: ${a}`);
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function openReadOnly(path, what) {
  try {
    return new DatabaseSync(path, { readOnly: true });
  } catch (error) {
    abort(`cannot open ${what} ${path}: ${error.message}`);
  }
}

function integrityOk(db, what) {
  let rows;
  try {
    rows = db.prepare("PRAGMA integrity_check").all();
  } catch (error) {
    abort(`${what} integrity check failed to run: ${error.message}`);
  }
  const ok = rows.length === 1 && rows[0].integrity_check === "ok";
  if (!ok) abort(`${what} failed integrity check (${rows.length} diagnostic row(s))`);
}

function tableNames(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => row.name);
}

function tableCount(db, table) {
  return db.prepare(`SELECT COUNT(*) AS n FROM "${table.replace(/"/g, '""')}"`).get().n;
}

/** Remove our own temp file; never anything else. Originals stay intact. */
function discardTemp(path) {
  try {
    unlinkSync(path);
  } catch {
    // Already gone or never created; nothing else may be removed.
  }
}

function doBackup(dbPath, destPath) {
  const absSrc = resolve(dbPath);
  let absDest = canonicalDest(resolve(destPath));
  // Canonical same-file check: catches identical paths through different
  // spellings, parent (..) segments, and symlinked components.
  try {
    if (realpathSync(absSrc) === absDest) abort(`backup source and destination are the same file: ${absSrc}`);
  } catch {
    // Source existence is checked below with a precise message.
  }
  requireSameFile(absSrc, absDest, "backup source and destination");
  if (!existsSync(absSrc)) abort(`backup source does not exist: ${absSrc}`);
  if (lstatSync(absSrc).isSymbolicLink()) abort(`refusing symlinked backup source: ${absSrc}`);
  requireAbsent(absDest, "backup destination");

  const tmp = `${absDest}.partial-${process.pid}`;
  requireAbsent(tmp, "backup staging file");
  const stage = openSync(tmp, "wx", RESTRICTED_MODE);
  closeSync(stage);
  try {
    // Read-only hot snapshot: consistent committed contents including WAL,
    // every table (no table enumeration, no schema assumptions), source
    // untouched and never locked for writing.
    const src = openReadOnly(absSrc, "backup source");
    try {
      src.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    } finally {
      src.close();
    }
    const check = openReadOnly(tmp, "backup staging copy");
    try {
      integrityOk(check, "backup staging copy");
      const tables = tableNames(check);
      const counts = tables.map((t) => `${t}=${tableCount(check, t)}`).join(" ");
      chmodSync(tmp, RESTRICTED_MODE);
      renameSync(tmp, absDest);
      process.stdout.write(`backup ok dest=${absDest} sha256=${sha256File(absDest)} tables=${tables.length} ${counts}\n`);
    } finally {
      check.close();
    }
  } catch (error) {
    discardTemp(tmp);
    if (error instanceof DataError) fail(`backup failed (source left intact): ${error.message}`);
    throw error;
  }
}

function doRestore(snapshotPath, destPath) {
  const absSnap = resolve(snapshotPath);
  const absDest = canonicalDest(resolve(destPath));
  try {
    if (realpathSync(absSnap) === absDest) abort(`restore snapshot and destination are the same file: ${absSnap}`);
  } catch {
    // Snapshot existence is checked below with a precise message.
  }
  requireSameFile(absSnap, absDest, "restore snapshot and destination");
  if (!existsSync(absSnap)) abort(`restore snapshot does not exist: ${absSnap}`);
  const snapStat = lstatSync(absSnap);
  if (!snapStat.isFile() || snapStat.isSymbolicLink()) {
    abort(`restore snapshot must be a regular file, not a symlink or special file: ${absSnap}`);
  }
  requireAbsent(absDest, "restore destination");

  const tmp = `${absDest}.partial-${process.pid}`;
  requireAbsent(tmp, "restore staging file");
  try {
    // Validate before copying: real SQLite, integrity ok, Gather marker.
    // The marker is the stable root table `businesses`, not a version gate:
    // see docs/DATA_RECOVERY.md for compatibility limits.
    const snap = openReadOnly(absSnap, "restore snapshot");
    try {
      integrityOk(snap, "restore snapshot");
      if (!tableNames(snap).includes("businesses")) {
        abort("restore snapshot is a valid SQLite file but not a Gather database (no businesses table)");
      }
    } finally {
      snap.close();
    }
    const stage = openSync(tmp, "wx", RESTRICTED_MODE);
    closeSync(stage);
    copyFileSync(absSnap, tmp);
    chmodSync(tmp, RESTRICTED_MODE);
    const check = openReadOnly(tmp, "restore staging copy");
    try {
      integrityOk(check, "restore staging copy");
      renameSync(tmp, absDest);
      process.stdout.write(`restore ok dest=${absDest} sha256=${sha256File(absDest)}\n`);
    } finally {
      check.close();
    }
  } catch (error) {
    discardTemp(tmp);
    if (error instanceof DataError) fail(`restore failed (originals left intact): ${error.message}`);
    throw error;
  }
}

function parseArgs(argv) {
  const out = { command: argv[0], db: undefined, dest: undefined, snapshot: undefined };
  for (let i = 1; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if ((flag === "--db" || flag === "--dest" || flag === "--snapshot") && value !== undefined) {
      out[flag.slice(2)] = value;
      i += 1;
    } else if (flag === "--help" || flag === "-h") {
      process.stdout.write(usage());
      process.exit(0);
    } else {
      fail(`unknown argument: ${flag}\n${usage()}`);
    }
  }
  return out;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
    run(args);
  } catch (error) {
    if (error instanceof DataError) fail(error.message);
    throw error;
  }
}

function run(args) {
  if (args.command === "backup") {
    const db = args.db ?? process.env.GATHER_DATABASE_PATH ?? "data/gather.sqlite";
    doBackup(requireFilePath(db, "--db"), requireFilePath(args.dest, "--dest"));
  } else if (args.command === "restore") {
    doRestore(requireFilePath(args.snapshot, "--snapshot"), requireFilePath(args.dest, "--dest"));
  } else {
    fail(`unknown command: ${args.command ?? "(none)"}\n${usage()}`);
  }
}

main();
