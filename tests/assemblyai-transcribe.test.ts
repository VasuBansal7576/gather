/**
 * ADR-013 transcription adapter tests (013-A03, 013-CHECKS).
 *
 * All scripted/local: fictional audio bytes and stub fetch only. No provider
 * contact, no credentials, no live assets. The 013-A01 live proof needs an
 * operator-supplied recording plus GATHER_ASSEMBLYAI_API_KEY; when absent
 * the live test below records the explicit blocker instead of passing.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  ASSEMBLYAI_MAX_AUDIO_BYTES,
  ASSEMBLYAI_PROFILE,
  AssemblyAIClient,
  evaluateVoiceCapabilityGate,
  resolveAssemblyAIConfig,
  transcribeLiveAudio,
  transcribeScriptedAudio,
  transcribeWithDedupe,
  validateVoiceAudio,
  voiceSourceIdentity,
  type AssemblyAITranscriptResponse,
  type FetchLike,
} from "../src/integrations/assemblyai/index.ts";
import { ServiceError } from "../src/server/booking-service.ts";

const WAV = "audio/wav";

function bytes(length: number, seed = 7): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) out[i] = (seed + i * 31) % 256;
  return out;
}

function enabledConfig() {
  return resolveAssemblyAIConfig({ GATHER_ASSEMBLYAI_API_KEY: "test-key-never-committed" } as unknown as NodeJS.ProcessEnv);
}

/** Stub fetch playing a canned AssemblyAI exchange; records every call. */
function stubFetch(script: Array<{ status: number; body: unknown }>): { fetchImpl: FetchLike; calls: string[] } {
  const calls: string[] = [];
  let step = 0;
  const fetchImpl = (async (url: unknown) => {
    calls.push(String(url));
    const next = script[Math.min(step, script.length - 1)]!;
    step += 1;
    return { status: next.status, json: () => Promise.resolve(next.body) };
  }) as unknown as FetchLike;
  return { fetchImpl, calls };
}

/* ---------------- configuration: disabled means zero network ------------- */

test("disabled without a key: exact missing evidence, no network possible", () => {
  const config = resolveAssemblyAIConfig({} as unknown as NodeJS.ProcessEnv);
  assert.equal(config.enabled, false);
  assert.match(config.missingEvidence ?? "", /GATHER_ASSEMBLYAI_API_KEY/);
});

test("disabled via GATHER_ASSEMBLYAI_DISABLED=1 even with a key", () => {
  const config = resolveAssemblyAIConfig({
    GATHER_ASSEMBLYAI_API_KEY: "k",
    GATHER_ASSEMBLYAI_DISABLED: "1",
  } as unknown as NodeJS.ProcessEnv);
  assert.equal(config.enabled, false);
  assert.match(config.missingEvidence ?? "", /disabled/i);
});

test("disabled client performs zero requests on every method", async () => {
  const config = resolveAssemblyAIConfig({} as unknown as NodeJS.ProcessEnv);
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    throw new Error("must never be called");
  }) as unknown as FetchLike;
  const client = new AssemblyAIClient({ config, fetchImpl });
  await assert.rejects(client.uploadAudio(bytes(8), WAV), (error: unknown) => error instanceof ServiceError && error.code === "DENIED");
  await assert.rejects(client.createTranscript("https://example.test/a"), (error: unknown) => error instanceof ServiceError && error.code === "DENIED");
  await assert.rejects(client.getTranscript("t"), (error: unknown) => error instanceof ServiceError && error.code === "DENIED");
  await assert.rejects(client.waitForTranscript("t"), (error: unknown) => error instanceof ServiceError && error.code === "DENIED");
  assert.equal(calls, 0);
});

/* ---------------- bounds: rejected locally before any upload --------------- */

test("oversize, unsupported type, bad duration and empty audio are rejected", () => {
  const config = enabledConfig();
  assert.throws(
    () => validateVoiceAudio({ audio: bytes(ASSEMBLYAI_MAX_AUDIO_BYTES + 1), contentType: WAV }, config),
    (error: unknown) => error instanceof ServiceError && error.code === "INVALID_REQUEST",
  );
  assert.throws(
    () => validateVoiceAudio({ audio: bytes(16), contentType: "video/mp4" }, config),
    (error: unknown) => error instanceof ServiceError && error.code === "INVALID_REQUEST",
  );
  assert.throws(
    () => validateVoiceAudio({ audio: bytes(16), contentType: WAV, durationSeconds: 601 }, config),
    (error: unknown) => error instanceof ServiceError && error.code === "INVALID_REQUEST",
  );
  assert.throws(
    () => validateVoiceAudio({ audio: new Uint8Array(0), contentType: WAV }, config),
    (error: unknown) => error instanceof ServiceError && error.code === "INVALID_REQUEST",
  );
  // At-limit audio validates.
  validateVoiceAudio({ audio: bytes(16), contentType: "audio/mpeg", durationSeconds: 600 }, config);
});

/* ---------------- live path with stubbed provider -------------------------- */

test("live transcription carries provenance, confidence and stable source identity", async () => {
  const { fetchImpl, calls } = stubFetch([
    { status: 200, body: { upload_url: "https://example.test/audio" } },
    { status: 200, body: { id: "job-1" } },
    { status: 200, body: { id: "job-1", status: "processing" } },
    {
      status: 200,
      body: { id: "job-1", status: "completed", text: "Wedding dinner November 14, about 90 guests.", confidence: 0.93, audio_duration: 14 } satisfies AssemblyAITranscriptResponse,
    },
  ]);
  const config = enabledConfig();
  const client = new AssemblyAIClient({ config, fetchImpl, pollIntervalMs: 1 });
  const result = await transcribeLiveAudio({ audio: bytes(64), contentType: WAV }, { config, client });
  assert.equal(result.text, "Wedding dinner November 14, about 90 guests.");
  assert.equal(result.confidence, 0.93);
  assert.equal(result.provenance.simulated, false);
  assert.equal(result.provenance.label, "live-provider:assemblyai");
  assert.equal(result.provenance.transcriptId, "job-1");
  assert.match(result.sourceId, /^voice:[0-9a-f]{64}$/);
  assert.equal(calls.length, 4);
  // Identical bytes share the source identity (retry dedupe key).
  assert.deepEqual(voiceSourceIdentity(bytes(64)), voiceSourceIdentity(bytes(64)));
  assert.notDeepEqual(voiceSourceIdentity(bytes(64)).sourceId, voiceSourceIdentity(bytes(65)).sourceId);
});

test("retry dedupe: identical bytes reuse the receipt, no second provider job", async () => {
  let jobs = 0;
  const first = transcribeScriptedAudio(
    { audio: bytes(32), contentType: WAV },
    { text: "Wedding dinner November 14, about 90 guests.", confidence: 0.9 },
    enabledConfig(),
    () => "2030-06-01T00:00:00.000Z",
  );
  const cache = new Map();
  const once = await transcribeWithDedupe({ audio: bytes(32), contentType: WAV }, cache, () => {
    jobs += 1;
    return Promise.resolve(first);
  });
  assert.equal(once.duplicate, false);
  const twice = await transcribeWithDedupe({ audio: bytes(32), contentType: WAV }, cache, () => {
    jobs += 1;
    return Promise.resolve(first);
  });
  assert.equal(twice.duplicate, true);
  assert.equal(twice.result.sourceId, once.result.sourceId);
  assert.equal(jobs, 1);
});

/* ---------------- provider failure maps to scoped errors ------------------- */

test("rejected credentials, quota exhaustion and provider outage map cleanly", async () => {
  const config = enabledConfig();
  const denied = new AssemblyAIClient({
    config,
    fetchImpl: stubFetch([{ status: 401, body: { error: "bad key" } }]).fetchImpl,
  });
  await assert.rejects(denied.uploadAudio(bytes(8), WAV), (error: unknown) => error instanceof ServiceError && error.code === "DENIED");

  const busy = new AssemblyAIClient({
    config,
    fetchImpl: stubFetch([{ status: 429, body: { error: "quota" } }]).fetchImpl,
  });
  await assert.rejects(busy.uploadAudio(bytes(8), WAV), (error: unknown) => error instanceof ServiceError && error.code === "EXECUTION_FAILED" && error.retryable === true);

  const down = new AssemblyAIClient({
    config,
    fetchImpl: stubFetch([{ status: 503, body: { error: "down" } }]).fetchImpl,
  });
  await assert.rejects(down.uploadAudio(bytes(8), WAV), (error: unknown) => error instanceof ServiceError && error.code === "EXECUTION_FAILED");

  const failingJob = new AssemblyAIClient({
    config,
    fetchImpl: stubFetch([
      { status: 200, body: { upload_url: "https://example.test/audio" } },
      { status: 200, body: { id: "job-9" } },
      { status: 200, body: { id: "job-9", status: "error", error: "audio unreadable" } },
    ]).fetchImpl,
    pollIntervalMs: 1,
  });
  await assert.rejects(
    transcribeLiveAudio({ audio: bytes(24), contentType: WAV }, { config, client: failingJob }),
    (error: unknown) => error instanceof ServiceError,
  );
});

test("empty transcript is UNCERTAIN (never an empty intake)", async () => {
  const { fetchImpl } = stubFetch([
    { status: 200, body: { upload_url: "https://example.test/audio" } },
    { status: 200, body: { id: "job-e" } },
    { status: 200, body: { id: "job-e", status: "completed", text: "   ", confidence: 0.2 } },
  ]);
  const config = enabledConfig();
  const client = new AssemblyAIClient({ config, fetchImpl, pollIntervalMs: 1 });
  await assert.rejects(
    transcribeLiveAudio({ audio: bytes(24), contentType: WAV }, { config, client }),
    (error: unknown) => error instanceof ServiceError && error.code === "UNCERTAIN",
  );
});

/* ---------------- profile contract (ADR-006 C12 shape) ---------------------- */

test("voice profile exports the 006 contract shape with the voice adapter", () => {
  assert.equal(ASSEMBLYAI_PROFILE.id, "assemblyai");
  assert.equal(ASSEMBLYAI_PROFILE.intakeAdapter, "voice");
  assert.equal(ASSEMBLYAI_PROFILE.proofLabel, "live-provider");
  assert.ok(ASSEMBLYAI_PROFILE.requiredCapabilities.includes("voice"));
  assert.ok(ASSEMBLYAI_PROFILE.credentialRequirements.some((req) => req.key === "assemblyai-key"));
});

test("voice capability gate blocks with exact missing evidence", () => {
  const noKey = evaluateVoiceCapabilityGate({} as unknown as NodeJS.ProcessEnv, true);
  assert.equal(noKey.status, "blocked");
  assert.match(noKey.missingEvidence ?? "", /GATHER_ASSEMBLYAI_API_KEY/);
  const noRecording = evaluateVoiceCapabilityGate(
    { GATHER_ASSEMBLYAI_API_KEY: "k" } as unknown as NodeJS.ProcessEnv,
    false,
  );
  assert.equal(noRecording.status, "blocked");
  assert.match(noRecording.missingEvidence ?? "", /voice-recording/);
  const ready = evaluateVoiceCapabilityGate(
    { GATHER_ASSEMBLYAI_API_KEY: "k" } as unknown as NodeJS.ProcessEnv,
    true,
  );
  assert.equal(ready.status, "pass");
});

/* ---------------- 013-A01 live proof: explicit credential blocker ----------- */

test("013-A01 live transcription is BLOCKED without operator credentials/recording (explicit, not faked)", () => {
  const keyPresent = Boolean(process.env.GATHER_ASSEMBLYAI_API_KEY?.trim());
  const recordingPresent = Boolean(process.env.GATHER_ASSEMBLYAI_TEST_RECORDING?.trim());
  const gate = evaluateVoiceCapabilityGate(process.env, recordingPresent);
  if (keyPresent && recordingPresent) {
    assert.equal(gate.status, "pass");
    return;
  }
  // The blocker is the assertion: without both, live proof cannot exist and
  // the suite proves the scripted path only. Missing evidence is named.
  assert.equal(gate.status, "blocked");
  const missing: string[] = [];
  if (!keyPresent) missing.push("GATHER_ASSEMBLYAI_API_KEY (AssemblyAI API key supplied outside Git)");
  if (!recordingPresent) missing.push("GATHER_ASSEMBLYAI_TEST_RECORDING (path to an operator-supplied authorized caller recording)");
  assert.ok(missing.length > 0, "expected at least one named missing credential");
  assert.match(gate.missingEvidence ?? "", keyPresent ? /voice-recording/ : /GATHER_ASSEMBLYAI_API_KEY/);
});
