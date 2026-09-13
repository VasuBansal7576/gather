# Operator runtime bridge

`src/server/operator-runtime/` wires the corrected Google read cursor
protocol, the booking identity resolver, and the coordination ledger to
the guarded booking services — with the runtime owning schedule/watch and
Gather owning business-specific durable intake, cursors, and receipts.

## Ownership split

- **Runtime owns**: scheduling (calling `runOperatorSweep`), watch
  triggers, the Gateway connection, and the MCP control plane
  (`src/runtime/operator-bridge.ts` translates; it owns no business
  state).
- **Gather owns**: intake batches, per-item evidence, per-account cursor
  checkpoints, identity candidates/decisions, ledger events/waiting, and
  execution receipts — all on the SAME SQLite database. No second
  database, no second daemon, no swarm.

## Intake sweep (`runIntakeSweep`)

1. Poll the injected inbox (pre-bound to one stable `accountId`; tokens
   arrive inside the poller — this lane never reads credentials).
2. Atomically persist the raw batch (`intake_batches` + `intake_items`,
   own `BEGIN IMMEDIATE`). The batch durably remains until every item is
   linked/drained or explicitly parked — never dropped.
3. Drain in provider order: resolve booking identity through source keys
   (ambiguous → `needs_decision`, open owner decision stays pending,
   nothing auto-links, nothing ingests), then `ledger.ingestEvent` per
   linked item with a stable `gather:intake:{account}:{message}` dedupeKey
   (no mutable inferred kind — replays collapse even across later
   reclassification, and content conflicts surface as visible failures,
   never merges). Replies classify by actual chronology and direction
   only: a strictly earlier, non-own message makes an item a reply; later
   messages, unparseable timestamps, and own outbound mail (recorded as
   `skipped`) never do. Ledger and identity run their own transactions;
   this layer never nests them.
4. Commit the cursor checkpoint only after the full drain (at-least-once:
   replays collapse on dedupeKeys and source keys). A history-404 expiry
   durably clears the dead cursor first, so the next sweep full-syncs
   cursor-less instead of replaying expiry. Parked items (`needs_decision`
   after owner resolution, retried `failed`) re-drive on later sweeps even
   when the poll returns nothing new, so the mailbox never stalls on them.

Replies stay ordered after the inquiries they answer, so the ledger
observes inquiry-then-reply and suppresses answered followups; a reply
never needs to precede its inquiry out of order. Control events
(pause/resume/cancel) are NEVER honored from intake — only
`applyOwnerControl` with host attestation mints control, and only
`recordVerifiedReceipt` with a trusted verifier retires deposit checks.
Provider payment text is evidence, never proof.

## Due-work drain (`drainDueWork`)

Selection and execution are both scoped: only waiting items whose booking
belongs to this runtime's business are claimed, and an item executes only
for a proposal bound to the same booking with a live exact-version
approval verified read-only. Immediately before any effect the drain
revalidates: the row is still claimed by us with a matching fencing
token, the booking is not paused/cancelled, and no customer reply arrived
since the claim (a late reply suppresses instead of executing).

Execution is reconcile-only: uncertain steps reconcile (read-only
provider truth, never a new write). Failed or never-run steps report
`awaitingOwner` — retrying an old approved offer is not automatically
authorized follow-up messaging, and resending customer email as an
automatic consequence of intake timing is never permitted here. The drain
NEVER calls `approveAndExecute`: the operator path cannot mint owner
approval. Nothing resolves as done on failure; failures surface in the
durable failure log.

## Health and tools

`operatorHealth()` aggregates last sweep, per-account cursor state,
`waitingByStatus` counts, paused bookings (ledger control table), and
recent durable failures, always stamped with the host-declared
`simulation` flag — derived from the injected port provenance and the poll
result mode, never a bare caller boolean; health without any durable
evidence assumes simulated rather than live. Simulated runs never claim
live. MCP exposes three read-only live tools (`operator.health`,
`operator.waiting`, `operator.intake.status`); every result is
`authority: "advisory"`.
There is deliberately no model-invokable approve/control/retry tool.

HTTP (`app/api/operator/`): `GET health`, `GET waiting`, `GET
intake/status`, and host-called `POST sweep` (same-origin guarded).
Routes report `INTAKE_NOT_CONFIGURED` (503, honest, non-simulated success)
until the host wires operator deps — never a fabricated poller.

## Account scope and connections

Cursors and source keys bind the stable `accountId`, never a `"me"`
alias: the poller requires it, cursors encode and enforce it, and two
pollers sharing `"me"` with different stable ids reject each other's
cursors before any HTTP. Account scope resolves from the store's
`connected_accounts` table first, then the injected connections
directory (independently owned lane, keyed by public connected-account
ids with explicit businessId); unknown accounts are denied, never
silently bound. Token supply stays behind the injected poller port.

## Scheduler status (explicit, not claimed)

No Gateway schedule/watch registration exists yet: health reports
`scheduler: { registered: false, status: "pending-registration" }` and
sweeps run only when the runtime scheduler or a host call invokes them.
A callable `runOperatorSweep` plus a manual endpoint is not proactive
execution, and nothing here labels it scheduled or watching. The Gateway
handshake check reports `mocked` explicitly when its connector is a
stand-in.

## Simulation and control-plane evidence

Local end-to-end runs use scripted transports and temporary SQLite with
`simulation: true` reported on every sweep and health payload. The
isolated Gateway handshake (`checkGatewayHandshake`: connect, hello-ok,
disconnect) is control-plane evidence reported separately — never mixed
into business receipts, and never a claim about model or live Google
behavior, which stay blocked pending owner assets.

## Manual limits

Cursor-less bootstraps replay; consumers de-duplicate by message id.
Indefinite provider uncertainty stays uncertain (reconcile, don't force).
Single-business runtime binding per operator instance; multi-business
deployments need one binding each. Expiry sweeps and absence-attested
re-execution remain unbuilt by design, not faked.
