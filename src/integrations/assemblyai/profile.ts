/**
 * ADR-013 AssemblyAI IntegrationProfile (C12, ADR-006 contract).
 *
 * The voice channel feeds the same inquiry engine — this profile declares
 * the capability/credential gates and the `voice` intake adapter id. It is
 * exported here for ADR-016 to mount; this module never touches the shared
 * registry (`src/integrations/registry.ts` is owned by 016 this wave).
 */

import type { IntegrationProfile } from "../contracts.ts";
import { resolveAssemblyAIConfig } from "./config.ts";

export const ASSEMBLYAI_PROFILE_ID = "assemblyai" as const;

export const ASSEMBLYAI_PROFILE: IntegrationProfile = {
  id: "assemblyai",
  label: "AssemblyAI voice intake",
  description:
    "Voice intake channel: a caller describes their event, AssemblyAI transcribes, the shared gate and booking engine produce the offer. No second voice booking agent.",
  requiredCapabilities: ["runtime", "knowledge", "google", "model", "voice"],
  credentialRequirements: [
    {
      key: "assemblyai-key",
      description: "AssemblyAI API key supplied outside Git",
      configuredBy: "GATHER_ASSEMBLYAI_API_KEY",
    },
    {
      key: "voice-recording",
      description: "Actual authorized caller recording for transcription",
      configuredBy: "operator-supplied audio upload",
    },
  ],
  intakeAdapter: "voice",
  proofLabel: "live-provider",
  implementationStatus: "implemented",
};

export interface AssemblyAICapabilityGate {
  capability: "voice";
  status: "pass" | "blocked";
  missingEvidence?: string;
}

/**
 * Voice capability gate: pass only when credentials are present AND a
 * recording has been supplied. An absent key or recording blocks the live
 * proof — never passed, never papered over with fixture injection.
 */
export function evaluateVoiceCapabilityGate(
  env: NodeJS.ProcessEnv = process.env,
  recordingSupplied: boolean = false,
): AssemblyAICapabilityGate {
  const config = resolveAssemblyAIConfig(env);
  if (!config.enabled) {
    return {
      capability: "voice",
      status: "blocked",
      missingEvidence: config.missingEvidence,
    };
  }
  if (!recordingSupplied) {
    return {
      capability: "voice",
      status: "blocked",
      missingEvidence:
        "voice-recording: no operator-supplied authorized caller recording has been uploaded for transcription",
    };
  }
  return { capability: "voice", status: "pass" };
}
