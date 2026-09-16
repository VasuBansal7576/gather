# ADR-005: Knowledge rules and self-improvement UX

Status: ready
Depends on: ADR-002, ADR-003
PRD: 4.2, 4.3, 5, 10 (Understanding, Knowledge lifecycle, Evaluation gates)

## Decision
Business knowledge is typed, sourced, scoped and versioned, and the owner can add or correct it in plain language with visible scope and citation. Every correction becomes a regression case; Gather re-scores itself on that business's own past inquiries and shows the trend. This is the honest form of "self-improving": measured, per business, without code changes.

## Owns
- `src/knowledge/**` (typed fact schema, owner-rule parsing, versioning, empty-state semantics)
- New `src/evals/**` (regression case store, scorer over past inquiries, trend)
- `app/api/knowledge/**`, new `app/api/evals/**`
- Business-understanding view, approval-invalidation presentation, and trend chart in `src/components/gather/**`, `src/host/**`
- `evaluation/knowledge/**` (reuse the existing scorer fixtures)
- `tests/knowledge-rules.test.ts`, `tests/evals*.test.ts`; extend `tests/golden-path.test.ts` steps 15 to 17

## Must not touch
- `src/runtime/**`, `src/connectors/google/**`, `src/intents/**`, `src/incidents/**`
- Floor enforcement in `src/server/booking-service.ts` (ADR-003 owns it; consume its results)

## Do
- Fact schema: `type (package | price | capacity | space | policy | customer_arrangement | owner_rule | booking_fact)`, `value`, `source {kind, locator, observedAt}`, `scope (business | customer:<id> | booking:<id>)`, `version`, `effectiveFrom?`, `effectiveTo?`, `supersedes?`. Writes without a type or source are rejected at the store.
- Owner rule input: a single text box in the Business understanding view. Parse to a typed fact with scope; show the parsed result ("Policy, business-wide: no events on Sundays. Source: you, today") and require one confirm click. Unparseable input asks one clarifying question; it never stores free text as a rule.
- Corrections create a new version with `supersedes`; pending proposals that relied on the superseded version are flagged "policy changed, re-check" through the existing proposal authority path. Accepted commitments are untouched.
- Empty states: no facts -> "No business information yet." Proposal preparation with a missing price fact produces a question to the owner, not a number.
- Approval invalidation presentation: version history on the proposal card; the superseded approval shows "Invalidated by price change on <time>" and the new version shows "Awaiting approval".
- Evals: each owner correction and each composer disagreement (ADR-003) becomes a regression case `{inquiry, expected fields/price/decision, source}`. `POST /api/evals/run` scores current behavior over the business's cases deterministically (fields, price, decision) and stores a run. Trend chart on the Today view: score per run, with the correction that preceded each change.
- Sent-mail mining (prepared business): from the seeded "sent" replies, extract candidate facts (price quoted, policy stated) as unconfirmed candidates the owner can confirm in one click. Label them "inferred from your past replies".
- Golden path additions: 15) owner rule "we don't do Sundays" -> next Sunday inquiry gets an alternative date and cites the rule; 16) correction of a price -> pending proposal flagged, accepted booking unchanged; 17) two eval runs with a correction between them show a changed score and the case that changed it.

## Don't
- Don't let the model write to the fact store directly; only the typed write path.
- Don't use an LLM judge for the deterministic parts of the score; only for free-text similarity if you add one, and then label it as such.
- Don't promote a customer-scoped exception to business scope automatically.
- Don't claim "learned" in the UI; say "remembered" with the citation, and "score" with the run.

## Out of scope
Real inbox history (ADR-006). Memory-wiki acceptance gate against OpenClaw native recall (future ADR).

## Acceptance
- Screenshots: rule typed -> parsed confirmation -> stored fact with scope and source; Sunday inquiry alternative citing the rule.
- Screenshot of proposal version history with invalidated and awaiting states.
- Trend chart with at least two runs and the correction annotated; API transcript of the runs.
- Store-level test rejecting an untyped or unsourced fact.
- Golden path green including steps 15 to 17.
- `npm test`, `npm run typecheck`, `npm run build` pass.
