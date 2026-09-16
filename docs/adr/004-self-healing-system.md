# ADR-004: Self-healing system

Status: ready
Depends on: ADR-002
PRD: 6 (all subsections), 10 (Self-healing gate, Recovery gate)

## Decision
Failures are detected automatically from failed intents, runtime health probes and dead-lettered work, recorded as incidents, and repaired by a Gather-owned repair agent choosing only from a fixed catalog of actions, each verified before the original intent resumes. The owner sees a plain-language repair thread or an honest blocked state. A labeled fault-injection panel on the prepared business drives the same path so judges can break things and watch them heal.

## Owns
- New `src/incidents/**` (contracts, store, detector, catalog, repair runner, verifier)
- `src/server/sqlite-store.ts` (new `incidents`, `repair_attempts` tables and migration only)
- `src/server/operator-runtime/health.ts`, `src/server/operator-runtime/due-work.ts` (emit incidents)
- New `app/api/incidents/**`, `app/api/faults/**` (prepared business only)
- Recoveries view and repair-thread components in `src/components/gather/**`, `src/host/**`
- `tests/incidents*.test.ts`, `tests/faults*.test.ts`; extend `tests/golden-path.test.ts` steps 11 to 14

## Must not touch
- `src/runtime/**` beyond calling its existing start/stop/health methods
- Pricing, approval, receipt logic; `src/connectors/google/**`; `~/.openclaw`

## Do
- Incident record: `id, businessId, source (intent | probe | deadletter | injected), signature, symptom, evidence (json: logs, step, error), state (open | repairing | recovered | blocked), attempts[], resumedIntentId?, createdAt`.
- Detector: subscribe to intent transitions to `failed`; poll runtime health at a fixed interval; scan dead letters. Deduplicate by `signature + businessId` while an incident is open.
- Catalog (`src/incidents/catalog.ts`), each entry `{ id, matches(incident), preconditions, run, verify }`:
  `restart_runtime`, `resume_sync_from_cursor`, `reconcile_execution_by_external_id`, `refresh_access`, `request_reconnect`, `rollback_config_known_good`, `rerun_resumable_intent`, `mark_blocked`. Nothing else is callable by the repair runner.
- Tier 1: deterministic mapping from known signatures to catalog entries. Implement for at least: runtime not responding, access expired, sync cursor corrupt, email failed after hold succeeded, database locked.
- Tier 2: for unknown signatures, a model call that receives the incident evidence and the catalog ids, and must return one catalog id plus a one-paragraph diagnosis. Validate the id against the catalog; any other output falls back to `mark_blocked`. The model never receives write tools.
- Verification is per catalog entry and must pass before state becomes `recovered`; `rerun_resumable_intent` then resumes the original intent through ADR-002's runner. Completed receipts are never redone.
- Bound to three attempts per incident, then `blocked` with all attempts listed. `request_reconnect` produces a reconnect action for the owner, never a claimed repair.
- Fault panel (prepared business only, behind a visible "Break something (simulated)" control): stop runtime, expire access, corrupt sync cursor, fail next Calendar call, fail email after hold, and one unrepairable fault ("provider permanently rejects") that must end `blocked`. Each injected incident is marked `source: injected`.
- Recoveries view: list of incidents with state; detail shows symptom -> diagnosis -> action -> verification -> resumed, in plain language. Workspace shows a small "Gather recovered from X" affordance linking to it.
- Golden path additions: 11) inject "fail email after hold" during execute -> incident opens -> recovered -> exactly one hold receipt, one email receipt; 12) inject runtime stop -> restart_runtime -> pending intent resumes; 13) inject unrepairable -> blocked after three attempts, attempts listed; 14) inject expire access -> state shows reconnect action, no fake recovery.

## Don't
- Don't let the business agent repair itself; the repair runner is a separate module with its own narrow interface.
- Don't add free-form shell, file or network tools to the repair agent.
- Don't recreate a hold because an email failed.
- Don't mark `recovered` on "action returned without error". Verification is a separate function.
- Don't auto-apply code changes. If a signature suggests a code defect, write `.runtime/repairs/<incident>.md` with the reproduction and stop.
- Don't retry the same failing action past the bound, and don't hide the give-up.

## Out of scope
Real provider failures (ADR-006 will route them here unchanged). Eval trend (ADR-005).

## Acceptance
- Screen recording or screenshot sequence for each of the four golden-path faults: fault panel click -> incident open -> repair thread -> recovered or blocked -> intent completed or reconnect action.
- SQL counts after fault 11: one hold receipt, one email receipt for the booking.
- Repair thread screenshot showing all five sections in plain language.
- Blocked incident screenshot listing three attempts and the operator message.
- Test asserting the repair runner cannot call anything outside the catalog (attempt an unknown action id, assert rejection).
- Golden path green including steps 11 to 14.
- `npm test`, `npm run typecheck`, `npm run build` pass.
