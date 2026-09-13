# Provider runtime composition

How `getRuntime()` chooses real vs demo providers per booking. Implemented in
`src/server/provider-runtime/` (dispatch + connection-service factory),
wired from `src/server/runtime.ts`.

## Wiring

```
routes -> getRuntime().deps.calendar/.email
        -> DispatchingCalendar / DispatchingEmail (per-call resolution)
        -> ProviderResolver
            |-- fixture booking  -> DurableDemoCalendar / DurableDemoEmail
            '-- real booking     -> createGoogleConnectors(...)
                                     transport: createFetchTransport()
                                     tokens: () => connectionService.accessToken({accountId, businessId})
                                     calendarId: explicit per request
                                     resolveHoldScope / resolveSentExpectation: durable action payload
```

`connectionServiceFor(store)` memoizes one `ConnectionService` per store
handle; `getConnectionService()` in `src/server/connections/index.ts`
delegates to it, so routes and connector dispatch share the same instance
(one refresh singleflight, one revision fence). The factory lives in
provider-runtime and `connections/config.ts` holds env config — this is what
removes the `getRuntime`/`getConnectionService` import cycle: runtime ->
provider-runtime -> connections leaves, index -> runtime stays one-way.

## Selection rules

- **Fixture/demo**: a booking whose source references are all `fictional`
  stays on the demo adapters; fixture calendars (`demo-calendar-001`)
  always resolve to demo.
- **Calendar scope is a durable, host-validated binding** — never inferred
  from proposals or payloads. `provider_calendar_bindings` records
  `calendar_id -> business_id + pinned connection_account_id + generation`
  (`bound`/`unbound` status); the host writes it via
  `providers.bindCalendar({businessId, calendarId, accountId?})`
  (verifies a bound, connected `google_calendar` account; one calendar
  claims one owner — a foreign business's claim conflicts) and releases it
  via `providers.unbindCalendar({businessId, calendarId, accountId?})`,
  which keeps an `unbound` tombstone (original proof preserved) after
  comparing exact owner + business (+ account when pinned). Every fresh
  bind — including same-account rebind after unbind — bumps `generation`.
  A request's `calendarId` on a real booking must be bound to that booking's
  business: unbound -> `not_found`, foreign -> `conflict`, bound-account
  revoked -> `access_revoked`.
- **Resolved calendar ports are guarded snapshots, not raw connectors.**
  `resolveCalendarPorts` returns a port that re-validates the exact binding
  (business + account + generation) and the account's connected status on
  every operation, so a retained port goes stale on unbind, rebind,
  account change, or revocation instead of acting on revoked authority.
  Callers re-resolve after any host change. Bind/unbind run atomically, so
  concurrent handles surface typed `conflict`, never raw constraint errors.
- **Authority is revalidated per transport dispatch, not just per call.**
  The pre-call guard alone cannot cover authority that lapses while a call
  awaits its token or async scope resolution. Every guarded calendar
  dispatch therefore re-reads the exact pinned business + account +
  calendar + generation at the transport boundary — after token
  acquisition, before each HTTP send (reads, writes, and reconcile
  follow-ups alike, on both resolved ports and the dispatching calendar).
  Stale authority throws before unsent IO and maps to the typed
  fail-closed result with zero new provider bytes; authority that changes
  after a write was actually dispatched is preserved as-is — effects
  stand, no pretend undo is attempted, and follow-up work must honestly
  re-resolve and reconcile.
- **Email sends** resolve through the durable execution row
  (`idempotency_key` -> action -> booking) to the business's unique
  connected `gmail` account.
- **Availability** resolves through the binding alone — it works before any
  proposal exists.

## Failure semantics (no silent demo fallback)

All dispatch failures are typed `ConnectorResult` failures, never thrown:

| Case | error.kind |
| --- | --- |
| Provider app not configured | `unsupported` |
| No bound account for the capability | `not_found` |
| Binding revoked/errored | `access_revoked` |
| More than one connected account (unpinned bind) | `conflict` |
| Calendar unbound or bound to another business | `not_found` / `conflict` |
| Real booking routed at a fixture calendar | `conflict` |
| Unknown operation key | `not_found` |

## Credential boundary

Tokens are supplied lazily: `accessToken({accountId, businessId})` is
invoked only inside an authorized connector call. Resolution decides
eligibility from durable rows only — no secrets are read while selecting an
account. Tokens never appear in results, DTOs, or errors.

## Composition hooks

`createProviderConnectors(options)` returns `{ calendar, email,
connectionService, resolveAccountPorts, resolveCalendarPorts, bindCalendar,
unbindCalendar, listCalendarBindings }`. `resolveAccountPorts({businessId,
capability})` hands the verified account's Google read ports (`inbox`,
`threads` for `gmail`; `documents` for `google_drive`); `resolveCalendarPorts`
(`{businessId, calendarId}`) resolves one bound calendar into its live
connector for offer/intake composition — usable before any proposal exists.
One resolver, no parallel registry.

## Limitations

Live provider calls were verified only against scripted HTTP transports and
fake OAuth in tests — no real Google account has been exercised. The
`GATHER_DEMO_TIMEOUT_KEYS` uncertain-write simulation still applies to the
demo path only.
