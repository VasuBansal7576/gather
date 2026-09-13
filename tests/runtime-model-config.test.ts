/**
 * Scripted tests for explicit model configuration (code only — no actual
 * provider, login, or credentials anywhere in this file).
 *
 * Verifies the exact installed-schema emission (`agents.defaults.model` as
 * a bare provider/model string, top-level `auth.profiles`/`auth.order`
 * metadata), the owner-authorized allowlist, subscription-only rejection
 * of key auth, the absent-model ready gate, and secret-freedom of the
 * materialized config.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGatewayConfig,
  resolveGatherOpenClawLayout,
  ensureLayoutDirectories,
  writeGatewayConfig,
  GatherOpenClawRuntime,
  GATHER_SUPPORTED_MODELS,
  ModelConfigError,
  type GatherModelSelection,
} from "../src/runtime/index.ts";

const MODEL = "openai-codex/gpt-5.6-luna";
const PROFILE = "gather-codex-subscription";

function selection(overrides: Record<string, unknown> = {}): GatherModelSelection {
  return {
    model: MODEL,
    auth: { profileId: PROFILE, provider: "openai-codex", mode: "oauth", email: "bansalv8198@gmail.com" },
    ...overrides,
  } as GatherModelSelection;
}

function layout() {
  const directory = mkdtempSync(join(tmpdir(), "gather-model-test-"));
  const port = 33000 + ((process.pid + (layoutCounter++)) % 20000);
  return {
    layout: resolveGatherOpenClawLayout({ rootDir: join(directory, "openclaw"), port }),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}
let layoutCounter = 0;

test("emits the exact model string with subscription profile selection/order", () => {
  const { layout: lay, cleanup } = layout();
  try {
    const config = buildGatewayConfig(lay, { model: selection() });
    assert.equal(config.agents !== undefined && (config.agents as Record<string, unknown>).defaults !== undefined, true);
    const defaults = (config.agents as { defaults: Record<string, unknown> }).defaults;
    assert.equal(defaults.model, MODEL);
    assert.equal(typeof defaults.model, "string", "model must be a bare string — never a primary+fallbacks object");
    assert.equal(JSON.stringify(config).includes("fallbacks"), false, "no alternate-model fallback may be configured");
    assert.deepEqual(config.auth, {
      profiles: {
        [PROFILE]: { provider: "openai-codex", mode: "oauth", email: "bansalv8198@gmail.com" },
      },
      order: { "openai-codex": [PROFILE] },
    });
  } finally {
    cleanup();
  }
});

test("unsupported, malformed, mismatched, and key-based selections fail closed", () => {
  const { layout: lay, cleanup } = layout();
  try {
    assert.throws(
      () => buildGatewayConfig(lay, { model: selection({ model: "openai-codex/gpt-9-other" }) }),
      (error: unknown) => error instanceof ModelConfigError && error.code === "UNSUPPORTED_MODEL",
    );
    assert.throws(
      () => buildGatewayConfig(lay, { model: selection({ model: "not-a-ref" }) }),
      (error: unknown) => error instanceof ModelConfigError && error.code === "INVALID_MODEL",
    );
    assert.throws(
      () => buildGatewayConfig(lay, { model: selection({ auth: { profileId: PROFILE, provider: "other-provider", mode: "oauth" } }) }),
      (error: unknown) => error instanceof ModelConfigError && error.code === "INVALID_AUTH",
    );
    assert.throws(
      () => buildGatewayConfig(lay, { model: selection({ auth: { profileId: PROFILE, provider: "openai-codex", mode: "api_key" } }) }),
      (error: unknown) => error instanceof ModelConfigError && error.code === "INVALID_AUTH",
      "API-key auth must be rejected: subscription-only",
    );
    assert.throws(
      () => buildGatewayConfig(lay, { model: selection({ auth: { profileId: "  ", provider: "openai-codex", mode: "oauth" } }) }),
      (error: unknown) => error instanceof ModelConfigError && error.code === "INVALID_AUTH",
    );
    assert.ok(GATHER_SUPPORTED_MODELS.includes(MODEL));
    assert.equal(GATHER_SUPPORTED_MODELS.length, 1, "exactly one owner-authorized model");
  } finally {
    cleanup();
  }
});

test("absent model emits no model/auth keys and fails ready-for-model clearly", () => {
  const { layout: lay, cleanup } = layout();
  try {
    const config = buildGatewayConfig(lay, {});
    const defaults = (config.agents as { defaults: Record<string, unknown> }).defaults;
    assert.equal("model" in defaults, false, "control-plane/demo configs carry no model key");
    assert.equal("auth" in config, false, "control-plane/demo configs carry no auth section");
    const runtime = new GatherOpenClawRuntime({ rootDir: lay.rootDir, gatewayPort: lay.port });
    const status = runtime.modelStatus();
    assert.equal(status.ready, false);
    assert.match(status.reason ?? "", /MODEL_NOT_CONFIGURED/);
    assert.throws(
      () => runtime.requireModelSelection(),
      (error: unknown) => error instanceof ModelConfigError && error.code === "MODEL_NOT_CONFIGURED",
    );
  } finally {
    cleanup();
  }
});

test("runtime provision passes the model through and gates readiness", () => {
  const { layout: lay, cleanup } = layout();
  try {
    ensureLayoutDirectories(lay);
    const runtime = new GatherOpenClawRuntime({ rootDir: lay.rootDir, gatewayPort: lay.port, model: selection() });
    const status = runtime.modelStatus();
    assert.equal(status.ready, true);
    assert.equal(status.model, MODEL);
    assert.deepEqual(runtime.requireModelSelection(), selection());
    const { configPath } = runtime.provision();
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    assert.equal(config.agents.defaults.model, MODEL);
    assert.equal(config.auth.order["openai-codex"][0], PROFILE);
    // Invalid selections report not-ready through the gate instead of throwing.
    const bad = new GatherOpenClawRuntime({ rootDir: lay.rootDir, gatewayPort: lay.port, model: selection({ model: "other/model" }) });
    const badStatus = bad.modelStatus();
    assert.equal(badStatus.ready, false);
    assert.match(badStatus.reason ?? "", /UNSUPPORTED_MODEL/);
  } finally {
    cleanup();
  }
});

test("materialized model config carries no credential material", () => {
  const { layout: lay, cleanup } = layout();
  try {
    ensureLayoutDirectories(lay);
    writeGatewayConfig(lay, { model: selection() });
    const raw = readFileSync(lay.configPath, "utf8");
    const lowered = raw.toLowerCase();
    for (const banned of ["api_key", "apikey", "secret", "credential", "refresh_token", "access_token", "private_key"]) {
      assert.equal(lowered.includes(banned), false, `config must not contain ${banned}`);
    }
    const config = JSON.parse(raw);
    assert.deepEqual(
      Object.keys(config.auth.profiles[PROFILE]).sort(),
      ["email", "mode", "provider"],
      "profile metadata is exactly the supported selection fields",
    );
  } finally {
    cleanup();
  }
});
