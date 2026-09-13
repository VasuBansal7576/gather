# Proactive host automation (`src/server/operator-runtime/automation.ts`, DEMO ONLY)

Host-owned proactive lifecycle for operator sweeps: register, refresh, and
remove per-account bindings, each owning exactly one bounded local timer.
There is deliberately no generic scheduler framework (and the OpenClaw
gateway denies `cron` to the agent surface): one interval timer per
binding, replaced on refresh, cleared on remove/stop/degrade.

## What the scheduler does and does not do

Each timer tick runs exactly one guarded cycle for its account: the
injected sweep body only (normally intake sweep + due-work drain via
`startProactiveAccount`). Overlapping ticks skip and count instead of
running concurrently. Repeated sweep failures degrade the binding
explicitly — timer stopped, status `degraded` with the last error —
instead of retrying silently forever; re-register to resume. `stop` clears
the timer and drains any in-flight sweep (bounded).

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
| `GET` | `/api/operator/automation/status[?accountId]` | Real binding state; unwired accounts report intake-not-configured, never a fabricated schedule. |
| `POST` | `/api/operator/automation/sweep` | One guarded manual cycle for the resolved binding. |
| `POST` | `/api/operator/retry` | `{ messageId, accountId? }`: re-arms exactly one validated dead-lettered message under the binding's business; unregistered accounts refused. |

`operator.health` keeps its static scheduler field (per-deps snapshot);
the automation status route is the live source for registration truth.

## Limits

Timers live in-process (no persisted schedule); simulation derives from
durable evidence as elsewhere; live provider wiring and approved account
assets remain explicit host gates (unwired routes answer 503, never fake
success). No duplicate stores, graphs, schedulers, or models introduced.
