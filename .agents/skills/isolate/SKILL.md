---
name: isolate
description: Start every ADR in a fresh git worktree branched from origin/main so parallel agents never collide. Use before touching any file.
---

# Isolate

Never build on `main` or inside another agent's worktree.

1. `git fetch origin main`
2. `git worktree add ../gather-adr-<NNN> -b adr-<NNN>-<slug> origin/main`
3. `cd ../gather-adr-<NNN> && npm ci`
4. Run `npm test` and `npm run typecheck` once before changing anything. Record the result in your PR as the "before" state for the suite.
5. Work only inside this worktree and only in the files your ADR lists under **Owns**. If you need a file outside that list, stop and write the reason in the PR; do not edit it.
6. Use a fresh `.runtime/` and a fresh SQLite path (`GATHER_DATABASE_PATH=.runtime/adr-<NNN>.sqlite`) so you never touch another worktree's state or the developer's live database.

Done when: the worktree exists, `npm test` baseline is recorded, and no edits have been made yet.
