import type { GatherStore } from "../sqlite-store.ts";
import { defaultSecretStore, googleProviderAppFromEnv } from "../connections/config.ts";
import { FetchOAuthTransport } from "../connections/oauth.ts";
import { ConnectionService } from "../connections/service.ts";
import type { GoogleProviderApp, OAuthTransport, SecretStore } from "../connections/types.ts";

/**
 * Shared ConnectionService factory for the provider runtime and the route
 * layer. One instance per GatherStore handle so the token-refresh
 * singleflight and the durable revision fence are shared — never duplicated
 * — between connection routes and connector dispatch.
 */

export interface ConnectionServiceOptions {
  ownerId: string;
  /** Injected transport (scripted in tests); defaults to fetch-backed OAuth. */
  transport?: OAuthTransport;
  /** Injected secret store (in-memory in tests); defaults to the host default. */
  secrets?: SecretStore;
  /** Namespace for the default OS-keychain secret store. */
  secretsNamespace?: string;
  /** Explicit provider app; `null` forces unavailable, absent reads env. */
  googleApp?: GoogleProviderApp | null;
}

const services = new Map<GatherStore, ConnectionService>();

export function connectionServiceFor(store: GatherStore, options: ConnectionServiceOptions): ConnectionService {
  const existing = services.get(store);
  if (existing) return existing;
  const service = new ConnectionService({
    store,
    secrets: options.secrets ?? defaultSecretStore(options.secretsNamespace ?? "gather"),
    transport: options.transport ?? new FetchOAuthTransport(),
    googleApp: options.googleApp === undefined ? googleProviderAppFromEnv() : (options.googleApp ?? undefined),
    ownerId: options.ownerId,
  });
  services.set(store, service);
  return service;
}

/** Test-only escape hatch: drop the memoized services between cases. */
export function resetConnectionServicesForTests(): void {
  services.clear();
}
