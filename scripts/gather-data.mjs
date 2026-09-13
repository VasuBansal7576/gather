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
 * content without touching the source), verifies integrity and the Gather
 * marker, and publishes atomically to an exclusive new destination via a
 * same-directory hard link (link-then-unlink-own-stage: a concurrent file
 * can never be overwritten). Restore validates a snapshot, re-snapshots it
 * consistently through VACUUM INTO (so uncheckpointed WAL rows are
 * preserved, never silently dropped), and publishes the same atomic way to
 * an exclusive new destination only: it never deletes, replaces, or
 * live-patches the original or current database. Selecting the restored
 * file (GATHER_DATABASE_PATH) is an explicit owner step performed with the
 * launcher stopped. No row contents are ever printed.
 */
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  readSync,
  realpathSync,
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
  // Bounded-memory digest: fixed 1 MiB window, never the whole file at once.
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  try {
    const window = Buffer.alloc(1024 * 1024);
    for (;;) {
      const n = readSync(fd, window, 0, window.length, null);
      if (n === 0) break;
      hash.update(window.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
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

/**
 * Honest Gather marker on both paths: a real SQLite file is not enough —
 * the stable root table `businesses` must exist. This is a sanity marker,
 * not a version gate (see docs/DATA_RECOVERY.md for compatibility limits).
 */
function requireGatherMarker(db, what) {
  if (!tableNames(db).includes("businesses")) {
    abort(`${what} is a valid SQLite file but not a Gather database (no businesses table)`);
  }
}

/**
 * Consistent snapshot into an exclusively created staging file: reads the
 * source read-only (committed WAL content included), writes every table
 * with no enumeration or schema assumptions, and never locks the source
 * for writing. The staging file is created mode 0600 BEFORE any data
 * lands (VACUUM INTO fills the pre-created file in place).
 */
function vacuumIntoStage(srcPath, tmp, what) {
  const src = openReadOnly(srcPath, what);
  try {
    src.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  } finally {
    src.close();
  }
}

/**
 * Remove a staging file ONLY when this run created it exclusively.
 * Pre-existing files (including another process's stage) are never
 * removed: callers pass staged=true solely after their own `wx` open.
 */
function discardOwnedTemp(staged, path) {
  if (!staged) return;
  try {
    unlinkSync(path);
  } catch {
    // Already gone; nothing else may be removed.
  }
}

/**
 * Genuinely atomic, exclusive publication. The staging file lives in the
 * destination directory (same filesystem by construction) and is linked to
 * the final name: link(2) either creates the destination atomically or
 * fails with EEXIST when another process won the race — it can never
 * silently overwrite. Only our own staging name is unlinked afterwards.
 */
function publishStage(tmp, absDest, what) {
  try {
    linkSync(tmp, absDest);
  } catch (error) {
    if (error.code === "EEXIST") abort(`${what} already exists (refusing to overwrite): ${absDest}`);
    abort(`cannot publish ${what} ${absDest}: ${error.message}`);
  }
  try {
    unlinkSync(tmp);
  } catch {
    // Destination holds the data; a leftover staging name is reported by
    // leaving it in place rather than touching anything else.
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
  const staged = true;
  try {
    // Marker first on the live source: refuse non-Gather databases before
    // doing any staging work.
    const probe = openReadOnly(absSrc, "backup source");
    try {
      integrityOk(probe, "backup source");
      requireGatherMarker(probe, "backup source");
    } finally {
      probe.close();
    }
    vacuumIntoStage(absSrc, tmp, "backup source");
    const check = openReadOnly(tmp, "backup staging copy");
    let tablesLine;
    try {
      integrityOk(check, "backup staging copy");
      requireGatherMarker(check, "backup staging copy");
      const tables = tableNames(check);
      tablesLine = `tables=${tables.length} ${tables.map((t) => `${t}=${tableCount(check, t)}`).join(" ")}`;
      chmodSync(tmp, RESTRICTED_MODE);
    } finally {
      check.close();
    }
    publishStage(tmp, absDest, "backup destination");
    process.stdout.write(`backup ok dest=${absDest} sha256=${sha256File(absDest)} ${tablesLine}\n`);
  } catch (error) {
    discardOwnedTemp(staged, tmp);
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
  const stage = openSync(tmp, "wx", RESTRICTED_MODE);
  closeSync(stage);
  const staged = true;
  try {
    // Validate before snapshotting: real SQLite, integrity ok, Gather marker.
    // The marker is the stable root table `businesses`, not a version gate:
    // see docs/DATA_RECOVERY.md for compatibility limits.
    const probe = openReadOnly(absSnap, "restore snapshot");
    try {
      integrityOk(probe, "restore snapshot");
      requireGatherMarker(probe, "restore snapshot");
    } finally {
      probe.close();
    }
    // Consistent snapshot for restore too: VACUUM INTO reads committed
    // contents including WAL sidecars, so a snapshot with uncheckpointed
    // WAL can never silently restore older main-file-only content.
    vacuumIntoStage(absSnap, tmp, "restore snapshot");
    chmodSync(tmp, RESTRICTED_MODE);
    const check = openReadOnly(tmp, "restore staging copy");
    try {
      integrityOk(check, "restore staging copy");
      requireGatherMarker(check, "restore staging copy");
    } finally {
      check.close();
    }
    publishStage(tmp, absDest, "restore destination");
    process.stdout.write(`restore ok dest=${absDest} sha256=${sha256File(absDest)}\n`);
  } catch (error) {
    discardOwnedTemp(staged, tmp);
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
