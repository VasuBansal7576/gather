# Connections (PRD G01/G18)

The owner chooses which apps to connect — never workflows, databases,
agents, or technical mappings. There is no arbitrary connection cap, and a
real Google integration is distinct from the demo fixtures: it requires a
configured provider app and reports an explicit `unavailable` status when
one is missing rather than fabricating a connected state.

Ownership: `src/server/connections/**`, `app/api/connections/**`,
`tests/connections*.test.ts`, this document. Shared `src/server/**` files
are read-only to this module; the route-facing wiring is the factory
contract below.

## Model

- `connected_accounts` (existing GatherStore table) stays authoritative for
  public account metadata — the service upserts rows for the capabilities
  the granted scopes cover (`gmail` / `google_calendar` / `google_drive` /
  `other`) and flips them to `revoked` on disconnect.
- `connection_auth_sessions`: single-use OAuth sessions — hashed state,
  PKCE verifier reference, expiry (10 min), business scope.
- `connection_accounts`: one row per verified provider identity
  (`UNIQUE(provider, account_key)`), linking the capability rows.
- `connection_token_meta`: token *references* — secret-store keys and the
  access-token expiry; never token material.

All state lives in the injected GatherStore SQLite database. No second
database, no credential form, no assumed hardcoded account.

## Trust boundary

- **Secrets never leave the injected `SecretStore` port** — PKCE verifiers,
  access/refresh tokens. DTOs, SQLite rows, and error messages carry
  references only.
- **State/PKCE/replay guards**: state is stored SHA-256 hashed, sessions
  expire after 10 minutes, and consumption is a conditional update inside
  `BEGIN IMMEDIATE` — a replayed or unknown state is `REPLAY`.
- **Loopback-only redirects**: the configured `redirectUri` must be an
  `http://localhost|127.0.0.1|[::1]` URL ending exactly in
  `/api/connections/google/callback`; anything else makes the connection
  `unavailable` instead of redirecting the owner elsewhere.
- **Verified identity**: the account key comes from the provider's userinfo
  endpoint called with the fresh access token — never from callback text.
  An account already bound to a different business is `CROSS_BUSINESS`.
- **Scope coverage**: every required scope must be granted, else
  `MISSING_SCOPE` and nothing connects.
- **Token supply**: `accessToken(connectionId)` refreshes near expiry under
  an in-process singleflight (concurrent callers share one exchange);
  `invalid_grant`/revocation marks the connection `revoked`.
- **Scoped disconnect**: removes only the selected binding — its
  secret-store keys, its linked account rows (revoked), its token meta —
  plus a best-effort remote revocation. Other connections, other secrets,
  and all provider-side data are untouched.

## Service API (`src/server/connections/index.ts`)

- `createConnectionService({ store, secrets, transport, googleApp?, ownerId, nowMs? })`
  — the host factory. `SecretStore` and `OAuthTransport` are injected ports.
- `getConnections(businessId)` → `ConnectionsSummaryDTO`
- `startAuthorization({ businessId, provider, displayName? })` → `{ authorizationUrl, expiresAt }`
- `completeAuthorization({ code, state })` → `AuthorizationCompleteDTO` (async; transport calls)
- `accessToken(connectionId)` → fresh access token (async; refreshes)
- `disconnect(connectionId)` → `{ disconnected: true }` (accepts connection or connected-account id)
- Errors: `ConnectionError` — `UNAVAILABLE`, `INVALID_REQUEST`, `REPLAY`,
  `NOT_FOUND`, `CROSS_BUSINESS`, `ACCESS_REVOKED`, `EXCHANGE_FAILED`,
  `MISSING_SCOPE`.

## Host wiring (documented handoff — shared runtime.ts unchanged)

Routes call `getConnectionService()` in `src/server/connections/index.ts`:
it borrows `getRuntime().store`, reads provider app metadata from
`GATHER_GOOGLE_CLIENT_ID` / `GATHER_GOOGLE_CLIENT_SECRET` /
`GATHER_GOOGLE_REDIRECT_URI` / `GATHER_GOOGLE_SCOPES`, injects
`FetchOAuthTransport`, and defaults secrets to `KeychainSecretStore`
(macOS `security` CLI, `service=gather-connections-<workspaceHash>` — it
can only touch entries it created) or `EnvSecretStore` when
`GATHER_SECRETS=env`. A different host injects its own
`SecretStore`/`OAuthTransport` via `createConnectionService` instead.

## Routes

- `GET  /api/setup` → `{ ownerId, businesses: [{id,name,timezone}], providers: [{provider,status,unavailableReason?}] }`
  — owner-scoped business list + global provider readiness; ownerId is
  server-derived.
- `POST /api/setup/business` `{name, timezone}` →
  `{ business: {id,name,timezone}, created, ownerId }` — same-origin
  guarded; IANA timezone validation; same-name+timezone retries return the
  existing business under `BEGIN IMMEDIATE` (no duplicates); creates only
  the business row, never fictional seed data.
- `GET  /api/connections?businessId` → `ConnectionsSummaryDTO`
- `POST /api/connections/google/authorize` `{businessId, displayName?}` →
  `{authorizationUrl, expiresAt}` or 503 `UNAVAILABLE` (same-origin guarded)
- `GET  /api/connections/google/callback?code&state` → 302 to
  `/setup?businessId=<session business>&connected=google` or
  `/setup?businessId=...&connectionError=CODE` — the redirect target is
  server-owned (`/setup`) and preserves the session's business context;
  `?format=json` returns the result body for scripted flows.
- `POST /api/connections/google/disconnect` `{accountId}` →
  `{disconnected:true}` (same-origin guarded)

Error bodies everywhere are `{ code, message, retryable }` with codes from
`ConnectionError` plus `CROSS_ORIGIN_DENIED`/`INVALID_REQUEST`.

## Explicitly out of scope

No live OAuth was performed for this task — transport is scripted in
tests. `KeychainSecretStore` was verified only as a scoped adapter over a
fake store interface; real `security`-CLI and provider calls are deferred
to live acceptance. No generic credential UI; the owner never sees a
client id/secret/token field.
