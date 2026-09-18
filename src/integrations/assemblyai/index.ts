export {
  ASSEMBLYAI_ALLOWED_CONTENT_TYPES,
  ASSEMBLYAI_API_BASE,
  ASSEMBLYAI_MAX_AUDIO_BYTES,
  ASSEMBLYAI_MAX_DURATION_SECONDS,
  ASSEMBLYAI_POLL_INTERVAL_MS,
  ASSEMBLYAI_POLL_TIMEOUT_MS,
  ASSEMBLYAI_REQUEST_TIMEOUT_MS,
  resolveAssemblyAIConfig,
  type AssemblyAIConfig,
} from "./config.ts";
export {
  AssemblyAIClient,
  type AssemblyAIClientOptions,
  type AssemblyAITranscriptResponse,
  type FetchLike,
} from "./client.ts";
export {
  assemblyAIDisabledError,
  assemblyAIStatusError,
  assemblyAITransportError,
} from "./errors.ts";
export {
  transcribeLiveAudio,
  transcribeScriptedAudio,
  transcribeWithDedupe,
  validateVoiceAudio,
  voiceSourceIdentity,
  type ScriptedTranscription,
  type TranscribeOptions,
  type TranscriptionProvenance,
  type TranscriptionResult,
  type VoiceAudioInput,
} from "./transcribe.ts";
export {
  buildVoiceIntakeEnvelope,
  evaluateVoiceIntake,
  VOICE_LOW_CONFIDENCE_THRESHOLD,
  VOICE_PRIVACY_NOTICE,
  VOICE_SOURCE_LABEL,
  type VoiceClarification,
  type VoiceIntakeContext,
  type VoiceIntakeEnvelope,
  type VoiceIntakeEvaluation,
} from "./intake.ts";
export {
  ASSEMBLYAI_PROFILE,
  ASSEMBLYAI_PROFILE_ID,
  evaluateVoiceCapabilityGate,
  type AssemblyAICapabilityGate,
} from "./profile.ts";
