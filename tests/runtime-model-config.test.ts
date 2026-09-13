/**
 * Scripted tests for explicit model configuration (code only — no actual
 * provider, login, or credentials anywhere in this file).
 *
 * Verifies the exact installed-schema emission (`agents.defaults.model` as
 * a bare provider/model string, top-level `auth.profiles`/`auth.order`
 * metadata), the owner-authorized allowlist, subscription-only rejection
 * of key auth, the absent-model configured gate, and secret-freedom of the
 * materialized config.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGatewayConfig,
  defineGatherTool,
  resolveGatherOpenClawLayout,
  ensureLayoutDirectories,
  writeGatewayConfig,
  GatherOpenClawRuntime,
  GATHER_SUPPORTED_MODELS,
  ModelConfigError,
  type GatherModelSelection,
} from "../src/runtime/index.ts";

const MODEL = "openai/gpt-5.6-luna";
const PROFILE = "openai:bansalv8198@gmail.com";

function selection(overrides: Record<string, unknown> = {}): GatherModelSelection {
  return {
    model: MODEL,
    auth: { profileId: PROFILE, provider: "openai", mode: "oauth", email: "owner@example.test" },
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
        [PROFILE]: { provider: "openai", mode: "oauth", email: "owner@example.test" },
      },
      order: { "openai": [PROFILE] },
    });
  } finally {
    cleanup();
  }
});

test("unsupported, malformed, mismatched, and key-based selections fail closed", () => {
  const { layout: lay, cleanup } = layout();
  try {
    assert.throws(
      () => buildGatewayConfig(lay, { model: selection({ model: "openai/gpt-9-other" }) }),
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
      () => buildGatewayConfig(lay, { model: selection({ auth: { profileId: PROFILE, provider: "openai", mode: "api_key" } }) }),
      (error: unknown) => error instanceof ModelConfigError && error.code === "INVALID_AUTH",
      "API-key auth must be rejected: subscription-only",
    );
    assert.throws(
      () => buildGatewayConfig(lay, { model: selection({ auth: { profileId: "  ", provider: "openai", mode: "oauth" } }) }),
      (error: unknown) => error instanceof ModelConfigError && error.code === "INVALID_AUTH",
    );
    assert.ok(GATHER_SUPPORTED_MODELS.includes(MODEL));
    assert.equal(GATHER_SUPPORTED_MODELS.length, 1, "exactly one owner-authorized model");
  } finally {
    cleanup();
  }
});

test("absent model emits no model/auth keys and reports configured/unverified clearly", () => {
  const { layout: lay, cleanup } = layout();
  try {
    const config = buildGatewayConfig(lay, {});
    const defaults = (config.agents as { defaults: Record<string, unknown> }).defaults;
    assert.equal("model" in defaults, false, "control-plane/demo configs carry no model key");
    assert.equal("auth" in config, false, "control-plane/demo configs carry no auth section");
    const runtime = new GatherOpenClawRuntime({ rootDir: lay.rootDir, gatewayPort: lay.port });
    const status = runtime.modelStatus();
    assert.equal(status.configured, false);
    assert.equal(status.verified, false, "configuration alone never reports verified readiness");
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
    assert.equal(status.configured, true);
    assert.equal(status.verified, false, "even a valid selection is configured/unverified until the live auth root proves it");
    assert.equal(status.model, MODEL);
    assert.deepEqual(runtime.requireModelSelection(), selection());
    const { configPath } = runtime.provision();
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    assert.equal(config.agents.defaults.model, MODEL);
    assert.equal(config.auth.order["openai"][0], PROFILE);
    // Invalid selections report unconfigured through the gate instead of throwing.
    const bad = new GatherOpenClawRuntime({ rootDir: lay.rootDir, gatewayPort: lay.port, model: selection({ model: "other/model" }) });
    const badStatus = bad.modelStatus();
    assert.equal(badStatus.configured, false);
    assert.equal(badStatus.verified, false);
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

test("failed-start rollback rewrite preserves the model selection", async () => {
  // Every config rewrite path (provision, MCP re-write, rollback) must
  // carry the explicit model/auth selection: a failed start that tears
  // down the MCP boundary rewrites the config without the stale MCP ref
  // but must never drop the model selection with it.
  const directory = mkdtempSync(join(tmpdir(), "gather-model-rollback-"));
  try {
    const runtime = new GatherOpenClawRuntime(
      {
        rootDir: join(directory, "openclaw"),
        gatewayPort: 34000 + ((process.pid + (layoutCounter++)) % 20000),
        mcpTools: [defineGatherTool({
          name: "probe",
          description: "rollback probe tool",
          inputSchema: {},
          execution: "simulated",
          handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
        })],
        model: selection(),
      },
      {
        processFactory: () => ({
          gatewayToken: "test-token",
          pid: null,
          currentState: "stopped" as const,
          start: async () => { throw new Error("spawn denied"); },
          stop: async () => {},
        }),
        connectionFactory: () => {
          throw new Error("connection factory must not run after a failed spawn");
        },
        // This tree's facade owns boundary construction directly (no
        // injected factory): the probe tool binds a real ephemeral
        // loopback listener, which rollback then tears down.
      },
    );
    await assert.rejects(runtime.start(), /spawn denied/);
    const config = JSON.parse(readFileSync(runtime.layout.configPath, "utf8"));
    assert.equal(config.mcp, undefined, "torn-down MCP ref must be gone after rollback");
    assert.equal(config.agents.defaults.model, MODEL, "rollback rewrite must preserve the model");
    assert.deepEqual(config.auth.order, { openai: [PROFILE] }, "rollback rewrite must preserve auth selection");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
