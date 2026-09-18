#!/usr/bin/env node
/**
 * gather — packaged local-first entry point (ADR-001 / C01).
 *
 *   gather [start] [--port N] [--no-open] [--mode prepared] [--dry-run]
 *   gather seed --scenario <id> [--yes]
 *   gather reset [--scenario <id>] --yes
 *   gather import --from <legacy-db-path>
 *   gather status [--json]
 *   gather doctor
 *   gather help
 *
 * Runs the staged app from <invocation-dir>/.runtime — never from npm's
 * package cache. All business state lives under .runtime/<mode>/; the packed
 * package directory is treated as read-only. Live mode is not offered by
 * this build.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  acquireInstallLease,
  fenceDeadInstallLease,
  installLeaseStatus,
  releaseInstallLease,
  heartbeatInstallLease,
} from "../src/setup/installation-lease.ts";

const MIN_NODE_MAJOR = 26;
const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** Files the staged build needs; the manifest must contain every one. */
const BUILD_INPUTS = [
  "package.json",
  "next.config.ts",
  "tsconfig.json",
  ".node-version",
  "app",
  "src",
  "scripts",
  "tests/fixtures/prepared",
];
const LOCKFILE_CANDIDATES = ["npm-shrinkwrap.json", "package-lock.json"];
const SCENARIO_IDS = ["glasshouse", "empty", "non-event", "partial", "connection-failed", "legacy"];

class CliError extends Error {}

function fail(message, code = 1) {
  process.stderr.write(`gather: error: ${message}\n`);
  process.exit(code);
}

function out(line) {
  process.stdout.write(`${line}\n`);
}

function usage() {
  return `Usage: gather <command> [options]

Commands:
  start (default)   Stage the packed app under .runtime/app/, then serve it
                    on a loopback port and open the setup page.
  seed              Seed a prepared scenario into .runtime/prepared/ while the
                    app is stopped. --scenario <id>, --yes to confirm.
  reset             Safely replace the prepared database set while the app is
                    stopped. --confirm-reset required; --scenario re-seeds
                    afterwards.
  import            Copy an existing legacy database into the prepared root
                    with integrity checks. --from <path>.
  status            Print install root, lock, mode and seeded-state details.
  doctor            Check the packaged-install prerequisites.
  help              Show this help.

Start options:
  --port N          Pin the loopback port (default: allocate a free one).
  --no-open         Print the URL instead of opening a browser.
  --mode prepared   Only "prepared" is supported by this build.
  --dry-run         Resolve root, validate inputs and port; do not start.
`;
}

/* ------------------------------ args -------------------------------- */

function parseArgs(argv) {
  const args = { command: "start", positional: [], flags: new Map() };
  const first = argv[0];
  if (first !== undefined && !first.startsWith("-")) {
    args.command = first;
    argv = argv.slice(1);
  }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!flag.startsWith("-")) {
      args.positional.push(flag);
      continue;
    }
    if (["--port", "--mode", "--scenario", "--from"].includes(flag)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) throw new CliError(`${flag} needs a value`);
      args.flags.set(flag, value);
      i += 1;
    } else if (["--no-open", "--dry-run", "--yes", "--confirm-reset", "--json", "--help", "-h"].includes(flag)) {
      args.flags.set(flag, true);
    } else {
      throw new CliError(`unknown option: ${flag}`);
    }
  }
  return args;
}

/* --------------------------- install root ---------------------------- */

/** The writable installation root is the invocation directory — never the package cache. */
function resolveInstallRoot(cwd) {
  const root = resolve(cwd);
  let stat;
  try {
    stat = lstatSync(root);
  } catch (error) {
    throw new CliError(`cannot inspect installation root ${root}: ${error.message}`);
  }
  if (!stat.isDirectory()) throw new CliError(`installation root is not a directory: ${root}`);
  const runtimeDir = join(root, ".runtime");
  if (existsSync(runtimeDir) && lstatSync(runtimeDir).isSymbolicLink()) {
    throw new CliError(`refusing symlinked state directory: ${runtimeDir}`);
  }
  mkdirSync(runtimeDir, { recursive: true });
  try {
    accessSync(runtimeDir, constants.W_OK);
  } catch {
    throw new CliError(`.runtime is not writable under ${root}`);
  }
  return root;
}

/** A path inside the package directory must be a real file/dir, never a symlink trick. */
function requireRealPackagePath(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new CliError(`package input is a symlink (refusing): ${path}`);
  return stat;
}

function readManifest(pkgDir) {
  const manifestPath = join(pkgDir, "package.json");
  try {
    requireRealPackagePath(manifestPath);
    return JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new CliError(`cannot read the Gather package manifest at ${manifestPath}: ${error.message}`);
  }
}

/** The manifest must contain every build input before anything is staged. */
function validateBuildInputs(pkgDir) {
  const missing = BUILD_INPUTS.filter((input) => {
    try {
      requireRealPackagePath(join(pkgDir, input));
      return false;
    } catch {
      return true;
    }
  });
  const lockfile = LOCKFILE_CANDIDATES.find((name) => {
    try {
      return requireRealPackagePath(join(pkgDir, name)).isFile();
    } catch {
      return false;
    }
  });
  if (missing.length > 0) {
    throw new CliError(`the Gather package is missing build inputs: ${missing.join(", ")}`);
  }
  if (!lockfile) {
    throw new CliError(`the Gather package has no dependency lockfile (${LOCKFILE_CANDIDATES.join(" or ")}); cannot stage a reproducible build`);
  }
  return { lockfile };
}

/* ------------------------------ locking ------------------------------ */

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

class LockHeld extends CliError {
  constructor(path, pid) {
    super(`another Gather process holds ${path} (pid ${pid})`);
    this.path = path;
    this.pid = pid;
  }
}

/** Exclusive create; a dead owner's stale lock is reclaimed exactly once. */
function acquireLock(lockPath, meta) {
  const body = `${JSON.stringify({ ...meta, pid: process.pid, createdAt: new Date().toISOString() })}\n`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      writeFileSync(fd, body);
      closeSync(fd);
      return {
        path: lockPath,
        release() {
          try {
            const current = JSON.parse(readFileSync(lockPath, "utf8"));
            if (current.pid === process.pid) unlinkSync(lockPath);
          } catch {
            // Already gone or replaced; nothing owned to remove.
          }
        },
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw new CliError(`cannot take lock ${lockPath}: ${error.message}`);
      let holder;
      try {
        holder = JSON.parse(readFileSync(lockPath, "utf8"));
      } catch {
        holder = undefined;
      }
      if (holder && typeof holder.pid === "number" && pidAlive(holder.pid)) {
        throw new LockHeld(lockPath, holder.pid);
      }
      // Stale or unreadable lock: reclaim it once.
      try {
        unlinkSync(lockPath);
      } catch (unlinkError) {
        throw new CliError(`cannot reclaim stale lock ${lockPath}: ${unlinkError.message}`);
      }
    }
  }
  throw new CliError(`could not take lock ${lockPath}: a concurrent run won the race`);
}

function lockStatus(lockPath) {
  try {
    const holder = JSON.parse(readFileSync(lockPath, "utf8"));
    return { held: true, alive: typeof holder.pid === "number" && pidAlive(holder.pid), pid: holder.pid, meta: holder };
  } catch {
    return { held: false, alive: false };
  }
}

/* ------------------------------ ports -------------------------------- */

function probePort(port) {
  return new Promise((resolveProbe, rejectProbe) => {
    const server = createServer();
    server.once("error", (error) => rejectProbe(error));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      const actual = server.address().port;
      server.close(() => resolveProbe(actual));
    });
  });
}

async function allocatePort(requested) {
  if (requested !== undefined) {
    if (!Number.isInteger(requested) || requested < 1 || requested > 65535) {
      throw new CliError(`--port must be an integer between 1 and 65535 (got ${requested})`);
    }
    try {
      await probePort(requested);
    } catch {
      throw new CliError(`port ${requested} is not free on 127.0.0.1 — pick another with --port or let Gather allocate one`);
    }
    return requested;
  }
  return probePort(0);
}

/* ------------------------------ staging ------------------------------ */

/**
 * Content-addressed stage revision: the lockfile plus every build input's
 * relpath+contents, so a source change produces a fresh staged build and an
 * identical tree reuses the existing one.
 */
function stageRevision(pkgDir, manifest, lockfile) {
  const hash = createHash("sha256");
  hash.update(readFileSync(join(pkgDir, "package.json")));
  hash.update(readFileSync(join(pkgDir, lockfile)));
  const feed = (inputPath) => {
    const stat = lstatSync(inputPath);
    if (stat.isDirectory()) {
      for (const name of readdirSync(inputPath).sort()) feed(join(inputPath, name));
      return;
    }
    hash.update(inputPath.slice(pkgDir.length));
    hash.update(readFileSync(inputPath));
  };
  for (const input of BUILD_INPUTS) feed(join(pkgDir, input));
  return `${manifest.name ?? "gather"}@${manifest.version ?? "0.0.0"}-${hash.digest("hex").slice(0, 12)}`;
}

/**
 * Stage the packaged app under .runtime/app/<revision>/: copy the build
 * inputs, install dependencies with an isolated npm cache, build once, and
 * mark the result with .built. The package directory itself is never
 * modified.
 */
async function stageApp(root, pkgDir, manifest, lockfile, emit) {
  const revision = stageRevision(pkgDir, manifest, lockfile);
  const appRoot = join(root, ".runtime", "app");
  const stagedDir = join(appRoot, revision);
  const marker = join(stagedDir, ".built");
  mkdirSync(appRoot, { recursive: true });

  if (existsSync(marker)) {
    emit(`Staged app is already built: ${stagedDir}`);
    return { stagedDir, revision, built: false };
  }
  if (existsSync(stagedDir)) {
    // A previous staging attempt left an incomplete tree; move it aside so
    // this run builds a clean one. It is our own artifact, never user data.
    renameSync(stagedDir, `${stagedDir}.stale-${Date.now()}`);
  }
  const staging = `${stagedDir}.staging-${process.pid}`;
  try {
    lstatSync(staging);
    throw new CliError(`staging directory already exists: ${staging}`);
  } catch (error) {
    if (error instanceof CliError) throw error;
  }
  mkdirSync(staging, { recursive: true });
  try {
    for (const input of [...BUILD_INPUTS, lockfile]) {
      const source = join(pkgDir, input);
      cpSync(source, join(staging, input), { recursive: true, dereference: false });
    }
    const npmCache = join(root, ".runtime", "npm-cache");
    mkdirSync(npmCache, { recursive: true });
    emit(`Installing dependencies into ${staging} (isolated npm cache: ${npmCache})…`);
    await run("npm", ["ci", "--cache", npmCache, "--no-audit", "--no-fund", "--loglevel=error"], {
      cwd: staging,
      env: childEnv({ NEXT_TELEMETRY_DISABLED: "1" }),
    });
    emit("Building the staged app…");
    await run("npm", ["run", "build"], {
      cwd: staging,
      env: childEnv({ NEXT_TELEMETRY_DISABLED: "1" }),
    });
    writeFileSync(join(staging, ".built"), `${JSON.stringify({ revision, builtAt: new Date().toISOString(), node: process.version })}\n`, { mode: 0o600 });
    renameSync(staging, stagedDir);
    return { stagedDir, revision, built: true };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function childEnv(extra) {
  // Minimal environment for child processes: nothing provider- or
  // credential-shaped is inherited.
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    TMPDIR: process.env.TMPDIR ?? "",
    LANG: process.env.LANG ?? "en_US.UTF-8",
    ...extra,
  };
  return env;
}

function run(command, args, options) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", (error) => rejectRun(new CliError(`could not run ${command}: ${error.message}`)));
    child.once("close", (code) => {
      if (code === 0) resolveRun();
      else rejectRun(new CliError(`${command} ${args.join(" ")} exited with code ${code}`));
    });
  });
}

/* ------------------------------ server ------------------------------- */

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not attempted";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.status < 500) return true;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 400));
  }
  throw new CliError(`the app did not answer at ${url} within ${Math.round(timeoutMs / 1000)}s (${lastError})`);
}

function openBrowser(url) {
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  try {
    const child = spawn(opener, [url], { stdio: "ignore", detached: true });
    child.unref();
    child.once("error", () => out(`Open this URL yourself: ${url}`));
    return true;
  } catch {
    return false;
  }
}

/* --------------------------- fixture seeding -------------------------- */

function preparedDbPath(root) {
  return join(root, ".runtime", "prepared", "gather.sqlite");
}

/**
 * Seed/inspect a prepared database through the app's own modules. Runs a
 * short child Node process (type-stripped TS import) with only the minimal
 * environment plus Gather-owned variables — never inherited credentials.
 */
function runStoreProgram(root, pkgDir, program, extraEnv = {}) {
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", program],
    {
      cwd: pkgDir,
      env: childEnv({ GATHER_DATABASE_PATH: preparedDbPath(root), ...extraEnv }),
      encoding: "utf8",
      timeout: 60_000,
    },
  );
  if (result.error) throw new CliError(`fixture program failed to run: ${result.error.message}`);
  if (result.status !== 0) {
    throw new CliError(`fixture program failed: ${(result.stderr ?? "").trim() || `exit ${result.status}`}`);
  }
  return result.stdout.trim();
}

const SEED_PROGRAM = `
const { GatherStore } = await import("./src/server/sqlite-store.ts");
const fixtures = await import("./src/server/demo-fixtures.ts");
const scenario = process.env.GATHER_FIXTURE_SCENARIO;
const store = new GatherStore(process.env.GATHER_DATABASE_PATH);
try {
  const summary = fixtures.seedPreparedFixtures(store, scenario);
  console.log(JSON.stringify(summary));
} finally {
  store.close();
}
`;

const STATE_PROGRAM = `
const { GatherStore } = await import("./src/server/sqlite-store.ts");
const fixtures = await import("./src/server/demo-fixtures.ts");
const store = new GatherStore(process.env.GATHER_DATABASE_PATH);
try {
  const state = fixtures.readPreparedState(store) ?? null;
  const inbox = fixtures.listPreparedInbox(store).map((m) => ({ id: m.id, kind: m.kind, subject: m.subject }));
  const businesses = store.listBusinesses().map((b) => ({ id: b.id, name: b.name }));
  const proposals = store.listAllProposedActions().length;
  console.log(JSON.stringify({ state, inbox, businesses, proposals }));
} finally {
  store.close();
}
`;

function seedPrepared(root, pkgDir, scenario) {
  const raw = runStoreProgram(root, pkgDir, SEED_PROGRAM, { GATHER_FIXTURE_SCENARIO: scenario });
  try {
    return JSON.parse(raw.split("\n").pop());
  } catch {
    throw new CliError("seed produced no readable summary");
  }
}

function readPreparedSummary(root, pkgDir) {
  if (!existsSync(preparedDbPath(root))) return null;
  const raw = runStoreProgram(root, pkgDir, STATE_PROGRAM);
  try {
    return JSON.parse(raw.split("\n").pop());
  } catch {
    return null;
  }
}

/* ------------------------------ reset --------------------------------- */

const DB_SET = ["gather.sqlite", "gather.sqlite-wal", "gather.sqlite-shm"];

function assertNoSymlinkEscape(root, modeDir) {
  const runtimeDir = join(root, ".runtime");
  for (const candidate of [runtimeDir, modeDir]) {
    if (!existsSync(candidate)) continue;
    if (lstatSync(candidate).isSymbolicLink()) {
      throw new CliError(`refusing symlinked state path (reset cannot escape the mode root): ${candidate}`);
    }
  }
  const realRuntime = realpathSync(runtimeDir);
  const realMode = realpathSync(modeDir);
  if (realMode !== join(realRuntime, "prepared")) {
    throw new CliError(`prepared state path does not resolve inside ${realRuntime}: ${modeDir}`);
  }
  return realMode;
}

function doReset(root, pkgDir, scenario) {
  if (process.env.GATHER_DATABASE_PATH !== undefined && process.env.GATHER_DATABASE_PATH.trim() !== "") {
    throw new CliError(
      `reset refuses an explicit GATHER_DATABASE_PATH (${process.env.GATHER_DATABASE_PATH}); reset only manages .runtime/prepared state`,
    );
  }
  const lease = installLeaseStatus(join(root, ".runtime"));
  if (lease.held && lease.alive) {
    throw new CliError(`Gather is running (pid ${lease.holder?.pid}); stop it before resetting prepared state`);
  }
  if (lease.held && !lease.alive) {
    const fenced = fenceDeadInstallLease(join(root, ".runtime"));
    if (fenced !== undefined) out(`Fenced a dead lease holder (pid ${fenced}); recorded in .runtime/installation.sqlite.`);
  }
  const modeDir = join(root, ".runtime", "prepared");
  mkdirSync(modeDir, { recursive: true });
  const realMode = assertNoSymlinkEscape(root, modeDir);
  const modeLock = acquireLock(join(modeDir, "reset.lock"), { command: "reset", mode: "prepared" });
  try {
    const preserved = [];
    const present = DB_SET.filter((name) => existsSync(join(realMode, name)));
    for (const name of present) {
      const target = join(realMode, name);
      if (lstatSync(target).isSymbolicLink()) {
        throw new CliError(`refusing to touch a symlinked database file: ${target}`);
      }
    }
    if (present.length > 0) {
      const backupDir = join(realMode, "reset-backup", String(Date.now()));
      mkdirSync(backupDir, { recursive: true });
      for (const name of present) {
        renameSync(join(realMode, name), join(backupDir, name));
        preserved.push(join(backupDir, name));
      }
      out(`Moved the previous prepared database set aside:`);
      for (const path of preserved) out(`  ${path}`);
    } else {
      out("No prepared database was present; nothing was moved aside.");
    }
    let summary = null;
    if (scenario !== undefined) {
      summary = seedPrepared(root, pkgDir, scenario);
      out(
        `Re-seeded scenario "${summary.scenario}": inbox=${summary.inboxCount} ` +
          `busyBlocks=${summary.busyBlockCount} offers=${summary.offerCount} coverage=${summary.coverage}`,
      );
    }
    out(`Reset complete. Prepared state directory: ${realMode}`);
    return { preserved, summary };
  } finally {
    modeLock.release();
  }
}

/* ------------------------------ import -------------------------------- */

function doImport(root, fromPath) {
  const source = resolve(fromPath);
  if (!existsSync(source)) throw new CliError(`import source does not exist: ${source}`);
  const stat = lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new CliError(`import source must be a regular file, not a symlink or special file: ${source}`);
  }
  // Validate before copying: real SQLite, integrity ok, Gather marker, and a
  // single business — an ambiguous multi-business store is refused.
  const probe = new DatabaseSync(source, { readOnly: true });
  try {
    const integrity = probe.prepare("PRAGMA integrity_check").all();
    if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") {
      throw new CliError(`import source failed its integrity check: ${source}`);
    }
    const tables = probe.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
    if (!tables.includes("businesses")) {
      throw new CliError(`import source is not a Gather database (no businesses table): ${source}`);
    }
    const count = probe.prepare("SELECT COUNT(*) AS n FROM businesses").get().n;
    if (count > 1) {
      throw new CliError(`import source holds ${count} businesses; ambiguous multi-business stores are refused`);
    }
  } finally {
    probe.close();
  }
  const dest = preparedDbPath(root);
  if (existsSync(dest)) {
    throw new CliError(`a prepared database already exists at ${dest}; reset it first`);
  }
  mkdirSync(dirname(dest), { recursive: true });
  // Delegate the copy to the reviewed data tool: consistent snapshot,
  // integrity verification, atomic exclusive publish; source preserved.
  const helper = join(PACKAGE_DIR, "scripts", "gather-data.mjs");
  const result = spawnSync(process.execPath, [helper, "restore", "--snapshot", source, "--dest", dest], {
    encoding: "utf8",
    timeout: 120_000,
  });
  if (result.status !== 0) {
    throw new CliError(`import failed (source left intact): ${(result.stderr ?? "").trim() || `exit ${result.status}`}`);
  }
  out((result.stdout ?? "").trim());
  out(`Imported ${source} -> ${dest}`);
  out("The original file was preserved and never modified.");
}

/* ------------------------------ status -------------------------------- */

function doStatus(root, pkgDir, json) {
  const installLock = installLeaseStatus(join(root, ".runtime"));
  const prepared = readPreparedSummary(root, pkgDir);
  const legacyPath = join(root, "data", "gather.sqlite");
  const report = {
    installRoot: root,
    runtimeDir: join(root, ".runtime"),
    installLock: installLock.held ? { pid: installLock.holder?.pid, alive: installLock.alive, mode: installLock.holder?.mode } : null,
    modes: {
      prepared: {
        database: preparedDbPath(root),
        present: existsSync(preparedDbPath(root)),
        scenario: prepared?.state ?? null,
        inbox: prepared?.inbox ?? [],
        businessCount: prepared?.businesses?.length ?? 0,
        proposals: prepared?.proposals ?? 0,
      },
      live: {
        database: join(root, ".runtime", "live", "gather.sqlite"),
        present: existsSync(join(root, ".runtime", "live", "gather.sqlite")),
        enabled: false,
      },
    },
    legacyDatabase: existsSync(legacyPath) ? legacyPath : null,
    stagedApps: (() => {
      try {
        return readdirSync(join(root, ".runtime", "app")).filter((name) => !name.includes(".staging-") && !name.includes(".stale-"));
      } catch {
        return [];
      }
    })(),
  };
  if (json) {
    out(JSON.stringify(report, null, 2));
    return report;
  }
  out(`Install root: ${report.installRoot}`);
  out(`Runtime dir:  ${report.runtimeDir}`);
  out(`Running:      ${report.installLock ? `yes (pid ${report.installLock.pid}${report.installLock.alive ? "" : ", dead — will be fenced"})` : "no"}`);
  out(`Prepared DB:  ${report.modes.prepared.database} ${report.modes.prepared.present ? "" : "(absent)"}`);
  if (report.modes.prepared.scenario) {
    const s = report.modes.prepared.scenario;
    out(`  scenario=${s.scenario} inbox=${s.inboxCount} busyBlocks=${s.busyBlockCount} offers=${s.offerCount} coverage=${s.coverage}`);
  }
  out(`Live DB:      ${report.modes.live.database} ${report.modes.live.present ? "" : "(absent)"} (live mode is not available in this build)`);
  if (report.legacyDatabase) {
    out(`Legacy DB:    ${report.legacyDatabase} (detected; not touched — use "gather import --from <path>" to copy it explicitly)`);
  }
  if (report.stagedApps.length > 0) out(`Staged apps:  ${report.stagedApps.join(", ")}`);
  return report;
}

/* ------------------------------ doctor -------------------------------- */

function doDoctor(root, pkgDir) {
  const checks = [];
  const major = Number.parseInt(process.versions.node.split(".", 1)[0], 10);
  checks.push({
    name: "Node.js",
    ok: major >= MIN_NODE_MAJOR,
    detail: `Node.js ${process.versions.node} ${major >= MIN_NODE_MAJOR ? "meets" : "is below"} the supported baseline (${MIN_NODE_MAJOR}+).`,
  });
  try {
    validateBuildInputs(pkgDir);
    checks.push({ name: "package", ok: true, detail: `Packed manifest contains all build inputs (${pkgDir}).` });
  } catch (error) {
    checks.push({ name: "package", ok: false, detail: error.message });
  }
  try {
    accessSync(join(root, ".runtime"), constants.W_OK);
    checks.push({ name: "install root", ok: true, detail: `${root} is writable; state lives under .runtime/.` });
  } catch {
    checks.push({ name: "install root", ok: false, detail: `${root}/.runtime is not writable.` });
  }
  const legacyPath = join(root, "data", "gather.sqlite");
  checks.push({
    name: "legacy data",
    ok: true,
    detail: existsSync(legacyPath)
      ? `Existing Gather data detected at ${legacyPath}; it will not be touched unless you run "gather import --from ${legacyPath}".`
      : "No legacy data/gather.sqlite found.",
  });
  for (const item of checks) {
    out(`${item.ok ? "PASS" : "FAIL"} ${item.name}: ${item.detail}`);
  }
  const failed = checks.filter((item) => !item.ok);
  out(failed.length === 0 ? "Doctor passed." : `Doctor failed: ${failed.length} check(s) need attention.`);
  return failed.length === 0;
}

/* ------------------------------- start -------------------------------- */

async function doStart(args) {
  const mode = args.flags.get("--mode") ?? "prepared";
  if (mode !== "prepared") {
    throw new CliError(`this build cannot start mode "${mode}" — only "prepared" is supported; live onboarding arrives with a later milestone`);
  }
  const root = resolveInstallRoot(process.cwd());
  const manifest = readManifest(PACKAGE_DIR);
  const { lockfile } = validateBuildInputs(PACKAGE_DIR);
  const port = await allocatePort(args.flags.has("--port") ? Number(args.flags.get("--port")) : undefined);

  const legacyPath = join(root, "data", "gather.sqlite");
  if (existsSync(legacyPath)) {
    out(`Found existing Gather data at ${legacyPath}.`);
    out(`It is preserved untouched; copy it into the prepared state explicitly with:`);
    out(`  gather import --from ${legacyPath}`);
  }

  if (args.flags.has("--dry-run")) {
    const revision = stageRevision(PACKAGE_DIR, manifest, lockfile);
    out(`Dry run: would stage ${revision} under ${join(root, ".runtime", "app")},`);
    out(`serve it on http://127.0.0.1:${port}/setup with state under ${join(root, ".runtime", "prepared")}.`);
    out("No process was started and no files were staged.");
    return 0;
  }

  // Singleton installation lease: one running Gather per install root. A
  // live foreign PID is never auto-cleared; a dead holder is fenced with
  // logged evidence before we take over.
  const leaseToken = `gather-${process.pid}-${crypto.randomUUID()}`;
  const lease = acquireInstallLease(join(root, ".runtime"), mode, leaseToken);
  if (!lease.acquired) {
    throw new CliError(`Gather is already running (pid ${lease.holder.pid}, mode ${lease.holder.mode}). Stop it first; state and port belong to that process.`);
  }
  if (lease.fencedDeadPid !== undefined) {
    out(`Fenced a dead lease holder (pid ${lease.fencedDeadPid}); takeover recorded in .runtime/installation.sqlite.`);
  }
  const heartbeat = setInterval(() => heartbeatInstallLease(join(root, ".runtime"), leaseToken), 30_000);
  heartbeat.unref();

  try {
    const staged = await stageApp(root, PACKAGE_DIR, manifest, lockfile, (line) => out(line));
    const url = `http://127.0.0.1:${port}/setup`;
    const nextBin = join(staged.stagedDir, "node_modules", "next", "dist", "bin", "next");
    out(`Starting Gather (${staged.revision}) on 127.0.0.1:${port}…`);
    out(`State lives under ${join(root, ".runtime", "prepared")} — nothing leaves this machine unless you connect real accounts (not in this build).`);
    const child = spawn(
      process.execPath,
      [nextBin, "start", "--hostname", "127.0.0.1", "--port", String(port)],
      {
        cwd: staged.stagedDir,
        env: childEnv({
          NEXT_TELEMETRY_DISABLED: "1",
          PORT: String(port),
          HOSTNAME: "127.0.0.1",
          GATHER_INSTALL_ROOT: root,
          GATHER_MODE: "prepared",
        }),
        stdio: "inherit",
      },
    );
    const exitPromise = new Promise((resolveExit) => {
      child.once("error", (error) => resolveExit({ error }));
      child.once("close", (code, signal) => resolveExit({ code, signal }));
    });
    const shutdown = (signal) => {
      child.kill(signal);
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));

    const ready = waitForServer(`http://127.0.0.1:${port}/setup`, 120_000).then(
      () => true,
      (error) => ({ error }),
    );
    const first = await Promise.race([exitPromise, ready]);
    if (first !== true) {
      child.kill("SIGTERM");
      await exitPromise;
      if (first && first.error) throw first.error instanceof CliError ? first.error : new CliError(first.error.message ?? String(first.error));
      throw new CliError(`the Gather app exited before it was ready (${JSON.stringify(first)})`);
    }
    out(`Gather is ready: ${url}`);
    if (args.flags.has("--no-open")) {
      out(`--no-open: browse to ${url}`);
    } else if (!openBrowser(url)) {
      out(`Could not open a browser; browse to ${url}`);
    }
    const ended = await exitPromise;
    if (ended.signal) out(`Gather stopped after signal ${ended.signal}.`);
    return ended.code ?? (ended.signal ? 0 : 1);
  } finally {
    clearInterval(heartbeat);
    releaseInstallLease(join(root, ".runtime"), leaseToken);
  }
}

/* ------------------------------- main --------------------------------- */

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`gather: ${error.message}\nRun "gather help" for usage.\n`);
    return 2;
  }
  if (args.flags.has("--help") || args.flags.has("-h") || args.command === "help") {
    process.stdout.write(usage());
    return 0;
  }
  const pkgDir = PACKAGE_DIR;
  try {
    switch (args.command) {
      case "start":
        return await doStart(args);
      case "doctor": {
        const root = resolveInstallRoot(process.cwd());
        return doDoctor(root, pkgDir) ? 0 : 1;
      }
      case "status": {
        const root = resolveInstallRoot(process.cwd());
        doStatus(root, pkgDir, args.flags.has("--json"));
        return 0;
      }
      case "seed": {
        const scenario = args.flags.get("--scenario") ?? "glasshouse";
        if (!SCENARIO_IDS.includes(scenario)) {
          throw new CliError(`unknown scenario "${scenario}"; expected one of: ${SCENARIO_IDS.join(", ")}`);
        }
        if (!args.flags.has("--yes")) {
          throw new CliError("seeding writes prepared state; pass --yes to confirm");
        }
        const root = resolveInstallRoot(process.cwd());
        const lease = installLeaseStatus(join(root, ".runtime"));
        if (lease.held && lease.alive) {
          throw new CliError(`Gather is running (pid ${lease.holder?.pid}); stop it before seeding`);
        }
        mkdirSync(join(root, ".runtime", "prepared"), { recursive: true });
        const summary = seedPrepared(root, pkgDir, scenario);
        out(
          `Seeded "${summary.scenario}" into ${preparedDbPath(root)}: ` +
            `inbox=${summary.inboxCount} busyBlocks=${summary.busyBlockCount} offers=${summary.offerCount} coverage=${summary.coverage}`,
        );
        out(summary.coverageDetail);
        return 0;
      }
      case "reset": {
        if (!args.flags.has("--yes") && !args.flags.has("--confirm-reset")) {
          throw new CliError("reset replaces the prepared database set; pass --confirm-reset (or --yes) to confirm");
        }
        const scenario = args.flags.get("--scenario");
        if (scenario !== undefined && !SCENARIO_IDS.includes(scenario)) {
          throw new CliError(`unknown scenario "${scenario}"; expected one of: ${SCENARIO_IDS.join(", ")}`);
        }
        const root = resolveInstallRoot(process.cwd());
        doReset(root, pkgDir, scenario);
        return 0;
      }
      case "import": {
        const from = args.flags.get("--from");
        if (from === undefined) throw new CliError("import needs --from <path>");
        const root = resolveInstallRoot(process.cwd());
        doImport(root, from);
        return 0;
      }
      default:
        throw new CliError(`unknown command: ${args.command}`);
    }
  } catch (error) {
    if (error instanceof CliError) {
      process.stderr.write(`gather: error: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`gather: unexpected failure: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
