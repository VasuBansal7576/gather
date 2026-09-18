# Connections

The owner chooses which apps to connect — never workflows, databases,
agents, or technical mappings. There is no arbitrary connection cap, and a
real Google integration is distinct from the demo fixtures: it requires a
configured provider app and reports an explicit `unavailable` status when
one is missing rather than fabricating a connected state.

Implementation: `src/server/connections/`, `app/api/connections/` and `tests/connections*.test.ts`. File ownership is determined by the active change scope, not this historical module guide.

## Model

- `connected_accounts` (existing GatherStore table) stays authoritative for
  public account metadata — the service upserts rows for the capabilities
  the granted scopes cover (`gmail` / `google_calendar` / `google_drive` /
  `other`) and flips them to `revoked` on disconnect.
- `connection_auth_sessions`: single-use OAuth sessions — hashed state,
  PKCE verifier reference, expiry (10 min), business scope, and owner
  binding. Sessions resolve only under their exact owner: pending counts,
  callback reads, and the consume transaction all filter by owner, and
  legacy rows without an owner default to `local-owner` so they are never
  adopted under an arbitrary new owner. Consume and the callback binding
  snapshot commit in one transaction, closing the gap where a disconnect
  could land between them.
- `connection_accounts`: one row per verified provider identity
  (`UNIQUE(provider, account_key)`), linking the capability rows. A
  monotonic `revision` fences every binding change — disconnect, revoke,
  refresh — so in-flight refreshes can never resurrect deleted secrets or
  return a token for a binding that changed mid-exchange (also makes
  cross-process refreshes fail closed rather than double-commit).
  Revocation itself is fenced too: it lands only when the binding is still
  the exact captured revision, business, owner, and connected status, so a
  stale `invalid_grant` after disconnect/reconnect reports `STALE` instead
  of revoking the fresh binding. Each row carries the configured local
  `owner_id` (single local owner; not a multi-user auth claim): resolution,
  reauthorization, status, and every mutation only ever see rows owned by
  the configured owner. The public DTO account list follows the
  authoritative binding: accounts bound by the configured owner's
  connections stay listed in every status, accounts bound only by another
  owner are hidden (foreign owners fail closed), and rows nobody bound
  (demo fixtures write `connected_accounts` directly) keep their previous
  visibility.
- `connection_token_meta`: token *references* — versioned secret-store
  keys and the access-token expiry; never token material. A missing expiry
  means the provider issued a non-expiring token: the cached value is
  served indefinitely and never triggers a refresh or a revocation on its
  own (a lost secret with no refresh token to recover from is still
  honestly revoked). New secrets are staged under fresh refs inside a
  cleanup boundary — a failure between the access and refresh writes
  removes the half-staged refs and surfaces only a typed, redacted
  `ConnectionError` — and published only on DB commit; superseded refs are
  deleted after commit, and a reauthorization that omits a new refresh
  token preserves the previously granted one.

Connection metadata lives in the injected GatherStore SQLite database; secret material lives in the injected secret store, not SQLite. Managed live installs use a Gather-owned file store below `.runtime/live/secrets/connections/`, with owner-only directories/files and atomic same-directory replacement. Prepared mode does not create or require credential files; unmanaged development keeps the explicit Keychain adapter (or `GATHER_SECRETS=env` for scripted hosts).

## Trust boundary

- **Secrets never leave the injected `SecretStore` port** — PKCE verifiers,
  access/refresh tokens. DTOs, SQLite rows, and error messages carry
  references only.
- **State/PKCE/replay guards**: state is stored SHA-256 hashed, sessions
  expire after 10 minutes, and consumption is a conditional update inside
  `BEGIN IMMEDIATE` — a replayed or unknown state is `REPLAY`. Staging and
  the commit `BEGIN` sit inside the same cleanup boundary, so a busy store
  deletes only newly staged refs and surfaces a typed, redacted error.
- **Loopback-only redirects**: the configured `redirectUri` must be an
  `http://localhost|127.0.0.1|[::1]` URL ending exactly in
  `/api/connections/google/callback` with no userinfo, query, or
  fragment; anything else makes the connection `unavailable` instead of
  redirecting the owner elsewhere.
- **Structural provider errors**: transport failures classify by the
  OAuth `error` code only — `invalid_grant`/`unauthorized_client` mark
  the connection `revoked` (`ACCESS_REVOKED`); anything else stays
  retryable `EXCHANGE_FAILED`. Provider description text never surfaces —
  it may carry sensitive material. Production requests are bounded by a
  10 s timeout and a 64 KiB response cap, and `expires_in` must be a
  positive finite number.
- **Verified identity**: the account key comes from the provider's userinfo
  endpoint called with the fresh access token — never from callback text.
  An account already bound to a different business is `CROSS_BUSINESS`.
- **Scope coverage**: every required scope must be granted, else
  `MISSING_SCOPE` and nothing connects. Google identity aliases are
  normalized for this check only (`email` ≡
  `https://www.googleapis.com/auth/userinfo.email`,
  `profile` ≡ `https://www.googleapis.com/auth/userinfo.profile` in
  either direction); Gmail/Drive/Calendar data scopes always compare
  exactly, so a missing data scope can never hide behind an alias.
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
- `providerReadiness()` → `{provider, status:'available'|'unavailable', unavailableReason?}`
- `accessToken({accountId, businessId})` → fresh access token (async; refreshes).
  `accountId` accepts the connection id OR a public connected_accounts id
  from the DTO; `businessId` scopes the lookup explicitly.
- `disconnect({accountId, businessId})` → `{ disconnected: true }` —
  same resolution and scope rules.
- Errors: `ConnectionError` — `UNAVAILABLE`, `INVALID_REQUEST`, `REPLAY`,
  `NOT_FOUND`, `STALE`, `CROSS_BUSINESS`, `ACCESS_REVOKED`,
  `EXCHANGE_FAILED`, `MISSING_SCOPE`; `providerError` carries structural
  OAuth codes and `retryable` flags transient failures.

## Current host wiring

Routes call `getConnectionService()` in `src/server/connections/index.ts`:
it borrows `getRuntime().store`, reads provider app metadata from
`GATHER_GOOGLE_CLIENT_ID` / `GATHER_GOOGLE_CLIENT_SECRET` /
`GATHER_GOOGLE_REDIRECT_URI` / `GATHER_GOOGLE_SCOPES`, injects
`FetchOAuthTransport`, and defaults secrets to `KeychainSecretStore`
or `EnvSecretStore` when `GATHER_SECRETS=env`. There is no automatic file-backed fallback on other operating systems; the prepared fixture path does not need one. A different host injects
its own `SecretStore`/`OAuthTransport` via `createConnectionService`
instead. Internal diagnostics: `GATHER_*` variable names and the
`security`/`swift` binaries are host-operations detail — the owner-facing
DTOs only ever say "Google connection is unavailable in this
installation".

`FileSecretStore` hashes keys into confined filenames, rejects a symlinked root, applies `0700` to its directory and `0600` to each token file, and atomically replaces values through a temporary sibling plus rename. `KeychainSecretStore` namespaces to
`service=gather-connections-<workspaceHash>` — it can only touch entries
it created. Writes go through a native SecItem boundary (`swift -e`
helper) with the secret on stdin — never argv — because
`security add-generic-password -w` would expose it to `ps`. Reads and
deletes use the same Swift/Security-framework boundary so Keychain access identity remains consistent (argv carries service/account metadata, never secret values). The command runner is injectable (`KeychainRunner`), which is how
tests assert the argv hygiene without ever touching a real keychain.

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
- `POST /api/connections/google/disconnect` `{accountId, businessId}` →
  `{disconnected:true}` (same-origin guarded; business scope is explicit)

Error bodies everywhere are `{ code, message, retryable }` with codes from
`ConnectionError` plus `CROSS_ORIGIN_DENIED`/`INVALID_REQUEST`.

## Verification boundary

The automated connection tests use scripted OAuth transports and injected secret stores. They do not establish a working Google consent journey or real Keychain/file-store access. Live onboarding remains developer-configured: a fresh authorized test account, configured desktop OAuth client, Picker API/key/origin settings, and harmless read evidence are required for 012-A03; no unverified-app bypass is promised. Default scopes use `calendar.events`, `calendar.freebusy`, and `drive.file`; document reads remain explicit Picker-selected IDs and never call Drive list/search. Composio is not implemented.
