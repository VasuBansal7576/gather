# Business operator (`src/server/business-operator`, host integration)

Host integration over the shared GatherStore database: attributable
candidate intake, explicit owner decisions, and booking proposal
preparation/persistence. It never approves, sends, or holds — execution
stays in the existing approve/retry pipeline with fresh availability.

## Trust model (enforced, not gated)

- The HTTP request supplies inquiry *content* and owner *decisions to make*;
  it can never supply availability evidence, provenance, or validator
  identity. A request `availability` field is rejected outright; forged
  `validator`/`validatedAt` values are stripped and replaced with this
  host's citation (`business-operator-host` plus the trusted clock).
- Candidate intake runs only through the strict host boundary
  (`intakeOperatorCandidate`, also wired into `POST /api/knowledge/candidates`
  with no raw serving bypass): every source reference requires a known kind,
  a bounded non-empty locator, a bounded string label when present, and a
  boolean fictional flag when present (bounded set size; bounded
  client-chosen intake ids). The knowledge service re-checks the same shape
  for direct callers, so malformed provenance never persists.
- Availability is always fetched fresh through the injected typed
  `CalendarAvailabilityReader` for exactly the hold calendar and window,
  under a canonical binding key plus a fresh per-read time/nonce suffix:
  `operator-prepare:<bookingId>:gather:calendar:availability:<digest>:<now>:<rand>`.
  The digest binds booking/business/calendar/window for audit; the suffix
  keeps every read fresh and never cached-reused. A failing reader degrades
  to explicitly empty evidence — unavailable, never invented — with the
  failure recorded.
- Sources and customer/model text can never become approval authority.
  Candidate intake stores `probable`/`uncertain` evidence only (nested
  source objects strictly validated); every decision path records approvals
  under the host-derived local owner identity. Request-supplied actors are
  stripped at the route boundary and ignored.
- Knowledge used for offers comes only from `snapshotForOffers`
  (confirmed, active, non-review facts); changed-source facts are withheld
  with reasons and cannot reach a proposal. Unparseable snapshot facts fail
  preparation instead of preparing on a silent subset.

## Result mode (correlated, never unconditional)

Responses carry `mode` derived from the actual availability port response
and the accepted facts: `live` only for a non-simulated reader response
with zero fictional sources; otherwise explicitly `demo` with fixture
content preserved as labeled. Simulated evidence is never passed as live.

## Endpoints (same-origin guarded, JSON only)

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/knowledge/candidates` | Intake an attributable candidate (businessId, key, value, confidence probable/uncertain, ≥1 strict source ref). |
| `GET` | `/api/knowledge/candidates?businessId=&status=` | List candidates with conflict flags. |
| `POST` | `/api/knowledge/decisions` | `{ kind: confirm/correct/reject/exception, ...params }`; actor always host-derived. |
| `GET` | `/api/knowledge/snapshot?businessId=` | Offer-ready snapshot (withheld facts listed with reasons). |
| `POST` | `/api/bookings/:bookingId/prepare` | Build an offer and, when feasible and fully specified, persist the exact proposal. |

Body: `{ sourceKey?, inquiry, calendarId, expiresAt?, email?, requestedVersion?, supersedesFingerprint? }`
with `email = { to, subject, body }`. New error codes: `DENIED` (403),
`BUSY` (503 retryable, store contention — retry the command).

## Prepare contract

1. Loads the exact booking (404 when absent). An optional `sourceKey`
   resolves through the active identity link only; a missing link or a link
   to another booking is refused (never guessed).
2. Validates inquiry content server-side (structural failures name the
   path; semantic gaps flow to explicit missing decisions), stamps host
   validator identity, and rejects cross-business inquiries.
3. Fetches fresh availability, adapts confirmed knowledge, and prepares the
   offer. Floor, margin, budget, policy, and unknown-profit rules apply
   unchanged: unknown costs never claim profit; alternatives and blocked
   states persist nothing.
4. Persists a `create_provisional_hold` proposal **only** for a feasible
   primary with a known total **and** explicit `expiresAt`, `emailTo`,
   `emailSubject`, `emailBody`. The payload carries a validated immutable
   copy of the reviewed primary's commercial terms (`payload.offer`: lines,
   totals, deposit, currency, space, guests, consequences, unknown-cost
   honesty) plus `payload.offerPreparationFingerprint`, all inside the
   canonical proposal fingerprint — so price-only, deposit-only, or
   space/terms changes persist as new actions that cannot reuse a prior
   approval. Anything missing yields explicit `missingForProposal` entries
   (unknown recipients, dates, prices, or business facts are never invented).
5. Persistence re-reads the backing knowledge revisions under the write
   transaction: a concurrent correction or review flag aborts with
   `STALE_PROPOSAL` instead of publishing a stale version. Repeating an
   identical persist reuses the existing proposal (fingerprint-bound
   idempotency, `reused: true`), after re-verifying the found row is live
   and carries a live status.

The persisted payload carries exactly `startAt/endAt/expiresAt/calendarId`
plus `emailTo/emailSubject/emailBody`, the validated `offer` commercial
snapshot, and `offerPreparationFingerprint`, with source references, with the
proposal version/fingerprint the approve pipeline binds. Approval, hold,
and send remain owner-gated downstream.

## Host duties left open

Validate raw inquiry content before calling (the operator re-validates);
connect real provider adapters plus approved account assets before any live
use (live gate stays BLOCKED — without a serving reader every prepare is
explicitly unavailable); surface `missingInformation`/`ownerDecisions` and
`missingForProposal` in owner UX. No duplicate fact stores, knowledge
graphs, schedulers, or models were introduced.
