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
   own `BEGIN IMMEDIATE`).
3. Drain in provider order: resolve booking identity through source keys
   (ambiguous → `needs_decision`, open owner decision stays pending,
   nothing auto-links, nothing ingests), then `ledger.ingestEvent` per
   linked item with a stable `gather:intake:{account}:{message}:{kind}`
   dedupeKey. Ledger and identity run their own transactions; this layer
   never nests them.
4. Commit the cursor checkpoint only after the full drain (at-least-once:
   replays collapse on dedupeKeys and source keys).

Replies stay ordered after the inquiries they answer, so the ledger
observes inquiry-then-reply and suppresses answered followups; a reply
never needs to precede its inquiry out of order. Control events
(pause/resume/cancel) are NEVER honored from intake — only
`applyOwnerControl` with host attestation mints control, and only
`recordVerifiedReceipt` with a trusted verifier retires deposit checks.
Provider payment text is evidence, never proof.

## Due-work drain (`drainDueWork`)

Lists due work, claims with fencing tokens, and for items linked to a
proposal (`detail.proposedActionId` host convention) verifies the live
exact-version approval read-only, then only `retryFailedSteps` (same
stable idempotency keys) or `reconcileExecution`. It NEVER calls
`approveAndExecute`: the operator path cannot mint owner approval.
Items without live approval are reported as `awaitingOwner` and left for
the owner; claimed leases fence them until expiry. Failed executions
surface in the durable failure log; nothing resolves as done on failure.

## Health and tools

`operatorHealth()` aggregates last sweep, per-account cursor state,
`waitingByStatus` counts, paused bookings (ledger control table), and
recent durable failures, always stamped with the host-declared
`simulation` flag — simulated runs never claim live. MCP exposes three
read-only live tools (`operator.health`, `operator.waiting`,
`operator.intake.status`); every result is `authority: "advisory"`.
There is deliberately no model-invokable approve/control/retry tool.

HTTP (`app/api/operator/`): `GET health`, `GET waiting`, `GET
intake/status`, and host-called `POST sweep` (same-origin guarded).
Routes report `INTAKE_NOT_CONFIGURED` (503, honest, non-simulated success)
until the host wires operator deps — never a fabricated poller.

## Account scope and connections

Cursors and source keys bind the stable `accountId`, never a `"me"`
alias. Account scope resolves from the store's `connected_accounts`
table first, then the injected connections directory (independently
owned lane); unknown accounts are denied, never silently bound.
Token supply stays behind the injected poller port.

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
