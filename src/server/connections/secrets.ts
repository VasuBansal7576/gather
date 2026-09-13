import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { ConnectionError, type SecretStore } from "./types.ts";

/**
 * Secret-store implementations. The service never sees these — it talks to
 * the SecretStore port only — and the OS adapter is scoped exclusively to
 * entries under its own fixed keychain service name: it can only ever read,
 * write, or delete secrets it created itself.
 */

const KEYCHAIN_SERVICE = "gather-connections";

/**
 * macOS keychain adapter backed by the `security` CLI. Every operation is
 * namespaced to `service = gather-connections`, so entries belonging to the
 * user, other apps, or other tooling are unreachable through this store.
 * Entry account names are the service's secret keys; only keys this module
 * generates (`conn:*`, `pkce:*`) are ever used.
 */
export class KeychainSecretStore implements SecretStore {
  private readonly service: string;

  constructor(opts: { namespace?: string } = {}) {
    // The namespace distinguishes Gather workspaces; it can only narrow the
    // scope further, never widen it beyond gather-connections entries.
    const suffix = opts.namespace ? `-${sha256(opts.namespace).slice(0, 12)}` : "";
    this.service = `${KEYCHAIN_SERVICE}${suffix}`;
  }

  private run(args: string[]): string {
    try {
      return execFileSync("security", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    } catch (error) {
      const detail = error instanceof Error && "stderr" in error ? String((error as { stderr?: unknown }).stderr ?? "") : "";
      if (/could not be found|not found/i.test(detail)) return "";
      throw new ConnectionError(
        "UNAVAILABLE",
        "Local keychain access is unavailable on this host; configure a different secret store",
      );
    }
  }

  get(key: string): string | undefined {
    const out = this.run(["find-generic-password", "-s", this.service, "-a", key, "-w"]);
    return out.length > 0 ? out : undefined;
  }

  set(key: string, value: string): void {
    this.run(["add-generic-password", "-U", "-s", this.service, "-a", key, "-w", value]);
  }

  delete(key: string): void {
    this.run(["delete-generic-password", "-s", this.service, "-a", key]);
  }
}

/**
 * Environment-backed secret store for hosts without keychain access. Keys
 * map to `GATHER_SECRET_<sanitized>`; values never appear in process args or
 * logs. Suitable for development and scripted transports.
 */
export class EnvSecretStore implements SecretStore {
  private envKey(key: string): string {
    return `GATHER_SECRET_${sha256(key).slice(0, 24).toUpperCase()}`;
  }

  get(key: string): string | undefined {
    const value = process.env[this.envKey(key)];
    return value !== undefined && value.length > 0 ? value : undefined;
  }

  set(key: string, value: string): void {
    process.env[this.envKey(key)] = value;
  }

  delete(key: string): void {
    delete process.env[this.envKey(key)];
  }
}

/** In-memory store — for tests and scripted transports; never durable. */
export class MemorySecretStore implements SecretStore {
  private readonly values = new Map<string, string>();
  get(key: string): string | undefined {
    return this.values.get(key);
  }
  set(key: string, value: string): void {
    this.values.set(key, value);
  }
  delete(key: string): void {
    this.values.delete(key);
  }
  keys(): string[] {
    return [...this.values.keys()];
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
