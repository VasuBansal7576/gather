/**
 * ADR-013 transcription orchestration (C02/C12).
 *
 * Bounded audio validation, content-hash source identity for retry dedupe,
 * and transcription provenance/confidence. Two paths, both labelled:
 *
 * - live: actual AssemblyAI upload -> transcript -> poll (simulated: false).
 * - scripted: deterministic fixture text for tests/prepared (simulated: true).
 *
 * Scripted output is never presented as a live-provider receipt: the
 * provenance label travels with every result into intake, UI, and receipts.
 */

import { createHash } from "node:crypto";
import {
  ASSEMBLYAI_ALLOWED_CONTENT_TYPES,
  type AssemblyAIConfig,
} from "./config.ts";
import { AssemblyAIClient } from "./client.ts";
import { ServiceError } from "../../server/booking-service.ts";

export interface VoiceAudioInput {
  /** Raw audio bytes supplied explicitly by the operator/caller. */
  audio: Uint8Array;
  contentType: string;
  /** Caller-declared duration; rejected when beyond the bound. */
  durationSeconds?: number;
  /** Operator-supplied recording label (e.g. "caller-2026-09-18"). Never a secret. */
  recordingLabel?: string;
}

export interface TranscriptionProvenance {
  provider: "assemblyai";
  /** False for real provider jobs; true for deterministic scripted text. */
  simulated: boolean;
  /** Stable operator-visible label carried into intake and receipts. */
  label: string;
  transcriptId?: string;
  audioDurationSeconds?: number;
}

export interface TranscriptionResult {
  /** Stable source identity: `voice:<sha256(audio)>` — retry dedupe key. */
  sourceId: string;
  contentHash: string;
  text: string;
  /** Mean provider confidence in [0,1]; undefined when the provider omits it. */
  confidence?: number;
  provenance: TranscriptionProvenance;
  receivedAt: string;
}

/** Validate bounds locally before any byte leaves the machine. */
export function validateVoiceAudio(input: VoiceAudioInput, config: AssemblyAIConfig): void {
  if (!(input.audio instanceof Uint8Array) || input.audio.byteLength === 0) {
    throw new ServiceError("INVALID_REQUEST", "Voice intake needs non-empty audio bytes", false);
  }
  if (input.audio.byteLength > config.maxAudioBytes) {
    throw new ServiceError(
      "INVALID_REQUEST",
      `Audio is ${input.audio.byteLength} bytes; the voice intake limit is ${config.maxAudioBytes} bytes`,
      false,
    );
  }
  const mime = input.contentType.trim().toLowerCase().split(";")[0] ?? "";
  if (!ASSEMBLYAI_ALLOWED_CONTENT_TYPES.includes(mime)) {
    throw new ServiceError(
      "INVALID_REQUEST",
      `Unsupported audio type "${input.contentType}"; supply one of: ${ASSEMBLYAI_ALLOWED_CONTENT_TYPES.join(", ")}`,
      false,
    );
  }
  if (
    input.durationSeconds !== undefined &&
    (!Number.isFinite(input.durationSeconds) ||
      input.durationSeconds <= 0 ||
      input.durationSeconds > config.maxDurationSeconds)
  ) {
    throw new ServiceError(
      "INVALID_REQUEST",
      `Declared audio duration must be within (0, ${config.maxDurationSeconds}] seconds`,
      false,
    );
  }
}

/** Stable source identity for retry dedupe: identical bytes share one key. */
export function voiceSourceIdentity(audio: Uint8Array): { sourceId: string; contentHash: string } {
  const hash = createHash("sha256")
    .update(Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength))
    .digest("hex");
  return { sourceId: `voice:${hash}`, contentHash: hash };
}

export interface TranscribeOptions {
  config: AssemblyAIConfig;
  client?: AssemblyAIClient;
  now?: () => string;
  signal?: AbortSignal;
}

/**
 * Live transcription: validate bounds -> upload -> create -> poll.
 * Throws the disabled gate (zero network) when the profile is not enabled.
 */
export async function transcribeLiveAudio(
  input: VoiceAudioInput,
  options: TranscribeOptions,
): Promise<TranscriptionResult> {
  validateVoiceAudio(input, options.config);
  const client = options.client ?? new AssemblyAIClient({ config: options.config });
  const { sourceId, contentHash } = voiceSourceIdentity(input.audio);
  const now = options.now?.() ?? new Date().toISOString();
  const uploadUrl = await client.uploadAudio(input.audio, input.contentType, options.signal);
  const transcriptId = await client.createTranscript(uploadUrl, options.signal);
  const job = await client.waitForTranscript(transcriptId, options.signal);
  const text = (job.text ?? "").trim();
  if (text.length === 0) {
    throw new ServiceError("UNCERTAIN", "AssemblyAI returned an empty transcript; nothing to feed intake", true);
  }
  const confidence =
    typeof job.confidence === "number" && Number.isFinite(job.confidence)
      ? Math.min(1, Math.max(0, job.confidence))
      : undefined;
  return {
    sourceId,
    contentHash,
    text,
    ...(confidence === undefined ? {} : { confidence }),
    provenance: {
      provider: "assemblyai",
      simulated: false,
      label: "live-provider:assemblyai",
      transcriptId,
      ...(typeof job.audio_duration === "number" ? { audioDurationSeconds: job.audio_duration } : {}),
    },
    receivedAt: now,
  };
}

export interface ScriptedTranscription {
  text: string;
  confidence?: number;
}

/**
 * Scripted transcription for tests/prepared flows: deterministic,
 * explicitly labelled simulated. Used when no credentials exist; never a
 * substitute for the 013-A01 live proof.
 */
export function transcribeScriptedAudio(
  input: VoiceAudioInput,
  scripted: ScriptedTranscription,
  config: AssemblyAIConfig,
  now: () => string = () => new Date().toISOString(),
): TranscriptionResult {
  validateVoiceAudio(input, config);
  const { sourceId, contentHash } = voiceSourceIdentity(input.audio);
  const text = scripted.text.trim();
  if (text.length === 0) {
    throw new ServiceError("INVALID_REQUEST", "Scripted transcript fixture carries no text", false);
  }
  return {
    sourceId,
    contentHash,
    text,
    ...(scripted.confidence === undefined ? {} : { confidence: scripted.confidence }),
    provenance: {
      provider: "assemblyai",
      simulated: true,
      label: "scripted:assemblyai-fixture (NOT a live transcription)",
    },
    receivedAt: now(),
  };
}

/**
 * Retry dedupe by source identity: the same audio bytes reuse the settled
 * receipt instead of dispatching a second provider job. The cache is
 * caller-owned (route- or test-scoped); no global mutable state.
 */
export async function transcribeWithDedupe(
  input: VoiceAudioInput,
  cache: Map<string, TranscriptionResult>,
  transcribe: () => Promise<TranscriptionResult>,
): Promise<{ result: TranscriptionResult; duplicate: boolean }> {
  const { sourceId } = voiceSourceIdentity(input.audio);
  const cached = cache.get(sourceId);
  if (cached) return { result: cached, duplicate: true };
  const result = await transcribe();
  cache.set(result.sourceId, result);
  return { result, duplicate: false };
}
