import type { ReactNode } from "react";
import {
  VOICE_PRIVACY_NOTICE,
  VOICE_SOURCE_LABEL,
  type VoiceClarification,
} from "../../../integrations/assemblyai/index.ts";

const panel: React.CSSProperties = {
  border: "1px solid #d8d2c7",
  borderRadius: 12,
  padding: 16,
  marginBottom: 16,
  maxWidth: "100%",
  background: "#fffdf8",
};

const heading: React.CSSProperties = { margin: "0 0 8px", fontSize: 18 };
const muted: React.CSSProperties = { color: "#5b564a", fontSize: 14 };
const sourceBadge: React.CSSProperties = {
  display: "inline-block",
  fontSize: 13,
  fontWeight: 600,
  background: "#efe8d8",
  border: "1px solid #d8d2c7",
  borderRadius: 999,
  padding: "2px 10px",
  marginBottom: 8,
};

export interface VoiceTranscriptView {
  text: string;
  confidence?: number | null;
  simulated: boolean;
  provenance: string;
}

export interface VoiceIntakePanelProps {
  /** Current transcription, if one has been produced. */
  transcript?: VoiceTranscriptView;
  /** Clarification gate from the shared intake evaluation. */
  clarification?: VoiceClarification;
  /** True when the profile is disabled (no credentials): upload off. */
  disabled?: boolean;
  disabledReason?: string;
  uploading?: boolean;
  /** Owner picks a bounded audio file; the host uploads it explicitly. */
  onSelectFile?: (file: File) => void;
  maxAudioBytes: number;
}

/**
 * ADR-013 voice intake panel (exported for ADR-016 composition).
 *
 * Bounded operator upload of a caller recording plus the transcription with
 * provenance/confidence and any clarification questions. The source/privacy
 * label is always visible: transcribed speech that must be verified, whose
 * instructions never grant authority. All controls are native and keyboard
 * operable; layout is fluid for 390px mobile and 1440px desktop.
 */
export function VoiceIntakePanel(props: VoiceIntakePanelProps): ReactNode {
  const { transcript, clarification, disabled, disabledReason, uploading, onSelectFile, maxAudioBytes } = props;
  const maxMb = (maxAudioBytes / (1024 * 1024)).toFixed(0);
  return (
    <section aria-label="Voice intake" style={panel}>
      <h2 style={heading}>Voice intake</h2>
      <span style={sourceBadge}>Source: {VOICE_SOURCE_LABEL}</span>
      <p style={muted}>{VOICE_PRIVACY_NOTICE}</p>
      {disabled === true ? (
        <p role="status">
          Voice transcription is disabled. {disabledReason ?? "Supply AssemblyAI credentials outside Git to enable it."}{" "}
          No audio leaves this machine while disabled.
        </p>
      ) : (
        <div>
          <label htmlFor="voice-audio-file" style={{ display: "block", marginBottom: 4 }}>
            Upload a caller recording (max {maxMb} MB, 10 minutes)
          </label>
          <input
            id="voice-audio-file"
            type="file"
            accept="audio/wav,audio/mpeg,audio/mp4,audio/x-m4a,audio/webm,audio/ogg,audio/flac"
            disabled={uploading === true}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file && onSelectFile) onSelectFile(file);
            }}
            aria-describedby="voice-audio-help"
          />
          <p id="voice-audio-help" style={muted}>
            The selected file is uploaded once, explicitly, for transcription. Nothing is recorded or sent automatically.
          </p>
        </div>
      )}
      {transcript !== undefined ? (
        <div style={{ marginTop: 12 }}>
          <h3 style={{ ...heading, fontSize: 16 }}>Transcription</h3>
          <p style={muted}>
            {transcript.simulated ? "Scripted fixture transcript (NOT a live transcription)" : "Live AssemblyAI transcript"} ·{" "}
            {transcript.provenance}
            {transcript.confidence !== undefined && transcript.confidence !== null
              ? ` · confidence ${transcript.confidence.toFixed(2)}`
              : " · confidence not reported"}
          </p>
          <blockquote style={{ margin: "8px 0", padding: "8px 12px", borderLeft: "3px solid #d8d2c7" }}>
            {transcript.text}
          </blockquote>
        </div>
      ) : null}
      {clarification !== undefined && clarification.required ? (
        <div role="alert" style={{ marginTop: 12 }}>
          <h3 style={{ ...heading, fontSize: 16 }}>Clarification needed before any booking action</h3>
          <ul>
            {clarification.questions.map((question) => (
              <li key={question}>{question}</li>
            ))}
          </ul>
          {clarification.reasons.map((reason) => (
            <p key={reason} style={muted}>
              {reason}
            </p>
          ))}
        </div>
      ) : null}
      {clarification !== undefined && !clarification.required ? (
        <p role="status" style={{ ...muted, marginTop: 12 }}>
          Transcript is confident and fully qualified; it may proceed through the normal inquiry flow. Owner approval is
          still required before any hold, offer, or send.
        </p>
      ) : null}
    </section>
  );
}
