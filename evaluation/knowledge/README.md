# Fictional knowledge evaluation (local, provisional)

Bounded local evaluation artifacts for the PRD knowledge-acceptance gate.
Everything under this directory is explicitly fictional: invented
businesses, prices, policies, people, and ground truth. Nothing here is
real, confirmed, or authoritative, and no result from this harness is a
production guarantee.

## Contents

- `businesses.json` — three isolated fictional businesses and their
  `containerTag` scope names (`gather:business:<id>`).
- `corpus.json` — representative documents: old/new prices, a signed scoped
  exception, duplicates, irrelevant text, similar customer names, changed
  policies, a withdrawn (deleted) sheet, and unknown-cost items. Status
  `active` means citable; `superseded` is history only; `deleted` must never
  be cited.
- `ground-truth.json` — questions with exact expected facts (source
  document, version, business), critical flags, and `mustAbstain` questions
  where any authoritative commercial conclusion is a gate failure.
- `thresholds.json` — acceptance thresholds established 2026-09-14 before
  any provider scoring: zero cross-business leakage, zero unsupported
  authoritative conclusions, 100% critical price/version/exception-scope
  correctness, >=95% fact precision, >=90% important-evidence recall.
- `fixtures/` — synthetic scorer fixtures. They test the scorer only and
  are never provider results.

## Scoring a provider (no provider is called by this harness)

1. Run the provider yourself against `corpus.json`, one `containerTag` per
   business, asking the `ground-truth.json` questions in business scope.
2. Transcribe its answers into the response JSON shape documented in
   `scripts/evaluate-knowledge.mjs` (questionId, abstained flag, assertions
   with factId/documentId/version/businessId links, optional real
   timestamps).
3. Score: `node scripts/evaluate-knowledge.mjs --responses <path> [--format json]`.
   Exit 0 means all gates pass, 1 means a gate failed.
4. Unanswered questions are reported as unmeasured and excluded from every
   denominator — never filled in, never scored as pass.
5. Latency is reported only from supplied timestamps; without them the
   report says unmeasured. No vendor figures are extrapolated.
