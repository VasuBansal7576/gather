/**
 * ADR-006 IntegrationProfile registry (C12), consumed by event ADRs in 016.
 *
 * One shared registry: base plus the three event profiles. Event profiles
 * are specified-only until their owning ADRs (013/014/015) wire them — they
 * are listed so configuration, evidence, and release gating have stable ids
 * to reference, but `isProfileAvailable` stays false and no adapter code,
 * network activity, or data flow exists for them here.
 */

import type { IntegrationProfile, IntegrationProfileId } from "./contracts.ts";

const PROFILES: Record<IntegrationProfileId, IntegrationProfile> = {
  base: {
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
  },
  assemblyai: {
    id: "assemblyai",
    label: "AssemblyAI voice intake",
    description: "Voice intake channel: a caller describes their event, AssemblyAI transcribes, the shared gate and booking engine produce the offer.",
    requiredCapabilities: ["runtime", "knowledge", "google", "model", "voice"],
    credentialRequirements: [
      { key: "assemblyai-key", description: "AssemblyAI API key supplied outside Git", configuredBy: "event configuration" },
      { key: "voice-recording", description: "Actual authorized caller recording for transcription", configuredBy: "event demonstration" },
    ],
    intakeAdapter: "voice",
    proofLabel: "live-provider",
    implementationStatus: "specified",
  },
  amazon: {
    id: "amazon",
    label: "Amazon owner interface",
    description: "Owner-facing agent interaction operating the booking engine through Gather's controlled tools, exposed as a self-hosted MCP server.",
    requiredCapabilities: ["runtime", "knowledge", "google", "model", "owner-mcp"],
    credentialRequirements: [
      { key: "mcp-deployment", description: "Loopback/self-hosted MCP surface, or a separately authorized secure external deployment", configuredBy: "event configuration" },
    ],
    intakeAdapter: "owner-mcp",
    proofLabel: "live-provider",
    implementationStatus: "specified",
  },
  nebius: {
    id: "nebius",
    label: "Nebius/NVIDIA model",
    description: "Booking reasoning routed through Nemotron on Nebius Token Factory.",
    requiredCapabilities: ["runtime", "knowledge", "google", "model"],
    credentialRequirements: [
      { key: "nebius-token-factory", description: "Nebius Token Factory access with a qualifying NVIDIA open-source model", configuredBy: "event configuration" },
    ],
    intakeAdapter: "model-call",
    proofLabel: "live-provider",
    implementationStatus: "specified",
  },
};

export function listProfiles(): IntegrationProfile[] {
  return Object.values(PROFILES);
}

export function getProfile(id: IntegrationProfileId): IntegrationProfile {
  return PROFILES[id];
}

/**
 * True only for the base profile. Event profiles become available when
 * their owning ADRs land the adapter and ADR-016 mounts them — never by
 * selecting them here.
 */
export function isProfileAvailable(id: IntegrationProfileId): boolean {
  return PROFILES[id].implementationStatus === "implemented";
}
