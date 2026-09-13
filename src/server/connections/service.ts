import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ConnectedAccount } from "../../domain/contracts.ts";
import type { GatherStore } from "../sqlite-store.ts";
import {
  ConnectionError,
  type AuthorizationCompleteDTO,
  type AuthorizationStartDTO,
  type ConnectedAccountDTO,
  type ConnectionProvider,
  type ConnectionStatus,
  type ConnectionsSummaryDTO,
  type GoogleProviderApp,
  type OAuthTransport,
  type ProviderConnectionDTO,
  type SecretStore,
} from "./types.ts";

/**
 * Local connection service (PRD G01/G18): a business-scoped registry of
 * provider connections plus the Google OAuth authorization boundary.
 *
 * - connected_accounts (shared GatherStore table) stays authoritative for
 *   public account metadata; this module only writes rows it created.
 * - connection_* tables on the same injected database hold auth sessions
 *   and verified provider identity — no second database.
 * - Secrets (PKCE verifier, access/refresh tokens, client secret values)
 *   live exclusively in the injected SecretStore port and never reach
 *   SQLite rows, DTOs, or error messages.
 * - Sessions are single-use and short-lived: state is stored hashed,
 *   expiry is enforced, and a consumed/replayed/expired state is rejected.
 */

const SESSION_TTL_MS = 10 * 60 * 1000;
const ACCESS_EXPIRY_SKEW_MS = 30 * 1000;
const GOOGLE_CALLBACK_PATH = "/api/connections/google/callback";

type SqlRow = Record<string, unknown>;

interface AuthSessionRow {
  id: string;
  businessId: string;
  provider: string;
  stateHash: string;
  verifierRef: string;
  redirectUri: string;
  scopesJson: string;
  displayName: string | undefined;
  status: "pending" | "consumed" | "failed";
  expiresAtMs: number;
  createdAt: string;
}

interface ConnectionAccountRow {
  id: string;
  connectedAccountIdsJson: string;
  businessId: string;
  ownerId: string;
  provider: string;
  accountKey: string;
  displayName: string;
  scopesJson: string;
  status: "connected" | "revoked" | "error";
  /** Durable fence: bumped on every binding change so in-flight work can't resurrect stale state. */
  revision: number;
  createdAt: string;
  updatedAt: string;
}

interface TokenMetaRow {
  connectionId: string;
  accessRef: string | undefined;
  accessExpiresAtMs: number | undefined;
  refreshRef: string | undefined;
}

function nowIso(): string {
  return new Date().toISOString();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function secretKey(...parts: string[]): string {
  return `conn:${parts.join(":")}`;
}

/** Fixed loopback redirect allowlist: http + loopback host + the exact callback path, no ambiguity. */
export function assertLoopbackRedirectUri(redirectUri: string): string {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    throw new ConnectionError("UNAVAILABLE", `Provider redirect URI is not a valid URL: ${redirectUri}`);
  }
  const loopbackHost = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  const ambiguous = url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "";
  if (url.protocol !== "http:" || !loopbackHost || url.pathname !== GOOGLE_CALLBACK_PATH || ambiguous) {
    throw new ConnectionError(
      "UNAVAILABLE",
      `Provider redirect URI must be a plain http loopback URL ending in ${GOOGLE_CALLBACK_PATH} with no userinfo, query, or fragment`,
    );
  }
  return redirectUri;
}

/** Map granted Google scopes onto connected_accounts capability providers. */
function capabilityProviders(scopes: string[]): ConnectedAccount["provider"][] {
  const granted = new Set(scopes);
  const providers = new Set<ConnectedAccount["provider"]>();
  if ([...granted].some((scope) => scope.includes("gmail") || scope.includes("mail.google"))) providers.add("gmail");
  if ([...granted].some((scope) => scope.includes("calendar"))) providers.add("google_calendar");
  if ([...granted].some((scope) => scope.includes("drive") || scope.includes("docs.google"))) providers.add("google_drive");
  if (providers.size === 0) providers.add("other");
  return [...providers].sort();
}

export interface ConnectionServiceDeps {
  store: GatherStore;
  secrets: SecretStore;
  transport: OAuthTransport;
  /** Undefined when the provider app is not configured — status reports unavailable. */
  googleApp?: GoogleProviderApp;
  /** Server-derived owner principal; stamped on audit-facing metadata only. */
  ownerId: string;
  nowMs?: () => number;
}

export class ConnectionService {
  private readonly store: GatherStore;
  private readonly secrets: SecretStore;
  private readonly transport: OAuthTransport;
  private readonly googleApp?: GoogleProviderApp;
  private readonly ownerId: string;
  private readonly nowMs: () => number;
  /** In-process singleflight: concurrent refreshes for one connection share a promise. */
  private readonly refreshes = new Map<string, Promise<string>>();

  constructor(deps: ConnectionServiceDeps) {
    this.store = deps.store;
    this.secrets = deps.secrets;
    this.transport = deps.transport;
    this.googleApp = deps.googleApp;
    this.ownerId = deps.ownerId;
    this.nowMs = deps.nowMs ?? (() => Date.now());
    this.ensureTables();
  }

  private get db(): DatabaseSync {
    return this.store.db;
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS connection_auth_sessions (
        id TEXT PRIMARY KEY,
        business_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        state_hash TEXT NOT NULL UNIQUE,
        verifier_ref TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        scopes_json TEXT NOT NULL,
        display_name TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending', 'consumed', 'failed')),
        expires_at_ms INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_connection_sessions_business
        ON connection_auth_sessions(business_id, status);
      CREATE TABLE IF NOT EXISTS connection_accounts (
        id TEXT PRIMARY KEY,
        connected_account_ids_json TEXT NOT NULL,
        business_id TEXT NOT NULL,
        owner_id TEXT NOT NULL DEFAULT 'local-owner',
        provider TEXT NOT NULL,
        account_key TEXT NOT NULL,
        display_name TEXT NOT NULL,
        scopes_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('connected', 'revoked', 'error')),
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(provider, account_key)
      );
      CREATE INDEX IF NOT EXISTS idx_connection_accounts_business
        ON connection_accounts(business_id, status);
      CREATE TABLE IF NOT EXISTS connection_token_meta (
        connection_id TEXT PRIMARY KEY REFERENCES connection_accounts(id),
        access_ref TEXT,
        access_expires_at_ms INTEGER,
        refresh_ref TEXT,
        updated_at TEXT NOT NULL
      );
    `);
    const cols = this.db.prepare("PRAGMA table_info(connection_accounts)").all() as Array<{ name: string }>;
    if (!cols.some((col) => col.name === "revision")) {
      this.db.exec("ALTER TABLE connection_accounts ADD COLUMN revision INTEGER NOT NULL DEFAULT 1");
    }
    if (!cols.some((col) => col.name === "owner_id")) {
      this.db.exec("ALTER TABLE connection_accounts ADD COLUMN owner_id TEXT NOT NULL DEFAULT 'local-owner'");
    }
  }

  // ---------------------------------------------------------------- reads

  private businessExists(businessId: string): void {
    try {
      this.store.getBusiness(businessId);
    } catch {
      throw new ConnectionError("NOT_FOUND", `Business not found: ${businessId}`);
    }
  }

  private toAccountDTO(account: ConnectedAccount): ConnectedAccountDTO {
    return {
      id: account.id,
      businessId: account.businessId,
      provider: account.provider,
      displayName: account.displayName,
      status: account.status,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    };
  }

  private providerSummary(businessId: string, provider: ConnectionProvider): ProviderConnectionDTO {
    const connectionRows = (
      this.db.prepare("SELECT * FROM connection_accounts WHERE business_id = $b AND provider = $p").all({
        $b: businessId,
        $p: provider,
      }) as SqlRow[]
    ).filter((row) => String(row.owner_id ?? "local-owner") === this.ownerId);
    // Account visibility follows the authoritative owner/business binding:
    // accounts bound by this owner's connections stay visible in every
    // status (connected, revoked, ...); accounts bound only by another
    // owner's connections are hidden, so a foreign owner fails closed;
    // accounts bound by nobody (fixtures, legacy rows) keep their previous
    // visibility, preserving local demo behavior.
    const ownedIds = new Set<string>();
    const foreignIds = new Set<string>();
    for (const row of this.db.prepare(
      "SELECT connected_account_ids_json, owner_id FROM connection_accounts WHERE business_id = $b AND provider = $p",
    ).all({ $b: businessId, $p: provider }) as SqlRow[]) {
      const target = String(row.owner_id ?? "local-owner") === this.ownerId ? ownedIds : foreignIds;
      for (const id of JSON.parse(String(row.connected_account_ids_json)) as string[]) target.add(id);
    }
    const linked = this.store
      .listConnectedAccounts(businessId)
      .filter((account) => ownedIds.has(account.id) || !foreignIds.has(account.id))
      .map((account) => this.toAccountDTO(account));
    if (provider === "google" && !this.googleApp) {
      return {
        provider,
        status: "unavailable",
        unavailableReason:
          "Google connection is unavailable in this installation",
        accounts: linked,
      };
    }
    const connected = connectionRows.filter((row) => row.status === "connected");
    const pending = this.db.prepare(
      `SELECT COUNT(*) AS n FROM connection_auth_sessions
       WHERE business_id = $b AND provider = $p AND status = 'pending' AND expires_at_ms > $now`,
    ).get({ $b: businessId, $p: provider, $now: this.nowMs() }) as SqlRow | undefined;
    let status: ConnectionStatus;
    if (connected.length > 0) status = "connected";
    else if (Number(pending?.n ?? 0) > 0) status = "authorization_pending";
    else if (connectionRows.some((row) => row.status === "revoked")) status = "revoked";
    else status = "not_connected";
    return { provider, status, accounts: linked };
  }

  getConnections(businessId: string): ConnectionsSummaryDTO {
    this.businessExists(businessId);
    return { businessId, providers: [this.providerSummary(businessId, "google")] };
  }

  /** Global provider readiness — independent of any business. */
  providerReadiness(): { provider: ConnectionProvider; status: "available" | "unavailable"; unavailableReason?: string }[] {
    return [
      this.googleApp
        ? { provider: "google", status: "available" }
        : {
            provider: "google",
            status: "unavailable",
            unavailableReason:
              "Google connection is unavailable in this installation",
          },
    ];
  }

  /** Business context for a callback redirect target; undefined for unknown states. */
  peekSessionBusinessId(state: string): string | undefined {
    if (typeof state !== "string" || state.length === 0) return undefined;
    return this.sessionByState(state)?.businessId;
  }

  // ------------------------------------------------------------ oauth start

  startAuthorization(input: { businessId: string; provider: ConnectionProvider; displayName?: string }): AuthorizationStartDTO {
    if (input.provider !== "google") {
      throw new ConnectionError("INVALID_REQUEST", `Unsupported provider: ${input.provider}`);
    }
    this.businessExists(input.businessId);
    const app = this.googleApp;
    if (!app || !app.clientId.trim()) {
      throw new ConnectionError(
        "UNAVAILABLE",
        "Google connection is unavailable in this installation",
      );
    }
    const redirectUri = assertLoopbackRedirectUri(app.redirectUri);
    if (app.requiredScopes.length === 0) {
      throw new ConnectionError("UNAVAILABLE", "Google provider app declares no required scopes");
    }
    const sessionId = randomUUID();
    const state = randomBytes(32).toString("base64url");
    const codeVerifier = randomBytes(64).toString("base64url");
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
    const expiresAtMs = this.nowMs() + SESSION_TTL_MS;
    const verifierRef = secretKey("pkce", sessionId);
    this.secrets.set(verifierRef, codeVerifier);
    this.db.prepare(
      `INSERT INTO connection_auth_sessions
        (id, business_id, provider, state_hash, verifier_ref, redirect_uri, scopes_json, display_name, status, expires_at_ms, created_at)
       VALUES ($id, $b, $p, $sh, $vr, $ru, $sj, $dn, 'pending', $ex, $at)`,
    ).run({
      $id: sessionId,
      $b: input.businessId,
      $p: "google",
      $sh: sha256(state),
      $vr: verifierRef,
      $ru: redirectUri,
      $sj: JSON.stringify(app.requiredScopes),
      $dn: input.displayName?.trim() || null,
      $ex: expiresAtMs,
      $at: nowIso(),
    });
    const url = new URL(app.authEndpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", app.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", app.requiredScopes.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    return { provider: "google", authorizationUrl: url.toString(), expiresAt: new Date(expiresAtMs).toISOString() };
  }

  // --------------------------------------------------------- oauth callback

  private sessionByState(state: string): AuthSessionRow | undefined {
    const found = this.db.prepare("SELECT * FROM connection_auth_sessions WHERE state_hash = $sh").get({
      $sh: sha256(state),
    });
    if (!found) return undefined;
    const row = found as SqlRow;
    return {
      id: String(row.id),
      businessId: String(row.business_id),
      provider: String(row.provider),
      stateHash: String(row.state_hash),
      verifierRef: String(row.verifier_ref),
      redirectUri: String(row.redirect_uri),
      scopesJson: String(row.scopes_json),
      displayName: row.display_name ? String(row.display_name) : undefined,
      status: row.status as AuthSessionRow["status"],
      expiresAtMs: Number(row.expires_at_ms),
      createdAt: String(row.created_at),
    };
  }

  /**
   * Complete an authorization-code callback. The session is consumed
   * atomically BEFORE any provider call: a replayed state — or one that
   * expired or never existed — is rejected with REPLAY. The granted scopes
   * must cover every required scope, and the verified provider identity
   * (fetched with the fresh access token, never taken from the callback)
   * cannot already belong to a different business.
   */
  async completeAuthorization(input: { code: string; state: string }): Promise<AuthorizationCompleteDTO> {
    const app = this.googleApp;
    if (!app) throw new ConnectionError("UNAVAILABLE", "Google connection is unavailable in this installation");
    if (typeof input.code !== "string" || input.code.trim().length === 0) {
      throw new ConnectionError("INVALID_REQUEST", "Authorization callback requires a code");
    }
    if (typeof input.state !== "string" || input.state.trim().length === 0) {
      throw new ConnectionError("INVALID_REQUEST", "Authorization callback requires a state");
    }
    const session = this.sessionByState(input.state);
    if (!session || session.status !== "pending" || session.expiresAtMs <= this.nowMs()) {
      throw new ConnectionError(
        "REPLAY",
        "Authorization session is unknown, expired, or already consumed; start a new authorization",
      );
    }
    // Single-use: consume under a write lock before any provider call.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const consumed = this.db.prepare(
        "UPDATE connection_auth_sessions SET status = 'consumed' WHERE id = $id AND status = 'pending'",
      ).run({ $id: session.id });
      if (Number(consumed.changes) !== 1) {
        throw new ConnectionError("REPLAY", "Authorization session was already consumed by a concurrent callback");
      }
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Already rolled back.
      }
      throw error;
    }
    const codeVerifier = this.secrets.get(session.verifierRef);
    if (!codeVerifier) {
      this.failSession(session.id);
      throw new ConnectionError("REPLAY", "Authorization verifier is missing; the session cannot be completed");
    }
    let token;
    try {
      token = await this.transport.exchangeCode({
        tokenEndpoint: app.tokenEndpoint,
        clientId: app.clientId,
        clientSecret: app.clientSecret,
        code: input.code,
        redirectUri: session.redirectUri,
        codeVerifier,
      });
    } catch (error) {
      this.failSession(session.id);
      throw new ConnectionError(
        "EXCHANGE_FAILED",
        `Authorization code exchange failed: ${error instanceof Error ? error.message : "provider error"}`,
      );
    } finally {
      this.secrets.delete(session.verifierRef);
    }
    const granted = new Set(token.scope.split(/\s+/).filter(Boolean));
    const missing = app.requiredScopes.filter((scope) => !granted.has(scope));
    if (missing.length > 0) {
      this.failSession(session.id);
      throw new ConnectionError("MISSING_SCOPE", `Provider did not grant required scope(s): ${missing.join(", ")}`);
    }
    let identity;
    try {
      identity = await this.transport.fetchAccountIdentity({
        userinfoEndpoint: app.userinfoEndpoint,
        accessToken: token.accessToken,
      });
    } catch (error) {
      this.failSession(session.id);
      throw new ConnectionError(
        "EXCHANGE_FAILED",
        `Could not verify the connected account identity: ${error instanceof Error ? error.message : "provider error"}`,
      );
    }
    if (!identity.accountKey.trim()) {
      this.failSession(session.id);
      throw new ConnectionError("EXCHANGE_FAILED", "Provider returned an empty verified account identity");
    }
    const existing = this.connectionByAccountKey("google", identity.accountKey);
    if (existing && existing.ownerId !== this.ownerId) {
      this.failSession(session.id);
      throw new ConnectionError("NOT_FOUND", "No connected account for this owner");
    }
    if (existing && existing.businessId !== session.businessId) {
      this.failSession(session.id);
      throw new ConnectionError(
        "CROSS_BUSINESS",
        `This Google account is already connected to a different business; disconnect it there first`,
      );
    }
    const grantedScopes = [...granted].sort();
    // Staged publish: new secrets are written under fresh versioned refs and
    // only become the binding's refs when the DB commit succeeds — a failure
    // anywhere before commit leaves the prior valid binding and its secrets
    // untouched, and superseded refs are deleted only after commit.
    const staged = this.stageSecrets(token.accessToken, token.refreshToken, identity.accountKey);
    const stagedAccessRef = staged.accessRef;
    const stagedRefreshRef = staged.refreshRef;
    const priorMeta = existing ? this.tokenMeta(existing.id) : undefined;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const timestamp = nowIso();
      const connectionId = existing?.id ?? randomUUID();
      const capabilities = capabilityProviders(grantedScopes);
      const connectedIds: string[] = existing ? (JSON.parse(existing.connectedAccountIdsJson) as string[]) : [];
      for (const capability of capabilities) {
        const display = session.displayName ?? identity.displayName;
        const found = connectedIds.find((id) => {
          try {
            return this.store.getConnectedAccount(id).provider === capability;
          } catch {
            return false;
          }
        });
        if (found) {
          this.db.prepare(
            "UPDATE connected_accounts SET display_name = $dn, status = 'connected', updated_at = $at WHERE id = $id",
          ).run({ $dn: display, $at: timestamp, $id: found });
        } else {
          const account = this.store.upsertConnectedAccount({
            id: `acct-${randomUUID()}`,
            businessId: session.businessId,
            provider: capability,
            displayName: display,
            status: "connected",
          });
          connectedIds.push(account.id);
        }
      }
      this.db.prepare(
        `INSERT INTO connection_accounts
          (id, connected_account_ids_json, business_id, owner_id, provider, account_key, display_name, scopes_json, status, revision, created_at, updated_at)
          VALUES ($id, $cids, $b, $o, 'google', $ak, $dn, $sj, 'connected', 1, $at, $at)
          ON CONFLICT(id) DO UPDATE SET connected_account_ids_json = $cids, scopes_json = $sj, status = 'connected',
            display_name = $dn, revision = connection_accounts.revision + 1, updated_at = $at`,
      ).run({
        $id: connectionId,
        $cids: JSON.stringify(connectedIds),
        $b: session.businessId,
        $o: this.ownerId,
        $ak: identity.accountKey,
        $dn: session.displayName ?? identity.displayName,
        $sj: JSON.stringify(grantedScopes),
        $at: timestamp,
      });
      // A provider that omits a new refresh token on reauthorization keeps
      // the previously granted one — never null it out.
      const refreshRef = stagedRefreshRef ?? priorMeta?.refreshRef ?? null;
      this.db.prepare(
        `INSERT INTO connection_token_meta (connection_id, access_ref, access_expires_at_ms, refresh_ref, updated_at)
         VALUES ($id, $ar, $ax, $rr, $at)
         ON CONFLICT(connection_id) DO UPDATE SET access_ref = $ar, access_expires_at_ms = $ax, refresh_ref = $rr, updated_at = $at`,
      ).run({
        $id: connectionId,
        $ar: stagedAccessRef,
        $ax: token.expiresInSec ? this.nowMs() + token.expiresInSec * 1000 : null,
        $rr: refreshRef,
        $at: timestamp,
      });
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Already rolled back.
      }
      this.secrets.delete(stagedAccessRef);
      if (stagedRefreshRef) this.secrets.delete(stagedRefreshRef);
      throw error;
    }
    // Compensating cleanup: only the now-superseded refs are removed, and
    // only after the new binding is durable.
    if (priorMeta?.accessRef && priorMeta.accessRef !== stagedAccessRef) this.secrets.delete(priorMeta.accessRef);
    if (stagedRefreshRef && priorMeta?.refreshRef && priorMeta.refreshRef !== stagedRefreshRef) {
      this.secrets.delete(priorMeta.refreshRef);
    }
    return {
      provider: "google",
      accountId: identity.accountKey,
      displayName: session.displayName ?? identity.displayName,
      businessId: session.businessId,
    };
  }

  /**
   * Staged secret writes inside a cleanup boundary: if any write in the
   * batch fails, refs already staged by this batch are removed and only a
   * typed, redacted ConnectionError surfaces — never raw store or provider
   * details, and never a half-staged binding.
   */
  private stageSecrets(
    accessToken: string,
    refreshToken: string | undefined,
    accountKey: string,
  ): { accessRef: string; refreshRef?: string } {
    const generation = randomUUID().slice(0, 12);
    const accessRef = secretKey("google", accountKey, "access", generation);
    const refreshRef = refreshToken ? secretKey("google", accountKey, "refresh", generation) : undefined;
    const staged: string[] = [];
    try {
      this.secrets.set(accessRef, accessToken);
      staged.push(accessRef);
      if (refreshRef && refreshToken) {
        this.secrets.set(refreshRef, refreshToken);
        staged.push(refreshRef);
      }
    } catch (error) {
      for (const ref of staged) {
        try {
          this.secrets.delete(ref);
        } catch {
          // Best-effort cleanup; the typed error below still carries the signal.
        }
      }
      if (error instanceof ConnectionError) throw error;
      throw new ConnectionError("UNAVAILABLE", "Secret storage failed; no credentials were persisted and no binding was created");
    }
    return refreshRef ? { accessRef, refreshRef } : { accessRef };
  }

  private failSession(sessionId: string): void {
    this.db.prepare("UPDATE connection_auth_sessions SET status = 'failed' WHERE id = $id").run({ $id: sessionId });
  }

  private connectionByAccountKey(provider: string, accountKey: string): ConnectionAccountRow | undefined {
    const found = this.db.prepare(
      "SELECT * FROM connection_accounts WHERE provider = $p AND account_key = $k",
    ).get({ $p: provider, $k: accountKey });
    return found ? this.toConnectionRow(found as SqlRow) : undefined;
  }

  private connectionById(id: string): ConnectionAccountRow | undefined {
    const found = this.db.prepare("SELECT * FROM connection_accounts WHERE id = $id").get({ $id: id });
    return found ? this.toConnectionRow(found as SqlRow) : undefined;
  }

  private toConnectionRow(row: SqlRow): ConnectionAccountRow {
    return {
      id: String(row.id),
      connectedAccountIdsJson: String(row.connected_account_ids_json),
      businessId: String(row.business_id),
      ownerId: row.owner_id ? String(row.owner_id) : "local-owner",
      provider: String(row.provider),
      accountKey: String(row.account_key),
      displayName: String(row.display_name),
      scopesJson: String(row.scopes_json),
      status: row.status as ConnectionAccountRow["status"],
      revision: Number(row.revision ?? 1),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  // ------------------------------------------------------------ token supply

  private tokenMeta(connectionId: string): TokenMetaRow | undefined {
    const found = this.db.prepare("SELECT * FROM connection_token_meta WHERE connection_id = $id").get({
      $id: connectionId,
    });
    if (!found) return undefined;
    const row = found as SqlRow;
    return {
      connectionId: String(row.connection_id),
      accessRef: row.access_ref ? String(row.access_ref) : undefined,
      accessExpiresAtMs: row.access_expires_at_ms == null ? undefined : Number(row.access_expires_at_ms),
      refreshRef: row.refresh_ref ? String(row.refresh_ref) : undefined,
    };
  }

  /**
   * Canonical public→internal resolution: accepts either the internal
   * connection id or a public connected_accounts id (the ids callers see in
   * getConnections DTOs) and returns the owning connection row. Rows owned
   * by a different configured owner never resolve — owner isolation rests
   * on this filter plus the per-call business scope enforced by callers.
   */
  private resolveConnection(id: string): ConnectionAccountRow | undefined {
    const direct = this.connectionById(id);
    if (direct && direct.ownerId === this.ownerId) return direct;
    const rows = this.db.prepare("SELECT * FROM connection_accounts").all() as SqlRow[];
    for (const row of rows) {
      const candidate = this.toConnectionRow(row);
      if (candidate.ownerId !== this.ownerId) continue;
      if ((JSON.parse(candidate.connectedAccountIdsJson) as string[]).includes(id)) return candidate;
    }
    return undefined;
  }

  /**
   * Return a usable access token for a connected account, refreshing when it
   * is expired or near expiry. `accountId` may be the connection id or a
   * public connected_accounts id; `businessId` scopes the lookup explicitly.
   * Concurrent refreshes for one connection share a single in-flight
   * exchange (singleflight); a revoked refresh token marks the connection
   * revoked instead of looping.
   */
  async accessToken(input: { accountId: string; businessId: string }): Promise<string> {
    const connection = this.resolveConnection(input.accountId);
    if (!connection || connection.businessId !== input.businessId || connection.status !== "connected") {
      throw new ConnectionError("NOT_FOUND", `No connected account ${input.accountId} for this business`);
    }
    const meta = this.tokenMeta(connection.id);
    const cached = meta?.accessRef ? this.secrets.get(meta.accessRef) : undefined;
    // A recorded expiry of null means the provider omitted expires_in: the
    // token is non-expiring and the cached value is served indefinitely.
    // (An absent cached secret still falls through to refresh below.)
    if (cached && (meta?.accessExpiresAtMs == null || meta.accessExpiresAtMs - this.nowMs() > ACCESS_EXPIRY_SKEW_MS)) {
      return cached;
    }
    const inFlight = this.refreshes.get(connection.id);
    if (inFlight) return inFlight;
    const attempt = this.refreshConnection(connection, meta).finally(() => this.refreshes.delete(connection.id));
    this.refreshes.set(connection.id, attempt);
    return attempt;
  }

  /**
   * Refresh under a durable revision fence: the connection's revision is
   * captured before the provider exchange, staged secrets are published only
   * if the connection is still the same connected binding inside BEGIN
   * IMMEDIATE, and the revision bumps on commit. A disconnect or reconnect
   * that lands mid-exchange makes the late refresh fail STALE — it can
   * never resurrect deleted secrets or hand back a usable token for a
   * binding that no longer exists. Cross-process refreshes serialize the
   * same way: the loser's revision check fails closed.
   */
  private async refreshConnection(connection: ConnectionAccountRow, meta: TokenMetaRow | undefined): Promise<string> {
    const app = this.googleApp;
    if (!app) throw new ConnectionError("UNAVAILABLE", "Google connection is unavailable in this installation");
    const refreshToken = meta?.refreshRef ? this.secrets.get(meta.refreshRef) : undefined;
    if (!refreshToken) {
      if (!this.markRevokedIfCurrent(connection)) {
        throw new ConnectionError("STALE", "The connection changed while refreshing; re-resolve the account and retry");
      }
      throw new ConnectionError("ACCESS_REVOKED", `Connection ${connection.id} has no usable refresh token`);
    }
    let token;
    try {
      token = await this.transport.refresh({
        tokenEndpoint: app.tokenEndpoint,
        clientId: app.clientId,
        clientSecret: app.clientSecret,
        refreshToken,
      });
    } catch (error) {
      // Structural classification only — provider description text never
      // surfaces (it may carry sensitive material). invalid_grant and
      // unauthorized_client are terminal; anything else stays retryable.
      if (
        error instanceof ConnectionError &&
        (error.providerError === "invalid_grant" || error.providerError === "unauthorized_client")
      ) {
        if (!this.markRevokedIfCurrent(connection)) {
          throw new ConnectionError("STALE", "The connection changed while refreshing; re-resolve the account and retry");
        }
        throw new ConnectionError("ACCESS_REVOKED", `Connection ${connection.id} was revoked at the provider`);
      }
      if (error instanceof ConnectionError) throw error;
      throw new ConnectionError("EXCHANGE_FAILED", "Token refresh failed at the provider", { retryable: true });
    }
    // Staged publish under the revision fence.
    const staged = this.stageSecrets(token.accessToken, token.refreshToken, connection.accountKey);
    const stagedAccessRef = staged.accessRef;
    const stagedRefreshRef = staged.refreshRef;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.connectionById(connection.id);
      if (
        !current ||
        current.status !== "connected" ||
        current.revision !== connection.revision ||
        current.businessId !== connection.businessId ||
        current.ownerId !== connection.ownerId
      ) {
        throw new ConnectionError(
          "STALE",
          "The connection changed while refreshing; the refreshed token was discarded",
        );
      }
      const timestamp = nowIso();
      const refreshRef = stagedRefreshRef ?? meta?.refreshRef ?? null;
      this.db.prepare(
        `INSERT INTO connection_token_meta (connection_id, access_ref, access_expires_at_ms, refresh_ref, updated_at)
         VALUES ($id, $ar, $ax, $rr, $at)
         ON CONFLICT(connection_id) DO UPDATE SET access_ref = $ar, access_expires_at_ms = $ax, refresh_ref = $rr, updated_at = $at`,
      ).run({
        $id: connection.id,
        $ar: stagedAccessRef,
        $ax: token.expiresInSec ? this.nowMs() + token.expiresInSec * 1000 : null,
        $rr: refreshRef,
        $at: timestamp,
      });
      this.db.prepare("UPDATE connection_accounts SET revision = revision + 1, updated_at = $at WHERE id = $id").run({
        $at: timestamp,
        $id: connection.id,
      });
      this.db.exec("COMMIT");
      if (meta?.accessRef && meta.accessRef !== stagedAccessRef) this.secrets.delete(meta.accessRef);
      if (stagedRefreshRef && meta?.refreshRef && meta.refreshRef !== stagedRefreshRef) {
        this.secrets.delete(meta.refreshRef);
      }
      return token.accessToken;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Already rolled back.
      }
      this.secrets.delete(stagedAccessRef);
      if (stagedRefreshRef) this.secrets.delete(stagedRefreshRef);
      throw error;
    }
  }

  /**
   * Fenced revocation: flips the binding to revoked only if it is still the
   * exact revision, business, owner, and connected status captured before
   * the provider exchange. Returns true when the revocation landed. A
   * disconnect/reconnect (or another refresh) that lands mid-exchange makes
   * this a no-op — a stale failure can never revoke a fresh binding, and
   * callers translate the miss into STALE so they re-resolve and retry.
   */
  private markRevokedIfCurrent(connection: ConnectionAccountRow): boolean {
    const changed = this.db.prepare(
      `UPDATE connection_accounts SET status = 'revoked', revision = revision + 1, updated_at = $at
       WHERE id = $id AND business_id = $b AND owner_id = $o AND revision = $rev AND status = 'connected'`,
    ).run({
      $at: nowIso(),
      $id: connection.id,
      $b: connection.businessId,
      $o: connection.ownerId,
      $rev: connection.revision,
    });
    if (Number(changed.changes) !== 1) return false;
    for (const id of JSON.parse(connection.connectedAccountIdsJson) as string[]) {
      try {
        this.store.setConnectedAccountStatus(id, "revoked");
      } catch {
        // Row already gone; keep going.
      }
    }
    return true;
  }

  // -------------------------------------------------------------- disconnect

  /**
   * Remove ONE selected Gather binding: the linked connected_accounts rows
   * flip to revoked, this module's secrets for the connection are deleted,
   * and a best-effort remote revocation is attempted. `accountId` may be the
   * connection id or a public connected_accounts id; `businessId` scopes it
   * explicitly. The revocation commits before secrets are removed, so a
   * refresh in flight at that moment hits the revision fence and discards
   * its staged secrets instead of resurrecting the binding. Nothing else
   * the owner has — other connections, other secrets, any provider-side
   * data — is touched.
   */
  async disconnect(input: { accountId: string; businessId: string }): Promise<{ disconnected: true }> {
    const connection = this.resolveConnection(input.accountId);
    if (!connection || connection.businessId !== input.businessId) {
      throw new ConnectionError("NOT_FOUND", `No connected account ${input.accountId} for this business`);
    }
    const meta = this.tokenMeta(connection.id);
    const app = this.googleApp;
    if (app?.revokeEndpoint && this.transport.revokeToken) {
      const token =
        (meta?.refreshRef ? this.secrets.get(meta.refreshRef) : undefined) ??
        (meta?.accessRef ? this.secrets.get(meta.accessRef) : undefined);
      if (token) {
        try {
          await this.transport.revokeToken({ revokeEndpoint: app.revokeEndpoint, token, clientId: app.clientId });
        } catch {
          // Best-effort only; the local binding is removed regardless.
        }
      }
    }
    const refs: string[] = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const timestamp = nowIso();
      this.db.prepare(
        "UPDATE connection_accounts SET status = 'revoked', revision = revision + 1, updated_at = $at WHERE id = $id",
      ).run({ $at: timestamp, $id: connection.id });
      const current = this.tokenMeta(connection.id);
      if (current?.accessRef) refs.push(current.accessRef);
      if (current?.refreshRef) refs.push(current.refreshRef);
      this.db.prepare("DELETE FROM connection_token_meta WHERE connection_id = $id").run({ $id: connection.id });
      for (const id of JSON.parse(connection.connectedAccountIdsJson) as string[]) {
        try {
          this.store.setConnectedAccountStatus(id, "revoked");
        } catch {
          // Row already gone; keep going.
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Already rolled back.
      }
      throw error;
    }
    for (const ref of refs) this.secrets.delete(ref);
    return { disconnected: true };
  }
}
