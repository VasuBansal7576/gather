# Bounded source-to-candidate extraction boundary (SIMULATED, unverified)

Executable boundary in `src/knowledge/extraction/` with regression coverage
in `tests/knowledge-extraction.test.ts` (injected fake backends only).
**No live model or provider has been contacted; actual backend connection
and semantic evaluation are explicit separate gates, not claimed here.**
Confidence categories (`probable`/`uncertain`) are uncalibrated labels —
never invented probabilities, never precision/recall.

## Architecture

The trusted host pins business/account/source locator/revision/content
digest and hands the backend bounded text. The injected typed backend
(`ExtractionBackend`) returns UNKNOWN untrusted data; task/result identity
(`backendId`, `taskId`, `simulated`) travels in the trusted envelope built
by the backend host object, never parsed from model JSON. The host
validates every candidate — vocabulary, probable/uncertain only, finite
JSON object, bounded length/count/depth, evidence spans that actually
occur in the supplied text — then feeds survivors through the existing
`KnowledgeService.intakeCandidate` with host-supplied source references.
Content stays data: this module has no path to confirm/correct/exception,
identity links, payments, or provider actions, and it preserves
do-not-auto-confirm. The design reuses the OpenClaw task-port concepts
(`submitTask` idempotency keys, terminal-wait semantics from
`src/runtime/tasks.ts`) instead of creating an agent scheduler. No keyword
heuristic pretends at model reasoning: structure and containment checks
only, no text classification anywhere.

## Exact API contract (for later runtime host wiring)

```ts
// Backend port (implement against a real task API at the connection gate).
interface ExtractionBackend {
  readonly backendId: string;
  readonly simulated: boolean;
  submitExtraction(s: { idempotencyKey: string; sourceDigest: string; text: string; maxCandidates: number })
    : Promise<{ taskId: string; acceptedAt: number; idempotencyKey: string }>;
  awaitExtraction(taskId: string, timeoutMs: number)
    : Promise<{ status: "ok" | "error" | "timeout" | "unknown"; payload: unknown; error?: string }>;
}
class BackendUnavailableError extends Error { code: "backend_unavailable" }

// Host entry point.
extractSourceCandidates(
  service: KnowledgeService,
  backend: ExtractionBackend,
  input: {
    source: {
      businessId: string; accountId: string;
      kind: "connected_account" | "document" | "email" | "calendar" | "manual" | "fixture";
      locator: string; label?: string; fictional?: boolean; sourceRevision?: string;
    };
    text: string;                    // bounded retrieved text, never silently cut
    idempotencyKey: string;          // caller-persisted per (business, source, bytes); intake ids derive from it
    contentDigest?: string;          // sha256 hex; mismatch fails closed before any backend call
    maxCandidates?: number;          // 1..MAX_CANDIDATES
    awaitTimeoutMs?: number;         // positive integer; default 30_000
    ledger?: ExtractionLedger;       // optional same-handle lineage ledger (createExtractionLedger)
  },
): Promise<{
  status: "accepted" | "no_relevant_facts" | "needs_review" | "invalid" | "backend_unavailable";
  backendId: string; taskId?: string; simulated: boolean;
  accepted: Array<{ key: string; subjectId: string; value: Record<string, unknown>;
                    confidence: "probable" | "uncertain"; candidateId: string; evidence: string[] }>;
  rejected: Array<{ index: number; reason: string }>;
  reason?: string;
}>
```

Outcome semantics: `accepted` (all fed, pending only), `no_relevant_facts`
(empty array, zero rows), `needs_review` (valid subset fed as pending with
explicit per-candidate reasons for the rest), `invalid` (nothing fed —
malformed payload, bound/digest violations, scope conflicts, dead lineage
ledger, zero survivors), and `backend_unavailable` (submit/await failure,
echo mismatch, or non-`ok` terminal status, nothing fed). Runtime wiring
must persist `idempotencyKey` per (business, account, source, bytes) —
reuse across scopes fails closed instead of skewing lineage — and reuse it
on retry; replays dedupe via derived intake ids. The submission
idempotency echo and task id are validated before anything downstream may
name the run; every await failure maps to `backend_unavailable`, never a
raw throw. The lineage ledger must wrap the same database connection the
service runs on (`ledger.db === service.database`); a foreign handle is
refused before any backend call.

## Canonical intake identity and lineage ledger

Per-candidate intake ids derive deterministically from business + account +
source locator + revision + content digest + backend id + task id + caller
command + position. Retries reproduce them exactly (stable dedupe through
intake's content match); an altered replay under the same command hits the
identity row with different content and is rejected deterministically
instead of leaking a raw `UNIQUE` error.

Account identity is server-fixed and persisted: `knowledge_candidates`
and `knowledge_revisions` carry `account_id`, content dedupe, supersede
detection, conflicts, and the active-revision uniqueness are all scoped by
it, and confirm/correct move one account's line without touching another's
(`correctFact` takes `accountId`, defaulting to the legacy `""` line).
Two accounts sharing one locator and value therefore mint separate rows,
facts, and revision lines — the previous cross-account aliasing is closed.

`createExtractionLedger(db)` opens two extraction-owned tables on the same
SQLite handle (never a second database): `extraction_runs` (one row per
idempotency key: business, account, locator, revision, digest, backend,
task, simulated flag, terminal status) and `extraction_run_candidates`
(index, candidate/intake ids, key, subject, confidence, original evidence
quotes). The run row is written first with status `started`, so a caller
key reused across business/account/locator/digest fails closed before any
candidate mutation, and a dead ledger fails typed with zero rows fed.
Candidate intake and its lineage row commit atomically inside the intake
transaction on the same connection (via the intake `atomically` hook) or
roll back together — a lineage failure reports `lineage write failed`
with no surviving candidate row. Every post-submit terminal outcome
records its run row; candidate slots colliding with different content
throw instead of silently overwriting. Simulated origin therefore
survives owner confirmation and snapshots: the ledger still names the
fake backend run, and each candidate row carries an extraction note —
owner confirmation is never evidence of an actual model run.

## Bounds

| Bound | Value | Violation |
| --- | --- | --- |
| source text | 32_768 bytes | `invalid`, backend never called |
| candidates per result | ≤ 20 | `invalid` whole result |
| candidate value | ≤ 4096 bytes JSON, depth ≤ 6, ≤ 64 top-level keys, ≤ 256 total keys, ≤ 10_000 nodes, finite only | per-candidate reject |
| key / subjectId | ≤ 128 / ≤ 256 bytes | per-candidate reject |
| evidence spans | 1..8 quotes, each ≤ 2000 bytes, each a verbatim substring of source text | per-candidate reject |

## What model output cannot mint

Business/source IDs, locators, revisions, provenance, `verified`
confidence (rejected, never coerced), owner decisions, availability keys,
payments, account links, or provider action authority. Spoofed identity
fields are ignored — stored attribution always equals the host pin — and
only an explicit owner decision through `KnowledgeService` can create a
verified fact. Failed extraction leaves zero candidates and zero verified
facts; partial batches name every rejection.

## Open gates (not this change)

1. **Backend connection**: implement `ExtractionBackend` against the real
   task API (gateway `agent` submit/wait), keeping identity in the trusted
   envelope and `simulated: false`.
2. **Semantic evaluation**: fixtures here assert structure only. Scoring
   extraction quality (relevance, span choice, confidence choice) needs an
   owner-judged frozen suite; mapper bias is the known uncertainty until a
   production backend exists to measure.

## OpenClaw task backend

`src/knowledge/extraction/openclaw-backend.ts` implements
`ExtractionBackend` over the existing isolated runtime task channel
(`GatherRuntimeTasks`: `agent` / `agent.wait` / `chat.history`). Nothing is
registered by default — the host constructs it with a validated
`{businessId, accountId}` scope and the runtime's task channel.

- One isolated stable session per task (`bookingSessionKey` over
  `extraction:<businessId>:<accountId>:<idempotencyKey>:<sourceDigest>`);
  the caller's persisted idempotency key plus the pinned digest fold into a
  scope-bound gateway key via `stableTaskIdempotencyKey`, so retries dedupe
  and no foreign scope/task/digest run can be adopted. A resubmitted caller
  key supersedes its older run ids explicitly instead of aliasing.
- The instruction pins the source digest, carries an in-text task marker
  (`gather-extraction:<idempotencyKey>`) matched as an exact marker line,
  fences source text as untrusted content, and grants the model no
  approval/spend/send authority. Model text and echoed markers are never
  identity authority — the session binding and trusted envelope are.
- `awaitExtraction` only accepts run ids this scope submitted, maps wait
  statuses 1:1 (`timeout` stays wait-only, `error` covers cancellation),
  and on `ok` reads the task's own session history for the first assistant
  text after the marker message — parsed strictly to `unknown` under a byte
  bound. Channel failures throw `BackendUnavailableError` →
  `backend_unavailable`. The submitted-run map is in-memory: pre-restart run
  ids await as `unknown` until the caller re-submits.

Tests fake only the gateway channel with explicit simulated fixtures
(`simulated: true`). No live model, provider, gateway, or credentials were
contacted; a real OpenClaw run remains unverified.
