/**
 * SIMULATED transport tests for the built-in fetch transport.
 * The "server" below is a loopback node:http fixture local to this test —
 * no live Google API is contacted and the live gate stays BLOCKED.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import assert from "node:assert/strict";
import test from "node:test";
import {
  TransportNetworkError,
  TransportTimeoutError,
  createFetchTransport,
} from "../src/connectors/google/transport.ts";

function startFakeServer(handler: (url: string, headers: Record<string, string>) => { status: number; body: string; delayMs?: number }): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req, res) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string") headers[key] = value;
    }
    const result = handler(req.url ?? "/", headers);
    const respond = () => {
      res.writeHead(result.status, { "Content-Type": "application/json" });
      res.end(result.body);
    };
    if (result.delayMs !== undefined) {
      setTimeout(respond, result.delayMs).unref?.();
    } else {
      respond();
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

test("fetch transport passes success through with headers intact", async () => {
  const { server, baseUrl } = await startFakeServer((url, headers) => {
    return { status: 200, body: JSON.stringify({ ok: true, url, authorization: headers.authorization ?? null, custom: headers["x-test"] ?? null }) };
  });
  try {
    const transport = createFetchTransport({ timeoutMs: 5000 });
    const response = await transport.request({
      method: "GET",
      url: `${baseUrl}/x`,
      headers: { Authorization: "Bearer test-token", Accept: "application/json", "X-Test": "yes" },
    });
    assert.equal(response.status, 200);
    // Headers pass through untouched; the transport adds, removes, or logs nothing.
    assert.deepEqual(JSON.parse(response.text), { ok: true, url: "/x", authorization: "Bearer test-token", custom: "yes" });
  } finally {
    server.close();
  }
});

test("fetch transport aborts past the bounded timeout", async () => {
  const { server, baseUrl } = await startFakeServer(() => ({ status: 200, body: "{}", delayMs: 5000 }));
  try {
    const transport = createFetchTransport({ timeoutMs: 100 });
    await assert.rejects(
      transport.request({ method: "POST", url: `${baseUrl}/slow`, headers: {}, body: "{}" }),
      (error: unknown) => error instanceof TransportTimeoutError,
    );
  } finally {
    server.close();
  }
});

test("fetch transport reports refused connections as network failures", async () => {
  const { server, baseUrl } = await startFakeServer(() => ({ status: 200, body: "{}" }));
  const port = new URL(baseUrl).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const transport = createFetchTransport({ timeoutMs: 2000 });
  await assert.rejects(
    transport.request({ method: "GET", url: `http://127.0.0.1:${port}/gone`, headers: {} }),
    (error: unknown) => error instanceof TransportNetworkError,
  );
});
