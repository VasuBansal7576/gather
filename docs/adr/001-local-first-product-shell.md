# ADR-001: Managed customer delivery and local inspection

Status: reconciled design contract — feature implementation remains paused. Existing defect repairs are authorized.

PRD: 1–3, 7, 8.1–8.3, 10.

## Reconciled decision

Customers use a managed web workspace. Gather hosts a dedicated isolated OpenClaw instance per business, owns pinned updates and operates an external supervisor. This supersedes the former customer-installed/local-first proposal; the historical filename is retained for existing links. No `npx github:` installer or second local customer product is required.

The current Next.js/SQLite checkout is a developer inspection path, not a hosted-ready deployment. Preserve its documented clone/install/build/start workflow and loopback binding. `local-owner` is not hosted authentication. Do not publish the prototype as a SaaS before authenticated tenant scope and runtime isolation are proved.

## State and fixture boundaries

- Preserve `data/gather.sqlite` as the existing default. Tests/inspection explicitly choose isolated paths. Any later migration must inventory all stores/runtime consumers, back up, migrate and verify existing records; changing one default is not a migration.
- Keep fixtures visibly simulated and opt-in. Current seeds contain two bookings with pre-created proposals, not a demonstrated intake-to-offer journey.
- A future fixture reset operates only on fixture-owned state after confirmation, never a shared database deletion or another business's records.
- Fixture inspection needs neither model credentials nor OpenClaw. Real runtime/model recovery belongs to the separate opt-in harness in ADR-004.
- Keep private strategy, hosting vendors and commercial plans outside public docs.

## Existing interfaces / future scope

`app/setup/`, `src/setup/`, `src/server/runtime.ts`, `src/server/sqlite-store.ts`, `src/server/demo-fixtures.ts`, the launcher/doctor and README describe the current path. Hosted authentication/provisioning and richer prepared-business UX are unbuilt features, not instructions to implement now. Any later implementation plan must include every actual state-path owner rather than forbid runtime/store changes while moving their data.

## Required future evidence

Documented inspection from a fresh checkout; explicit simulation labels; no personal runtime access; fixture reset isolation if implemented. For hosted delivery: authenticated business scope on all routes, isolated runtime/credential/file access, lifecycle recovery and owner onboarding without local installation. Existing prototype tests alone cannot pass the hosted gate.
