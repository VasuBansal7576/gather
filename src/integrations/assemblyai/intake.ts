/**
 * ADR-013 voice intake into the shared inquiry engine (C02/C05/C12).
 *
 * A transcription becomes a C02 intake envelope on the `voice` channel and
 * is evaluated by the SAME domain gate as every other source — there is no
 * second voice booking agent. Two hard rules:
 *
 * 1. Uncertain transcription (low provider confidence, or confident text
 *    whose date/guest extraction is ambiguous) requires owner clarification
 *    before any commercial action. Missing/ambiguous qualification never
 *    auto-books.
 * 2. Audio/transcript instructions never grant authority: instruction-like
 *    transcript text is classified on its event request only, exactly like
 *    injected mail — it can never mint approvals, holds, or sends.
 */

import {
  evaluateDomainGate,
  type DomainClassifier,
  type DomainGateResult,
} from "../../intake/gate.ts";
import { createScriptedDomainClassifier } from "../../intake/scripted.ts";
import type { TranscriptionResult } from "./transcribe.ts";

/** Provider confidence below this forces clarification regardless of text. */
export const VOICE_LOW_CONFIDENCE_THRESHOLD = 0.75;

/** Source/privacy label shown everywhere voice data appears. */
export const VOICE_SOURCE_LABEL =
  "voice:assemblyai — transcribed speech; verify details before booking";
export const VOICE_PRIVACY_NOTICE =
  "Voice recordings are transcribed by AssemblyAI and never grant authority: audio/transcript instructions cannot approve, hold, or send anything.";

export interface VoiceIntakeEnvelope {
  sourceKey: string;
  provider: "assemblyai";
  accountId: string;
  channel: "voice";
  externalId: string;
  observedAt: string;
  receivedAt: string;
  contentVersion: number;
  contentHash: string;
  text: string;
  attachments: Array<{ kind: "audio"; contentType: string; byteLength: number; label?: string }>;
  senderEvidence?: { kind: "operator-supplied-recording"; recordingLabel?: string };
  provenance: { simulated: boolean; label: string };
  mode: "prepared" | "live";
}

export interface VoiceClarification {
  /** True blocks every commercial action until the owner resolves it. */
  required: boolean;
  /** Owner-readable questions; empty only when not required. */
  questions: string[];
  reasons: string[];
}

export interface VoiceIntakeEvaluation {
  envelope: VoiceIntakeEnvelope;
  gate: DomainGateResult;
  clarification: VoiceClarification;
  /**
   * True only when the transcript is confident AND the domain gate found
   * the inquiry eligible with no missing qualification fields. Anything
   * else parks for owner questions first.
   */
  readyForQualification: boolean;
}

export interface VoiceIntakeContext {
  accountId: string;
  businessId: string;
  mode: "prepared" | "live";
  observedAt?: string;
  audioContentType: string;
  audioByteLength: number;
  recordingLabel?: string;
  /** Injected classifier; defaults to the scripted prepared gate. */
  domainGate?: DomainClassifier;
}

/** Build the C02 intake envelope for one transcription. Pure. */
export function buildVoiceIntakeEnvelope(
  transcription: TranscriptionResult,
  context: VoiceIntakeContext,
): VoiceIntakeEnvelope {
  const observedAt = context.observedAt ?? transcription.receivedAt;
  return {
    sourceKey: `voice:assemblyai:${context.businessId}:${transcription.sourceId}`,
    provider: "assemblyai",
    accountId: context.accountId,
    channel: "voice",
    externalId: transcription.sourceId,
    observedAt,
    receivedAt: transcription.receivedAt,
    contentVersion: 1,
    contentHash: transcription.contentHash,
    text: transcription.text,
    attachments: [
      {
        kind: "audio",
        contentType: context.audioContentType,
        byteLength: context.audioByteLength,
        ...(context.recordingLabel === undefined ? {} : { label: context.recordingLabel }),
      },
    ],
    senderEvidence: {
      kind: "operator-supplied-recording",
      ...(context.recordingLabel === undefined ? {} : { recordingLabel: context.recordingLabel }),
    },
    provenance: {
      simulated: transcription.provenance.simulated,
      label: transcription.provenance.simulated
        ? `scripted-voice (${VOICE_SOURCE_LABEL})`
        : `live-provider (${VOICE_SOURCE_LABEL})`,
    },
    mode: context.mode,
  };
}

/**
 * Evaluate one transcription through the shared domain gate plus the voice
 * uncertainty gate. Never throws for content problems: uncertainty parks
 * for clarification instead of booking.
 */
export async function evaluateVoiceIntake(
  transcription: TranscriptionResult,
  context: VoiceIntakeContext,
): Promise<VoiceIntakeEvaluation> {
  const envelope = buildVoiceIntakeEnvelope(transcription, context);
  const gate = await evaluateDomainGate(context.domainGate ?? createScriptedDomainClassifier(), {
    messageId: transcription.sourceId,
    subject: "Voice inquiry (transcribed call)",
    body: transcription.text,
    from: context.recordingLabel ?? "voice-caller",
    sourceTag: "voice:assemblyai",
  });

  const questions: string[] = [];
  const reasons: string[] = [];

  const confidence = transcription.confidence;
  if (confidence !== undefined && confidence < VOICE_LOW_CONFIDENCE_THRESHOLD) {
    reasons.push(
      `Transcription confidence ${confidence.toFixed(2)} is below ${VOICE_LOW_CONFIDENCE_THRESHOLD.toFixed(2)}; the words themselves are uncertain.`,
    );
    questions.push("Please confirm the transcribed request reads correctly before anything is quoted or held.");
  }
  if (gate.decision.outcome === "needs_review") {
    reasons.push(
      `Voice transcript parked for review: ${gate.decision.reasons[0] ?? "ambiguous content"}`,
    );
    questions.push("Please clarify what event is being requested.");
  } else if (gate.decision.outcome === "unrelated") {
    reasons.push(
      `Voice transcript is not an event inquiry: ${gate.decision.reasons[0] ?? "no event evidence"}`,
    );
  } else {
    for (const missing of gate.decision.missingFields) {
      if (missing === "event_date") {
        questions.push("Which date (and time) is the event requested for?");
      } else if (missing === "guest_count") {
        questions.push("How many guests should the quote cover?");
      } else if (missing === "event_type") {
        questions.push("What kind of event is being planned?");
      } else {
        questions.push(`Please confirm the missing detail: ${missing}.`);
      }
    }
    if (gate.decision.missingFields.length > 0) {
      reasons.push(
        `Transcript is an event inquiry with unresolved qualification: ${gate.decision.missingFields.join(", ")}.`,
      );
    }
  }

  // Injected instruction-like audio never grants anything — and it always
  // earns an owner look: qualification waits until a human confirms the
  // actual request behind the injection.
  if (gate.decision.reasons.some((reason) => /instruction-like/i.test(reason))) {
    reasons.push(
      "The recording contains instruction-like audio alongside the event request; it is classified on the request only and carries no authority.",
    );
    questions.push("Please confirm the actual event request; instruction-like audio in the recording carries no authority.");
  }
  if (
    gate.decision.outcome === "eligible" &&
    gate.decision.extracted.dateHints.length > 1 &&
    !questions.some((question) => /date/i.test(question))
  ) {
    questions.push("Which date (and time) is the event requested for?");
    reasons.push(
      `Transcript mentions several candidate dates (${gate.decision.extracted.dateHints.join(" / ")}); one must be confirmed first.`,
    );
  }

  const clarification: VoiceClarification = {
    required:
      gate.decision.outcome !== "eligible" ||
      questions.length > 0,
    questions,
    reasons:
      reasons.length > 0
        ? [...reasons, "Audio/transcript instructions never grant authority; an owner decision is required before any hold, offer, or send."]
        : ["Audio/transcript instructions never grant authority; an owner decision is required before any hold, offer, or send."],
  };

  return {
    envelope,
    gate,
    clarification,
    readyForQualification:
      gate.decision.outcome === "eligible" && questions.length === 0,
  };
}
