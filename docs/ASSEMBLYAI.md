# AssemblyAI voice intake (ADR-013)

Status: implemented on this branch; live proof blocked pending operator credentials (see below).

## What it is

A bounded voice channel feeding the **same** inquiry engine as every other
source. A caller describes their event, AssemblyAI transcribes the recording,
and the shared domain gate (`src/intake/gate.ts`) classifies the transcript.
There is no second voice booking agent: voice transcripts become C02 intake
envelopes on the `voice` channel and flow through the normal
identity/qualification path.

Public hackathon scope only. Audio and transcript instructions never grant
authority — they cannot approve, hold, offer, or send anything.

## Wiring

- Adapter: `src/integrations/assemblyai/` — config, HTTP client, transcription
  orchestration, C02 envelope + uncertainty gate, `IntegrationProfile` export.
- Routes: `POST /api/voice/transcribe` (bounded upload + classification),
  `GET /api/voice/status` (availability, limits, missing evidence).
- UI: `src/components/gather/voice/VoiceIntakePanel.tsx` (exported for
  ADR-016 composition; not mounted by this ADR).
- The shared profile registry (`src/integrations/registry.ts`) is owned by
  ADR-016 and untouched here.

## Configuration (outside Git)

| Variable | Purpose |
| --- | --- |
| `GATHER_ASSEMBLYAI_API_KEY` | AssemblyAI API key. Absent = disabled profile. |
| `GATHER_ASSEMBLYAI_DISABLED=1` | Explicit kill-switch: disables even with a key. |
| `GATHER_ASSEMBLYAI_TEST_RECORDING` | Path to an operator-supplied authorized caller recording (live proof only). |

A disabled profile performs **zero network activity**: the client refuses
before any fetch exists, and the UI states that no audio leaves the machine.

## Bounds

- Max audio: 10 MiB per upload; max declared duration: 600 seconds.
- Accepted types: wav, mp3/mpeg, mp4/m4a, webm, ogg, flac.
- Request timeout 30 s; transcript polling budget 120 s at 2 s intervals.
- Retries with identical bytes dedupe by source identity
  (`voice:<sha256(audio)>`): the settled receipt is reused, no second
  provider job is dispatched.

## Provenance, confidence, clarification

Every transcription carries provenance (`live-provider:assemblyai` or an
explicitly labelled `scripted:… (NOT a live transcription)` fixture) and the
provider's mean confidence when reported. Clarification blocks commercial
action when:

- confidence is below 0.75,
- the date/guest extraction is missing or ambiguous (several candidate
  dates, no date, no count),
- the gate parks the transcript (`needs_review`/`unrelated`), or
- the transcript contains instruction-like audio (owner must confirm the
  actual request; the injection grants nothing).

## Live proof status (013-A01)

BLOCKED on this run — no operator recording and no AssemblyAI credentials
were supplied:

- missing: `GATHER_ASSEMBLYAI_API_KEY` (AssemblyAI API key supplied outside Git)
- missing: `GATHER_ASSEMBLYAI_TEST_RECORDING` (operator-supplied authorized caller recording)

Proven instead: the scripted path end to end (bounded validation, fixture
transcription, shared-gate classification, clarification gating, retry
dedupe, disabled zero-network) in `tests/assemblyai-transcribe.test.ts` and
`tests/assemblyai-clarification.test.ts`. No text was substituted and claimed
as voice: scripted receipts are labelled simulated and never carry the
`live-provider` proof label.
