# Working on Gather

## Current scope

This public repository is the **hackathon build**, governed by `docs/HACKATHON_PRD.md` and its hackathon ADRs. Preserve its local-first distribution, prepared-business path and event-specific requirements. The private SaaS is a different product scope; do not import its hosted-delivery, billing or operational requirements here. A difference between the two is not a defect.

Feature implementation is paused at the owner's request. The active task is repository recovery: understand the product, correct misleading documentation and conflicting PRD/ADR instructions, repair existing application defects, and repair build/test/CI reproducibility. Application code is in scope for evidenced repairs; do not execute the unbuilt PRD/ADR backlog, remove existing modules, migrate data, or invent a new product direction.

Read [README.md](README.md) and [docs/README.md](docs/README.md) first. The [PRD](docs/HACKATHON_PRD.md) describes intended behavior, not current capabilities. ADRs 001–006 are hackathon proposals with future acceptance evidence; they are not approved implementation tasks. Only an explicit owner instruction resumes feature work.

## Workflow

- Inspect Git state and use an isolated worktree; continue the existing clean PR worktree for follow-up repairs, or create a fresh one from `origin/main` for a new task. Never overwrite another worker's files or runtime state.
- Use the repository's `isolate`, `build`, `prove`, and `ship` skills in `.agents/skills/`. Maintenance can use a bounded PR scope; feature work requires an accepted ADR. User instructions take precedence over either.
- No delegation or parallel workers unless requested. An ADR marked ready is not a dispatch instruction.
- Keep changes reviewable. Record before/after evidence and unresolved findings in the PR, not a new progress ledger. Do not mark planned work implemented or a PR merged without evidence.
- Open PRs ready for review, never draft. Do not merge or deploy unless explicitly authorized. If a reviewer is unavailable, report that fact; do not claim review approval or wait indefinitely for an unconfigured service.

## Boundaries

- Never read or write the developer's personal `~/.openclaw` for Gather work. Any Gather runtime must use its own root and isolated environment. `src/runtime/` owns the Gateway/process boundary; existing server/knowledge modules consume it.
- Preserve deterministic server-side authority, recipient, scope, pricing, and approval checks. Prompts and memory never replace enforcement. Missing checks are defects/design gaps, not permission to claim the intended boundary already exists.
- Preserve explicitly simulated labels on fixtures, UI states, and receipts. A test pass, model statement, or successful tool return is not evidence of a real external outcome.
- Do not use live credentials or contact Google/model providers during default checks. Real runtime tests require an explicit `GATHER_TEST_OPENCLAW_BIN`; never discover and boot the developer's installation implicitly.
- Never commit credentials, databases, `.runtime/`, customer data, or personal account identifiers. Tests must own their temporary state and keep fictional input fixtures in Git, not depend on a shared `/tmp` file.
- Do not change existing database paths or delete data as a documentation fix. Supply `GATHER_DATABASE_PATH` explicitly for local inspection.
- Preserve unrelated settings; no speculative dependency/framework swaps or removal of existing modules.

## Validation

Node.js 26+; use `.node-version` for the checked baseline. Run `npm ci`, `npm test`, `npm run typecheck`, and `npm run build`. The doctor also needs an existing `.runtime/` directory. `npm run lint` currently aliases typechecking.

Keep skips visible. The full product golden-path test does not exist yet; do not claim it passed. Add focused regression/integration tests for existing behavior repaired during cleanup; this does not authorize building the missing product journey. Once separately implemented, it must remain green. UI changes need rendered evidence; docs/config-only changes do not need invented screenshots.
