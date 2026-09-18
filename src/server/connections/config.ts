import { EnvSecretStore, FileSecretStore, KeychainSecretStore } from "./secrets.ts";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import type { GoogleProviderApp, SecretStore } from "./types.ts";

/**
 * Host environment configuration for the connection boundary. This leaf
 * module reads only process.env — it imports no runtime or service modules,
 * so both the route-facing index and the provider runtime can consume it
 * without a circular dependency.
 */

const DEFAULT_GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.freebusy",
  "https://www.googleapis.com/auth/drive.file",
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
 * gather-connections entries (namespace supplied by the caller — this module
 * never resolves host paths itself), with an env-backed fallback when
 * GATHER_SECRETS=env is set for development/scripted hosts.
 */
export function defaultSecretStore(namespace: string): SecretStore {
  if (process.env.GATHER_SECRETS === "env") return new EnvSecretStore();
  // Managed live mode owns a separate root. Prepared mode never needs or
  // creates credential files, and unmanaged development keeps Keychain as an
  // explicit developer choice.
  const installRoot = process.env.GATHER_INSTALL_ROOT?.trim();
  if (installRoot && (process.env.GATHER_MODE ?? "prepared").trim().toLowerCase() === "live") {
    const root = join(resolve(installRoot), ".runtime", "live", "secrets", "connections", sha256(namespace).slice(0, 16));
    return new FileSecretStore(root);
  }
  return new KeychainSecretStore({ namespace });
}

function sha256(value: string): string {
  // Namespace hashing prevents database paths from becoming filesystem names.
  return createHash("sha256").update(value).digest("hex");
}
