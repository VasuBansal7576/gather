import assert from "node:assert/strict";
import test from "node:test";
import { FetchOAuthTransport } from "../src/server/connections/oauth.ts";
import { ConnectionError } from "../src/server/connections/types.ts";
const input = { tokenEndpoint: "https://oauth.example.test/token", clientId: "fictional", refreshToken: "fictional-refresh" };

for (const body of ["null", "[]", '"text"', "not-json"]) {
  test(`cleanup regression: OAuth rejects non-object response ${body} with typed error`, async () => {
    const transport = new FetchOAuthTransport({ fetchImpl: async () => new Response(body) });
    await assert.rejects(transport.refresh(input), (error: unknown) => error instanceof ConnectionError && error.code === "EXCHANGE_FAILED");
    await assert.rejects(transport.fetchAccountIdentity({ userinfoEndpoint: "https://oauth.example.test/user", accessToken: "fictional" }),
      (error: unknown) => error instanceof ConnectionError && error.code === "EXCHANGE_FAILED");
  });
}

test("cleanup regression: OAuth error field cannot leak provider text", async () => {
  const transport = new FetchOAuthTransport({ fetchImpl: async () => new Response(JSON.stringify({ error: "token=fictional-secret" }), { status: 400 }) });
  await assert.rejects(transport.refresh(input), (error: unknown) => {
    assert.ok(error instanceof ConnectionError);
    assert.equal(error.providerError, "http_400");
    assert.ok(!error.message.includes("fictional-secret"));
    return true;
  });
});

test("OAuth HTML outage remains retryable without exposing its body", async () => {
  const transport = new FetchOAuthTransport({ fetchImpl: async () => new Response("<h1>fictional-sensitive-proxy-error</h1>", { status: 503 }) });
  await assert.rejects(transport.refresh(input), (error: unknown) =>
    error instanceof ConnectionError && error.retryable && !error.message.includes("fictional-sensitive"));
});

for (const endpoint of ["token", "identity"] as const) {
  test(`cleanup regression: OAuth ${endpoint} enforces byte cap while streaming and cancels oversized body`, async () => {
    let cancelled = false;
    let bodyController: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller;
        // Valid JSON shorter than 64 characters but longer than 64 UTF-8 bytes.
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ access_token: "ok", sub: "ok", pad: "é".repeat(20) })));
      },
      cancel() { cancelled = true; },
    });
    const transport = new FetchOAuthTransport({ maxBytes: 64, fetchImpl: async () => new Response(stream) });
    const pending = endpoint === "token" ? transport.refresh(input)
      : transport.fetchAccountIdentity({ userinfoEndpoint: "https://oauth.example.test/user", accessToken: "fictional" });
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      await assert.rejects(Promise.race([pending, new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error("body read hung past byte cap")), 1000); })]),
        (error: unknown) => error instanceof ConnectionError && /size bound/.test(error.message));
      assert.equal(cancelled, true);
    } finally {
      clearTimeout(watchdog);
      if (!cancelled) bodyController!.close();
    }
  });
}

test("OAuth body timeout cancels stalled stream and returns a redacted retryable error", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const transport = new FetchOAuthTransport({ timeoutMs: 20, fetchImpl: async () => new Response(stream) });
  // Keep the event loop alive while AbortSignal.timeout's unref'ed timer fires.
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    await assert.rejects(Promise.race([
      transport.refresh(input),
      new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error("OAuth timeout did not stop body read")), 1000); }),
    ]), (error: unknown) => error instanceof ConnectionError && error.retryable && /timeout/.test(error.message));
    assert.equal(cancelled, true);
  } finally { clearTimeout(watchdog); }
});
