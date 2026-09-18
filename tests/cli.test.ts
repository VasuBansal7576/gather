import assert from "node:assert/strict";
import { spawnSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createServer, type Server } from "node:net";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { GatherStore } from "../src/server/sqlite-store.ts";
import { listPreparedInbox, readPreparedState } from "../src/server/demo-fixtures.ts";
import { installLeaseStatus, leaseEvents } from "../src/setup/installation-lease.ts";

const REPO = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CLI = join(REPO, "scripts", "gather-cli.mjs");

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "gather-cli-"));
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function gather(root: string, args: string[], env: Record<string, string | undefined> = {}): RunResult {
  const cleanEnv = new Map<string, string>();
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("GATHER_")) cleanEnv.set(key, value);
  }
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) cleanEnv.delete(key);
    else cleanEnv.set(key, value);
  }
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    env: Object.fromEntries(cleanEnv) as NodeJS.ProcessEnv,
    encoding: "utf8",
    timeout: 60_000,
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function readState(dbPath: string) {
  const store = new GatherStore(dbPath);
  try {
    return {
      state: readPreparedState(store),
      inbox: listPreparedInbox(store),
      businesses: store.listBusinesses(),
      proposals: store.listAllProposedActions(),
    };
  } finally {
    store.close();
  }
}

test("help prints usage and exits cleanly", () => {
  const root = tempRoot();
  try {
    const result = gather(root, ["help"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /gather <command>/);
    assert.match(result.stdout, /--no-open/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("doctor reports a writable install root and a complete package manifest", () => {
  const root = tempRoot();
  try {
    const result = gather(root, ["doctor"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /PASS Node\.js/);
    assert.match(result.stdout, /PASS package/);
    assert.match(result.stdout, /PASS install root/);
    assert.ok(existsSync(join(root, ".runtime")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("seed requires --yes and writes the documented prepared state", () => {
  const root = tempRoot();
  const dbPath = join(root, ".runtime", "prepared", "gather.sqlite");
  try {
    const refused = gather(root, ["seed", "--scenario", "glasshouse"]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /--yes/);
    assert.equal(existsSync(dbPath), false);

    const unknown = gather(root, ["seed", "--scenario", "bogus", "--yes"]);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /unknown scenario/);

    const seeded = gather(root, ["seed", "--scenario", "glasshouse", "--yes"]);
    assert.equal(seeded.status, 0, seeded.stderr);
    assert.match(seeded.stdout, /inbox=6 busyBlocks=2 offers=0/);

    const state = readState(dbPath);
    assert.equal(state.state?.scenario, "glasshouse");
    assert.equal(state.inbox.length, 6);
    assert.equal(state.proposals.length, 0);
    assert.equal(state.businesses.length, 1);

    // Repeated seed produces the documented state again.
    const reseeded = gather(root, ["seed", "--scenario", "glasshouse", "--yes"]);
    assert.equal(reseeded.status, 0);
    const again = readState(dbPath);
    assert.equal(again.inbox.length, 6);
    assert.equal(again.proposals.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reset replaces the prepared DB set, preserves a backup, and reseeds", () => {
  const root = tempRoot();
  const dbPath = join(root, ".runtime", "prepared", "gather.sqlite");
  try {
    assert.equal(gather(root, ["seed", "--scenario", "glasshouse", "--yes"]).status, 0);

    const unconfirmed = gather(root, ["reset"]);
    assert.equal(unconfirmed.status, 1);
    assert.match(unconfirmed.stderr, /--yes/);
    assert.equal(readState(dbPath).inbox.length, 6);

    const reset = gather(root, ["reset", "--yes", "--scenario", "empty"]);
    assert.equal(reset.status, 0, reset.stderr);
    assert.match(reset.stdout, /Moved the previous prepared database set aside/);

    // The old set was moved aside, not deleted.
    const backupDir = join(root, ".runtime", "prepared", "reset-backup");
    assert.ok(existsSync(backupDir));
    const state = readState(dbPath);
    assert.equal(state.state?.scenario, "empty");
    assert.equal(state.inbox.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reset refuses an explicit custom database path", () => {
  const root = tempRoot();
  try {
    const result = gather(root, ["reset", "--yes"], { GATHER_DATABASE_PATH: join(root, "custom.sqlite") });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /GATHER_DATABASE_PATH/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const LEASE_MODULE = new URL("../src/setup/installation-lease.ts", import.meta.url).pathname;

/** Spawn a live child that takes the installation lease and stays alive. */
async function holdLease(root: string): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const m = await import(${JSON.stringify(LEASE_MODULE)});
       const r = m.acquireInstallLease(${JSON.stringify(join(root, ".runtime"))}, "prepared", "test-token");
       if (!r.acquired) { console.error("lease not acquired"); process.exit(1); }
       setInterval(() => {}, 1000);`,
    ],
    { stdio: "ignore" },
  );
  // Give the child a moment to take the lease.
  for (let i = 0; i < 50; i += 1) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    const status = installLeaseStatus(join(root, ".runtime"));
    if (status.held && status.alive && status.holder?.pid === child.pid) return child;
  }
  child.kill("SIGKILL");
  throw new Error("lease-holding child did not acquire the installation lease");
}

test("reset refuses while another Gather process holds the installation lease", async () => {
  const root = tempRoot();
  let foreign: ChildProcess | undefined;
  try {
    foreign = await holdLease(root);
    const result = gather(root, ["reset", "--confirm-reset"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`pid ${foreign.pid}`));
    // Once the holder exits, reset fences the dead PID and proceeds.
    foreign.kill("SIGKILL");
    foreign = undefined;
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
    const allowed = gather(root, ["reset", "--confirm-reset"]);
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.match(allowed.stdout, /Fenced a dead lease holder/);
    const events = leaseEvents(join(root, ".runtime"));
    assert.ok(events.some((event) => event.event === "fenced-dead-pid"));
  } finally {
    foreign?.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});

test("reset refuses a symlinked prepared state directory", () => {
  const root = tempRoot();
  const outside = tempRoot();
  try {
    mkdirSync(join(root, ".runtime"), { recursive: true });
    symlinkSync(outside, join(root, ".runtime", "prepared"));
    const result = gather(root, ["reset", "--yes"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /symlink/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a dead lease holder is fenced with logged evidence, not silently cleared", () => {
  const root = tempRoot();
  try {
    // A child takes the lease then exits immediately, leaving a dead holder.
    const taker = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const m = await import(${JSON.stringify(LEASE_MODULE)});
         m.acquireInstallLease(${JSON.stringify(join(root, ".runtime"))}, "prepared", "dead-token");`,
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
    assert.equal(taker.status, 0, taker.stderr);
    const before = installLeaseStatus(join(root, ".runtime"));
    assert.equal(before.held, true);
    assert.equal(before.alive, false);

    const result = gather(root, ["reset", "--yes"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Fenced a dead lease holder \(pid \d+\)/);
    const events = leaseEvents(join(root, ".runtime"));
    assert.ok(events.some((event) => event.event === "acquired"));
    assert.ok(events.some((event) => event.event === "fenced-dead-pid"));
    assert.equal(installLeaseStatus(join(root, ".runtime")).held, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reset never touches a legacy database in the install root", () => {
  const root = tempRoot();
  const legacyPath = join(root, "data", "gather.sqlite");
  try {
    mkdirSync(join(root, "data"), { recursive: true });
    const legacy = new GatherStore(legacyPath);
    legacy.createBusiness({ name: "Legacy Venue", timezone: "UTC" });
    legacy.close();
    const before = readFileSyncSafe(legacyPath);

    assert.equal(gather(root, ["seed", "--scenario", "glasshouse", "--yes"]).status, 0);
    assert.equal(gather(root, ["reset", "--yes"]).status, 0);
    assert.equal(readFileSyncSafe(legacyPath), before);

    const legacyAfter = new GatherStore(legacyPath);
    try {
      assert.equal(legacyAfter.listBusinesses().length, 1);
      assert.equal(legacyAfter.listBusinesses()[0]?.name, "Legacy Venue");
    } finally {
      legacyAfter.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function readFileSyncSafe(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

test("start --mode live is refused honestly", () => {
  const root = tempRoot();
  try {
    const result = gather(root, ["start", "--mode", "live"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /only "prepared" is supported/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("start --dry-run validates inputs and reports the plan without starting", async () => {
  const root = tempRoot();
  let server: Server | undefined;
  try {
    // An occupied pinned port is refused before anything stages.
    server = createServer();
    await new Promise<void>((resolveListen) => server!.listen(0, "127.0.0.1", resolveListen));
    const occupied = (server.address() as { port: number }).port;
    const busy = gather(root, ["start", "--dry-run", "--port", String(occupied)]);
    assert.equal(busy.status, 1);
    assert.match(busy.stderr, /not free/);

    const plan = gather(root, ["start", "--dry-run", "--no-open"]);
    assert.equal(plan.status, 0, plan.stderr);
    assert.match(plan.stdout, /Dry run: would stage/);
    assert.match(plan.stdout, /http:\/\/127\.0\.0\.1:\d+\/setup/);
    assert.equal(existsSync(join(root, ".runtime", "app")), false);
  } finally {
    server?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("start reports a detected legacy database without touching it", () => {
  const root = tempRoot();
  try {
    mkdirSync(join(root, "data"), { recursive: true });
    const legacy = new GatherStore(join(root, "data", "gather.sqlite"));
    legacy.createBusiness({ name: "Legacy Venue", timezone: "UTC" });
    legacy.close();
    const result = gather(root, ["start", "--dry-run", "--no-open"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /existing Gather data/i);
    assert.match(result.stdout, /gather import --from/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("import copies a single-business legacy database and refuses multi-business stores", () => {
  const root = tempRoot();
  const sourcePath = join(tempRoot(), "legacy.sqlite");
  try {
    const source = new GatherStore(sourcePath);
    source.createBusiness({ name: "One Venue", timezone: "UTC" });
    source.close();

    const imported = gather(root, ["import", "--from", sourcePath]);
    assert.equal(imported.status, 0, imported.stderr);
    const dest = join(root, ".runtime", "prepared", "gather.sqlite");
    assert.ok(existsSync(dest));
    const destStore = new GatherStore(dest);
    try {
      assert.equal(destStore.listBusinesses().length, 1);
    } finally {
      destStore.close();
    }
    // The source file was preserved.
    const check = new GatherStore(sourcePath);
    try {
      assert.equal(check.listBusinesses()[0]?.name, "One Venue");
    } finally {
      check.close();
    }

    // Multi-business sources are ambiguous and refused.
    const multi = new GatherStore(sourcePath);
    multi.createBusiness({ name: "Second Venue", timezone: "UTC" });
    multi.close();
    const root2 = tempRoot();
    try {
      const refused = gather(root2, ["import", "--from", sourcePath]);
      assert.equal(refused.status, 1);
      assert.match(refused.stderr, /multi-business|businesses are refused|ambiguous/i);
    } finally {
      rmSync(root2, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dirname(sourcePath), { recursive: true, force: true });
  }
});

test("status reports mode roots, locks and seeded state honestly", () => {
  const root = tempRoot();
  try {
    const empty = gather(root, ["status", "--json"]);
    assert.equal(empty.status, 0);
    const report = JSON.parse(empty.stdout);
    assert.equal(report.modes.prepared.present, false);
    assert.equal(report.modes.live.enabled, false);
    assert.equal(report.installLock, null);

    gather(root, ["seed", "--scenario", "non-event", "--yes"]);
    const seeded = JSON.parse(gather(root, ["status", "--json"]).stdout);
    assert.equal(seeded.modes.prepared.present, true);
    assert.equal(seeded.modes.prepared.scenario.scenario, "non-event");
    assert.equal(seeded.modes.prepared.scenario.inboxCount, 3);
    assert.equal(seeded.modes.prepared.proposals, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a symlinked .runtime directory is refused as the install state root", () => {
  const root = tempRoot();
  const outside = tempRoot();
  try {
    symlinkSync(outside, join(root, ".runtime"));
    const result = gather(root, ["status"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /symlink/);
    // Nothing was written outside the root through the link.
    assert.equal(existsSync(join(outside, "prepared")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
