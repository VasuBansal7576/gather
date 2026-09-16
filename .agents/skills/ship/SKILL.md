---
name: ship
description: Open a PR for an ADR with the evidence embedded, then loop with automated review until there are zero unresolved comments. Use after prove.
---

# Ship

1. Commit on your `adr-<NNN>-*` branch. Message: what changed and why, one paragraph. No co-author trailers.
2. Push and open the PR against `main` with `gh pr create`. Body template:

```
## ADR
docs/adr/NNN-slug.md

## What changed
<3 to 6 bullets>

## Evidence
| Acceptance item | Artifact |
|---|---|
| ... | <inline image or link to .evidence/adr-NNN/...> |

Before/after: <images>
Suite: npm test <n> passed, typecheck ok, build ok, golden path ok
Simulated vs real: <state which artifacts are simulated, scripted, or real>

## Follow-ups
<things noticed but outside this ADR's Owns list>
```

3. Wait for review (Greptile or the reviewer agent). For each comment: fix it or reply with the reason it is wrong, citing the ADR. Push again. Repeat until the reviewer reports no unresolved comments and the PR body's evidence table has no missing rows.
4. Do not merge. The integrator merges (see `coordinate`). Do not mark the ADR `shipped`; the integrator does.
5. After merge, remove your worktree: `git worktree remove ../gather-adr-<NNN>`.

A PR without the evidence table is returned unread.
