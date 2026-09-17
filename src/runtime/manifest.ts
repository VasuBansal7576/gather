import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * ADR-009 step 1: pinned-manifest loading and pre-provision validation.
 *
 * The manifest (`scripts/gather-runtime-manifest.json`) records the one
 * exact tested runtime/client/plugin combination. Provisioning validates the
 * live environment against it BEFORE spawning anything: Node/platform
 * support, exact installed pins (never "latest"), and no global/personal
 * installation sources. A mismatch is a hard failure, not a warning.
 */

export interface PinnedRelease {
  pinned: string;
  resolved?: string;
  integrity?: string;
  role?: string;
}

export interface RuntimeManifest {
  schemaVersion: number;
  releases: Record<string, PinnedRelease>;
  node: { minimum: string; verified?: string; source?: string };
  platforms: string[];
  gatewayProtocol?: { minProtocol?: number; readinessSignal?: string; methods?: string[] };
  budgets?: {
    maxToolCallsPerRun?: number;
    maxTokensPerRun?: number;
    runDeadlineMs?: number;
    maxRunsPerBusinessPerDay?: number;
  };
}

export const MANIFEST_SCHEMA_VERSION = 1;

export class ManifestError extends Error {
  readonly code:
    | "MANIFEST_UNREADABLE"
    | "MANIFEST_SCHEMA"
    | "NODE_UNSUPPORTED"
    | "PLATFORM_UNSUPPORTED"
    | "PIN_MISMATCH"
    | "FORBIDDEN_SOURCE";
  constructor(
    code: ManifestError["code"],
    message: string,
  ) {
    super(message);
    this.name = "ManifestError";
    this.code = code;
  }
}

/** Default manifest path: scripts/gather-runtime-manifest.json beside this package. */
export function defaultManifestPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "scripts", "gather-runtime-manifest.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads and schema-checks the manifest. Throws ManifestError, never returns partial data. */
export function loadRuntimeManifest(path?: string): { manifest: RuntimeManifest; path: string } {
  const manifestPath = path ?? defaultManifestPath();
  let raw: string;
  try {
    raw = readFileSync(manifestPath, "utf8");
  } catch (error) {
    throw new ManifestError(
      "MANIFEST_UNREADABLE",
      `cannot read runtime manifest at ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ManifestError(
      "MANIFEST_SCHEMA",
      `runtime manifest at ${manifestPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new ManifestError("MANIFEST_SCHEMA", `runtime manifest at ${manifestPath} must be a JSON object`);
  }
  if (parsed.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new ManifestError(
      "MANIFEST_SCHEMA",
      `unsupported manifest schemaVersion ${JSON.stringify(parsed.schemaVersion)}; expected ${MANIFEST_SCHEMA_VERSION}`,
    );
  }
  if (!isRecord(parsed.releases) || Object.keys(parsed.releases).length === 0) {
    throw new ManifestError("MANIFEST_SCHEMA", "runtime manifest must pin at least one release in `releases`");
  }
  for (const [name, release] of Object.entries(parsed.releases)) {
    if (!isRecord(release) || typeof release.pinned !== "string" || release.pinned.length === 0) {
      throw new ManifestError("MANIFEST_SCHEMA", `manifest release ${JSON.stringify(name)} must carry a non-empty pinned version`);
    }
    if (release.pinned === "latest" || release.pinned.includes("*") || release.pinned.startsWith("^") || release.pinned.startsWith("~")) {
      throw new ManifestError(
        "MANIFEST_SCHEMA",
        `manifest release ${JSON.stringify(name)} pins ${JSON.stringify(release.pinned)}: ranges and "latest" are forbidden — record the exact tested version`,
      );
    }
  }
  if (!isRecord(parsed.node) || typeof parsed.node.minimum !== "string") {
    throw new ManifestError("MANIFEST_SCHEMA", "runtime manifest must declare `node.minimum`");
  }
  if (!Array.isArray(parsed.platforms) || parsed.platforms.length === 0) {
    throw new ManifestError("MANIFEST_SCHEMA", "runtime manifest must declare a non-empty `platforms` list");
  }
  return { manifest: parsed as unknown as RuntimeManifest, path: manifestPath };
}

function parseVersion(version: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function versionAtLeast(actual: string, minimum: string): boolean {
  const a = parseVersion(actual);
  const m = parseVersion(minimum);
  if (!a || !m) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i]! > m[i]!) return true;
    if (a[i]! < m[i]!) return false;
  }
  return true;
}

/**
 * Validates the live host against the manifest: platform allowlist
 * (macOS/Linux only — Windows is not claimed) and Node floor. Pure
 * function of injected values so tests never depend on the host.
 */
export function checkNodePlatform(
  manifest: RuntimeManifest,
  host: { nodeVersion: string; platform: string },
): void {
  if (!manifest.platforms.includes(host.platform)) {
    throw new ManifestError(
      "PLATFORM_UNSUPPORTED",
      `platform ${JSON.stringify(host.platform)} is not in the manifest allowlist [${manifest.platforms.join(", ")}]; Windows support is not claimed`,
    );
  }
  if (!versionAtLeast(host.nodeVersion, manifest.node.minimum)) {
    throw new ManifestError(
      "NODE_UNSUPPORTED",
      `node ${host.nodeVersion} is below the manifest minimum ${manifest.node.minimum}`,
    );
  }
}

/**
 * Validates installed dependency versions against the exact pins.
 * `installed` maps package name -> installed version (read from the
 * installed tree / lockfile, never from a registry "latest" lookup).
 * Every pinned release must be present and exactly equal.
 */
export function checkPinnedReleases(
  manifest: RuntimeManifest,
  installed: Record<string, string>,
): void {
  for (const [name, release] of Object.entries(manifest.releases)) {
    const actual = installed[name];
    if (actual === undefined) {
      throw new ManifestError("PIN_MISMATCH", `manifest-pinned ${name}@${release.pinned} is not installed`);
    }
    if (actual === "latest" || actual.includes("*")) {
      throw new ManifestError(
        "PIN_MISMATCH",
        `${name} resolves to ${JSON.stringify(actual)}: floating installs are forbidden — install the exact pin ${release.pinned}`,
      );
    }
    if (actual !== release.pinned) {
      throw new ManifestError(
        "PIN_MISMATCH",
        `${name} installed ${actual} does not match manifest pin ${release.pinned}; reinstall the pinned combination, never "latest"`,
      );
    }
  }
}

const FORBIDDEN_EXECUTABLE_HINTS = [".openclaw", "npm-global", "node_global"];

/**
 * Rejects executable sources that could reach outside the isolated,
 * explicitly-resolved runtime: bare PATH commands, global installs, and
 * anything under a personal ~/.openclaw tree. Mirrors the absolute-path
 * rule in process.ts at the manifest layer.
 */
export function checkExecutableSource(input: { command: string; resolvedPath?: string }): void {
  if (!input.command.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(input.command)) {
    throw new ManifestError(
      "FORBIDDEN_SOURCE",
      `openclaw executable must be an absolute validated path, got bare command ${JSON.stringify(input.command)}`,
    );
  }
  const haystack = `${input.command} ${input.resolvedPath ?? ""}`;
  for (const hint of FORBIDDEN_EXECUTABLE_HINTS) {
    if (haystack.includes(hint)) {
      throw new ManifestError(
        "FORBIDDEN_SOURCE",
        `openclaw executable ${JSON.stringify(input.command)} looks like a personal/global install (${hint}); use an explicit isolated binary, never ~/.openclaw or a global install`,
      );
    }
  }
}

/**
 * Full step-1 preflight: manifest load + host checks + pin checks +
 * executable-source check. Returns the manifest and its path on success.
 */
export function provisionPreflight(input: {
  manifestPath?: string;
  nodeVersion?: string;
  platform?: string;
  installed?: Record<string, string>;
  executableCommand?: string;
}): { manifest: RuntimeManifest; path: string } {
  const { manifest, path } = loadRuntimeManifest(input.manifestPath);
  checkNodePlatform(manifest, {
    nodeVersion: input.nodeVersion ?? process.version,
    platform: input.platform ?? process.platform,
  });
  if (input.installed) checkPinnedReleases(manifest, input.installed);
  if (input.executableCommand) checkExecutableSource({ command: input.executableCommand });
  return { manifest, path };
}

/** Reads this checkout's package.json pins without a registry lookup (for preflight callers). */
export function readInstalledPins(packageJson: { dependencies?: Record<string, string> }): Record<string, string> {
  return { ...(packageJson.dependencies ?? {}) };
}

/** Joins the manifest path for callers that stage it (evidence helper). */
export function manifestEvidencePath(): string {
  return join(defaultManifestPath());
}
