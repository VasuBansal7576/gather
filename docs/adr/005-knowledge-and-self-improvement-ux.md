# ADR-005: Native business knowledge, transactional authority and evaluation

Status: reconciled design contract — feature implementation remains paused. Existing defect repairs are authorized.

PRD: 4–4.3, 7, 8.5, 10. Related: ADR-002, ADR-003.

## Reconciled decision

Use OpenClaw native recall plus bundled memory-wiki first, subject to the knowledge gate. Do not defer that gate until after building a competing fact engine. Existing SQLite fact/candidate modules remain prototype code to preserve during cleanup, not approval to expand them into the permanent knowledge architecture or delete/migrate them without evidence.

## Knowledge and authority contracts

- Supported native interfaces hold attributable business understanding. Preserve business/customer/booking scope, source identity/version, observation/effective times and uncertainty.
- Gather-controlled boundaries validate commercial assertions and owner confirmations. Memory text alone cannot grant authority or bypass deterministic pricing/recipient/approval checks.
- Transaction records freeze the terms, policy versions and exact action identity relied on by offers/approvals. They establish commitments and effects, not a second general retrieval/policy engine.
- Candidate extraction does not automatically become current policy. Customer claims and historical sent replies remain scoped evidence until their authority/applicability is established.
- Owner correction affects the relevant pending work; accepted commitments remain unchanged. Deletion/revocation/staleness propagates to derived context, and missing retrieval is never proof of no policy.
- Missing pricing evidence produces a question, not an invented number. Useful progressive import does not imply complete account coverage.

## Evaluation and UX

Native-knowledge proof must cover changed prices, conflicting sources, customer-only exceptions, deletion and restart recall before adoption. Add another memory/search component only for an evidenced gap. Source mapping/migration and failure behavior must be designed before wiring native knowledge into the existing application.

Owner correction UX and per-business evaluation trends remain intended features. Preserve human-reviewed regression cases; deterministic arithmetic/authority/isolation checks are not replaced by an LLM judge. Semantic scoring is calibrated and labeled. A score change does not prove business improvement, revenue uplift or successful provider execution.

## Existing interfaces / future scope

`src/knowledge/`, `src/offers/`, `business-operator/` and knowledge routes describe current prototype contracts. No new parallel schema/store is mandated. Do not delete those modules or silently switch their authority during cleanup. Future migration needs compatibility, rollback and changed/deleted-evidence tests.
