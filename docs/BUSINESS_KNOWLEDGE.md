# Business knowledge boundary

`src/knowledge/` implements the source-linked business understanding lane:
extracted content from connected documents/messages arrives as **untrusted
candidates** (`probable` or `uncertain`), and only an **explicit owner
command** can mint the verified `BusinessFact` rows the rest of Gather (and
the offers adapter) consumes.

This is deliberately a booking-business facts + approval boundary, not a
generic wiki/graph/memory platform: keys are the shared fact vocabulary
(`business`, `space`, `policy`, `price_line`, `cost`, `pricing_bounds`,
`service`, `scoped_exception`) that `adaptBusinessFacts` in the offers lane
already understands.

## Trust model

| Actor kind | Capability |
| --- | --- |
| `owner` | confirm, correct, scoped exceptions, candidate rejection — every decision is audited |
| `service`, `agent`, `content` | **denied** — attempts throw `KnowledgeDeniedError` and are recorded in the decision audit; retrieved instructions embedded in content are inert data, never commands |

Untrusted extraction cannot claim `verified` at intake — the service rejects
it outright. Verified confidence exists only as the output of an owner
decision.

## Data flow

```
connected doc/message → intakeCandidate (probable|uncertain, attributed)
  → pending candidates (conflicts exposed, never last-write-wins)
  → confirmCandidate (owner, transactional)
      → business_facts row via store.addBusinessFact (verified)
      → knowledge_revisions row (active, rev N)
      → knowledge_candidates.status = confirmed
      → knowledge_decisions audit row
  → snapshotForOffers → BusinessFact[] for adaptBusinessFacts
```

Fresh availability/calendar observations are **rejected at intake**
(`availability*`, `calendar*` keys are reserved) — they belong to the fresh
evidence path (`buildAvailabilityEvidence`), never to static confirmed
knowledge.

## Storage

Only `knowledge_*` tables are owned by this module, created on the same
injected `GatherStore.db`:

- `knowledge_candidates` — extracted candidates with source locator +
  optional `sourceRevision`, status `pending|confirmed|rejected|stale`.
- `knowledge_revisions` — one active revision per
  `(business_id, key, subject_id, scope, scope_id)` (partial unique index);
  carries `review_state` for source-change invalidation.
- `knowledge_decisions` — `command_id` PK makes every mutating call
  idempotent; replays return the recorded outcome.

Confirmed facts themselves are written through the existing
`store.addBusinessFact` / `listBusinessFacts` path — no duplicate fact
storage. `subjectId` disambiguates facts sharing a key (e.g. two `space`
facts); pending candidates for the same `key+subjectId` with different
canonical values are reported via `conflictsWith`.

## Source changes and supersession

When a new observation arrives from the same source locator for the same
`key+subjectId` with a **different value**:

- prior pending candidates from that source become `stale` (they cannot be
  confirmed anymore);
- active revisions derived from that source are flagged
  `review_state = 'review'` and surfaced in the snapshot's `reviewFactIds` —
  a changed source raises review rather than silently rewriting approved
  pricing. A revision bump with identical content is a re-observation, not a
  change.

`correctFact` requires `expectedRevision` to equal the active revision —
stale corrections are rejected and audited, and each correction supersedes
the prior revision (rev N → N+1), preserving provenance.

`addScopedException` requires an explicit `booking` or `customer` scope +
`scopeId`, stamps `scope`/`scopeId` into the fact (contradictions rejected),
and stays versioned under that scope — exceptions never silently globalize.

## Snapshot for offers

`snapshotForOffers(businessId)` returns:

- `businessId`, `timezone` — from the owner-maintained business record;
- `facts` — a synthesized verified `business` fact (businessId + timezone)
  plus every active confirmed fact (verified, attributed) in the shape
  `adaptBusinessFacts` accepts;
- `reviewFactIds` — confirmed facts whose source changed since approval;
  callers should gate consequential use;
- `scopedFactCount` — how many included facts are scoped exceptions.

Completeness is honest: `pricing_bounds.costsComplete` appears in the
snapshot only if the owner confirmed a fact whose value actually contains
it — the boundary never claims cost completeness on its own.

## API surface

`KnowledgeService` (constructed with a `KnowledgeStorePort` — the shared
`GatherStore` satisfies it structurally):

| Method | Authority | Notes |
| --- | --- | --- |
| `intakeCandidate` | extraction | probable/uncertain only, ≥1 source ref, reserved keys rejected, dedupes identical re-ingest |
| `listCandidates` | read | includes `conflictsWith` for competing pending values |
| `rejectCandidate` | owner | audited |
| `confirmCandidate` | owner | transactional fact+revision+audit; double-confirm and commandId replay are idempotent |
| `correctFact` | owner | stale `expectedRevision` rejected + audited |
| `addScopedException` | owner | booking/customer scope required |
| `listFacts` | read | active confirmed facts with revision/scope/review metadata |
| `listDecisions` | read | the decision audit trail |
| `snapshotForOffers` | read | offer-ready verified facts + review flags |

Every mutating call accepts an optional `commandId`; a repeat returns the
recorded outcome (`duplicate: true`) with no additional effect.

## Verification

- `npx tsc --noEmit` — clean.
- `node --experimental-strip-types --test tests/knowledge.test.ts` — 12
  tests: intake confidence/attribution/reserved-key gates, conflict
  exposure, owner confirmation through the shared fact path, double-confirm
  and commandId idempotency, versioned corrections with stale-version
  rejection, source-change review flagging, scoped exceptions, honest
  `costsComplete`, denied non-owner actors (audited), cross-business
  rejection (audited), restart durability, and mid-confirmation transactional
  rollback.
