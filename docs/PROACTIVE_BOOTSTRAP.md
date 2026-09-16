# Proactive host bootstrap (`src/server/proactive/`)

Host registration of durable inquiry capture (proactive waiting).
This assembly uses the shared
scheduler (`operator-runtime/automation.ts`), provider composition
(`provider-runtime`), connection service, SQLite store, and ledger are
used as-is — this module only decides *which* accounts sweep and keeps
that registry consistent with connection lifecycle.

## What it does

`ensureProactiveHost({ store, ownerId, providers, booking,
connectionService, ... })` is called once per process from
`getRuntime()` (lazy host entry / server boot) and `refreshProactiveHost()`
runs on every connection-callback, disconnect, and setup-business event,
so eligible accounts register automatically with no owner-typed prompt.

Per active business, eligibility is decided from durable rows only:

1. Business status is `active` (paused businesses stop, wiring kept).
2. The Google provider app is configured (`providerReadiness`).
3. `providers.resolveAccountPorts({ businessId, capability: "gmail" })`
   returns a connected account with inbox+threads ports.

Eligible accounts get fully-built `IntakeDeps` (inbox adapter with live
provenance, thread-reader adapter, shared-store `CoordinationLedger`,
dispatching booking ports, connection directory) registered via
`setOperatorDeps` + `startProactiveAccount`. Anything else reconciles
down: revoked/errored accounts degrade via `noteProactiveRevocation`
with operator wiring removed; removed or never-configured accounts are
unbound (`removeProactiveBinding` + `removeOperatorDeps`); vanished
businesses are pruned. One failing business never blocks the others —
failures collect on the report.

Unconfigured providers, account-less businesses, and demo-only setups
register nothing and trigger zero external calls: resolution reads rows,
token supply stays lazy inside the ports, and sweeps only exist for
registered bindings. `GATHER_PROACTIVE_DISABLE=1` (or `disabled: true`)
registers nothing at all.

## Truthfulness

`watching` (per-account status and the automation status route) is true
only for a running binding whose latest sweep succeeded — never claimed
before real registration and a first successful sweep. Health keeps
reporting the real binding state (`pending-registration` when unwired).
Shutdown is `stopProactiveHost()` (bounded real-time drain per binding,
no orphaned timers; interval timers are `unref`d so the process can
always exit).

## Capture-only boundary (no model offers)

The registered sweep runs the guarded intake sweep + due-work drain,
which CAPTURE inquiries into durable intake rows. No model generates
offers anywhere on this path — that separation is structural (there is
no model port in the deps) and asserted in tests (`proposed_actions`
stays empty, no provider writes). `setExtractionAssemblyHook` is the
explicit composition seam for the later extraction/operator assembly;
registering a hook never enables model work — the trigger wiring
arrives with that assembly (pending).

## Owner calendar choice (`app/api/setup/calendar`)

The holds path needs one pinned calendar per business. The owner
supplies an opaque calendar id; the server binds it to that business's
single verified connected calendar account (`bindBusinessCalendar`).
Responses expose only business, calendar id, and account display name —
never account ids or binding internals. Zero or several connected
calendar accounts fail with owner-actionable codes
(`CALENDAR_ACCOUNT_MISSING` / `CALENDAR_ACCOUNT_AMBIGUOUS`) instead of
guessing, and use-time resolution re-verifies the binding on every call,
so a stale binding fails closed and nothing authorizes an arbitrary
model-chosen calendar.

## Verification

`tests/proactive-bootstrap.test.ts` (scripted fictional Gmail HTTP over
the real poller/reader/ports — no live model, gateway, provider,
keychain, or credentials): composed capture loop, demo/unconfigured
silence, restart cursor reuse + redelivery dedupe, revoke degradation,
pause/resume, per-account failure isolation + healing, calendar
choice rules.
