---
name: prove
description: Verify the actual changed Gather behavior and report honest evidence.
---

# Prove

Keep local evidence under ignored `.evidence/`; put inspectable summaries, command output or CI links in the PR. An ignored local path alone is not a public evidence link.

1. Show the before/after for the actual change: source excerpts or command output for docs/config, failing/passing reproductions for defects, rendered interaction for UI.
2. Run `npm test`, `npm run typecheck` and `npm run build`; state the revision and any skips/failures. Run the golden path only once it exists; until then say it is absent.
3. For authorized feature work, account for every ADR acceptance item. Missing evidence stays missing; never alter criteria to manufacture a pass.
4. Label simulated, scripted and real provider evidence separately. Tool returns and model prose do not establish external effects.
5. For UI changes, capture desktop/mobile rendered evidence. For persistence changes, restart against the same isolated database. Neither requirement applies automatically to documentation-only work.

For an isolated app inspection, set the database on the **server process**, not merely on the preceding build:

```sh
mkdir -p .runtime
npm run build
GATHER_DATABASE_PATH=.runtime/review.sqlite npm start -- --hostname 127.0.0.1 --port <free-port>
```

Do not reuse an existing developer database or stop an unrelated server. Do not include credentials or personal/customer content in evidence.
