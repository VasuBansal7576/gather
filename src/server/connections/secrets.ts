import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, openSync, closeSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";
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
    // Never surface stderr in the message: tool output may echo material the
    // caller wrote. The raw text stays attached for internal classification
    // (not-found detection) but is never part of the thrown message.
    const detail = error instanceof Error && "stderr" in error ? String((error as { stderr?: unknown }).stderr ?? "") : "";
    const wrapped = new Error("keychain operation failed");
    (wrapped as { stderr?: string }).stderr = detail;
    throw wrapped;
  }
};

// Native keychain operations via the Security framework: every op runs under
// the SAME `swift` SecItem boundary so the item's access identity matches its
// writer. Mixing tools (SecItemAdd via swift for writes, `security` for
// reads) breaks reads: a generic-password item's default ACL trusts only its
// creating application, so a different binary gets a user prompt or a denial
// (errSecInteractionNotAllowed) instead of the value. The secret value still
// arrives on stdin — nothing secret ever appears in argv. stderr carries
// only constant strings — never keychain or secret content.
const SWIFT_QUERY_PREAMBLE = `
import Foundation
import Security
let args = Array(CommandLine.arguments.dropFirst())
let service = args[0], account = args[1]
var query: [String: Any] = [
  kSecClass as String: kSecClassGenericPassword,
  kSecAttrService as String: service,
  kSecAttrAccount as String: account,
]
`;

// Refresh path: SecItemUpdate mutates the existing record in place, so the
// item's established access (trusted-application ACL) survives a token
// rotation — delete+add would recreate the item and reset it. SecItemAdd is
// used only when no record exists yet; every other status fails closed.
const SWIFT_SET_PROGRAM = `${SWIFT_QUERY_PREAMBLE}
let secret = FileHandle.standardInput.readDataToEndOfFile()
var status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: secret] as CFDictionary)
if status == errSecItemNotFound {
  query[kSecValueData as String] = secret
  status = SecItemAdd(query as CFDictionary, nil)
}
if status != errSecSuccess {
  FileHandle.standardError.write("keychain write failed".data(using: .utf8)!)
  exit(2)
}
`;

const SWIFT_GET_PROGRAM = `${SWIFT_QUERY_PREAMBLE}
query[kSecReturnData as String] = true
var item: CFTypeRef?
let status = SecItemCopyMatching(query as CFDictionary, &item)
if status == errSecItemNotFound {
  FileHandle.standardError.write("The specified item could not be found".data(using: .utf8)!)
  exit(1)
}
if status != errSecSuccess || item == nil {
  FileHandle.standardError.write("SecItemCopyMatching failed".data(using: .utf8)!)
  exit(2)
}
FileHandle.standardOutput.write(item as! Data)
`;

const SWIFT_DELETE_PROGRAM = `${SWIFT_QUERY_PREAMBLE}
let status = SecItemDelete(query as CFDictionary)
if status == errSecItemNotFound {
  FileHandle.standardError.write("The specified item could not be found".data(using: .utf8)!)
  exit(1)
}
if status != errSecSuccess {
  FileHandle.standardError.write("SecItemDelete failed".data(using: .utf8)!)
  exit(2)
}
`;

/**
 * macOS keychain adapter. Every operation is namespaced to
 * `service = gather-connections[-<namespace hash>]`, so entries belonging
 * to the user, other apps, or other tooling are unreachable. ALL operations
 * go through the same `swift` SecItem boundary: an item's default ACL
 * trusts only its creating application, so reads/deletes must run under the
 * same tool identity that wrote them — splitting writes (SecItem) from
 * reads (`security` CLI) makes own entries unreadable. The secret value
 * still never appears in argv (`security add-generic-password -w` would
 * expose it to `ps`); argv carries only the service name and account key.
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
        const out = this.run({ argv: ["swift", "-e", SWIFT_GET_PROGRAM, this.service, key] });
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
        this.run({ argv: ["swift", "-e", SWIFT_DELETE_PROGRAM, this.service, key] });
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

/**
 * File-backed store for the managed live mode. Secret filenames are hashes of
 * store keys, so a provider/account key can never escape the configured root.
 * Writes use a same-directory temporary file followed by rename: readers see
 * either the old complete token or the new complete token, never a partial
 * value. This adapter never logs or serializes secret material elsewhere.
 */
export class FileSecretStore implements SecretStore {
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = resolve(rootDir);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const stat = lstatSync(this.root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new ConnectionError("UNAVAILABLE", "Secret store root is not a directory");
    chmodSync(this.root, 0o700);
  }

  private pathFor(key: string): string {
    return join(this.root, `${sha256(key)}.secret`);
  }

  get(key: string): string | undefined {
    try {
      const path = this.pathFor(key);
      if (lstatSync(path).isSymbolicLink()) throw new Error("secret path is a symlink");
      return readFileSync(path, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new ConnectionError("UNAVAILABLE", "Secret storage could not be read");
    }
  }

  set(key: string, value: string): void {
    const target = this.pathFor(key);
    const temporary = `${target}.${process.pid}.${sha256(`${key}:${Date.now()}:${Math.random()}`).slice(0, 12)}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(temporary, "wx", 0o600);
      writeFileSync(fd, value, { encoding: "utf8" });
      closeSync(fd);
      fd = undefined;
      chmodSync(temporary, 0o600);
      renameSync(temporary, target);
      chmodSync(target, 0o600);
    } catch {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temporary); } catch { /* best effort cleanup */ }
      throw new ConnectionError("UNAVAILABLE", "Secret storage could not be updated");
    }
  }

  delete(key: string): void {
    try {
      unlinkSync(this.pathFor(key));
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new ConnectionError("UNAVAILABLE", "Secret storage could not be cleaned up");
    }
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
