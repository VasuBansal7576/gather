/**
 * ADR-016 integration profile registry (C12): one engine, explicit profiles.
 *
 * The base profile plus the three event profiles land here as explicit
 * imports of their owning modules' stable exports — not stubs:
 * - ADR-013 `ASSEMBLYAI_PROFILE` (voice intake channel),
 * - ADR-014 `AMAZON_OWNER_MCP_PROFILE` (owner-facing MCP surface),
 * - ADR-015 `NEBIUS_INTEGRATION_PROFILE` (Nebius/NVIDIA model routing).
 *
 * Selected-only data flow: exactly one profile is selected per run via
 * `GATHER_INTEGRATION_PROFILE` (default `base`). `routeProfileData` delivers
 * a payload to the selected profile's receiver only — disabled adapters
 * receive nothing, verified by tests/release-profile-routing.test.ts. Each
 * adapter additionally gates itself on its own credentials (AssemblyAI
 * refuses without a key, Nebius throws PROFILE_DISABLED/CREDENTIAL_MISSING,
 * Amazon requires explicit per-session construction), so selection never
 * silently falls back from a required sponsor provider to another.
 */

import type { IntegrationProfile, IntegrationProfileId } from "./contracts.ts";
import { ASSEMBLYAI_PROFILE } from "./assemblyai/profile.ts";
import { AMAZON_OWNER_MCP_PROFILE } from "./amazon/index.ts";
import { NEBIUS_INTEGRATION_PROFILE } from "./nebius/index.ts";

const BASE_PROFILE: IntegrationProfile = {
  id: "base",
  label: "Base Gather",
  description: "Local-first booking coordination over Gmail, Drive, and Calendar through the pinned runtime.",
  requiredCapabilities: ["runtime", "knowledge", "google", "model"],
  credentialRequirements: [
    { key: "google-oauth", description: "Gather-operated Google OAuth client consent on the owner's own account", configuredBy: "setup flow" },
    { key: "model-access", description: "Supported model login or user-provided API key", configuredBy: "GATHER_MODEL_PROFILE_ID" },
    { key: "test-recipient", description: "Explicitly authorized live test recipient; live sends are restricted to it", configuredBy: "GATHER_TEST_RECIPIENT" },
    { key: "acceptance-signing", description: "Local secret signing live acceptance tokens", configuredBy: "GATHER_ACCEPTANCE_KEY" },
  ],
  intakeAdapter: "gmail",
  proofLabel: "live-provider",
  implementationStatus: "implemented",
};

const PROFILES: Record<IntegrationProfileId, IntegrationProfile> = {
  base: BASE_PROFILE,
  assemblyai: ASSEMBLYAI_PROFILE,
  amazon: AMAZON_OWNER_MCP_PROFILE,
  nebius: NEBIUS_INTEGRATION_PROFILE,
};

export function listProfiles(): IntegrationProfile[] {
  return Object.values(PROFILES);
}

export function getProfile(id: IntegrationProfileId): IntegrationProfile {
  return PROFILES[id];
}

/** True when the owning ADR has landed the adapter (all four, as of 016). */
export function isProfileAvailable(id: IntegrationProfileId): boolean {
  return PROFILES[id].implementationStatus === "implemented";
}

/** Environment knob carrying the owner's selected submission profile. */
export const SELECTED_PROFILE_ENV = "GATHER_INTEGRATION_PROFILE";

const PROFILE_IDS: readonly IntegrationProfileId[] = ["base", "assemblyai", "amazon", "nebius"];

/**
 * Resolve the selected profile from the environment. Defaults to `base`;
 * an unknown value falls back to `base` — never silently enabling a sponsor
 * adapter the owner did not select.
 */
export function resolveSelectedProfileId(env: Record<string, string | undefined> = process.env): IntegrationProfileId {
  const raw = (env[SELECTED_PROFILE_ENV] ?? "").trim();
  return (PROFILE_IDS as readonly string[]).includes(raw) ? (raw as IntegrationProfileId) : "base";
}

/** True only for the selected profile's adapter. Disabled adapters get nothing. */
export function isAdapterEnabled(adapterId: IntegrationProfileId, selectedId: IntegrationProfileId): boolean {
  return adapterId === selectedId;
}

/**
 * Deliver a payload to the selected profile's receiver only. Every other
 * profile's receiver is never invoked and receives no data — not even a
 * metadata ping. Returns the profile that received the payload.
 */
export function routeProfileData<T>(
  selectedId: IntegrationProfileId,
  receivers: Record<IntegrationProfileId, (payload: T) => void>,
  payload: T,
): IntegrationProfileId {
  receivers[selectedId](payload);
  return selectedId;
}
