# Calendar hold release (G11 cancellation/revisions)

Bounded verified release port for provisional calendar holds. Consumed by
the K cancellation service through the separately exported optional port
`CalendarHoldReleaseConnector` — deliberately NOT merged into
`CalendarConnector`, so existing lanes keep compiling unchanged.

## Contract (for the K cancellation service)

- Types: `src/connectors/hold-release.ts`
  - `ReleaseProvisionalHoldRequest`: `operationKey` (this release action's
    stable key — persist and reuse across retries), `bookingId`,
    `calendarId`, `holdId`, `originalHoldOperationKey`, plus the exact
    expected hold window (`startAt`/`endAt`/`expiresAt`) when known.
  - `ReleasedHold` (`status: "released"`, `alreadyReleased`, `releasedAt`)
    plus `provenance`; standard `ConnectorResult` outcomes.
  - `CalendarHoldReleaseConnector.releaseProvisionalHold` /
    `reconcileReleasedHold`; `ReleaseScopeResolver` for restart-stable
    reconcile; `releaseHoldOperationKey` deterministic key helper.
- Live adapter: `src/connectors/google/hold-release.ts`
  (`GoogleCalendarHoldReleaseConnector`, options mirror the calendar
  adapter: injected `transport` + `tokens`, optional `calendarId` binding,
  durable `resolveReleaseScope`). Exported from
  `src/connectors/google/index.ts`.
- Demo simulator: `src/connectors/hold-release-demo.ts`
  (`DemoCalendarHoldReleaseConnector`, `DEMO ONLY`/`simulated:true`).
  Standalone file — `src/connectors/demo.ts` is untouched.

## Release protocol (live adapter)

Verified against the official Calendar v3 docs (`events.get`,
`events.delete` with `sendUpdates=none`, empty-body success):

1. Validate + enforce the calendar binding (violations fail before any HTTP).
2. Refuse any `holdId` that is not the deterministic event id for
   `originalHoldOperationKey` — a mistyped id can never delete (or falsely
   "release") a stranger event.
3. `events.get` the hold and verify Gather private properties
   (`gatherOperationKey` = original key, `gatherBookingId` = booking, exact
   window/expiry when supplied) before deleting. Missing linkage is never a
   pass. 404/410 here is authentic absence → idempotent success.
4. `events.delete` with `sendUpdates=none` and `If-Match` set to the read's
   ETag, so a concurrently changed event fails 412 (conflict) instead of
   being silently removed.
5. Confirm genuine absence with a follow-up `events.get` (404/410) before
   reporting success. A surviving event is a retryable transport failure;
   a lost confirmation read is `uncertain`.
6. Error honesty: 404/410 = absence; 403 = permission denial, 401 =
   revoked access — never absence. 5xx/408/425, timeouts, and network
   failures after DELETE dispatch are `uncertain` (`timeout_after_success`,
   `reconciliationRequired`), never retryable failures.
7. `reconcileReleasedHold` (key-only, scope from the durable resolver)
   only re-reads — it never DELETEs, so it can never blind-repeat a
   release. Absence → success; surviving verified hold → `conflict`
   (safe to retry the release with the same release operation key).

## Scopes

Least-privilege: `calendar.readonly` (verify/reconcile reads) +
`calendar.events` (delete). Never full `calendar`.

## Tests

- `tests/google-hold-release.test.ts` (SIMULATED scripted HTTP): loopback
  release, idempotent replay, wrong calendar/event (zero HTTP calls),
  changed identity/window, ETag 412, concurrent delete, surviving event,
  timeout-after-delete → uncertain → restart reconcile, delete 5xx,
  401/403 mapping, missing token (zero HTTP calls), reconcile honesty.
- `tests/hold-release-demo.test.ts` (DEMO ONLY, fictional): seed/release,
  replay, refusal, timeout/reconcile, deterministic keys.

Live gate: BLOCKED — no live account verification performed.
