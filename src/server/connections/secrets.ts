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
 * One keychain operation. `stdin` carries secret material so it never
 * appears in process argv (visible to `ps`), error text, or logs; the argv
 * itself must never contain the value being stored.
 */
export interface KeychainRunner {
  (spec: { argv: string[]; stdin?: string }): string;
}

const defaultRunner: KeychainRunner = (spec) => {
  try {
    return execFileSync(spec.argv[0]!, spec.argv.slice(1), {
      input: spec.stdin,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    // Never surface stderr: tool output may echo material the caller wrote.
    const detail = error instanceof Error && "stderr" in error ? String((error as { stderr?: unknown }).stderr ?? "") : "";
    const wrapped = new Error(detail ? `keychain operation failed: ${detail.split("\n")[0]}` : "keychain operation failed");
    (wrapped as { stderr?: string }).stderr = detail;
    throw wrapped;
  }
};

// Native keychain write via the Security framework: the value arrives on
// stdin and the SecItem API does the store — nothing secret in argv.
const SWIFT_SET_PROGRAM = `
import Foundation
import Security
let args = Array(CommandLine.arguments.dropFirst())
let service = args[0], account = args[1]
let secret = FileHandle.standardInput.readDataToEndOfFile()
let query: [String: Any] = [
  kSecClass as String: kSecClassGenericPassword,
  kSecAttrService as String: service,
  kSecAttrAccount as String: account,
]
SecItemDelete(query as CFDictionary)
var attrs = query
attrs[kSecValueData as String] = secret
let status = SecItemAdd(attrs as CFDictionary, nil)
if status != errSecSuccess {
  FileHandle.standardError.write("SecItemAdd failed".data(using: .utf8)!)
  exit(1)
}
`;

/**
 * macOS keychain adapter. Every operation is namespaced to
 * `service = gather-connections[-<namespace hash>]`, so entries belonging
 * to the user, other apps, or other tooling are unreachable. Writes go
 * through a SecItem boundary with the secret on stdin — never argv —
 * because `security add-generic-password -w` would expose it to `ps`.
 * Reads/deletes use `security` (their argv carries only the service name
 * and account key, no secret material).
 */
export class KeychainSecretStore implements SecretStore {
  private readonly service: string;
  private readonly run: KeychainRunner;

  constructor(opts: { namespace?: string; runner?: KeychainRunner } = {}) {
    const suffix = opts.namespace ? `-${sha256(opts.namespace).slice(0, 12)}` : "";
    this.service = `${KEYCHAIN_SERVICE}${suffix}`;
    this.run = opts.runner ?? defaultRunner;
  }

  private try<T>(op: () => T, notFound: () => T): T {
    try {
      return op();
    } catch (error) {
      const stderr = error instanceof Error && "stderr" in error ? String((error as { stderr?: unknown }).stderr ?? "") : "";
      if (/could not be found|not found|The specified item/i.test(stderr)) return notFound();
      throw new ConnectionError(
        "UNAVAILABLE",
        "Local keychain access is unavailable on this host; configure a different secret store",
      );
    }
  }

  get(key: string): string | undefined {
    return this.try(
      () => {
        const out = this.run({ argv: ["security", "find-generic-password", "-s", this.service, "-a", key, "-w"] });
        return out.length > 0 ? out : undefined;
      },
      () => undefined,
    );
  }

  set(key: string, value: string): void {
    this.try(
      () => {
        this.run({ argv: ["swift", "-e", SWIFT_SET_PROGRAM, this.service, key], stdin: value });
      },
      () => {
        throw new ConnectionError("UNAVAILABLE", "Keychain write failed");
      },
    );
  }

  delete(key: string): void {
    this.try(
      () => {
        this.run({ argv: ["security", "delete-generic-password", "-s", this.service, "-a", key] });
      },
      () => undefined,
    );
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
