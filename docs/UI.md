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
Before approving, the owner can inspect the `consequences` list (each step the host will attempt — recheck, provisional hold, offer send) and the source evidence for the proposal.
The approve control stays disabled while the proposal's fingerprint is in `pendingApprovals`, any receipt on the booking is still pending, or a request was just sent and not yet acknowledged — so the same version cannot be approved twice.
A sent approval only displays "waiting" — the workspace never presents a hold or a sent request as a confirmed booking.

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

## Visual and accessibility notes

The interface uses a warm paper, ink, coral, sage, and gold palette with system sans-serif text and a restrained serif display face.
There are no external image or paid font dependencies.
All meaningful actions are native buttons with visible focus rings; controls without a real action behind them — new inquiry, search, filter, settings, manage, add connection, more menus — render disabled with honest product wording rather than pretending to work.
The active navigation item exposes `aria-current`, loading exposes `role="status"`, blocked notices expose `role="status"`, and receipts update inside an `aria-live="polite"` region.
The mobile layout changes from the desktop split booking view to a list-first detail route, and the navigation menu button actually expands the workspace nav on small screens.
`prefers-reduced-motion` disables shimmer and interaction transitions.

The styling is scoped under `.gather-app-shell` so the host application can mount the workspace beside another product surface without global resets.

## Local checks

`src/components/gather/state.ts` holds the pure selection, pending-approval, and recovery-routing helpers; `src/components/gather/state.test.ts` covers them and runs with `node --experimental-strip-types --test src/components/gather/state.test.ts` until the shared test script picks it up.
