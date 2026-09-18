/**
 * ADR-013 AssemblyAI voice intake: operator configuration (C12).
 *
 * Credentials come from the environment, never from Git or customer text.
 * A disabled profile performs zero network activity and receives no audio
 * data — the client refuses to run before any fetch exists.
 */

export const ASSEMBLYAI_MAX_AUDIO_BYTES = 10 * 1024 * 1024; // 10 MiB per upload
export const ASSEMBLYAI_MAX_DURATION_SECONDS = 600; // 10 minutes per recording
export const ASSEMBLYAI_REQUEST_TIMEOUT_MS = 30_000;
export const ASSEMBLYAI_POLL_TIMEOUT_MS = 120_000;
export const ASSEMBLYAI_POLL_INTERVAL_MS = 2_000;

export const ASSEMBLYAI_API_BASE = "https://api.assemblyai.com";

/** Audio MIME types the adapter accepts. Everything else is rejected locally. */
export const ASSEMBLYAI_ALLOWED_CONTENT_TYPES: readonly string[] = [
  "audio/wav",
  "audio/x-wav",
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/x-m4a",
  "audio/webm",
  "audio/ogg",
  "audio/flac",
];

export interface AssemblyAIConfig {
  /** True only when an API key is supplied and the profile is not disabled. */
  enabled: boolean;
  /** Present only when enabled. Never logged or returned to clients. */
  apiKey?: string;
  /** Exact missing evidence when disabled (credential-gate wording). */
  missingEvidence?: string;
  maxAudioBytes: number;
  maxDurationSeconds: number;
}

/**
 * Resolve the voice profile configuration from the process environment.
 * Reads only Gather-owned `GATHER_*` variables; never the developer's
 * personal OpenClaw state or live customer data.
 */
export function resolveAssemblyAIConfig(
  env: NodeJS.ProcessEnv = process.env,
): AssemblyAIConfig {
  const base = {
    maxAudioBytes: ASSEMBLYAI_MAX_AUDIO_BYTES,
    maxDurationSeconds: ASSEMBLYAI_MAX_DURATION_SECONDS,
  };
  if (env.GATHER_ASSEMBLYAI_DISABLED === "1") {
    return {
      ...base,
      enabled: false,
      missingEvidence:
        "AssemblyAI voice profile is disabled (GATHER_ASSEMBLYAI_DISABLED=1); the adapter performs zero network activity",
    };
  }
  const apiKey = env.GATHER_ASSEMBLYAI_API_KEY?.trim();
  if (!apiKey) {
    return {
      ...base,
      enabled: false,
      missingEvidence:
        "GATHER_ASSEMBLYAI_API_KEY is not set: AssemblyAI credentials were not supplied outside Git, so live transcription is BLOCKED",
    };
  }
  return { ...base, enabled: true, apiKey };
}
