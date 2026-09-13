import type { ConnectedAccount, ISODateTime } from "../../domain/contracts.ts";

/**
 * Connection service contracts (PRD G01/G18): the owner chooses which apps
 * to connect — never workflows, databases, agents, or technical mappings —
 * and every public shape is free of secrets. Two injected host ports keep
 * this module honest: SecretStore holds tokens/verifiers outside SQLite,
 * and OAuthTransport is the only way provider HTTP happens (scripted in
 * tests, fetch-backed in production).
 */

export type ConnectionProvider = "google";

export type ConnectionStatus =
  | "unavailable" // provider app assets (client id etc.) are not configured
  | "not_connected"
  | "authorization_pending"
  | "connected"
  | "revoked"
  | "error";

/** Public account metadata — sourced from the authoritative connected_accounts table. */
export interface ConnectedAccountDTO {
  id: string;
  businessId: string;
  provider: ConnectedAccount["provider"];
  displayName: string;
  status: ConnectedAccount["status"];
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface ProviderConnectionDTO {
  provider: ConnectionProvider;
  status: ConnectionStatus;
  /** Present when status is 'unavailable' — explains exactly what is missing. */
  unavailableReason?: string;
  accounts: ConnectedAccountDTO[];
}

export interface ConnectionsSummaryDTO {
  businessId: string;
  providers: ProviderConnectionDTO[];
}

export interface AuthorizationStartDTO {
  provider: ConnectionProvider;
  /** The URL the owner is sent to; contains the opaque state + PKCE challenge. */
  authorizationUrl: string;
  expiresAt: ISODateTime;
}

export interface AuthorizationCompleteDTO {
  provider: ConnectionProvider;
  accountId: string;
  displayName: string;
  businessId: string;
}

export type ConnectionErrorCode =
  | "UNAVAILABLE"
  | "INVALID_REQUEST"
  | "REPLAY"
  | "NOT_FOUND"
  | "STALE"
  | "CROSS_BUSINESS"
  | "ACCESS_REVOKED"
  | "EXCHANGE_FAILED"
  | "MISSING_SCOPE";

export class ConnectionError extends Error {
  readonly code: ConnectionErrorCode;
  /**
   * Structural provider error code (e.g. 'invalid_grant') when the failure
   * came from a standards-shaped token endpoint — classification only, never
   * provider description text that could carry sensitive material.
   */
  readonly providerError?: string;
  /** True when the caller may retry the same operation later. */
  readonly retryable: boolean;
  constructor(code: ConnectionErrorCode, message: string, opts: { providerError?: string; retryable?: boolean } = {}) {
    super(message);
    this.name = "ConnectionError";
    this.code = code;
    this.providerError = opts.providerError;
    this.retryable = opts.retryable ?? code === "EXCHANGE_FAILED";
  }
}

/**
 * Host-owned secret storage. Keys are namespaced strings; implementations
 * must only ever touch entries they own (the OS-keychain adapter scopes to
 * its own service name and never reads pre-existing entries).
 */
export interface SecretStore {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): void;
}

export interface OAuthTokenResponse {
  accessToken: string;
  refreshToken?: string;
  /** Seconds until the access token expires; absent means non-expiring. */
  expiresInSec?: number;
  /** Space-separated granted scopes. */
  scope: string;
}

export interface VerifiedAccountIdentity {
  /** Stable provider-side identity (google sub); never a typed-in value. */
  accountKey: string;
  displayName: string;
}

/**
 * The only path provider HTTP takes. Implementations are injected — a
 * scripted transport in tests, a fetch-backed transport in production.
 */
export interface OAuthTransport {
  exchangeCode(input: {
    tokenEndpoint: string;
    clientId: string;
    clientSecret?: string;
    code: string;
    redirectUri: string;
    codeVerifier: string;
  }): Promise<OAuthTokenResponse>;
  refresh(input: {
    tokenEndpoint: string;
    clientId: string;
    clientSecret?: string;
    refreshToken: string;
  }): Promise<OAuthTokenResponse>;
  fetchAccountIdentity(input: {
    userinfoEndpoint: string;
    accessToken: string;
  }): Promise<VerifiedAccountIdentity>;
  /** Best-effort remote revocation; failures are swallowed by callers. */
  revokeToken?(input: { revokeEndpoint: string; token: string; clientId: string }): Promise<void>;
}

/** Configurable provider app metadata; absent means the connection is unavailable. */
export interface GoogleProviderApp {
  clientId: string;
  /** Optional confidential-client secret (public PKCE clients omit it). */
  clientSecret?: string;
  authEndpoint: string;
  tokenEndpoint: string;
  userinfoEndpoint: string;
  revokeEndpoint: string;
  /** Loopback redirect; validated against the fixed allowlist before use. */
  redirectUri: string;
  /** Scopes this Gather deployment requires; granted scopes must cover all. */
  requiredScopes: string[];
}
