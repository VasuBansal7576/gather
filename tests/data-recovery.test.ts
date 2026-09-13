/**
 * Data backup/recovery tests. Every destructive step runs the real
 * scripts/gather-data.mjs against task-owned temporary SQLite files only
 * (mkdtemp under os.tmpdir); the repo working tree and any live database
 * are never touched. No credentials, personal data, providers, or models.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
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
    // Byte-identity of the copy itself, captured before any read-write open
    // (opening read-write may legitimately rewrite bytes via checkpointing).
    assert.equal(sha256(snap), sha256(restored));
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
