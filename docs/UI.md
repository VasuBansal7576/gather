# Gather owner interface

The isolated owner workspace lives in `src/components/gather/` and exports `GatherWorkspace` from `src/components/gather/index.ts`.

## What is included

The root component includes three responsive views:

- **Today:** a calm daily briefing, review queue, and next-up context.
- **Bookings:** a list and detail workspace with inquiry summary, proposal review, source evidence, activity history, and blocked availability states.
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
      onNavigate={(view) => analytics.track('gather_view_opened', { view })}
      onSelectBooking={(bookingId) => router.navigate(`/bookings/${bookingId}`)}
      onApproveProposal={(bookingId, proposalId) => openApprovalReview(bookingId, proposalId)}
      onEditProposal={(bookingId, proposalId) => openProposalEditor(bookingId, proposalId)}
      onConnect={(provider) => beginConnection(provider)}
      onRetryBlockedAction={() => reconnectCalendar()}
    />
  );
}
```

`GatherWorkspace` does not claim that an action succeeded.
Approval, edit, connect, and retry controls only invoke callbacks.
The host application owns the real mutation, confirmation, failure, and uncertain-outcome states.

The component accepts these key props:

| Prop | Purpose |
| --- | --- |
| `bookings` | Typed booking records to render instead of the local fixtures. |
| `connections` | Typed connected-account records to render instead of the local fixtures. |
| `loading` | Shows the workspace skeleton while the host resolves data. |
| `blockedState` | Shows a host-controlled blocked banner above the active view. |
| `initialView` | Opens `today`, `bookings`, or `connections`. |
| `onNavigate` | Receives view changes. |
| `onSelectBooking` | Receives a selected booking ID. |
| `onApproveProposal` | Receives the booking ID and exact proposal ID for approval. |
| `onEditProposal` | Receives the booking ID and exact proposal ID for editing. |
| `onConnect` | Receives the provider that needs connection or reconnection. |
| `onRetryBlockedAction` | Receives a host-controlled retry request for a blocked state. |

The domain types are exported from the same entry point so the coordinator can map shared contracts into this view without changing the component internals.

## Visual and accessibility notes

The interface uses a warm paper, ink, coral, sage, and gold palette with system sans-serif text and a restrained serif display face.
There are no external image or paid font dependencies.
All meaningful actions are native buttons with visible focus rings.
The active navigation item exposes `aria-current`, loading exposes `role="status"`, and blocked notices expose `role="status"`.
The mobile layout changes from the desktop split booking view to a list-first detail route.
`prefers-reduced-motion` disables shimmer and interaction transitions.

The styling is scoped under `.gather-app-shell` so the host application can mount the workspace beside another product surface without global resets.
