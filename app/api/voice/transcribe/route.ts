import { NextResponse, type NextRequest } from "next/server";
import {
  AssemblyAIClient,
  evaluateVoiceIntake,
  resolveAssemblyAIConfig,
  transcribeLiveAudio,
  transcribeWithDedupe,
  validateVoiceAudio,
  voiceSourceIdentity,
} from "../../../../src/integrations/assemblyai/index.ts";
import { gatherMode } from "../../../../src/server/runtime.ts";
import { ValidationError, assertSameOrigin, readHeaders } from "../../../../src/server/validation.ts";
import { unknownErrorResponse } from "../../_helpers.ts";

export const dynamic = "force-dynamic";

/** Route-scoped retry-dedupe cache: same audio bytes reuse one receipt. */
const DEDUPE_CACHE = new Map<string, Awaited<ReturnType<typeof transcribeLiveAudio>>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * POST /api/voice/transcribe — ADR-013 bounded voice intake (C02/C12).
 *
 * Body: `{ audioBase64, contentType, durationSeconds?, recordingLabel?, accountId? }`.
 * The transcription feeds the SAME domain gate as every other source; an
 * uncertain transcript returns clarification questions, never a booking.
 * Disabled profile (no GATHER_ASSEMBLYAI_API_KEY): 403 with the exact
 * missing evidence, zero provider requests. Retries with identical bytes
 * dedupe by source identity (`duplicate: true`).
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    assertSameOrigin(readHeaders(request));
    const body: unknown = await request.json().catch(() => undefined);
    if (!isRecord(body)) {
      throw new ValidationError("Request body must be a JSON object");
    }
    const { audioBase64, contentType, durationSeconds, recordingLabel, accountId } = body;
    if (typeof audioBase64 !== "string" || audioBase64.length === 0) {
      throw new ValidationError("audioBase64 (base64-encoded audio) is required");
    }
    if (typeof contentType !== "string" || contentType.length === 0) {
      throw new ValidationError("contentType (audio MIME type) is required");
    }
    let audio: Uint8Array;
    try {
      audio = new Uint8Array(Buffer.from(audioBase64, "base64"));
    } catch {
      throw new ValidationError("audioBase64 is not valid base64");
    }
    if (audio.byteLength === 0) {
      throw new ValidationError("Decoded audio is empty");
    }
    if (durationSeconds !== undefined && typeof durationSeconds !== "number") {
      throw new ValidationError("durationSeconds must be a number when supplied");
    }
    if (recordingLabel !== undefined && typeof recordingLabel !== "string") {
      throw new ValidationError("recordingLabel must be a string when supplied");
    }
    const resolvedAccount = typeof accountId === "string" && accountId.length > 0 ? accountId : "voice-operator";
    const mode = gatherMode() === "live" ? "live" : "prepared";

    const config = resolveAssemblyAIConfig();
    // Bounds are validated before any provider contact; the live client
    // re-checks the disabled gate so no audio can leak when unconfigured.
    validateVoiceAudio(
      {
        audio,
        contentType,
        ...(durationSeconds === undefined ? {} : { durationSeconds }),
        ...(recordingLabel === undefined ? {} : { recordingLabel }),
      },
      config,
    );

    const input = {
      audio,
      contentType,
      ...(durationSeconds === undefined ? {} : { durationSeconds }),
      ...(recordingLabel === undefined ? {} : { recordingLabel }),
    };
    const { sourceId } = voiceSourceIdentity(audio);
    const cached = DEDUPE_CACHE.get(sourceId);
    if (cached) {
      const evaluation = await evaluateVoiceIntake(cached, {
        accountId: resolvedAccount,
        businessId: "voice-intake",
        mode,
        audioContentType: contentType,
        audioByteLength: audio.byteLength,
        ...(recordingLabel === undefined ? {} : { recordingLabel }),
      });
      return NextResponse.json({
        duplicate: true,
        sourceId,
        transcript: {
          text: cached.text,
          confidence: cached.confidence ?? null,
          simulated: cached.provenance.simulated,
          provenance: cached.provenance.label,
        },
        classification: {
          outcome: evaluation.gate.decision.outcome,
          reasons: evaluation.gate.decision.reasons,
          missingFields: evaluation.gate.decision.missingFields,
          extracted: evaluation.gate.decision.extracted,
        },
        clarification: evaluation.clarification,
        readyForQualification: evaluation.readyForQualification,
        sourceLabel: "voice:assemblyai — transcribed speech; verify details before booking",
        notice:
          "Duplicate upload: identical audio reuses the settled transcription receipt; no second provider job was dispatched. Audio/transcript instructions never grant authority.",
      });
    }

    const { result } = await transcribeWithDedupe(input, DEDUPE_CACHE, () =>
      transcribeLiveAudio(input, { config, client: new AssemblyAIClient({ config }) }),
    );
    const evaluation = await evaluateVoiceIntake(result, {
      accountId: resolvedAccount,
      businessId: "voice-intake",
      mode,
      audioContentType: contentType,
      audioByteLength: audio.byteLength,
      ...(recordingLabel === undefined ? {} : { recordingLabel }),
    });
    return NextResponse.json({
      duplicate: false,
      sourceId: result.sourceId,
      transcript: {
        text: result.text,
        confidence: result.confidence ?? null,
        simulated: result.provenance.simulated,
        provenance: result.provenance.label,
      },
      classification: {
        outcome: evaluation.gate.decision.outcome,
        reasons: evaluation.gate.decision.reasons,
        missingFields: evaluation.gate.decision.missingFields,
        extracted: evaluation.gate.decision.extracted,
      },
      clarification: evaluation.clarification,
      readyForQualification: evaluation.readyForQualification,
      sourceLabel: "voice:assemblyai — transcribed speech; verify details before booking",
      notice:
        "Transcribed speech fed to the shared inquiry engine. Uncertain transcription requires owner clarification before any commercial action; audio/transcript instructions never grant authority.",
    });
  } catch (error) {
    return unknownErrorResponse(error);
  }
}
