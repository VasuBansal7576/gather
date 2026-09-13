import { databasePath, getRuntime, ownerId } from "../runtime.ts";
import { FetchOAuthTransport } from "./oauth.ts";
import { ConnectionService, type ConnectionServiceDeps } from "./service.ts";
import { EnvSecretStore, KeychainSecretStore } from "./secrets.ts";
import type { GoogleProviderApp, OAuthTransport, SecretStore } from "./types.ts";

export {
  assertLoopbackRedirectUri,
  ConnectionService,
  type ConnectionServiceDeps,
} from "./service.ts";
export { EnvSecretStore, KeychainSecretStore, MemorySecretStore } from "./secrets.ts";
export { FetchOAuthTransport } from "./oauth.ts";
export {
  ConnectionError,
  type AuthorizationCompleteDTO,
  type AuthorizationStartDTO,
  type ConnectedAccountDTO,
  type ConnectionErrorCode,
  type ConnectionProvider,
  type ConnectionsSummaryDTO,
  type ConnectionStatus,
  type GoogleProviderApp,
  type OAuthTokenResponse,
  type OAuthTransport,
  type ProviderConnectionDTO,
  type SecretStore,
  type VerifiedAccountIdentity,
} from "./types.ts";

/** Service factory — the wiring contract hosts use instead of shared-file edits. */
export function createConnectionService(deps: ConnectionServiceDeps): ConnectionService {
  return new ConnectionService(deps);
}

const DEFAULT_GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/drive.readonly",
];

/**
 * Provider app metadata from host config. Absent client id yields undefined —
 * the service then reports the connection as explicitly unavailable rather
 * than fabricating a connected state.
 */
export function googleProviderAppFromEnv(): GoogleProviderApp | undefined {
  const clientId = process.env.GATHER_GOOGLE_CLIENT_ID?.trim();
  if (!clientId) return undefined;
  const scopes = process.env.GATHER_GOOGLE_SCOPES?.split(/[\s,]+/).filter(Boolean);
  return {
    clientId,
    clientSecret: process.env.GATHER_GOOGLE_CLIENT_SECRET?.trim() || undefined,
    authEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint: "https://oauth2.googleapis.com/token",
    userinfoEndpoint: "https://openidconnect.googleapis.com/v1/userinfo",
    revokeEndpoint: "https://oauth2.googleapis.com/revoke",
    redirectUri:
      process.env.GATHER_GOOGLE_REDIRECT_URI?.trim() ??
      "http://localhost:3000/api/connections/google/callback",
    requiredScopes: scopes && scopes.length > 0 ? scopes : DEFAULT_GOOGLE_SCOPES,
  };
}

/**
 * Secret store for host wiring: the OS keychain adapter scoped to its own
 * gather-connections entries (namespace = this workspace's database path),
 * with an env-backed fallback when GATHER_SECRETS=env is set for
 * development/scripted hosts.
 */
export function defaultSecretStore(): SecretStore {
  if (process.env.GATHER_SECRETS === "env") return new EnvSecretStore();
  return new KeychainSecretStore({ namespace: databasePath() });
}

let cached: ConnectionService | undefined;

/**
 * Route-facing singleton. runtime.ts is shared and unmodified — this is the
 * documented handoff: routes call getConnectionService(), which borrows the
 * shared GatherStore and injects env-configured provider app metadata, the
 * keychain/env secret store, and the fetch transport.
 */
export function getConnectionService(transport?: OAuthTransport): ConnectionService {
  if (!cached) {
    cached = createConnectionService({
      store: getRuntime().store,
      secrets: defaultSecretStore(),
      transport: transport ?? new FetchOAuthTransport(),
      googleApp: googleProviderAppFromEnv(),
      ownerId: ownerId(),
    });
  }
  return cached;
}

/** Test-only escape hatch. */
export function resetConnectionServiceForTests(): void {
  cached = undefined;
}
