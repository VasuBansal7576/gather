/**
 * Data backup/recovery tests. Every destructive step runs the real
 * scripts/gather-data.mjs against task-owned temporary SQLite files only
 * (mkdtemp under os.tmpdir); the repo working tree and any live database
 * are never touched. No credentials, personal data, providers, or models.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { GatherStore } from "../src/server/sqlite-store.ts";
import { DatabaseSync } from "node:sqlite";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "gather-data.mjs");

const FIXTURE_SOURCE = {
  kind: "fixture" as const,
  locator: "fixture://fictional/sample-inquiry-001",
  label: "Fictional sample inquiry",
  fictional: true,
};

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), "gather-data-test-"));
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function run(args: string[], env: Record<string, string> = {}): { status: number; stdout: string; stderr: string } {
  const child = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf-8",
    env: { ...process.env, ...env },
    timeout: 60_000,
  });
  return { status: child.status ?? -1, stdout: child.stdout ?? "", stderr: child.stderr ?? "" };
}

/** Live store with committed-but-uncheckpointed WAL content. */
function liveStore(dir: string, seedBookings: number) {
  const dbPath = join(dir, "app.sqlite");
  const store = new GatherStore(dbPath);
  const business = store.createBusiness({ name: "Fictional Walnut Hall", timezone: "America/New_York" });
  for (let i = 0; i < seedBookings; i += 1) {
    store.createBooking({ businessId: business.id, eventName: `Fictional event ${i}`, sourceReferences: [FIXTURE_SOURCE] });
  }
  return { store, businessId: business.id, dbPath };
}

function integrityOk(path: string): boolean {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = db.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;
    return rows.length === 1 && rows[0]?.integrity_check === "ok";
  } finally {
    db.close();
  }
}

test("backup snapshots live WAL contents and reopens via GatherStore", () => {
  const dir = tmpRoot();
  try {
    const { store, businessId, dbPath } = liveStore(dir, 3);
    try {
      assert.ok(existsSync(`${dbPath}-wal`), "seeded writes must sit in the WAL before backup");
      const before = sha256(dbPath);
      const dest = join(dir, "snapshots", "app-backup.sqlite");
      const out = run(["backup", "--db", dbPath, "--dest", dest]);
      assert.equal(out.status, 0, out.stderr);
      assert.match(out.stdout, /backup ok/);
      // Full capture without table assumptions: every source table is present.
      const srcTables = (store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
      assert.ok(srcTables.length > 0);
      assert.ok(integrityOk(dest));
      const reopened = new GatherStore(dest);
      try {
        const names = (reopened.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
        assert.deepEqual(names, srcTables);
        assert.equal((reopened.db.prepare("SELECT COUNT(*) AS n FROM bookings").get() as { n: number }).n, 3);
        assert.equal((reopened.db.prepare("SELECT COUNT(*) AS n FROM businesses").get() as { n: number }).n, 1);
      } finally {
        reopened.close();
      }
      // Source untouched: main file bytes identical (WAL sidecar may evolve, data file must not).
      assert.equal(sha256(dbPath), before);
      // Restricted permissions on the created file.
      assert.equal(statSync(dest).mode & 0o777, 0o600);
      // No row contents leak into the command output.
      assert.ok(!out.stdout.includes("Fictional Walnut Hall"), "output must not print row contents");
      void businessId;
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("backup races concurrent writes and stays valid", () => {
  const dir = tmpRoot();
  try {
    const { store, businessId, dbPath } = liveStore(dir, 2);
    try {
      const dest = join(dir, "race-backup.sqlite");
      const child = spawnSync(process.execPath, [SCRIPT, "backup", "--db", dbPath, "--dest", dest], { encoding: "utf-8", timeout: 60_000 });
      // Writes continue around the snapshot; exact interleaving is not asserted.
      for (let i = 0; i < 20; i += 1) {
        store.createBooking({ businessId, eventName: `Fictional race ${i}`, sourceReferences: [FIXTURE_SOURCE] });
      }
      assert.equal(child.status, 0, child.stderr);
      assert.ok(integrityOk(dest));
      const db = new DatabaseSync(dest, { readOnly: true });
      try {
        const n = (db.prepare("SELECT COUNT(*) AS n FROM bookings").get() as { n: number }).n;
        assert.ok(n >= 2 && n <= 22, `snapshot must hold a consistent prefix of writes, got ${n}`);
      } finally {
        db.close();
      }
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restore writes a new database the owner can restart on; originals intact", () => {
  const dir = tmpRoot();
  try {
    const { store, dbPath } = liveStore(dir, 2);
    const snap = join(dir, "snap.sqlite");
    assert.equal(run(["backup", "--db", dbPath, "--dest", snap]).status, 0);
    store.close();
    // Closing the last writer checkpoints the WAL into the main file, so the
    // stable original hash is captured here; restore must never touch it after.
    const srcHash = sha256(dbPath);
    const restored = join(dir, "restored.sqlite");
    const out = run(["restore", "--snapshot", snap, "--dest", restored]);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /restore ok/);
    assert.equal(statSync(restored).mode & 0o777, 0o600);
    // Content identity (not byte identity: restore snapshots through
    // VACUUM INTO, which reformats pages by design). Same tables, same rows.
    const snapDb = new DatabaseSync(snap, { readOnly: true });
    const restDb = new DatabaseSync(restored, { readOnly: true });
    try {
      const names = (db: DatabaseSync) =>
        (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
      assert.deepEqual(names(restDb), names(snapDb));
      for (const table of ["businesses", "bookings"] as const) {
        const n = (db: DatabaseSync) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
        assert.equal(n(restDb), n(snapDb), `${table} row counts must match`);
      }
    } finally {
      snapDb.close();
      restDb.close();
    }
    // Restart analogue: a fresh GatherStore opens the restored file with full data.
    const restarted = new GatherStore(restored);
    try {
      assert.equal((restarted.db.prepare("SELECT COUNT(*) AS n FROM bookings").get() as { n: number }).n, 2);
      assert.ok(integrityOk(restored));
    } finally {
      restarted.close();
    }
    // Neither the snapshot nor the original changed.
    assert.equal(sha256(dbPath), srcHash);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restore refuses corrupt, truncated, and non-Gather inputs", () => {
  const dir = tmpRoot();
  try {
    const garbage = join(dir, "garbage.sqlite");
    writeFileSync(garbage, "this is not a database at all");
    const real = join(dir, "real.sqlite");
    const db = new DatabaseSync(real);
    db.exec("CREATE TABLE t(x TEXT); INSERT INTO t VALUES ('v');");
    db.close();
    const truncated = join(dir, "trunc.sqlite");
    writeFileSync(truncated, readFileSync(real).subarray(0, 100));
    const other = join(dir, "other.sqlite");
    const db2 = new DatabaseSync(other);
    db2.exec("CREATE TABLE widgets(id TEXT PRIMARY KEY);");
    db2.close();
    for (const [name, snap] of [["garbage", garbage], ["truncated", truncated], ["non-gather", other]] as const) {
      const before = sha256(snap);
      const out = run(["restore", "--snapshot", snap, "--dest", join(dir, `${name}-out.sqlite`)]);
      assert.notEqual(out.status, 0, `${name} must be refused`);
      assert.equal(sha256(snap), before, `${name} snapshot must be byte-intact`);
      assert.ok(!existsSync(join(dir, `${name}-out.sqlite`)), `${name} must leave no destination`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("existing, symlink, and same-file destinations are refused; sources intact", () => {
  const dir = tmpRoot();
  try {
    const { store, dbPath } = liveStore(dir, 1);
    try {
      const snap = join(dir, "snap.sqlite");
      assert.equal(run(["backup", "--db", dbPath, "--dest", snap]).status, 0);
      const beforeDb = sha256(dbPath);
      const beforeSnap = sha256(snap);
      // Existing destination (backup and restore).
      assert.notEqual(run(["backup", "--db", dbPath, "--dest", snap]).status, 0);
      assert.notEqual(run(["restore", "--snapshot", snap, "--dest", snap]).status, 0);
      // Symlink destination.
      const link = join(dir, "link.sqlite");
      symlinkSync(snap, link);
      const r1 = run(["backup", "--db", dbPath, "--dest", link]);
      assert.notEqual(r1.status, 0);
      assert.match(r1.stderr, /symlink/);
      // Same file via parent traversal spelling.
      const same = join(dir, "sub", "..", "app-same.sqlite");
      mkdirSync(join(dir, "sub"), { recursive: true });
      execFileSync(process.execPath, [SCRIPT, "backup", "--db", dbPath, "--dest", join(dir, "app-same.sqlite")]);
      const r2 = run(["backup", "--db", join(dir, "app-same.sqlite"), "--dest", same]);
      assert.notEqual(r2.status, 0);
      // Sources byte-identical after every refusal.
      assert.equal(sha256(dbPath), beforeDb);
      assert.equal(sha256(snap), beforeSnap);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("failed publication leaves no staging files and the source intact", () => {
  const dir = tmpRoot();
  try {
    const { store, dbPath } = liveStore(dir, 1);
    try {
      const before = sha256(dbPath);
      const locked = join(dir, "locked");
      mkdirSync(locked);
      chmodSync(locked, 0o555);
      let out: { status: number; stdout: string; stderr: string };
      try {
        out = run(["backup", "--db", dbPath, "--dest", join(locked, "nope.sqlite")]);
      } finally {
        chmodSync(locked, 0o755);
      }
      assert.notEqual(out.status, 0);
      assert.deepEqual(readdirSync(locked), [], "no staging file may remain");
      assert.deepEqual(readdirSync(dir).filter((f) => f.includes(".partial-")), [], "no staging file may remain at top level");
      assert.equal(sha256(dbPath), before);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("backup honors GATHER_DATABASE_PATH and prints no row contents", () => {
  const dir = tmpRoot();
  try {
    const { store, dbPath } = liveStore(dir, 1);
    try {
      const dest = join(dir, "env-backup.sqlite");
      const out = run(["backup", "--dest", dest], { GATHER_DATABASE_PATH: dbPath });
      assert.equal(out.status, 0, out.stderr);
      assert.ok(existsSync(dest));
      assert.ok(!out.stdout.includes("Fictional"), "output must not print row contents");
      assert.ok(!out.stderr.includes("Fictional"), "errors must not print row contents");
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing source and unknown command fail without side effects", () => {
  const dir = tmpRoot();
  try {
    const out = run(["backup", "--db", join(dir, "absent.sqlite"), "--dest", join(dir, "out.sqlite")]);
    assert.notEqual(out.status, 0);
    assert.ok(!existsSync(join(dir, "out.sqlite")));
    const bad = run(["defragment", "--dest", join(dir, "x.sqlite")]);
    assert.notEqual(bad.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Genuine concurrent-destination race: a victim file lands AFTER the
 * requireAbsent check but BEFORE publication. link(2) publication must
 * fail with EEXIST and leave the victim byte-identical; the old
 * check-then-renameSync sequence would silently clobber it and exit 0.
 */
test("concurrent destination creation cannot clobber: existing file untouched", async () => {
  const dir = tmpRoot();
  try {
    // Large enough that VACUUM INTO leaves a wide, reliably hittable window.
    const { store, dbPath } = liveStore(dir, 1500);
    try {
      const beforeDb = sha256(dbPath);
      const dest = join(dir, "race-victim.sqlite");
      let landed = false;
      for (let attempt = 0; attempt < 5 && !landed; attempt += 1) {
        if (existsSync(dest)) rmSync(dest);
        const child = spawn(process.execPath, [SCRIPT, "backup", "--db", dbPath, "--dest", dest], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        const chunks: Buffer[] = [];
        child.stderr?.on("data", (c: Buffer) => chunks.push(c));
        const exited = new Promise<number>((resolve) => {
          child.on("exit", (code) => resolve(code ?? -1));
        });
        const deadline = Date.now() + 90_000;
        while (Date.now() < deadline) {
          const code = child.exitCode;
          if (code !== null) break;
          const partials = readdirSync(dir).filter((f) => f === `race-victim.sqlite.partial-${child.pid}`);
          if (partials.length > 0 && !existsSync(dest)) {
            writeFileSync(dest, "VICTIM-CONTENT-MUST-SURVIVE");
            landed = true;
            break;
          }
          await sleepMs(5);
        }
        const status = await exited;
        if (!landed) continue; // child won before the victim landed; retry.
        assert.notEqual(status, 0, "publication into a raced destination must fail");
        assert.equal(readFileSync(dest, "utf-8"), "VICTIM-CONTENT-MUST-SURVIVE", "victim file must be byte-intact");
        assert.deepEqual(
          readdirSync(dir).filter((f) => f.includes(".partial-")),
          [],
          "our staging file must be cleaned; nothing else touched",
        );
      }
      assert.ok(landed, "race window must be hit within attempts");
      assert.equal(sha256(dbPath), beforeDb, "source intact");
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two simultaneous publishers serialize: one valid destination, no leftovers", async () => {
  const dir = tmpRoot();
  try {
    const { store, dbPath } = liveStore(dir, 200);
    try {
      const dest = join(dir, "duel.sqlite");
      const runOnce = () =>
        new Promise<number>((resolve) => {
          const child = spawn(process.execPath, [SCRIPT, "backup", "--db", dbPath, "--dest", dest], {
            stdio: ["ignore", "ignore", "ignore"],
          });
          child.on("exit", (code) => resolve(code ?? -1));
        });
      const [first, second] = await Promise.all([runOnce(), runOnce()]);
      // Exactly one publisher wins however the writes interleave; the loser
      // refuses (requireAbsent or EEXIST) instead of overwriting.
      assert.equal([first, second].filter((s) => s === 0).length, 1, `exactly one winner, got ${first}/${second}`);
      assert.ok(integrityOk(dest), "winning destination is a valid database");
      assert.deepEqual(
        readdirSync(dir).filter((f) => f.includes(".partial-")),
        [],
        "loser cleans only its own staging file",
      );
      const db = new DatabaseSync(dest, { readOnly: true });
      try {
        assert.equal((db.prepare("SELECT COUNT(*) AS n FROM bookings").get() as { n: number }).n, 200);
      } finally {
        db.close();
      }
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a foreign staging file is never deleted by our run", () => {
  const dir = tmpRoot();
  try {
    const { store, dbPath } = liveStore(dir, 1);
    try {
      const dest = join(dir, "guarded.sqlite");
      const foreign = `${dest}.partial-42424242`;
      writeFileSync(foreign, "another process owns this");
      const before = sha256(foreign);
      const out = run(["backup", "--db", dbPath, "--dest", dest]);
      assert.equal(out.status, 0, out.stderr);
      assert.equal(sha256(foreign), before, "foreign staging file must survive our run");
      assert.ok(integrityOk(dest));
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("backup refuses non-Gather SQLite without touching anything", () => {
  const dir = tmpRoot();
  try {
    const other = join(dir, "other.sqlite");
    const db = new DatabaseSync(other);
    db.exec("CREATE TABLE widgets(id TEXT PRIMARY KEY); INSERT INTO widgets VALUES ('w');");
    db.close();
    const dest = join(dir, "other-backup.sqlite");
    const out = run(["backup", "--db", other, "--dest", dest]);
    assert.notEqual(out.status, 0, "non-Gather database must be refused");
    assert.match(out.stderr, /not a Gather database/);
    assert.ok(!existsSync(dest), "no destination may be created");
    assert.deepEqual(
      readdirSync(dir).filter((f) => f.includes(".partial-")),
      [],
      "no staging file may remain",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restore preserves uncheckpointed WAL rows from a live snapshot", () => {
  const dir = tmpRoot();
  try {
    const { store, businessId, dbPath } = liveStore(dir, 2);
    try {
      // Two more rows committed after the last checkpoint opportunity stay
      // in the WAL while the writer holds the database open.
      store.createBooking({ businessId, eventName: "Fictional wal-row-A", sourceReferences: [FIXTURE_SOURCE] });
      store.createBooking({ businessId, eventName: "Fictional wal-row-B", sourceReferences: [FIXTURE_SOURCE] });
      assert.ok(existsSync(`${dbPath}-wal`), "rows must sit in the WAL before restore");
      // Restore straight from the LIVE main file (sidecars alongside): the
      // old copyFileSync path would silently drop the two WAL rows.
      const restored = join(dir, "wal-restored.sqlite");
      const out = run(["restore", "--snapshot", dbPath, "--dest", restored]);
      assert.equal(out.status, 0, out.stderr);
      const db = new DatabaseSync(restored, { readOnly: true });
      try {
        const names = (db.prepare("SELECT event_name FROM bookings ORDER BY event_name").all() as Array<{ event_name: string }>).map(
          (r) => r.event_name,
        );
        assert.ok(names.includes("Fictional wal-row-A"), `WAL row A preserved, got ${names.length} rows`);
        assert.ok(names.includes("Fictional wal-row-B"), `WAL row B preserved, got ${names.length} rows`);
        assert.equal(names.length, 4);
        assert.ok(integrityOk(restored));
      } finally {
        db.close();
      }
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
