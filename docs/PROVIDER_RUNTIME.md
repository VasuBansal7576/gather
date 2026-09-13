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
  stays on the demo adapters. Fixture calendars (`demo-calendar-001`) also
  resolve to demo when no action references them.
- **Real bookings** resolve business -> capability account
  (`google_calendar` for holds/availability, `gmail` for sends). Only
  accounts durably bound by an owned `connection_accounts` row qualify —
  unbound `connected_accounts` rows (fixtures, legacy data, other owners'
  bindings) never serve real bookings.
- **Holds and sends** resolve through the durable execution row
  (`idempotency_key` -> action -> booking), so tenant scope comes from the
  approved record, not the request.
- **Availability** has no booking on the request: the owning business is
  derived from proposal payloads naming the `calendarId`. Zero referents on
  a non-fixture calendar, or referents in more than one business, fail.

## Failure semantics (no silent demo fallback)

All dispatch failures are typed `ConnectorResult` failures, never thrown:

| Case | error.kind |
| --- | --- |
| Provider app not configured | `unsupported` |
| No bound account for the capability | `not_found` |
| Binding revoked/errored | `access_revoked` |
| More than one connected binding | `conflict` |
| Calendar unbound or cross-business | `not_found` / `conflict` |
| Unknown operation key | `not_found` |

## Credential boundary

Tokens are supplied lazily: `accessToken({accountId, businessId})` is
invoked only inside an authorized connector call. Resolution decides
eligibility from durable rows only — no secrets are read while selecting an
account. Tokens never appear in results, DTOs, or errors.

## Composition hooks

`createProviderConnectors(options)` returns `{ calendar, email,
connectionService, resolveAccountPorts }`. `resolveAccountPorts({businessId,
capability})` hands the verified account's Google read ports (`inbox`,
`threads` for `gmail`; `documents` for `google_drive`) to later
intake/operator assembly — one resolver, no parallel registry.

## Limitations

Live provider calls were verified only against scripted HTTP transports and
fake OAuth in tests — no real Google account has been exercised. The
`GATHER_DEMO_TIMEOUT_KEYS` uncertain-write simulation still applies to the
demo path only.
