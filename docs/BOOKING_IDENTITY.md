# Booking identity (PRD G04)

Cross-app identity resolver: connects inquiry, conversation, proposal,
calendar hold, deposit, and resource records to the same booking, and
requires explicit owner resolution instead of silently merging different
customers or events.

Ownership: `src/identity/**`, `tests/identity*.test.ts`, and this document.
Existing `src/domain/**` and `src/server/**` contracts are read-only to this
module; it calls `GatherStore` but never modifies shared files.

## Model

A **source key** addresses ONE provider-side record in the scope that owns
it: `provider + connected account + business + source kind + provider
external id + provider thread id`. Encoding is `v1.` + base64url of the JSON
component array (`src/identity/source-key.ts`), so delimiter strings (`|`,
`::`, `/`), unicode, and empty segments can never collide the way a naive
`parts.join("|")` key would. Provider/source-kind segments normalize case;
scope segments stay exact.

All state lives in the injected `GatherStore` SQLite database — no new
database file, no generic graph/wiki:

- `booking_identity_links`: at most one row per source key; `status` is
  `active` or `unlinked`. Rows are never deleted.
- `booking_identity_decisions`: versioned owner-decision requests. One `open`
  row per source key; superseded/resolved rows are kept.
- `booking_identity_audit`: append-only transition log (`verified_link`,
  `owner_link`, `decision_opened`, `decision_resolved`, `unlink`,
  `correction`).

## Trust rules

- **Weak hints never bind.** Sender email/name, event date/name matches only
  nominate deterministic candidates. Even a single weak candidate returns
  `needs_decision` — never an automatic link. Different customers may share
  an email address; one thread may hold several events.
- **Untrusted message content never binds.** A message claiming a Gather
  booking id or an `authorizedBy` value surfaces at most as an explicitly
  non-authoritative candidate (`authoritative: false`) so the owner sees the
  claim. There is deliberately no code path from message text to a link.
- **Only two binding paths exist:**
  1. `recordVerifiedIdentityLink` — host-verified, provider-correlated
     receipt (explicit `operationKey` + `demo`/`live` provenance mode).
     First writer wins; any conflict throws `CONFLICT`, including against
     unlink history (revisit via owner decision). Duplicate receipts for the
     same booking are idempotent.
  2. `recordOwnerIdentityDecision` — explicit trusted owner resolution
     against the open decision's exact `candidateVersion` +
     `candidateFingerprint`. Stale fingerprints, cross-business, and
     cross-account choices are rejected. This path MAY correct an existing
     binding; the prior record stays in audit history.
- **Scope is enforced on both paths.** The chosen booking's business must
  equal the source key's business; when the account is a known connected
  account, its business and provider must agree.
- **Unlink/correction preserves history.** `unlinkIdentityLink` flips status
  and appends audit rows; nothing is deleted. A correction records
  `old -> new` with the actor and reason.

Owner links store `demo` provenance: they are local owner assertions, not
live provider state. `decidedBy` must be server-derived (e.g.
`GATHER_OWNER_ID`); request-supplied identities are not accepted — the
current API takes it as a parameter and the host must pass its configured
owner identity.

## Service API (`src/identity/index.ts`)

- `proposeBookingIdentity(store, { components, hints? })` → `linked` (exact
  durable link) or `needs_decision` (deterministic candidates +
  versioned/fingerprinted open decision).
- `recordVerifiedIdentityLink(store, { components, bookingId, receipt, actor? })`
- `recordOwnerIdentityDecision(store, { sourceKey, chosenBookingId, decidedBy, candidateVersion, candidateFingerprint })`
- `unlinkIdentityLink(store, { sourceKey, actor, reason, replacementBookingId? })`
- Readers: `getIdentityLink`, `getActiveIdentityLink`, `getOpenIdentityDecision`,
  `listIdentityDecisions`, `listIdentityAudit`, `buildSourceKey`,
  `decodeSourceKey`, `fingerprintCandidates`.
- Errors: `IdentityError` with codes `CONFLICT`, `STALE_DECISION`,
  `CROSS_BUSINESS`, `CROSS_ACCOUNT`, `INVALID_REQUEST`, `NOT_FOUND`.

## Host wiring gaps (for later ingestion/UI integration)

1. No ingestion hook calls `proposeBookingIdentity` yet — Gmail/calendar
   readers, deposit/resource writers, and proposal creation do not emit
   identity components or receipts.
2. `decidedBy` is caller-supplied; the host must pass the server-derived
   owner identity (same rule as approvals) and never a request field.
3. The UI has no "ambiguous match" surface: `needs_decision` candidates and
   the audit trail are API-ready but unrendered.
4. `findCandidates` matches only same-business bookings on weak
   contact/date/name overlap; richer deposit/resource correlation needs the
   ingestion hook (gap 1) first.
5. Concurrent writers on separate connections serialize via SQLite + unique
   key; lock-contention errors are mapped to `CONFLICT`, so callers should
   surface "another writer bound it first" and re-propose rather than retry
   blindly.
