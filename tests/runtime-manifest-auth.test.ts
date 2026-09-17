import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import {
  AuthError,
  assertIsolatedPath,
  containsSecret,
  deleteSecretRef,
  hasSecretRef,
  loginChoices,
  readSecretRef,
  redactForDiagnostics,
  requireLoginRoute,
  writeSecretRef,
} from "../src/runtime/index.ts";
import { resolveGatherOpenClawLayout, ensureLayoutDirectories } from "../src/runtime/index.ts";
import {
  ManifestError,
  checkExecutableSource,
  checkNodePlatform,
  checkPinnedReleases,
  loadRuntimeManifest,
  provisionPreflight,
  readInstalledPins,
} from "../src/runtime/index.ts";

/**
 * ADR-009 steps 1-2: pinned manifest validation and the isolated
 * login/key flow. Scripted only — no gateway, model, or provider.
 */

const MANIFEST_PATH = new URL("../scripts/gather-runtime-manifest.json", import.meta.url);

function layoutFixture() {
  const directory = mkdtempSync(join(tmpdir(), "gather-auth-test-"));
  const layout = resolveGatherOpenClawLayout({ rootDir: join(directory, "openclaw"), port: 41000 });
  ensureLayoutDirectories(layout);
  return { directory, layout, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test("the shipped manifest loads and its pins match this checkout's package.json", () => {
  const { manifest, path } = loadRuntimeManifest(new URL(MANIFEST_PATH).pathname);
  assert.ok(path.endsWith("gather-runtime-manifest.json"));
  assert.equal(manifest.schemaVersion, 1);
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    dependencies: Record<string, string>;
  };
  const installed = readInstalledPins(pkg);
  for (const [name, release] of Object.entries(manifest.releases)) {
    assert.equal(installed[name], release.pinned, `${name} drifted from its manifest pin`);
    assert.ok((release.integrity ?? "").startsWith("sha512-"), `${name} records package integrity`);
  }
  // The live host running this suite satisfies its own manifest.
  const { manifest: checked } = provisionPreflight({
    manifestPath: new URL(MANIFEST_PATH).pathname,
    installed,
    executableCommand: "/bin/sh",
  });
  assert.deepEqual(Object.keys(checked.releases).sort(), Object.keys(manifest.releases).sort());
});

test("node/platform/pin/executable gates fail closed", () => {
  const { manifest } = loadRuntimeManifest(new URL(MANIFEST_PATH).pathname);
  assert.throws(() => checkNodePlatform(manifest, { nodeVersion: "v20.0.0", platform: "darwin" }), (error: unknown) =>
    error instanceof ManifestError && error.code === "NODE_UNSUPPORTED",
  );
  assert.throws(() => checkNodePlatform(manifest, { nodeVersion: process.version, platform: "win32" }), (error: unknown) =>
    error instanceof ManifestError && error.code === "PLATFORM_UNSUPPORTED",
  );
  const installed = { ...Object.fromEntries(Object.entries(manifest.releases).map(([name, release]) => [name, release.pinned])) };
  const first = Object.keys(installed)[0]!;
  assert.throws(() => checkPinnedReleases(manifest, { ...installed, [first]: "9.9.9" }), (error: unknown) =>
    error instanceof ManifestError && error.code === "PIN_MISMATCH",
  );
  assert.throws(() => checkPinnedReleases(manifest, { ...installed, [first]: "latest" }), /floating installs are forbidden/);
  const { [first]: _dropped, ...missing } = installed;
  void _dropped;
  assert.throws(() => checkPinnedReleases(manifest, missing), /not installed/);
  assert.throws(() => checkExecutableSource({ command: "openclaw" }), (error: unknown) =>
    error instanceof ManifestError && error.code === "FORBIDDEN_SOURCE",
  );
  assert.throws(() => checkExecutableSource({ command: "/Users/someone/.openclaw/bin/openclaw" }), /personal\/global/);
});

test("isolated secret refs round-trip with owner-only permissions and never touch personal state", () => {
  const { layout, cleanup } = layoutFixture();
  try {
    assert.equal(hasSecretRef(layout, "oauth-refresh"), false);
    const { path } = writeSecretRef(layout, "oauth-refresh", "fixture-refresh-token-abc123");
    assert.ok(path.startsWith(layout.secretsDir));
    assert.equal(hasSecretRef(layout, "oauth-refresh"), true);
    assert.equal(readSecretRef(layout, "oauth-refresh"), "fixture-refresh-token-abc123");
    // Traversal and absolute names are refused.
    assert.throws(() => writeSecretRef(layout, "../escape", "x"), AuthError);
    assert.throws(() => writeSecretRef(layout, "/abs", "x"), AuthError);
    assert.throws(() => readSecretRef(layout, "missing"), (error: unknown) =>
      error instanceof AuthError && error.code === "SECRET_NOT_CONFIGURED",
    );
    // Personal OpenClaw state is unreachable through the isolation gate.
    assert.throws(() => assertIsolatedPath(`${process.env.HOME}/.openclaw/config.json`, layout.rootDir), (error: unknown) =>
      error instanceof AuthError && (error.code === "PERSONAL_STATE_DENIED" || error.code === "PATH_ESCAPE"),
    );
    deleteSecretRef(layout, "oauth-refresh");
    assert.equal(hasSecretRef(layout, "oauth-refresh"), false);
  } finally {
    cleanup();
  }
});

test("login choices are offered only when supported AND verified; api_key never exists", () => {
  const blocked = loginChoices({ oauth: { runtimeSupported: true, providerVerified: false, evidence: "no hello-ok handshake observed" } });
  const oauth = blocked.find((choice) => choice.route === "oauth")!;
  assert.equal(oauth.available, false);
  assert.match(oauth.reason, /LOGIN_BLOCKED/);
  assert.match(oauth.reason, /no hello-ok handshake/);
  assert.throws(() => requireLoginRoute(blocked, "oauth"), (error: unknown) =>
    error instanceof AuthError && error.code === "LOGIN_BLOCKED",
  );

  const ready = loginChoices({ oauth: { runtimeSupported: true, providerVerified: true } });
  requireLoginRoute(ready, "oauth");

  // api_key is outside the supported surface: always blocked, never a fallback.
  const apiKey = ready.find((choice) => choice.route === "api_key")!;
  assert.equal(apiKey.available, false);
  assert.match(apiKey.reason, /LOGIN_UNSUPPORTED_ROUTE/);
  assert.throws(() => requireLoginRoute(ready, "api_key"), (error: unknown) =>
    error instanceof AuthError && error.code === "LOGIN_UNSUPPORTED_ROUTE",
  );
});

test("diagnostics redaction keeps secrets out of tracked output", () => {
  const secret = "fixture-super-secret-value-999";
  const text = `token=${secret} status=ok`;
  assert.equal(containsSecret(text, [secret]), true);
  const redacted = redactForDiagnostics(text, [secret]);
  assert.equal(containsSecret(redacted, [secret]), false);
  assert.match(redacted, /\[REDACTED\]/);
  assert.match(redacted, /status=ok/);
});
