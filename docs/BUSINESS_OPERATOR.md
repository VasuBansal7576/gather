# Business operator (`src/server/business-operator`, DEMO ONLY)

Host integration over the shared GatherStore database: attributable
candidate intake, explicit owner decisions, and booking proposal
preparation/persistence. It never approves, sends, or holds — execution
stays in the existing approve/retry pipeline with fresh availability. Every
response is explicitly demo-marked; nothing here calls a live provider.

## Trust model

- Sources and customer/model text can never become approval authority.
  Candidate intake stores `probable`/`uncertain` evidence only; every
  decision path records approvals under the host-derived local owner
  identity (`GATHER_OWNER_ID`, default `local-owner`). Request-supplied
  actors are stripped at the route boundary and ignored by `decideOperator`.
- Knowledge used for offers comes only from `snapshotForOffers`
  (confirmed, active, non-review facts); changed-source facts are withheld
  with reasons and cannot reach a proposal.
- Availability observations are host-fetched and shape-checked here
  (`buildAvailabilityEvidence`); freshness is enforced by `prepareOffer`
  against its bounds. The availability calendar must equal the hold
  calendar. The approve pipeline rechecks availability immediately before
  any hold — a prepared proposal is never a hold.

## Endpoints (same-origin guarded, JSON only)

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/knowledge/candidates` | Intake an attributable candidate (businessId, key, value, confidence probable/uncertain, ≥1 source ref). |
| `GET` | `/api/knowledge/candidates?businessId=&status=` | List candidates with conflict flags. |
| `POST` | `/api/knowledge/decisions` | `{ kind: confirm/correct/reject/exception, ...params }`; actor always host-derived. |
| `GET` | `/api/knowledge/snapshot?businessId=` | Offer-ready snapshot (withheld facts listed with reasons). |
| `POST` | `/api/bookings/:bookingId/prepare` | Build an offer and, when feasible and fully specified, persist the exact proposal. |

New error codes: `DENIED` (403, non-owner or unauthorized actor),
`BUSY` (503 retryable, store contention — retry the command).

## Prepare contract

`POST /api/bookings/:bookingId/prepare` body: `{ sourceKey?, inquiry,
availability, calendarId, expiresAt?, email?, requestedVersion?,
supersedesFingerprint? }` with `email = { to, subject, body }`.

1. Loads the exact booking (404 when absent). An optional `sourceKey`
   resolves through the active identity link only; a missing link or a link
   to another booking is refused (never guessed).
2. Builds the offer from confirmed current knowledge, the validated
   inquiry, and the supplied availability. Inquiry/knowledge business
   mismatch is `CROSS_BOOKING`.
3. Persists a `create_provisional_hold` proposal **only** for a feasible
   primary with a known total **and** explicit `expiresAt`, `emailTo`,
   `emailSubject`, `emailBody`. Anything missing yields explicit
   `missingForProposal` entries (unknown recipients, dates, prices, or
   business facts are never invented). Floor, margin, budget, policy, and
   unknown-profit rules from the offer apply unchanged: unknown costs never
   claim profit; alternatives and blocked states persist nothing.
4. Persistence re-reads the backing knowledge revisions under the write
   transaction: a concurrent correction or review flag aborts with
   `STALE_PROPOSAL` instead of publishing a stale version. Repeating an
   identical persist reuses the existing proposal (fingerprint-bound
   idempotency, `reused: true`).

The persisted payload carries exactly `startAt/endAt/expiresAt/calendarId`
plus `emailTo/emailSubject/emailBody` and source references, with the
proposal version/fingerprint the approve pipeline binds. Approval, hold,
and send remain owner-gated downstream.

## Host duties left open

Validate raw inquiries upstream (`validator`/`validatedAt`); fetch
availability fresh per request with explicit venue/space scope; connect real
provider adapters plus approved account assets before any live use (live
gate stays BLOCKED); surface `missingInformation`/`ownerDecisions` and
`missingForProposal` in owner UX. No duplicate fact stores, knowledge
graphs, schedulers, or models were introduced.
