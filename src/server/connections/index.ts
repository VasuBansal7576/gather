import { databasePath, getRuntime, ownerId } from "../runtime.ts";
import { connectionServiceFor } from "../provider-runtime/index.ts";
import { ConnectionService, type ConnectionServiceDeps } from "./service.ts";
import type { OAuthTransport } from "./types.ts";

export {
  assertLoopbackRedirectUri,
  ConnectionService,
  type ConnectionServiceDeps,
} from "./service.ts";
export { EnvSecretStore, FileSecretStore, KeychainSecretStore, MemorySecretStore, type KeychainRunner } from "./secrets.ts";
export { FetchOAuthTransport, type FetchImpl } from "./oauth.ts";
export { googleProviderAppFromEnv, defaultSecretStore } from "./config.ts";
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

/**
 * Route-facing singleton. The instance is shared with the provider runtime
 * (one in-process token-refresh singleflight and one revision fence): the
 * factory lives in provider-runtime so this module only imports the runtime
 * for the store/owner scope — never the other way around.
 */
export function getConnectionService(transport?: OAuthTransport): ConnectionService {
  return connectionServiceFor(getRuntime().store, {
    ownerId: ownerId(),
    secretsNamespace: databasePath(),
    transport,
  });
}
