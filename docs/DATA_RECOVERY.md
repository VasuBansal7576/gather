# Local data backup and recovery (SIMULATED fixtures only)

`scripts/gather-data.mjs` provides offline backup and restore-to-new-database
commands using Node's built-in SQLite only. No new dependencies, no runtime
or host changes, no provider or model calls. All behavior below is proven by
`tests/data-recovery.test.ts` against temporary fixture databases; no live
database has been backed up or restored.

## Commands

```sh
node scripts/gather-data.mjs backup [--db <path>] --dest <new-path>
node scripts/gather-data.mjs restore --snapshot <path> --dest <new-path>
```

Backup source defaults to `GATHER_DATABASE_PATH` (else `data/gather.sqlite`).
Both commands print only paths, digests, and table counts — never row contents.

## Guarantees

- **Consistent hot backup**: `VACUUM INTO` from a read-only connection
  captures committed contents including uncheckpointed WAL data while the app
  writes, without enumerating tables (no assumption of current core tables)
  and without write-locking the source.
- **Verified publish**: the staging copy must pass `PRAGMA integrity_check`
  before an atomic rename publishes it. Any failure removes only the staging
  file; the source is left byte-intact.
- **Exclusive destinations**: existing files, directories, and symlinks are
  refused, as is a destination identical to the source (compared
  canonically). Destinations are canonicalized through the filesystem and
  reported in canonical form, so a redirected write cannot pass unnoticed.
- **Restore is copy-only**: the snapshot is validated (real SQLite file,
  integrity `ok`, `businesses` root table present) and copied to a new,
  unused destination with mode `0600`. The original and current database are
  never deleted, replaced, or live-patched, and no in-place restore safety
  is claimed. Created files are mode `0600` in both commands.
- **Owner cutover**: point `GATHER_DATABASE_PATH` at the restored file only
  with the launcher stopped, then restart.

## Honest limitations

- **Same-version only**: snapshots carry no schema version marker (the store
  does not set `application_id`), and restore checks only the `businesses`
  root-table heuristic plus integrity — not version compatibility. Restoring
  into a different codebase version is unsupported in both directions: an
  older snapshot into newer code works only while migrations stay purely
  additive (`CREATE TABLE IF NOT EXISTS`, as today); a newer snapshot into
  older code, or any schema with destructive migrations, may fail or
  misbehave, and this tool will not detect that beyond integrity.
- **No rollback mechanism**: recovery means restoring an older snapshot onto
  the same code version and re-applying later work by hand; there is no
  downgrade path and no merge of divergent databases.
- **Stale staging files**: a killed run can leave `<dest>.partial-<pid>`;
  the next run refuses rather than deleting it — remove it by hand after
  confirming no `gather-data` process is running.
- **Scope**: single-file SQLite plus its WAL sidecars at backup time. External
  assets (gateway state, MCP tokens, logs) are not included.
