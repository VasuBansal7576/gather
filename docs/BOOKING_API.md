# Booking approval API (DEMO ONLY)

Local, durable booking-approval service backed by SQLite and deterministic
demo connectors. Every response is explicitly marked
`{ "demo": true, "mode": { "kind": "demo", "label": "DEMO ONLY", ... } }`.
Nothing here calls a live provider; receipts are simulated.

Typed contract: `src/server/dto.ts` (UI should import these types).
Service functions (injectable clock/connectors): `src/server/booking-service.ts`.
Request validation + same-origin guard: `src/server/validation.ts`.

## Approval identity

`approvedBy` is **server-derived** from `GATHER_OWNER_ID` (default
`"local-owner"`) and exposed in `GET /api/workspace` as `approvalIdentity`.
Clients must not send `approvedBy`; any such field is ignored, so untrusted
inquiry text can never authorize execution.

## Fingerprint coverage

`proposalFingerprint` covers exactly `{ bookingId, kind, payload,
sourceReferences }`. The pipeline executes **only** payload-explicit fields
(`startAt`, `endAt`, `expiresAt`, `emailTo`, `emailSubject`, `emailBody`) and
rejects proposals that omit any of them — so the displayed fingerprint covers
every consequential hold/email field. `GET /api/workspace` exposes per-proposal
`consequences` previews (resolved with the same function the pipeline uses);
`consequences: null` plus `consequencesError` means the proposal is incomplete
and approval will return `INVALID_REQUEST`.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/workspace` | Bookings with proposals + consequences previews, approvals, per-step executions, connections, `approvalIdentity`. |
| `POST` | `/api/bookings/:bookingId/approve` | Exact-version approve then fresh-availability → hold → email pipeline. Body: `{ bookingId, proposedActionId, proposalVersion, proposalFingerprint }`. |
| `POST` | `/api/actions/:actionId/retry` | Retry failed steps only. Succeeded steps are reused, never resent. Uncertain steps return `RECONCILE_REQUIRED`. |
| `POST` | `/api/executions/:executionId/reconcile` | Reconcile one `uncertain`/`partial` execution via its stable idempotency key. |
| `POST` | `/api/demo/init` | Seed fictional fixtures. Body must be exactly `{ "demo": true }`. |

A provisional hold is **never** a confirmed booking: successful responses carry
`"confirmedBooking": false`, and booking status becomes `provisional_hold`
(not `confirmed`) after a hold. `confirmed` is reserved for a future
payment/confirmation step.

## Durability model

- Step executions are **reserved atomically in SQLite before** any provider
  side effect (`reserveStepExecution`), keyed by a stable idempotency key
  (`stableOperationKey` over `{ proposedActionId, proposalVersion }`) that is
  identical across retries, reconciliation, and restarts.
- Uncertainty (throw/timeout) is **persisted as `uncertain` before** any retry
  is allowed; retry of an uncertain step is refused until reconciliation.
- Success receipts (hold/email provider records) are persisted in
  `action_executions.result_json`, so a restart reuses them without new
  provider writes. The demo adapter's in-memory world is volatile and is never
  the source of truth; simulation restart recovery proves SQLite durability,
  not a real external provider restart.
- Failed steps reopen under the **same** idempotency key, so a real provider
  dedupes them.

## Errors

Typed `{ code, message, retryable, demo: true }`. Codes: `INVALID_REQUEST`
(400), `NOT_FOUND` (404), `STALE_PROPOSAL`/`CROSS_BOOKING`/`SLOT_UNAVAILABLE`/
`CONFLICT`/`RECONCILE_REQUIRED` (409), `CROSS_ORIGIN_DENIED` (403),
`ACCESS_REVOKED`/`EXECUTION_FAILED` (502), `UNCERTAIN` (503).

Mutations require `Content-Type: application/json` and reject cross-origin
browser requests: when `Origin` (or `Referer` fallback) is present it must
match the request `Host`, else `403 CROSS_ORIGIN_DENIED`.

## Examples

```sh
curl -s localhost:3000/api/workspace | head -c 400
curl -s -X POST localhost:3000/api/demo/init \
  -H 'Content-Type: application/json' -d '{"demo":true}'
curl -s -X POST localhost:3000/api/bookings/demo-booking-clara-01/approve \
  -H 'Content-Type: application/json' \
  -d '{"bookingId":"demo-booking-clara-01","proposedActionId":"demo-proposal-clara-v1","proposalVersion":1,"proposalFingerprint":"<from workspace>"}'
curl -s -X POST localhost:3000/api/actions/demo-proposal-clara-v1/retry
curl -s -X POST localhost:3000/api/executions/<executionId>/reconcile
```

## UI mapping notes (left to the UI owner)

- Render `mode.label` ("DEMO ONLY") wherever bookings or receipts appear.
- Show each proposal's `consequences` (hold window, recipients, subject) next
  to the approve control, plus `approvalIdentity` ("approval recorded as …").
- Approval controls send the exact `proposalVersion` + `proposalFingerprint`
  from the displayed proposal; `409 STALE_PROPOSAL` means refresh the workspace.
- Blocked states: `SLOT_UNAVAILABLE` (unavailable date), `ACCESS_REVOKED`
  (reconnect), `RECONCILE_REQUIRED` (reconcile action), `UNCERTAIN` (retry later).
