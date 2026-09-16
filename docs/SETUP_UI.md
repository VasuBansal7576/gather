# Owner setup UI

Guided setup: a real owner chooses or creates a venue (name + timezone),
connects Google apps against actual connection state, then enters the
workspace — or explicitly tries the demo. No workflows, agents, databases,
mappings, or OAuth technical forms are exposed; the provider list is driven
by the server (no app cap).

Existing implementation: `app/setup/`, `src/setup/`, and `tests/setup*.test.ts`. This is the venue-form setup, not the proposed two-card prepared-business onboarding.

## Route and states

`/setup` (client component, scoped `app/setup/setup.css` under
`.setup-shell`, inheriting host `globals.css`):

1. **Your venue** — existing businesses from `GET /api/setup` (workspace fallback only if the setup route is absent) as
   single-tap choices; create form (name + timezone with datalist)
   `POST /api/setup/business`. Loading, empty, error/retry throughout.
2. **Your apps** — `GET /api/connections?businessId` drives one card per
   returned provider: `unavailable` shows the server reason honestly,
   `authorization_pending`/`?connected=` shows the pending callback state,
   `?connectionError=` shows the failure with retry, `revoked`/`error`
   accounts show attention copy, disconnect requires confirmation and
   refetches. Connect navigates only to the validated server-returned
   `https` authorize URL (`window.location.assign`); nothing is constructed
   client-side and no token ever enters the UI.
3. **Ready** — summary plus Enter workspace (`/`). Continue is gated on at
   least one connected account.

A separate dashed **Try demo** panel calls `POST /api/demo/init`
`{demo:true}` and enters with demo context; it never seeds real setup.

Stale-request safety: a monotonic `RequestEpoch` drops late responses from
superseded business selections or retries. Callback query is read once for
the controlled `connected`/`connectionError` hint only; authoritative state
always comes from a refetch. Keyboard: native buttons/inputs/labels,
`aria-live` status region, `aria-current` steps, visible `:focus-visible`
ring. Layouts: single column under 720px and centered 880px panel at desktop; verify rendered behavior for each UI change rather than relying on historical screenshot claims.

## API contract

- `GET /api/setup` → `{ownerId, businesses:[{id,name,timezone}], providers:[{provider:'google',status:'available'|'unavailable',unavailableReason?}]}` — venue list plus readiness. Only when this route itself is absent does the UI fall back to the workspace aggregation for the same business rows.
- `POST /api/setup/business {name, timezone}` → `{business:{id,name,timezone}, created, ownerId}` — IANA-validated, idempotent on same name+timezone, owner server-derived, no seed data.
- `GET /api/connections?businessId` → `{businessId, providers[]}` with per-account states including `expired`.
- `POST /api/connections/google/authorize {businessId, displayName?}` → `{authorizationUrl, expiresAt}` (`UNAVAILABLE` → honest 503). Callback returns to `/setup?businessId=<id>&connected=google` (or `&connectionError=CODE`); the UI applies the business context and refetches — query values are never trusted as proof.
- `POST /api/connections/google/disconnect {accountId, businessId}` → `{disconnected:true}` (both ids required; account-only posts get 400).
- `POST /api/demo/init {demo:true}` (existing) for the demo action.

## Verification state

`tests/setup-contracts.test.ts` + `tests/setup-api.test.ts` use an
injected fixture fetch only — they assert validators, stale guards, and
error mapping, never real provider outcomes. The app itself calls the real
local service and renders the honest unavailable state when APIs are
absent. Rendered browser checks belong to individual UI changes; this guide does not claim current screenshot or live-provider acceptance.
