import assert from "node:assert/strict";
import test from "node:test";
import {
  GATHER_BOOKING_TOOLS,
  NEBIUS_ENDPOINT,
  NebiusProfileError,
  callNebiusBookingModel,
  verifyNebiusModel,
  type NebiusProviderTransport,
} from "../src/integrations/nebius/index.ts";
import type { RuntimeControlPort, SubmitInput } from "../src/runtime/control.ts";

const identity = {
  modelId: "operator-supplied/nvidia-model",
  publisher: "NVIDIA" as const,
  provenanceUrl: "https://www.nvidia.com/en-us/ai-data-science/foundation-models/",
  endpoint: NEBIUS_ENDPOINT,
};

function control(): { port: RuntimeControlPort; submissions: unknown[] } {
  const submissions: unknown[] = [];
  return {
    submissions,
    port: {
      kind: "scripted",
      submit: async (input: SubmitInput) => {
        submissions.push(input);
        return { budget: {} as never, duplicate: false, gatewayRunId: "gw-1", sessionKey: "session-1" };
      },
    } as unknown as RuntimeControlPort,
  };
}

test("model verification requires NVIDIA provenance and the qualifying endpoint", () => {
  assert.equal(verifyNebiusModel(identity).verified, true);
  assert.equal(verifyNebiusModel({ ...identity, publisher: "other" as "NVIDIA" }).verified, false);
  assert.equal(verifyNebiusModel({ ...identity, endpoint: "https://api.example.test/v1/chat/completions" }).verified, false);
  assert.equal(verifyNebiusModel({ ...identity, provenanceUrl: "https://example.test/model" }).verified, false);
});

test("disabled profile sends nothing, including no credential or runtime call", async () => {
  const runtime = control();
  let calls = 0;
  const transport: NebiusProviderTransport = { call: async () => { calls += 1; throw new Error("must not call"); } };
  await assert.rejects(
    callNebiusBookingModel({ identity, enabled: false, apiKey: "operator-secret", control: runtime.port, transport }, {
      businessId: "b-1", bookingId: "booking-1", idempotencyKey: "key-1", prompt: "booking proposal", maxInputTokens: 100, maxOutputTokens: 100, deadlineMs: 1000,
    }),
    (error: unknown) => error instanceof NebiusProfileError && error.code === "PROFILE_DISABLED",
  );
  assert.equal(calls, 0);
  assert.equal(runtime.submissions.length, 0);
});

test("verified call reserves budgets and passes only the existing booking tools", async () => {
  const runtime = control();
  let request: { tools: readonly string[] } | undefined;
  const transport: NebiusProviderTransport = {
    call: async (input) => {
      request = input;
      return {
        reasoning: "grounded booking reasoning",
        content: "proposal",
        usage: { inputTokens: 20, outputTokens: 30, totalTokens: 50 },
        receipt: { provider: "nebius", requestId: "req-1", modelId: input.modelId, endpoint: input.endpoint, simulated: true },
      };
    },
  };
  const result = await callNebiusBookingModel({ identity, enabled: true, apiKey: "operator-secret", control: runtime.port, transport }, {
    businessId: "b-1", bookingId: "booking-1", idempotencyKey: "key-1", prompt: "booking proposal", maxInputTokens: 100, maxOutputTokens: 100, deadlineMs: 1000,
  });
  assert.equal(result.reasoning, "grounded booking reasoning");
  assert.deepEqual(request?.tools, GATHER_BOOKING_TOOLS);
  assert.equal(runtime.submissions.length, 1);
  assert.equal(JSON.stringify(result.receipt).includes("operator-secret"), false);
});
