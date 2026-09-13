# Proactive host automation (`src/server/operator-runtime/automation.ts`, DEMO ONLY)

Host-owned proactive lifecycle for operator sweeps: register, refresh, and
remove per-account bindings, each owning exactly one bounded local timer.
There is deliberately no generic scheduler framework (and the OpenClaw
gateway denies `cron` to the agent surface): one interval timer per
binding, replaced on refresh, cleared on remove/stop/degrade.

## What the scheduler does and does not do

Each timer tick runs exactly one guarded cycle for its account: the
injected sweep body only (normally intake sweep + due-work drain via
`startProactiveAccount`). Overlap protection is a shared per-account
latch: overlapping ticks skip and count instead of running concurrently,
a refresh during an in-flight sweep keeps the latch (the fresh binding
waits, then sweeps normally — it can never wedge), and a prior sweep's
completion releases the shared latch without writing stale counters onto
the new record. Repeated sweep failures degrade the binding
explicitly — timer stopped, status `degraded` with the last error —
instead of retrying silently forever; re-register to resume. `stop` clears
the timer and awaits the in-flight sweep on a real elapsed-time deadline
(default 30 s, never the injectable business clock); the returned state
honestly reports `inFlight` when the sweep did not drain in time, and a
sweep finishing after stop/revoke/refresh writes nothing (epoch-guarded)
— no late counters, no clobbered revocation error, no resurrected status.

The scheduler never sends, approves, holds, or links anything: pause/cancel
and commercial approval gates stay enforced inside the existing intake and
due-work paths, so a firing timer can never send an unapproved followup.
Connection revocation is explicit via `noteProactiveRevocation`
(degraded at once, no quiet retries against a dead credential);
re-register after the owner reconnects. Restart state comes from existing
SQLite (cursors, checkpoints, batches, waiting rows); bindings themselves
are re-registered by the host on boot.

## Production registration hook (for D bootstrap integration)

`startProactiveAccount({ runtime, intervalMs?, maxConsecutiveErrors?, clock? })`
is the exported hook. D supplies the requested connector/dependency shape —
nothing else is needed, and no shared-file change is required:

```ts
runtime: OperatorRuntimeDeps & {
  store: GatherStore;            // shared database handle
  ledger: CoordinationLedger;    // same-handle waiting ledger
  inbox: InboxPort;              // approved provider poller + provenance
  booking: BookingServiceDeps;   // approved calendar/email ports + owner
  accountId: string;             // stable polled account (never a userId alias)
  businessId: string;            // bound business for scope enforcement
  now?: () => string;
  connections?: ConnectionDirectoryPort;
};
intervalMs?: number;             // default 300_000, bounds 30_000..86_400_000
maxConsecutiveErrors?: number;   // default 5, then degraded
clock?: () => number;            // timestamps only
```

Also exported: `registerProactiveBinding` (raw sweep callbacks),
`tickBinding` (manual guarded trigger + fake-clock seam),
`stopProactiveAccount`, `removeProactiveBinding`,
`getProactiveBinding`, `listProactiveBindings`,
`noteProactiveRevocation`, `resetProactiveAutomation` (tests).

## Routes (same-origin guarded; scope from registered bindings only)

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/operator/automation/status[?accountId]` | Real binding state, scoped to wired operator-deps accounts (`listProactiveBindingsForAccounts`) — the proactive registry is separate, and unwired/foreign entries never appear. |
| `POST` | `/api/operator/automation/sweep` | One guarded manual cycle for the resolved binding. |
| `POST` | `/api/operator/retry` | `{ messageId, accountId? }`: re-arms exactly one validated dead-lettered message under the binding's business; unregistered accounts refused. |

`operator.health` reports the real per-account binding state
(`registered` + `running`/`stopped`/`degraded`, or `pending-registration`
when unwired) — the automation status route and health agree on the same
source of truth.

## Limits

Timers live in-process (no persisted schedule); simulation derives from
durable evidence as elsewhere; live provider wiring and approved account
assets remain explicit host gates (unwired routes answer 503, never fake
success). No duplicate stores, graphs, schedulers, or models introduced.
