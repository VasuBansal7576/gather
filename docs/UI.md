# Gather owner interface

The isolated owner workspace lives in `src/components/gather/` and exports `GatherWorkspace` from `src/components/gather/index.ts`.

## What is included

The root component includes three responsive views:

- **Today:** a calm daily briefing, review queue, and next-up context.
- **Bookings:** a list and detail workspace with inquiry summary, proposal review, exact approval scope, action receipts, source evidence, activity history, and blocked availability states.
- **Connections:** Gmail, Drive, and Calendar connection cards with onboarding and reconnect states.

Loading, empty, and blocked states are first-class UI states.
The local fixtures in `demo-data.ts` are visibly labeled `Demo data` in the workspace.
They must be replaced with the host application's contracts before production use.

## Integration

```tsx
import { GatherWorkspace } from './components/gather';

export function OwnerApp() {
  return (
    <GatherWorkspace
      bookings={bookings}
      connections={connections}
      pendingApprovals={inFlightFingerprints}
      onNavigate={(view) => analytics.track('gather_view_opened', { view })}
      onSelectBooking={(bookingId) => router.navigate(`/bookings/${bookingId}`)}
      onApproveProposal={async (identity) => { await approveExactVersion(identity); }}
      onEditProposal={(identity) => openProposalEditor(identity)}
      onConnect={(provider) => beginConnection(provider)}
      onRetryBlockedAction={() => reconnectCalendar()}
      onRetryAction={({ bookingId, actionId }) => retryAction(actionId)}
      onReconcileExecution={({ bookingId, executionId }) => reconcile(executionId)}
    />
  );
}
```

`GatherWorkspace` does not claim that an action succeeded.
Approval, edit, connect, retry, and reconcile controls only invoke callbacks — and controls whose callback is not connected render disabled with an honest disclosure instead of simulating success.
The host application owns the real mutation, confirmation, failure, and uncertain-outcome states.

## Approval contract

`onApproveProposal` and `onEditProposal` receive a `ProposalIdentity`:

| Field | Source |
| --- | --- |
| `bookingId` | The displayed booking. |
| `proposedActionId` | `proposal.id` — maps to the host `ProposedAction` id. |
| `proposalVersion` | `proposal.version` — the exact numeric version shown. |
| `proposalFingerprint` | `proposal.fingerprint` — the content fingerprint shown. |

The callback carries the exact displayed identity, so an approval can never silently target a newer version.
Before approving, the owner can inspect the `consequences` list (each step the host will attempt — recheck, provisional hold, offer send), the source evidence for the proposal, and `proposal.emailPreview` — the exact recipients, subject, and body of the email it would send.
The approve control stays disabled while the proposal's fingerprint is in `pendingApprovals`, any receipt on the booking is still pending, or a request was just sent and not yet acknowledged — so the same version cannot be approved twice.
A sent approval only displays "waiting" — the workspace never presents a hold or a sent request as a confirmed booking.

The completed "Proposal approved" state requires a succeeded receipt for **every** required executable step the host declares on `proposal.requiredSteps` (e.g. `['hold', 'email']` for a provisional-hold offer), each scoped to the exact displayed action id and proposal version.
A proposal with missing steps, versionless receipts, receipts on another action or version, or pending/failed/partial/uncertain receipts never reads as approved — it stays approvable or exposes its recovery controls.
Proposals whose required steps are absent or empty can never prove completeness, so they never show the completed state; the host adapter derives `requiredSteps` from the authoritative `ProposedAction.kind`.

### Approval request lifecycle

`onApproveProposal` may return a promise:

- The click sets a synchronous `sending` guard so duplicate clicks are ignored.
- Promise resolution clears the guard; the host's props (`pendingApprovals`, receipts) then own the pending display.
- Promise rejection (or a synchronous throw) surfaces an observable "did not go through" state with a `Try approval again` control — nothing is marked sent or confirmed.
- When the host's props next show the fingerprint acknowledged, a terminal receipt, or the proposal superseded, the local record is dropped so the button can never wedge in "waiting" after the host has moved on.

## Receipts and recovery

`BookingDetail.receipts` lists one `ActionReceipt` per consequential step, each with an honest `status` of `pending`, `succeeded`, `failed`, `partial`, or `uncertain`.

- `failed` receipts with a `recoveryLabel` invoke `onRetryAction({ bookingId, actionId })` — the action retry path.
- `uncertain` and `partial` receipts with a `recoveryLabel` invoke `onReconcileExecution({ bookingId, executionId })` — the execution is verified before anything retries; an aggregate partial never lets the UI infer a definitive failed step.
- A receipt may declare `recovery: 'retry' | 'reconcile'` explicitly when the host knows the definitive safe path — but `uncertain` always reconciles first, even if `'retry'` is mistakenly declared.
- The booking-level waiting notice only renders evidence from `detail.waitingReason` (falling back to a neutral "waiting" notice and `nextAction`), routes its retry through the first recoverable receipt so the host receives exact context, and shows a "Review connections" link only when `waitingReason.connectionsRelated` is set.

## Props

| Prop | Purpose |
| --- | --- |
| `bookings` | Typed booking records to render instead of the local fixtures. Selection is preserved while the booking still exists and recovers to the first booking when it disappears. |
| `connections` | Typed connected-account records to render instead of the local fixtures. |
| `loading` | Shows the workspace skeleton while the host resolves data. |
| `blockedState` | Shows a host-controlled blocked banner above the active view. |
| `initialView` | Opens `today`, `bookings`, or `connections`. |
| `dataMode` | `'demo'` keeps the simulation label on custom data that is still simulated; `'live'` hides it. Defaults to `'demo'` when fixtures are in use. |
| `pendingApprovals` | Proposal fingerprints with an in-flight approval; matching approve controls stay disabled. |
| `onNavigate` | Receives view changes. |
| `onSelectBooking` | Receives a selected booking ID. |
| `onApproveProposal` | Receives the exact `ProposalIdentity` for approval; may return a promise for the request lifecycle above. |
| `onEditProposal` | Receives the exact `ProposalIdentity` for editing. |
| `onConnect` | Receives the provider that needs connection or reconnection. |
| `onRetryBlockedAction` | Receives a host-controlled retry request for a blocked state. |
| `onRetryAction` | Receives `{ bookingId, actionId }` to retry a failed or partial action. |
| `onReconcileExecution` | Receives `{ bookingId, executionId }` to reconcile an uncertain execution. |

Booking statuses include `needs-review`, `proposal-ready`, `waiting`, `provisional-hold`, `confirmed`, `failed`, `uncertain`, and `partial`; the legacy `hold-pending` value is still accepted as an alias for `waiting`.
The domain types are exported from the same entry point so the coordinator can map shared contracts into this view without changing the component internals.

## Host adapter (`src/host/`)

`GatherHostWorkspace` wires this UI to the local workspace service:

- `dto.ts` validates every consumed field of `GET /api/workspace` at the boundary — booking status, execution status, and mode kind are checked against enums, and `mode.kind`/`demo` must correlate (`demo` requires `demo: true`; `live` forbids it).
- `adapter.ts` maps each booking to its own business (`businessId`, not `businesses[0]`) and renders all consequence/expiry timestamps in that business's IANA timezone with an explicit abbreviation. Pending approvals are scoped to the displayed action id + version, so a stale pending execution can never block a newer proposal. Unknown source kinds and connection providers render as `unsupported` rather than being mislabeled; a missing guest count stays absent instead of reading `0`, and the booking's event name is never presented as a customer name. The proposal's `emailPreview` carries the exact recipients, subject, and body the approval would send.
- Mutations re-fetch the workspace on success AND failure so receipts reflect the durable record; the original error is preserved. A refresh failure on a loaded workspace keeps the data but discloses staleness, and a generation counter drops out-of-order responses.

## Visual and accessibility notes

The interface uses the Linear-inspired near-black palette (dark panels, fine dividers, compact type) with lavender selection/accent, a purple approve footer, and a right-side booking metadata column.
There are no external image or paid font dependencies.
All meaningful actions are native buttons with visible focus rings; controls without a real action behind them — new inquiry, search, filter, settings, manage, add connection, more menus — render disabled with honest product wording rather than pretending to work.
The active navigation item exposes `aria-current`, loading exposes `role="status"`, blocked notices expose `role="status"`, and receipts update inside an `aria-live="polite"` region.
The mobile layout changes from the desktop split booking view to a list-first detail route, and the navigation menu button actually expands the workspace nav on small screens.
`prefers-reduced-motion` disables shimmer and interaction transitions.

The styling is scoped under `.gather-app-shell` so the host application can mount the workspace beside another product surface without global resets.

## Local checks

`src/components/gather/state.ts` holds the pure selection, pending-approval, and recovery-routing helpers; `src/components/gather/state.test.ts` covers them and runs with `node --experimental-strip-types --test src/components/gather/state.test.ts` until the shared test script picks it up.

## Delivery readiness route (later integration hook)

`app/bookings/[bookingId]/delivery` renders confirmation readiness, guarded
confirmation, per-step receipts, and the operational handoff for one booking
against the actual readiness/confirm/handoff endpoints
(`src/delivery-owner/` client with strict response validation). It is
deliberately outside the shared workspace nav: hosts link to it via
`deliveryRouteForBooking(bookingId)` from `src/delivery-owner/state.ts`.
Confirm posts only the exact displayed action/version/fingerprint plus a
fresh idempotency key and stays disabled until readiness is live-ready;
handoff previews label unpersisted revisions explicitly, and recording
requires an explicit owner action. All fixture data encountered here is
labeled DEMO ONLY; no paid state is editable and no provider proofs are
fabricated.

The displayed proposal is the host's durable current pointer
(`currentProposedActionId` on the workspace booking record): the delivery
client selects exactly that action id — never `proposals.at(-1)`, never
max version. A missing, malformed, or dangling pointer is honestly no
authority ("no current proposal") instead of confirming or proving the
wrong one. Action receipts are labeled the same way: only rows scoped to
the exact current proposal with a known hold/email step count as proof,
each carrying its stored live/simulated/unknown provenance; superseded
rows render as clearly labeled history and unknown keys as unsupported
steps, never as proof. Page lifecycle is guarded
by `src/delivery-owner/page-lifecycle.ts`: load generation is separate from
each operation lifecycle and every commit is booking-scoped, so a
post-confirm reload settles busy instead of wedging it, the command result
survives refresh while the exact proposal is current (cleared on
booking/proposal change), and stale reload/navigation/unmount/concurrent
commits never mutate the current booking.
