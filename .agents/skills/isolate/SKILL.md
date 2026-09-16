---
name: isolate
description: Inspect state and use a fresh worktree before changing Gather files.
---

# Isolate

1. Read `AGENTS.md`, the requested scope, and relevant documentation. A paused ADR is not an implementation instruction.
2. Inspect `git status`, branches and worktrees; fetch `origin/main`.
3. For a new task create a fresh worktree/branch from `origin/main`; for a follow-up continue the existing clean PR worktree after checking remote state. Never edit another worker's checkout or overwrite uncommitted work.
4. Run `npm ci`, `npm test` and `npm run typecheck` before changes. Record failures and real skips in the PR. Do not infer clean-checkout reproducibility from untracked local files.
5. For maintenance, use the bounded scope in the request/PR. For authorized feature work, use the accepted ADR's owned files. Explain any necessary scope change before editing unrelated files.
6. Create a fresh `.runtime/` in this worktree and pass `GATHER_DATABASE_PATH` explicitly to every app invocation. Never use another checkout's database or personal OpenClaw state.

Done when the worktree and baseline are established. No parallel workers unless explicitly requested.
