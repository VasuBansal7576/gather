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
  provider: string;
  accountKey: string;
  displayName: string;
  scopesJson: string;
  status: "connected" | "revoked" | "error";
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

/** Fixed loopback redirect allowlist: http + loopback host + the exact callback path. */
export function assertLoopbackRedirectUri(redirectUri: string): string {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    throw new ConnectionError("UNAVAILABLE", `Provider redirect URI is not a valid URL: ${redirectUri}`);
  }
  const loopbackHost = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "http:" || !loopbackHost || url.pathname !== GOOGLE_CALLBACK_PATH) {
    throw new ConnectionError(
      "UNAVAILABLE",
      `Provider redirect URI must be an http loopback URL ending in ${GOOGLE_CALLBACK_PATH} (got ${redirectUri})`,
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
        provider TEXT NOT NULL,
        account_key TEXT NOT NULL,
        display_name TEXT NOT NULL,
        scopes_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('connected', 'revoked', 'error')),
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
    const connectionRows = this.db.prepare(
      "SELECT * FROM connection_accounts WHERE business_id = $b AND provider = $p",
    ).all({ $b: businessId, $p: provider }) as SqlRow[];
    const linked = this.store.listConnectedAccounts(businessId).map((account) => this.toAccountDTO(account));
    if (provider === "google" && !this.googleApp) {
      return {
        provider,
        status: "unavailable",
        unavailableReason:
          "Google provider app is not configured (missing client id/metadata); set GATHER_GOOGLE_CLIENT_ID to enable real authorization",
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
        "Google connection is unavailable: provider app is not configured (missing client id)",
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
    if (!app) throw new ConnectionError("UNAVAILABLE", "Google provider app is not configured");
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
    if (existing && existing.businessId !== session.businessId) {
      this.failSession(session.id);
      throw new ConnectionError(
        "CROSS_BUSINESS",
        `This Google account is already connected to a different business; disconnect it there first`,
      );
    }
    const grantedScopes = [...granted].sort();
    const accessRef = secretKey("google", identity.accountKey, "access");
    const refreshRef = secretKey("google", identity.accountKey, "refresh");
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
          (id, connected_account_ids_json, business_id, provider, account_key, display_name, scopes_json, status, created_at, updated_at)
         VALUES ($id, $cids, $b, 'google', $ak, $dn, $sj, 'connected', $at, $at)
         ON CONFLICT(id) DO UPDATE SET connected_account_ids_json = $cids, scopes_json = $sj, status = 'connected',
           display_name = $dn, updated_at = $at`,
      ).run({
        $id: connectionId,
        $cids: JSON.stringify(connectedIds),
        $b: session.businessId,
        $ak: identity.accountKey,
        $dn: session.displayName ?? identity.displayName,
        $sj: JSON.stringify(grantedScopes),
        $at: timestamp,
      });
      this.db.prepare(
        `INSERT INTO connection_token_meta (connection_id, access_ref, access_expires_at_ms, refresh_ref, updated_at)
         VALUES ($id, $ar, $ax, $rr, $at)
         ON CONFLICT(connection_id) DO UPDATE SET access_ref = $ar, access_expires_at_ms = $ax, refresh_ref = $rr, updated_at = $at`,
      ).run({
        $id: connectionId,
        $ar: accessRef,
        $ax: token.expiresInSec ? this.nowMs() + token.expiresInSec * 1000 : null,
        $rr: token.refreshToken ? refreshRef : null,
        $at: timestamp,
      });
      this.secrets.set(accessRef, token.accessToken);
      if (token.refreshToken) this.secrets.set(refreshRef, token.refreshToken);
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Already rolled back.
      }
      this.secrets.delete(accessRef);
      this.secrets.delete(refreshRef);
      throw error;
    }
    return {
      provider: "google",
      accountId: identity.accountKey,
      displayName: session.displayName ?? identity.displayName,
      businessId: session.businessId,
    };
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
      provider: String(row.provider),
      accountKey: String(row.account_key),
      displayName: String(row.display_name),
      scopesJson: String(row.scopes_json),
      status: row.status as ConnectionAccountRow["status"],
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
   * Return a usable access token for a connected account, refreshing when it
   * is expired or near expiry. Concurrent refreshes for one connection share
   * a single in-flight exchange (singleflight); a revoked refresh token
   * marks the connection revoked instead of looping.
   */
  async accessToken(connectionId: string): Promise<string> {
    const connection = this.connectionById(connectionId);
    if (!connection || connection.status !== "connected") {
      throw new ConnectionError("NOT_FOUND", `No connected account ${connectionId}`);
    }
    const meta = this.tokenMeta(connectionId);
    const cached = meta?.accessRef ? this.secrets.get(meta.accessRef) : undefined;
    if (cached && meta?.accessExpiresAtMs && meta.accessExpiresAtMs - this.nowMs() > ACCESS_EXPIRY_SKEW_MS) {
      return cached;
    }
    const inFlight = this.refreshes.get(connectionId);
    if (inFlight) return inFlight;
    const attempt = this.refreshConnection(connection, meta).finally(() => this.refreshes.delete(connectionId));
    this.refreshes.set(connectionId, attempt);
    return attempt;
  }

  private async refreshConnection(connection: ConnectionAccountRow, meta: TokenMetaRow | undefined): Promise<string> {
    const app = this.googleApp;
    if (!app) throw new ConnectionError("UNAVAILABLE", "Google provider app is not configured");
    const refreshToken = meta?.refreshRef ? this.secrets.get(meta.refreshRef) : undefined;
    if (!refreshToken) {
      this.markRevoked(connection);
      throw new ConnectionError("ACCESS_REVOKED", `Connection ${connection.id} has no usable refresh token`);
    }
    try {
      const token = await this.transport.refresh({
        tokenEndpoint: app.tokenEndpoint,
        clientId: app.clientId,
        clientSecret: app.clientSecret,
        refreshToken,
      });
      const timestamp = nowIso();
      const accessRef = meta?.accessRef ?? secretKey("google", connection.accountKey, "access");
      const refreshRef = meta?.refreshRef ?? secretKey("google", connection.accountKey, "refresh");
      this.secrets.set(accessRef, token.accessToken);
      if (token.refreshToken) this.secrets.set(refreshRef, token.refreshToken);
      this.db.prepare(
        `INSERT INTO connection_token_meta (connection_id, access_ref, access_expires_at_ms, refresh_ref, updated_at)
         VALUES ($id, $ar, $ax, $rr, $at)
         ON CONFLICT(connection_id) DO UPDATE SET access_ref = $ar, access_expires_at_ms = $ax, refresh_ref = $rr, updated_at = $at`,
      ).run({
        $id: connection.id,
        $ar: accessRef,
        $ax: token.expiresInSec ? this.nowMs() + token.expiresInSec * 1000 : null,
        $rr: refreshRef,
        $at: timestamp,
      });
      return token.accessToken;
    } catch (error) {
      if (error instanceof ConnectionError) throw error;
      const message = error instanceof Error ? error.message : "provider error";
      if (/invalid_grant|revoked|unauthorized/i.test(message)) {
        this.markRevoked(connection);
        throw new ConnectionError("ACCESS_REVOKED", `Connection ${connection.id} was revoked at the provider`);
      }
      throw new ConnectionError("EXCHANGE_FAILED", `Token refresh failed: ${message}`);
    }
  }

  private markRevoked(connection: ConnectionAccountRow): void {
    const timestamp = nowIso();
    this.db.prepare("UPDATE connection_accounts SET status = 'revoked', updated_at = $at WHERE id = $id").run({
      $at: timestamp,
      $id: connection.id,
    });
    for (const id of JSON.parse(connection.connectedAccountIdsJson) as string[]) {
      try {
        this.store.setConnectedAccountStatus(id, "revoked");
      } catch {
        // Row already gone; keep going.
      }
    }
  }

  // -------------------------------------------------------------- disconnect

  /**
   * Remove ONE selected Gather binding: the linked connected_accounts rows
   * flip to revoked, this module's secrets for the connection are deleted,
   * and a best-effort remote revocation is attempted. Nothing else the owner
   * has — other connections, other secrets, any provider-side data — is
   * touched.
   */
  async disconnect(connectionId: string): Promise<{ disconnected: true }> {
    let connection = this.connectionById(connectionId);
    if (!connection) {
      // Also accept a connected_accounts id: resolve to its owning connection.
      const rows = this.db.prepare("SELECT * FROM connection_accounts").all() as SqlRow[];
      for (const row of rows) {
        const candidate = this.toConnectionRow(row);
        if ((JSON.parse(candidate.connectedAccountIdsJson) as string[]).includes(connectionId)) {
          connection = candidate;
          break;
        }
      }
    }
    if (!connection) throw new ConnectionError("NOT_FOUND", `No connected account ${connectionId}`);
    const meta = this.tokenMeta(connectionId);
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
    for (const ref of [meta?.accessRef, meta?.refreshRef]) {
      if (ref) this.secrets.delete(ref);
    }
    const timestamp = nowIso();
    this.db.prepare("UPDATE connection_accounts SET status = 'revoked', updated_at = $at WHERE id = $id").run({
      $at: timestamp,
      $id: connection.id,
    });
    for (const id of JSON.parse(connection.connectedAccountIdsJson) as string[]) {
      try {
        this.store.setConnectedAccountStatus(id, "revoked");
      } catch {
        // Row already gone; keep going.
      }
    }
    this.db.prepare("DELETE FROM connection_token_meta WHERE connection_id = $id").run({ $id: connection.id });
    return { disconnected: true };
  }
}
