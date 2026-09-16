# ADR-012: Google consent, document selection and credential lifecycle

Status: specified — implementation paused
Depends on: ADR-007, ADR-009
Authorization: planning only; explicit owner instruction is required to start implementation.
PRD: 3, 8.3; gates Live mode, Isolation
Contracts: C01, C03, C08, C11 in [shared contracts](CONTRACTS.md)

## Decision

Implement direct Google onboarding using the existing adapters and secret-store interface. Separate client/Picker feasibility from a completed connection, and do not silently add a broker.

## Existing code and scope

Read the source paths below and their module guides before editing. Existing implementations are reusable foundations, not evidence that this ADR is complete. Follow the [execution index](README.md) and shared contracts; references are not competing work orders.

## Owns

- `src/server/connections/**`
- `src/connectors/google/transport.ts`
- `src/connectors/google/documents.ts` (scope-capability mapping only)
- `src/connectors/google/calendar.ts` (scope-capability mapping only)
- `src/connectors/google/errors.ts`
- `app/api/connections/**`
- `app/setup/**` (live connection components only)
- `src/setup/**` (connection contracts only)
- `tests/connections*.test.ts`
- `tests/oauth-boundary.test.ts`
- `tests/secret-store*.test.ts` (new)
- `docs/CONNECTIONS.md`
- `docs/GOOGLE_CONNECTORS.md`

## Must not touch

- Personal `~/.openclaw`, unrelated installations, private SaaS files, credentials or live customer data.
- Paths outside Owns, including other in-flight ADR files. Shared paths require the index's exclusive write lock and predecessor integration; no simultaneous writers.
- Product requirements, acceptance criteria or shared contract semantics. Return a contradiction to Chief with source evidence; do not silently redesign.

## Inputs, outputs and integration

Operator-configured OAuth/Picker settings + user consent -> server-owned account binding and secret refs. C03 source pipeline receives scoped accounts/document IDs; no credential is a booking approval. Existing secret-store interface gets a file-backed live adapter; Keychain remains explicit developer-only.

## Implementation steps

1. Implement state/PKCE/loopback callback validation, selected-document Picker flow and C11 scope-capability mapping, including free/busy and selected-file reads without broad-read requirements. Describe real consent/testing restrictions, never guaranteed bypass.
2. File-backed secrets confined beneath active live root, owner-only directory/files, atomic replace, no tokens in DB/URLs/logs; revoke/disconnect invalidates dependent sources and work.
3. Verify pagination/refresh/revocation/account-switch/denied consent with scripted transports first, then opt-in configured-client evidence.
4. If client/Picker capability fails, return exact evidence and keep live onboarding blocked. Composio is not implemented without Chief reviewed amendment and separate deployment/spend authority.

## Failure and recovery

Use the cited contracts' durable, scoped error paths. A capability/credential gate may block real verification without blocking scripted development; name the exact missing evidence. Do not substitute simulated success, relax authority, add a second progression owner or change vendors to make acceptance pass.

## Out of scope

Private hosted SaaS, billing, revenue-recovery strategy and autonomous code deployment. Adjacent subsystems belong to their named ADRs in the index. No merge, external deployment, purchases or submission is authorized here.

## Acceptance

- **012-A01:** State mismatch, replay, wrong account and malformed/oversized OAuth response denied without secret disclosure.
- **012-A02:** Selected files only; denied scope and revoked access visible; successful consent cannot be reported as completed sync.
- **012-A03:** Fresh authorized test account completes actual consent/Picker and harmless read, or explicit credential/verification blocker recorded.
- **012-A04:** Local file-secret permissions/path confinement and cleanup tested; prepared mode requires none of these credentials.
- **012-CHECKS:** `npm test`, `npm run typecheck`, `npm run build` pass; report optional skips honestly. Run the existing golden suite after ADR-002 introduces it; do not claim later release cases before their owning ADR lands. Attach source/command evidence, and rendered evidence for UI changes.

## Completion handoff

Return changed files, local/remote commit IDs, acceptance-ID evidence and remaining blockers to the Orca coordinator. Commit and push the task branch; verify matching remote SHA. Do not self-mark shipped or merge. The coordinator reviews actual artifacts and integrated behaviour, not only the worker summary.
