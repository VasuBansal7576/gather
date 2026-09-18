/**
 * ADR-016 release test: explicit profile registration + selected-only data flow.
 *
 * The registry must reference the three event profiles' real exports
 * (ADR-013/014/015), not stubs, and `routeProfileData` must deliver to the
 * selected profile's receiver only — disabled adapters receive nothing.
 * Scripted/deterministic; no network, credentials, or live providers.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { ASSEMBLYAI_PROFILE } from "../src/integrations/assemblyai/profile.ts";
import { AMAZON_OWNER_MCP_PROFILE } from "../src/integrations/amazon/index.ts";
import { NEBIUS_INTEGRATION_PROFILE } from "../src/integrations/nebius/index.ts";
import type { IntegrationProfileId } from "../src/integrations/contracts.ts";
import {
  getProfile,
  isAdapterEnabled,
  isProfileAvailable,
  listProfiles,
  resolveSelectedProfileId,
  routeProfileData,
  SELECTED_PROFILE_ENV,
} from "../src/integrations/registry.ts";

const ALL: IntegrationProfileId[] = ["base", "assemblyai", "amazon", "nebius"];

test("016 routing: registry holds the three real profile exports plus base", () => {
  const profiles = listProfiles();
  assert.deepEqual(profiles.map((profile) => profile.id).sort(), ["amazon", "assemblyai", "base", "nebius"]);
  assert.equal(getProfile("assemblyai"), ASSEMBLYAI_PROFILE);
  assert.equal(getProfile("amazon"), AMAZON_OWNER_MCP_PROFILE);
  assert.equal(getProfile("nebius"), NEBIUS_INTEGRATION_PROFILE);
  for (const id of ALL) {
    assert.equal(isProfileAvailable(id), true, `${id} adapter has landed and is available`);
  }
  // No silent fallback: each event profile keeps its own intake adapter and capabilities.
  assert.equal(getProfile("assemblyai").intakeAdapter, "voice");
  assert.equal(getProfile("amazon").intakeAdapter, "owner-mcp");
  assert.equal(getProfile("nebius").intakeAdapter, "model-call");
  assert.ok(getProfile("assemblyai").requiredCapabilities.includes("voice"));
  assert.ok(getProfile("amazon").requiredCapabilities.includes("owner-mcp"));
});

test("016 routing: selection defaults to base and never enables an unselected sponsor adapter", () => {
  assert.equal(resolveSelectedProfileId({}), "base");
  assert.equal(resolveSelectedProfileId({ [SELECTED_PROFILE_ENV]: "" }), "base");
  assert.equal(resolveSelectedProfileId({ [SELECTED_PROFILE_ENV]: "assemblyai" }), "assemblyai");
  assert.equal(resolveSelectedProfileId({ [SELECTED_PROFILE_ENV]: "amazon" }), "amazon");
  assert.equal(resolveSelectedProfileId({ [SELECTED_PROFILE_ENV]: "nebius" }), "nebius");
  assert.equal(resolveSelectedProfileId({ [SELECTED_PROFILE_ENV]: "alexa-super-voice" }), "base");
  for (const selected of ALL) {
    for (const adapter of ALL) {
      assert.equal(isAdapterEnabled(adapter, selected), adapter === selected, `${adapter} enabled only when selected (${selected})`);
    }
  }
});

test("016 routing: disabled adapters receive nothing", () => {
  for (const selected of ALL) {
    const calls: Record<IntegrationProfileId, unknown[]> = { base: [], assemblyai: [], amazon: [], nebius: [] };
    const receivers = {
      base: (payload: string) => { calls.base.push(payload); },
      assemblyai: (payload: string) => { calls.assemblyai.push(payload); },
      amazon: (payload: string) => { calls.amazon.push(payload); },
      nebius: (payload: string) => { calls.nebius.push(payload); },
    };
    const delivered = routeProfileData(selected, receivers, "sensitive-inquiry-payload");
    assert.equal(delivered, selected);
    assert.deepEqual(calls[selected], ["sensitive-inquiry-payload"]);
    for (const adapter of ALL) {
      if (adapter !== selected) assert.deepEqual(calls[adapter], [], `${adapter} must receive nothing when ${selected} is selected`);
    }
  }
});
