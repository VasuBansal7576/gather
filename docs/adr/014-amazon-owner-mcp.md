# ADR-014: Amazon owner-facing MCP profile

Status: specified — implementation paused
Depends on: ADR-006
Authorization: planning only; explicit owner instruction is required to start implementation.
PRD: 3.1, 8, 11 Amazon; gates Submission, Exact authority
Contracts: C02, C05, C08, C12 in [shared contracts](CONTRACTS.md)

## Decision

Expose owner-facing booking decisions through an authenticated MCP interface using the existing SDK, without giving customer content approval powers.

## Existing code and scope

Read the source paths below and their module guides before editing. Existing implementations are reusable foundations, not evidence that this ADR is complete. Follow the [execution index](README.md) and shared contracts; references are not competing work orders.

## Owns

- `src/integrations/amazon/**` (new)
- `tests/amazon-owner-mcp*.test.ts` (new)
- `docs/AMAZON.md` (new)

## Must not touch

- Personal `~/.openclaw`, unrelated installations, private SaaS files, credentials or live customer data.
- Paths outside Owns, including other in-flight ADR files. Shared paths require the index's exclusive write lock and predecessor integration; no simultaneous writers.
- Product requirements, acceptance criteria or shared contract semantics. Return a contradiction to Chief with source evidence; do not silently redesign.

## Inputs, outputs and integration

Authenticated owner session -> narrow read/propose/exact-confirm tools -> existing Gather services. Reuse existing Streamable HTTP primitives; export IntegrationProfile. Owner confirmation includes exact version/action summary and cannot be inferred from an ambiguous natural-language name.

## Implementation steps

1. Support what-needs-attention and exact offer approval with persistent context; require second explicit confirmation when the spoken/name reference is ambiguous.
2. Protect token/origin/host and session ownership; loopback is not authentication. Customer inquiry text cannot reach owner-control calls.
3. Verify selected MCP protocol version and event route against official rules; label local simulated Alexa client separately from platform integration. No external service deployment without authority.

## Failure and recovery

Use the cited contracts' durable, scoped error paths. A capability/credential gate may block real verification without blocking scripted development; name the exact missing evidence. Do not substitute simulated success, relax authority, add a second progression owner or change vendors to make acceptance pass.

## Out of scope

Private hosted SaaS, billing, revenue-recovery strategy and autonomous code deployment. Adjacent subsystems belong to their named ADRs in the index. No merge, external deployment, purchases or submission is authorized here.

## Acceptance

- **014-A01:** Authenticated owner views pending work, confirms exact offer and sees separately verified cross-service results.
- **014-A02:** Ambiguous name/stale version/wrong owner/customer injection cannot approve; token and origin guards exercised.
- **014-A03:** Actual MCP protocol handshake and tool calls captured; event-specific demonstration discloses simulated client if used.
- **014-CHECKS:** `npm test`, `npm run typecheck`, `npm run build` pass; report optional skips honestly. Run the existing golden suite after ADR-002 introduces it; do not claim later release cases before their owning ADR lands. Attach source/command evidence, and rendered evidence for UI changes.

## Completion handoff

Return changed files, local/remote commit IDs, acceptance-ID evidence and remaining blockers to the Orca coordinator. Commit and push the task branch; verify matching remote SHA. Do not self-mark shipped or merge. The coordinator reviews actual artifacts and integrated behaviour, not only the worker summary.
