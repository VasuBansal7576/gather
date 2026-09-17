import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { GatherOpenClawLayout } from "./layout.ts";

/**
 * ADR-009 step 2: supported local-user login/key flow with isolated secrets.
 *
 * Secrets are local file-backed refs under the Gather-owned layout's
 * secretsDir (mode 0600, dir 0700) — never inherited developer credentials,
 * channels, or personal state. Nothing here reads or writes personal
 * ~/.openclaw: any path resolving inside the user's home OpenClaw tree or
 * outside the layout root is refused.
 *
 * Model login choices are shown only when supported by the pinned
 * runtime/provider AND verified. A missing capability is a recorded
 * blocker (LoginBlocked with evidence), never a substitute architecture:
 * there is no API-key fallback, no alternate vendor, no silent downgrade.
 */

export type LoginRoute = "oauth" | "api_key";

/** Routes the pinned runtime supports. Subscription-only: api_key is unrepresentable. */
export const SUPPORTED_LOGIN_ROUTES: readonly LoginRoute[] = Object.freeze(["oauth"]);

export class AuthError extends Error {
  readonly code:
    | "SECRET_NOT_CONFIGURED"
    | "SECRET_INVALID"
    | "PATH_ESCAPE"
    | "PERSONAL_STATE_DENIED"
    | "LOGIN_BLOCKED"
    | "LOGIN_UNSUPPORTED_ROUTE";
  constructor(code: AuthError["code"], message: string) {
    super(message);
    this.name = "AuthError";
    this.code = code;
  }
}

const SECRET_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SECRET_FILE_MODE = 0o600;
const SECRET_DIR_MODE = 0o700;

/** Resolves the secrets dir, refusing symlinked escapes. */
function secretsDir(layout: GatherOpenClawLayout): string {
  mkdirSync(layout.secretsDir, { recursive: true, mode: SECRET_DIR_MODE });
  chmodSync(layout.secretsDir, SECRET_DIR_MODE);
  return layout.secretsDir;
}

function secretPath(layout: GatherOpenClawLayout, name: string): string {
  if (!SECRET_NAME_PATTERN.test(name)) {
    throw new AuthError(
      "SECRET_INVALID",
      `secret name ${JSON.stringify(name)} must match ${SECRET_NAME_PATTERN}; path separators and traversal are never accepted`,
    );
  }
  const dir = resolve(secretsDir(layout));
  const candidate = resolve(dir, name);
  if (candidate !== join(dir, name) || !candidate.startsWith(dir + sep)) {
    throw new AuthError("PATH_ESCAPE", `secret ${JSON.stringify(name)} escapes the isolated secrets directory`);
  }
  return candidate;
}

/**
 * Refuses any path that would reach personal OpenClaw state or leave the
 * Gather-owned root. Callers pass every external path through this gate
 * before use.
 */
export function assertIsolatedPath(candidate: string, rootDir: string): string {
  const root = resolve(rootDir);
  const resolved = resolve(candidate);
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new AuthError("PATH_ESCAPE", `path ${JSON.stringify(candidate)} escapes the Gather-owned root ${root}`);
  }
  const personal = join(homedir(), ".openclaw");
  if (resolved === personal || resolved.startsWith(personal + sep)) {
    throw new AuthError(
      "PERSONAL_STATE_DENIED",
      `path ${JSON.stringify(candidate)} reaches personal OpenClaw state; Gather uses only its isolated root ${root}`,
    );
  }
  return resolved;
}

/** Stores one secret ref in the isolated secrets dir (0600). Overwrites atomically. */
export function writeSecretRef(layout: GatherOpenClawLayout, name: string, value: string): { path: string } {
  if (typeof value !== "string" || value.length === 0) {
    throw new AuthError("SECRET_INVALID", `secret ${JSON.stringify(name)} must be a non-empty string`);
  }
  if (value.length > 16 * 1024) {
    throw new AuthError("SECRET_INVALID", `secret ${JSON.stringify(name)} exceeds the 16 KiB ref limit`);
  }
  const path = secretPath(layout, name);
  assertIsolatedPath(path, layout.rootDir);
  writeFileSync(path, `${value}\n`, { mode: SECRET_FILE_MODE });
  chmodSync(path, SECRET_FILE_MODE);
  return { path };
}

/** Reads one isolated secret ref. Missing -> SECRET_NOT_CONFIGURED (a gate, not a fallback). */
export function readSecretRef(layout: GatherOpenClawLayout, name: string): string {
  const path = secretPath(layout, name);
  assertIsolatedPath(path, layout.rootDir);
  if (!existsSync(path)) {
    throw new AuthError(
      "SECRET_NOT_CONFIGURED",
      `secret ${JSON.stringify(name)} is not configured in the isolated store; complete the supported login flow — no inherited credential will be used`,
    );
  }
  return readFileSync(path, "utf8").replace(/\n$/, "");
}

export function hasSecretRef(layout: GatherOpenClawLayout, name: string): boolean {
  return existsSync(secretPath(layout, name));
}

/** Removes one isolated secret ref (rotation/revocation). Missing is a no-op success. */
export function deleteSecretRef(layout: GatherOpenClawLayout, name: string): void {
  const path = secretPath(layout, name);
  assertIsolatedPath(path, layout.rootDir);
  rmSync(path, { force: true });
}

export interface LoginChoice {
  route: LoginRoute;
  /** True only when the pinned runtime supports the route AND the provider capability is verified. */
  available: boolean;
  /** Exact blocker evidence when unavailable — shown to the owner, never worked around. */
  reason: string;
}

export interface LoginCapability {
  /** The pinned runtime supports this route (from the manifest / adapter surface). */
  runtimeSupported: boolean;
  /** The provider capability was actually verified (live handshake / capability probe). */
  providerVerified: boolean;
  /** Evidence string for the blocker record (e.g. which probe failed). */
  evidence?: string;
}

/**
 * Computes the owner-visible login choices. A route is offered only when
 * supported AND verified; anything else is a recorded blocker. `api_key`
 * is never offered: it is outside the supported surface entirely.
 */
export function loginChoices(capabilities: Partial<Record<LoginRoute, LoginCapability>>): LoginChoice[] {
  return (["oauth", "api_key"] as const).map((route) => {
    if (!SUPPORTED_LOGIN_ROUTES.includes(route)) {
      return {
        route,
        available: false,
        reason: `LOGIN_UNSUPPORTED_ROUTE: ${route} is not on the supported surface (${SUPPORTED_LOGIN_ROUTES.join(", ")} only); no fallback exists and none will be substituted`,
      };
    }
    const capability = capabilities[route];
    if (!capability?.runtimeSupported) {
      return {
        route,
        available: false,
        reason: `LOGIN_BLOCKED: ${route} is not supported by the pinned runtime${capability?.evidence ? ` — ${capability.evidence}` : ""}`,
      };
    }
    if (!capability.providerVerified) {
      return {
        route,
        available: false,
        reason: `LOGIN_BLOCKED: ${route} is supported but provider verification is missing${capability.evidence ? ` — ${capability.evidence}` : ""}; complete verification before login is offered`,
      };
    }
    return { route, available: true, reason: "supported and verified" };
  });
}

/** Requires the named route to be available; throws AuthError(LOGIN_BLOCKED/LOGIN_UNSUPPORTED_ROUTE) otherwise. */
export function requireLoginRoute(choices: LoginChoice[], route: LoginRoute): void {
  const choice = choices.find((entry) => entry.route === route);
  if (!choice || !choice.available) {
    const reason = choice?.reason ?? `LOGIN_BLOCKED: no capability evidence for ${route}`;
    const code = reason.startsWith("LOGIN_UNSUPPORTED_ROUTE") ? "LOGIN_UNSUPPORTED_ROUTE" : "LOGIN_BLOCKED";
    throw new AuthError(code, reason);
  }
}

const REDACTED = "[REDACTED]";

/**
 * Redacts known secret values from a diagnostic string. Secrets never
 * enter tracked files or diagnostics; callers pass every secret they
 * handled so logs/snapshots stay clean. Returns the redacted copy.
 */
export function redactForDiagnostics(text: string, secrets: readonly string[]): string {
  let redacted = text;
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 4) {
      redacted = redacted.split(secret).join(REDACTED);
    }
  }
  return redacted;
}

/**
 * Scans a diagnostic payload for a known secret value. Returns true when
 * any secret of length >= 4 is present — a pre-write gate for backups
 * and tracked files.
 */
export function containsSecret(text: string, secrets: readonly string[]): boolean {
  return secrets.some((secret) => typeof secret === "string" && secret.length >= 4 && text.includes(secret));
}
