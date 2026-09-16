---
name: ship
description: Publish a ready-for-review Gather PR with validation and known limitations.
---

# Ship

1. Review the diff for scope, secrets, generated files and accidental product changes. Commit only the authorized change on its isolated branch. No co-author trailers.
2. Push and open a **ready-for-review**, never draft, PR. Describe the problem, fix and actual validation concisely. Link the ADR for authorized feature work; maintenance may cite its bounded scope instead.
3. Include inspectable before/after evidence and exact test/build results. Distinguish passed, failed, skipped, not run and not implemented. Never paste a template claiming the golden path passed when it does not exist.
4. Check actual CI and available review comments on the exact head. Fix relevant failures and address comments without weakening tests. Do not assume Greptile or another reviewer is configured; absent review is unreviewed, not approval and not an indefinite wait.
5. Do not merge or deploy without explicit authorization. Report the PR link, CI state and remaining blockers. Do not mark an ADR shipped before a verified merge.
6. Retain the worktree while the PR is open. Remove it after merge only if clean and no longer needed; never discard someone else's work.

Suggested PR shape: Problem / Changes / Validation / Remaining limitations. Feature PRs additionally map the accepted ADR's evidence requirements. No progress ledger is needed.
