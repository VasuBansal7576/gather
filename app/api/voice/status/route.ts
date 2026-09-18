import { NextResponse, type NextRequest } from "next/server";
import {
  evaluateVoiceCapabilityGate,
  resolveAssemblyAIConfig,
  ASSEMBLYAI_MAX_AUDIO_BYTES,
  ASSEMBLYAI_MAX_DURATION_SECONDS,
} from "../../../../src/integrations/assemblyai/index.ts";
import { ASSEMBLYAI_PROFILE } from "../../../../src/integrations/assemblyai/index.ts";
import { assertSameOrigin, readHeaders } from "../../../../src/server/validation.ts";
import { unknownErrorResponse } from "../../_helpers.ts";

export const dynamic = "force-dynamic";

/**
 * GET /api/voice/status — ADR-013 voice profile availability (C12).
 *
 * Read-only: profile id, intake adapter, upload bounds, and the exact
 * missing evidence blocking live transcription. Never returns secrets or
 * audio. A disabled profile reports blocked with zero network activity.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    assertSameOrigin(readHeaders(request));
    const config = resolveAssemblyAIConfig();
    const gate = evaluateVoiceCapabilityGate(process.env, false);
    return NextResponse.json({
      profile: ASSEMBLYAI_PROFILE.id,
      label: ASSEMBLYAI_PROFILE.label,
      intakeAdapter: ASSEMBLYAI_PROFILE.intakeAdapter,
      proofLabel: ASSEMBLYAI_PROFILE.proofLabel,
      implementationStatus: ASSEMBLYAI_PROFILE.implementationStatus,
      enabled: config.enabled,
      voiceGate: gate.status,
      ...(gate.missingEvidence === undefined ? {} : { missingEvidence: gate.missingEvidence }),
      limits: {
        maxAudioBytes: ASSEMBLYAI_MAX_AUDIO_BYTES,
        maxDurationSeconds: ASSEMBLYAI_MAX_DURATION_SECONDS,
      },
      sourceLabel: "voice:assemblyai — transcribed speech; verify details before booking",
      notice:
        "PUBLIC hackathon build: operator-supplied recordings only. Audio/transcript instructions never grant authority.",
    });
  } catch (error) {
    return unknownErrorResponse(error);
  }
}
