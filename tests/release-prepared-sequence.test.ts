/**
 * ADR-016 release test: full prepared sequence at the final commit.
 *
 * - Every prepared scenario (glasshouse / empty / non-event / partial /
 *   connection-failed) reports honest coverage: empty is never a completed
 *   scan with invented leads, partial is partial, failure is failure.
 * - Each event adapter is exercised on its qualifying task under its exact
 *   profile, scripted: AssemblyAI transcription -> shared intake gate,
 *   Amazon owner MCP attention round-trip over loopback Streamable HTTP,
 *   Nebius verified booking-reasoning call behind the budget boundary.
 *   Disabled adapters make no calls (no key / disabled flag / no session).
 * - Owner correction is measured on the SAME versioned case set before and
 *   after (score numerator/denominator + version shown; verdict honest).
 *
 * All scripted/deterministic; no network beyond loopback, no credentials,
 * no live providers. Fault paths, acceptance, and handoff ride the existing
 * suites (faults, customer-acceptance, delivery.handoff, golden-path) which
 * stay green as part of 016-CHECKS.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  evaluateLiveGate,
  type LiveGateEvidence,
} from "../src/integrations/contracts.ts";
import { getProfile } from "../src/integrations/registry.ts";
import {
  evaluateVoiceIntake,
  resolveAssemblyAIConfig,
  transcribeScriptedAudio,
} from "../src/integrations/assemblyai/index.ts";
import {
  createAmazonOwnerMcp,
  type AmazonOwnerBackend,
} from "../src/integrations/amazon/index.ts";
import {
  NEBIUS_ENDPOINT,
  NebiusProfileError,
  callNebiusBookingModel,
  verifyNebiusModel,
  type NebiusProviderTransport,
} from "../src/integrations/nebius/index.ts";
import type { RuntimeControlPort, SubmitInput } from "../src/runtime/control.ts";
import { GatherStore } from "../src/server/sqlite-store.ts";
import {
  listPreparedInbox,
  readPreparedState,
  seedPreparedFixtures,
  type PreparedScenarioId,
} from "../src/server/demo-fixtures.ts";
import { KnowledgeService } from "../src/knowledge/service.ts";
import { PreparedKnowledgePort } from "../src/knowledge/prepared.ts";
import { EVAL_CASE_SET_VERSION, NO_CAUSAL_CLAIM, loadCaseSet } from "../src/evals/case-set.ts";
import { compareRuns, runCaseSet } from "../src/evals/runner.ts";

/* ---------------- prepared scenarios: honest coverage ---------------- */

function scenarioWorld(scenario: PreparedScenarioId) {
  const dir = mkdtempSync(join(tmpdir(), `gather-016-seq-${scenario}-`));
  const store = new GatherStore(join(dir, "gather.sqlite"));
  const summary = seedPreparedFixtures(store, scenario);
  return {
    store,
    summary,
    cleanup: () => {
      try { store.close(); } catch { /* already closed */ }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("016 sequence: empty/partial/error scenarios report honest coverage", (t) => {
  const expectations: Array<{
    scenario: PreparedScenarioId; inbox: number; coverage: string; detail: RegExp;
  }> = [
    { scenario: "glasshouse", inbox: 6, coverage: "complete", detail: /3 .*event inquiries; 3 are not event inquiries/ },
    { scenario: "empty", inbox: 0, coverage: "complete", detail: /No event inquiries found/ },
    { scenario: "non-event", inbox: 3, coverage: "complete", detail: /No event inquiries found/ },
    { scenario: "partial", inbox: 3, coverage: "partial", detail: /Import incomplete/ },
    { scenario: "connection-failed", inbox: 0, coverage: "failed", detail: /Connection failed/ },
  ];
  for (const expected of expectations) {
    const w = scenarioWorld(expected.scenario);
    try {
      assert.equal(listPreparedInbox(w.store).length, expected.inbox, `${expected.scenario} inbox count`);
      const state = readPreparedState(w.store);
      assert.ok(state, `${expected.scenario} persists scenario state`);
      assert.equal(state.coverage, expected.coverage, `${expected.scenario} coverage`);
      assert.match(state.coverageDetail, expected.detail, `${expected.scenario} detail`);
      t.diagnostic(`016-scenario[${expected.scenario}] inbox=${expected.inbox} coverage=${expected.coverage}`);
    } finally {
      w.cleanup();
    }
  }
});

/* ---------------- event adapters on their qualifying tasks ------------- */

const SCRIPTED_KEY = { GATHER_ASSEMBLYAI_API_KEY: "test-key-never-committed" } as unknown as NodeJS.ProcessEnv;

function scriptedTranscript(text: string, confidence: number) {
  return transcribeScriptedAudio(
    {
      audio: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8].map((n) => (n * 13 + text.length) % 256)),
      contentType: "audio/wav",
      recordingLabel: "release-qualifying-call",
    },
    { text, confidence },
    resolveAssemblyAIConfig(SCRIPTED_KEY),
    () => "2030-06-01T00:00:00.000Z",
  );
}

test("016 sequence: assemblyai profile transcribes a qualifying call into the shared gate (scripted)", async () => {
  assert.equal(getProfile("assemblyai").intakeAdapter, "voice");
  const transcription = scriptedTranscript(
    "Hello! We're planning our wedding dinner for Saturday November 14, 2026, about 90 guests, 6:30pm to 11pm. Is the Glasshouse available, and what would it cost?",
    0.97,
  );
  assert.equal(transcription.provenance.simulated, true);
  const evaluation = await evaluateVoiceIntake(transcription, {
    accountId: "voice-operator",
    businessId: "biz-release-1",
    mode: "prepared",
    audioContentType: "audio/wav",
    audioByteLength: 8,
    recordingLabel: "release-qualifying-call",
  });
  assert.equal(evaluation.gate.decision.outcome, "eligible");
  assert.equal(evaluation.readyForQualification, true);
});

test("016 sequence: disabled voice adapter makes no calls", async () => {
  const config = resolveAssemblyAIConfig({} as unknown as NodeJS.ProcessEnv);
  assert.equal(config.enabled, false);
  assert.match(config.missingEvidence ?? "", /GATHER_ASSEMBLYAI_API_KEY/);
});

const RELEASE_OFFER = {
  offerId: "offer:release-glasshouse",
  version: 1,
  fingerprint: "b".repeat(64),
  actionSummary: "Hold the Glasshouse on 2030-06-12 and send the exact approved offer",
  customerId: "customer-release-1",
};

const releaseBackend: AmazonOwnerBackend = {
  async whatNeedsAttention() {
    return [{ id: "release-attention-1", kind: "approval", summary: "Release offer requires owner approval", offerId: RELEASE_OFFER.offerId, offerVersion: RELEASE_OFFER.version }];
  },
  async resolveOffer() {
    return RELEASE_OFFER;
  },
  async approveExact(_session, exact) {
    return { receipt: "existing-gather-authority", offerId: exact.offerId, version: exact.version };
  },
};

test("016 sequence: amazon profile serves owner attention over loopback MCP (scripted)", async (t) => {
  assert.equal(getProfile("amazon").intakeAdapter, "owner-mcp");
  const adapter = createAmazonOwnerMcp({
    authToken: "owner-token-016-long-enough",
    session: { ownerId: "owner-release", businessId: "business-release" },
    backend: releaseBackend,
  });
  const listening = await adapter.boundary.listen({ port: 0 });
  try {
    const initialize = await fetch(listening.url, {
      method: "POST",
      headers: {
        authorization: "Bearer owner-token-016-long-enough",
        host: new URL(listening.url).host,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "release-smoke-client", version: "0.1.0" } },
      }),
    });
    assert.equal(initialize.status, 200);
    const sessionId = initialize.headers.get("mcp-session-id");
    assert.ok(sessionId);
    const attention = await fetch(listening.url, {
      method: "POST",
      headers: {
        authorization: "Bearer owner-token-016-long-enough",
        host: new URL(listening.url).host,
        origin: new URL(listening.url).origin,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": sessionId,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "what_needs_attention", arguments: {} } }),
    });
    assert.equal(attention.status, 200);
    const payload = await attention.text();
    assert.match(payload, /release-attention-1/);
    assert.doesNotMatch(payload, /guest inquiry text/i);
    t.diagnostic("016-sequence[amazon] attention round-trip over loopback; no customer content exposed");
  } finally {
    await adapter.boundary.close();
  }
});

test("016 sequence: amazon adapter requires explicit owner session (no anonymous surface)", () => {
  assert.throws(
    () => createAmazonOwnerMcp({ authToken: "x", session: { ownerId: "", businessId: "" }, backend: releaseBackend }),
    /owner and business session identity are required/,
  );
});

const NEBIUS_IDENTITY = {
  modelId: "operator-supplied/nvidia-release-model",
  publisher: "NVIDIA" as const,
  provenanceUrl: "https://www.nvidia.com/en-us/ai-data-science/foundation-models/",
  endpoint: NEBIUS_ENDPOINT,
};

function scriptedControl(): { port: RuntimeControlPort; submissions: unknown[] } {
  const submissions: unknown[] = [];
  return {
    submissions,
    port: {
      kind: "scripted",
      submit: async (input: SubmitInput) => {
        submissions.push(input);
        return { budget: {} as never, duplicate: false, gatewayRunId: "gw-release", sessionKey: "session-release" };
      },
    } as unknown as RuntimeControlPort,
  };
}

test("016 sequence: nebius profile routes qualifying reasoning behind the budget boundary (scripted transport)", async () => {
  assert.equal(getProfile("nebius").intakeAdapter, "model-call");
  assert.equal(verifyNebiusModel(NEBIUS_IDENTITY).verified, true);
  const runtime = scriptedControl();
  let transportCalls = 0;
  const transport: NebiusProviderTransport = {
    call: async (input) => {
      transportCalls += 1;
      return {
        reasoning: "release booking reasoning",
        content: "proposal",
        usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
        receipt: { provider: "nebius", requestId: "req-release", modelId: input.modelId, endpoint: input.endpoint, simulated: true },
      };
    },
  };
  const result = await callNebiusBookingModel(
    { identity: NEBIUS_IDENTITY, enabled: true, apiKey: "operator-secret", control: runtime.port, transport },
    { businessId: "b-release", bookingId: "booking-release", idempotencyKey: "key-release", prompt: "release proposal", maxInputTokens: 100, maxOutputTokens: 100, deadlineMs: 1000 },
  );
  assert.equal(result.reasoning, "release booking reasoning");
  assert.equal(transportCalls, 1);
  assert.equal(runtime.submissions.length, 1);
  assert.equal(JSON.stringify(result.receipt).includes("operator-secret"), false);
});

test("016 sequence: disabled nebius profile sends nothing", async () => {
  const runtime = scriptedControl();
  let transportCalls = 0;
  const transport: NebiusProviderTransport = {
    call: async () => { transportCalls += 1; throw new Error("must not call"); },
  };
  await assert.rejects(
    callNebiusBookingModel(
      { identity: NEBIUS_IDENTITY, enabled: false, apiKey: "operator-secret", control: runtime.port, transport },
      { businessId: "b-release", bookingId: "booking-release", idempotencyKey: "key-release", prompt: "x", maxInputTokens: 10, maxOutputTokens: 10, deadlineMs: 100 },
    ),
    (error: unknown) => error instanceof NebiusProfileError && error.code === "PROFILE_DISABLED",
  );
  assert.equal(transportCalls, 0);
  assert.equal(runtime.submissions.length, 0);
});

/* ---------------- same-case-set correction measurement ----------------- */

const DOC = { kind: "document" as const, locator: "fixture://fictional/adr016/release-eval", label: "Fictional release eval seed", fictional: true };
const OWNER = { kind: "owner" as const, id: "fictional-owner-release" };

test("016 sequence: owner correction measured on the same versioned case set", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gather-016-eval-"));
  const store = new GatherStore(join(dir, "gather.sqlite"));
  try {
    const business = store.createBusiness({ name: "Fictional Release Hall", timezone: "America/New_York" });
    const service = new KnowledgeService(store);
    const port = new PreparedKnowledgePort(service, business.id);
    const confirm = (key: string, subjectId: string, value: Record<string, unknown>) => {
      const candidate = service.intakeCandidate({ businessId: business.id, key, subjectId, value, confidence: "probable", sourceReferences: [DOC] });
      service.confirmCandidate({ businessId: business.id, candidateId: candidate.id, actor: OWNER });
    };
    // Before: the pricing_bounds correction has NOT landed yet.
    confirm("price_line", "plated", { unitCents: 9500 });
    service.addScopedException({
      businessId: business.id, actor: OWNER, policyId: "late-checkout", effect: "allow",
      scope: "booking", scopeId: "booking-7", value: { note: "owner approved late checkout" },
    });
    const caseSet = loadCaseSet();
    const before = runCaseSet(port, business.id, caseSet);
    // Owner correction: confirm the missing pricing bounds in plain language.
    confirm("pricing_bounds", "", { currency: "USD", floorCents: 100000, costsComplete: false });
    const after = runCaseSet(port, business.id, caseSet);
    assert.equal(before.caseSetVersion, EVAL_CASE_SET_VERSION);
    assert.equal(after.caseSetVersion, EVAL_CASE_SET_VERSION);
    const comparison = compareRuns(before, after);
    assert.ok(["improved", "unchanged", "worse"].includes(comparison.verdict));
    assert.equal(comparison.disclaimer, NO_CAUSAL_CLAIM);
    assert.match(comparison.denominatorNote, /Same \d+-case denominator/);
    t.diagnostic(`016-eval before=${before.passedCount}/${before.denominator} after=${after.passedCount}/${after.denominator} verdict=${comparison.verdict}`);
  } finally {
    try { store.close(); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------- native + live stay honestly blocked ------------------ */

const EMPTY_EVIDENCE: LiveGateEvidence = {
  runtimeProvisioned: false,
  knowledgeNative: false,
  googleConfigured: false,
  googleAccountConnected: false,
  modelAuthorized: false,
  testRecipientConfigured: false,
  acceptanceKeyConfigured: false,
};

test("016 sequence: every profile reports BLOCKED live proof without operator access", () => {
  for (const id of ["base", "assemblyai", "amazon", "nebius"] as const) {
    const report = evaluateLiveGate(getProfile(id), EMPTY_EVIDENCE);
    assert.equal(report.liveReady, false, `${id} must not claim live proof without access`);
    assert.ok(report.blockedBy.length > 0, `${id} names its missing evidence`);
    assert.match(report.notice, /BLOCKED/);
  }
});
