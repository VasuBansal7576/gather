# Business knowledge boundary

This documents the existing SQLite-backed module, not the PRD's proposed native OpenClaw recall/wiki integration. The native integration remains unimplemented; the ownership and adoption gate are clarified in ADR-005. See the [repository guide](README.md#design-conflicts-to-resolve-before-implementation).

`src/knowledge/` implements the source-linked business understanding boundary:
extracted content from connected documents/messages arrives as **untrusted
candidates** (`probable` or `uncertain`), and only an **explicit owner
command** can mint the verified `BusinessFact` rows the rest of Gather (and
the offers adapter) consumes.

This is deliberately a booking-business facts + approval boundary, not a
generic wiki/graph/memory platform: intake enforces the shared fact
vocabulary (`business`, `space`, `policy`, `price_line`, `cost`,
`pricing_bounds`, `service`, `scoped_exception`) that `adaptBusinessFacts`
in the offers lane already understands. Any other key — including
generic wiki-style keys and fresh-evidence-like keys (`freebusy`, `slots`,
`windows`, `schedule`, plus the reserved `availability*`/`calendar*`) — is
rejected before any row is written, and corrections to unknown keys are
refused the same way.

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
  idempotent; replays return the recorded outcome only when the full
  canonical request (kind, business, subject, actor) fingerprints
  identically, otherwise the altered replay is rejected as
  `command_conflict`. Stored values are canonicalized (key-order
  insensitive) so identical observations dedupe across revisions.

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
`scopeId`, plus an explicit `policyId` and `effect` (`allow` or
`require_owner_decision`). The stored value is canonical and adapter-shaped
(`exceptionId` server-minted, `policyId`, `scope` as `{ bookingId }` or
`{ customerId }`, `effect`, `approvedBy` always the commanding owner id):
client-supplied authority fields that contradict the command are rejected,
and the fact stays versioned under its revision scope — exceptions never
silently globalize.

## Transaction discipline and honest contention

Every mutating call runs its state reads, validation of live state,
conditional mutation, and applied-decision audit inside exactly one
`BEGIN IMMEDIATE` transaction (bounded lock-busy retries with backoff).
Status and version checks re-run under the lock, conditional updates assert
`changes === 1`, and the partial unique index on active revisions is the
final fence — so concurrent confirms apply once (losers observe the terminal
state idempotently) and concurrent corrections admit exactly one winner
(losers report audited `stale_version`). Only lock contention
(`SQLITE_BUSY`) is retried; constraint and application conflicts propagate
unchanged, and exhaustion surfaces an honest retryable `busy` error rather
than a silent or mislabeled outcome. Rejection evidence is recorded outside
any rolled-back transaction, so the audit always survives the failure it
describes; intake validation failures carry no command id and are not
decision-logged by design.

Command identity is re-verified inside the same transaction before any
mutation: a shared commandId that landed between the fast-path replay check
and the lock returns the recorded outcome for exact duplicates and rolls
back with `command_conflict` for altered payloads — a conflicting audit row
can never be hidden by the idempotent insert. Correction and exception
fingerprints bind effective provenance (resolved sources, subject scope), so
altered sources cannot replay as identical. Rejected decisions replay as
their typed rejection (code and message stored at audit time), never as a
successful result with absent rows. Reconfirming an already-confirmed
candidate after a correction answers with the live fact/revision pair,
never the stale confirmedFactId paired with a newer revision.

## Snapshot for offers

`snapshotForOffers(businessId)` returns:

- `businessId`, `timezone` — from the owner-maintained business record;
- `facts` — a synthesized verified `business` fact (businessId + timezone)
  plus every active confirmed fact that is verified, attributed,
  registry-keyed, and NOT under review. Source-changed facts are withheld
  here, so a host feeding `facts` straight into `adaptBusinessFacts`
  cannot use stale pricing (verified end-to-end: the offers adapter
  fail-closes on the missing bounds instead);
- `reviewFactIds` — ids of the withheld facts (same set as `withheld`);
- `withheld` — withheld facts with explicit reconfirmation reasons;
- `scopedFactCount` — how many included facts are scoped exceptions.

Reconfirmation paths that return a fact to `facts`: `correctFact` (new
revision, review cleared) or confirming the updated candidate (supersedes
the flagged revision). Applied decision records keep the confirmed values
(they mirror the fact rows); every *rejected* decision records scalar
metadata only — raw candidate values never land in the rejection audit.

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

The following describes module coverage, not a current run receipt. Test counts and live outcomes must come from the exact revision's CI or explicit verification.


- `npx tsc --noEmit` — clean.
- `node --experimental-strip-types --test tests/knowledge.test.ts` — 12
  tests: intake confidence/attribution/reserved-key gates, conflict
  exposure, owner confirmation through the shared fact path, double-confirm
  and commandId idempotency, versioned corrections with stale-version
  rejection, source-change review flagging, scoped exceptions, honest
  `costsComplete`, denied non-owner actors (audited), cross-business
  rejection (audited), restart durability, and mid-confirmation transactional
  rollback.

## ADR-008 native adapter and selection gate (specified; live BLOCKED)

`src/knowledge/port.ts` publishes the thin C04 `KnowledgePort`
(`ingestSource`, `proposeCandidates`, `confirmCandidate`, `correctFact`,
`addScopedException`, `invalidateSource`, `query`, `snapshotForOffer`,
`health`) — a Gather interface, not a claim about upstream RPC names.
Exactly one authority is active per mode; consumers (ADR-005/010) program
against the port.

- `src/runtime/knowledge.ts` (only translation point) maps the required
  native surfaces — `memory_search`/`memory_get`, `wiki_search`/`wiki_get`/
  `wiki_apply`, gateway `wiki.overview`/`wiki.get`, CLI ingest/compile,
  source-deletion recompile, agent-scoped vaults — against the exact
  ADR-009 pinned manifest method table. Each surface is traceable to the
  public embedding / memory-wiki docs; no RPC is invented and no private
  runtime database is inspected (the embedding contract forbids it).
- `src/knowledge/prepared.ts` is the labelled scripted implementation over
  this module's `KnowledgeService`, plus a source-version registry on the
  same handle (restart-durable). Deletion/revocation purges derived
  candidates/revisions into stale/review so snapshots withhold them;
  `query` blocks per applicable fact group with explicit reasons.
- `src/knowledge/native.ts` is the native candidate. Current verdict:
  **BLOCKED** — 0/11 surfaces live-verified on the pinned manifest and no
  live method-table probe has run. Every operation throws
  `blocked_native_unavailable` with the exact missing evidence; `health()`
  reports unavailable (never empty). Live stays disabled.
- `src/knowledge/migration.ts` exports confirmed facts through the public
  service, compares migration output, and activates the live port only
  after verified capability + full C04 gate + clean comparison —
  otherwise it refuses and prepared remains sole authority. Rollback
  preserves the prepared store read-only; there is no dual-writer policy
  store.
- `src/runtime/config.ts` carries the knowledge capability allowlist
  (`prepared-scripted`, `native-live`) with an explicit selection gate:
  `native-live` without verified capability, or any second-vendor name,
  throws instead of silently falling back.

Gate evidence: `tests/native-knowledge-gate.test.ts` (C04 cases on
fictional isolated data: changed price, customer exception, deleted
source, conflicts, injected instruction, restart recall, cross-mode
denial) and `tests/native-knowledge-capability.test.ts` (capability
mapping, blocked evidence, selection gate, migration). Live cutover
remains BLOCKED pending an explicit harness (`GATHER_TEST_OPENCLAW_BIN`),
an enabled memory-wiki plugin, and an observed method table.
