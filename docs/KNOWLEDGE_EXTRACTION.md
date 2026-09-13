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
    idempotencyKey: string;          // caller-persisted; per-candidate intake ids derive from it
    contentDigest?: string;          // sha256 hex; mismatch fails closed before any backend call
    maxCandidates?: number;          // 1..MAX_CANDIDATES
    awaitTimeoutMs?: number;         // default 30_000
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
malformed payload, bound/digest violations, zero survivors), and
`backend_unavailable` (submit/await failure or non-`ok` terminal status,
nothing fed). Runtime wiring must persist `idempotencyKey` per
(source, bytes) pair and reuse it on retry; replays dedupe via derived
intake ids.

## Bounds

| Bound | Value | Violation |
| --- | --- | --- |
| source text | 32_768 bytes | `invalid`, backend never called |
| candidates per result | ≤ 20 | `invalid` whole result |
| candidate value | ≤ 4096 bytes JSON, depth ≤ 6, ≤ 64 top-level keys, finite only | per-candidate reject |
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
