/**
 * SIMULATED read tests for explicit-ID Google Drive retrieval.
 * Scripted transports only; no files.list scan exists in the adapter and
 * these tests assert none is ever attempted. No live account verification
 * has been performed; the live gate is BLOCKED.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { GoogleDocumentRetriever } from "../src/connectors/google/documents.ts";
import type { GoogleHttpRequest, GoogleHttpResponse, GoogleHttpTransport } from "../src/connectors/google/transport.ts";

function json(status: number, body: unknown): GoogleHttpResponse {
  return { status, headers: { "Content-Type": "application/json" }, text: JSON.stringify(body) };
}

function googleError(status: number, reason: string, message: string): GoogleHttpResponse {
  return json(status, { error: { code: status, message, errors: [{ domain: "global", reason, message }] } });
}

function scripted(handler: (req: GoogleHttpRequest) => GoogleHttpResponse | Promise<GoogleHttpResponse>): {
  transport: GoogleHttpTransport;
  log: GoogleHttpRequest[];
} {
  const log: GoogleHttpRequest[] = [];
  return {
    log,
    transport: {
      request: (req) => {
        log.push(req);
        return Promise.resolve(handler(req)).then((res) => res);
      },
    },
  };
}

function retriever(handler: (req: GoogleHttpRequest) => GoogleHttpResponse | Promise<GoogleHttpResponse>, byteCap?: number) {
  const { transport, log } = scripted(handler);
  const connector = new GoogleDocumentRetriever({
    transport,
    tokens: () => Promise.resolve("t"),
    ...(byteCap === undefined ? {} : { byteCap }),
  });
  return { connector, log };
}

function assertNoScan(log: GoogleHttpRequest[]): void {
  // Explicit IDs only: metadata/export/media endpoints, never a listing.
  assert.ok(log.every((entry) => !/\/drive\/v3\/files(\?|$)/.test(entry.url) || entry.url.includes("/files/")));
  assert.ok(log.every((entry) => !entry.url.includes(" corpora=") && !entry.url.includes("q=")));
}

const DOC_META = {
  id: "doc-001",
  name: "Autumn menus",
  mimeType: "application/vnd.google-apps.document",
  capabilities: { canDownload: true },
};

test("Google Doc exports to text with live provenance", async () => {
  const { connector, log } = retriever((req) => {
    if (req.url.includes("/export?")) {
      assert.match(req.url, /mimeType=text%2Fplain/);
      return { status: 200, headers: {}, text: "Seasonal menu\nFamily style" };
    }
    return json(200, DOC_META);
  });
  const result = await connector.retrieveDocument({ operationKey: "op-doc-1", documentId: "doc-001" });
  assert.equal(result.status, "succeeded");
  if (result.status !== "succeeded") return;
  assert.equal(result.data.document.documentId, "doc-001");
  assert.equal(result.data.document.title, "Autumn menus");
  assert.equal(result.data.document.mimeType, "text/plain");
  assert.equal(result.data.document.text, "Seasonal menu\nFamily style");
  assert.equal(result.metadata.simulated, false);
  assert.ok(result.data.provenance.every((ref) => ref.kind === "document" && ref.fictional === false));
  assert.match(result.data.provenance[0]?.label ?? "", /not verified authority/);
  assertNoScan(log);
});

test("text blobs download range-capped; binary is refused, never decoded", async () => {
  const blob = retriever((req) => {
    if (req.url.includes("alt=media")) {
      assert.equal(req.headers.Range, "bytes=0-1023");
      return { status: 200, headers: {}, text: "plain policy text" };
    }
    return json(200, { id: "blob-1", name: "policy.txt", mimeType: "text/plain", capabilities: { canDownload: true } });
  }, 1024);
  const text = await blob.connector.retrieveDocument({ operationKey: "op-doc-2", documentId: "blob-1" });
  assert.equal(text.status, "succeeded");
  if (text.status !== "succeeded") return;
  assert.equal(text.data.document.text, "plain policy text");

  const binary = retriever((req) => {
    if (req.url.includes("alt=media")) return { status: 200, headers: {}, text: "FFD8FF" };
    return json(200, { id: "img-1", name: "photo.jpg", mimeType: "image/jpeg", capabilities: { canDownload: true } });
  });
  const refused = await binary.connector.retrieveDocument({ operationKey: "op-doc-3", documentId: "img-1" });
  assert.equal(refused.status, "failed");
  if (refused.status !== "failed") return;
  assert.equal(refused.error.kind, "unsupported");
  assert.ok(binary.log.every((entry) => !entry.url.includes("alt=media")));
});

test("over-cap content fails closed instead of truncating silently", async () => {
  const big = retriever((req) => {
    if (req.url.includes("alt=media")) return { status: 206, headers: {}, text: "x".repeat(100) };
    return json(200, { id: "big-1", name: "big.txt", mimeType: "text/plain", capabilities: { canDownload: true } });
  }, 100);
  const result = await big.connector.retrieveDocument({ operationKey: "op-doc-4", documentId: "big-1" });
  assert.equal(result.status, "failed");
});

test("metadata errors map honestly; undownloadable files are denied", async () => {
  const gone = retriever(() => googleError(404, "notFound", "File not found"));
  const missing = await gone.connector.retrieveDocument({ operationKey: "op-d5", documentId: "nope" });
  assert.equal(missing.status, "failed");
  if (missing.status !== "failed") return;
  assert.equal(missing.error.kind, "not_found");

  const revoked = retriever(() => googleError(401, "authError", "Invalid Credentials"));
  const denied = await revoked.connector.retrieveDocument({ operationKey: "op-d6", documentId: "doc-001" });
  assert.equal(denied.status, "failed");
  if (denied.status !== "failed") return;
  assert.equal(denied.error.kind, "access_revoked");

  const limited = retriever(() => googleError(403, "rateLimitExceeded", "Rate Limit Exceeded"));
  const throttled = await limited.connector.retrieveDocument({ operationKey: "op-d7", documentId: "doc-001" });
  assert.equal(throttled.status, "failed");
  if (throttled.status !== "failed") return;
  assert.equal(throttled.error.kind, "rate_limited");
  assert.equal(throttled.error.retryable, true);

  const locked = retriever(() => json(200, { ...DOC_META, capabilities: { canDownload: false } }));
  const blocked = await locked.connector.retrieveDocument({ operationKey: "op-d8", documentId: "doc-001" });
  assert.equal(blocked.status, "failed");
  if (blocked.status !== "failed") return;
  assert.equal(blocked.error.kind, "authorization_denied");
  assert.ok(locked.log.every((entry) => !entry.url.includes("/export")));

  const malformed = retriever(() => ({ status: 200, headers: {}, text: "[oops" }));
  const broken = await malformed.connector.retrieveDocument({ operationKey: "op-d9", documentId: "doc-001" });
  assert.equal(broken.status, "failed");
});

test("validation rejects empty ids before any HTTP call", async () => {
  const { connector, log } = retriever(() => json(200, DOC_META));
  const result = await connector.retrieveDocument({ operationKey: "op-d0", documentId: "   " });
  assert.equal(result.status, "failed");
  if (result.status !== "failed") return;
  assert.equal(result.error.kind, "invalid_request");
  assert.equal(log.length, 0);
});

// ---------- 206 Content-Range acceptance: complete-only, fail-closed ----------

const BLOB_META = { id: "blob-1", name: "venue-policy.md", mimeType: "text/plain", capabilities: { canDownload: true } };

function blobRetriever(media: (req: GoogleHttpRequest) => GoogleHttpResponse, byteCap = 1024) {
  return retriever((req) => (req.url.includes("alt=media") ? media(req) : json(200, BLOB_META)), byteCap);
}

test("a complete-range 206 is accepted — the reported venue-policy.md case", async () => {
  const body = "x".repeat(817);
  const { connector, log } = blobRetriever(() => ({
    status: 206,
    headers: { "content-range": "bytes 0-816/817", "content-length": "817" },
    text: body,
  }));
  const result = await connector.retrieveDocument({ operationKey: "op-206-ok", documentId: "blob-1" });
  assert.equal(result.status, "succeeded", "a 206 covering the whole file is the complete body, not over-cap");
  if (result.status !== "succeeded") return;
  assert.equal(result.data.document.text, body);
  assert.ok(log.every((entry) => entry.headers.Range === "bytes=0-1023" || !entry.url.includes("alt=media")),
    "the bounded Range request is preserved — no unbounded refetch");
});

test("206 without provable full coverage fails closed", async () => {
  const cases: Array<{ name: string; headers: Record<string, string>; body?: string }> = [
    { name: "partial range", headers: { "content-range": "bytes 0-99/5000" }, body: "x".repeat(100) },
    { name: "unknown total", headers: { "content-range": "bytes 0-816/*" }, body: "x".repeat(817) },
    { name: "malformed range", headers: { "content-range": "0-816/817" }, body: "x".repeat(817) },
    { name: "missing header", headers: {}, body: "x".repeat(817) },
    { name: "nonzero start", headers: { "content-range": "bytes 100-816/817" }, body: "x".repeat(717) },
    { name: "truncated body", headers: { "content-range": "bytes 0-816/817", "content-length": "817" }, body: "x".repeat(100) },
    { name: "content-length mismatch", headers: { "content-range": "bytes 0-816/817", "content-length": "50" }, body: "x".repeat(817) },
  ];
  for (const testCase of cases) {
    const { connector } = blobRetriever(() => ({ status: 206, headers: testCase.headers, text: testCase.body ?? "" }));
    const result = await connector.retrieveDocument({ operationKey: `op-206-${testCase.name}`, documentId: "blob-1" });
    assert.equal(result.status, "failed", `206 with ${testCase.name} must not be treated as complete`);
  }
  // Complete range but the file itself exceeds the cap: still refused.
  const big = blobRetriever(() => ({
    status: 206,
    headers: { "content-range": "bytes 0-1999/2000", "content-length": "2000" },
    text: "x".repeat(2000),
  }), 1024);
  const over = await big.connector.retrieveDocument({ operationKey: "op-206-big", documentId: "blob-1" });
  assert.equal(over.status, "failed", "a fully-covered 206 over the byte cap still fails closed");
});

test("real loopback HTTP 206 with complete range succeeds through the fetch transport", async () => {
  const { createServer } = await import("node:http");
  const { createFetchTransport } = await import("../src/connectors/google/transport.ts");
  const body = "x".repeat(817);
  const server = createServer((req, res) => {
    if ((req.url ?? "").includes("alt=media")) {
      res.writeHead(206, { "Content-Range": "bytes 0-816/817", "Content-Length": "817", "Content-Type": "text/plain" });
      res.end(body);
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(BLOB_META));
  });
  const baseUrl = await new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as import("node:net").AddressInfo;
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
  try {
    const connector = new GoogleDocumentRetriever({
      transport: createFetchTransport({
        fetchImpl: async (url, init) => {
          const response = await fetch(url.replace("https://www.googleapis.com", baseUrl), init);
          const headers: Record<string, string> = {};
          response.headers.forEach((value, key) => { headers[key] = value; });
          return { status: response.status, headers, text: () => response.text() };
        },
        timeoutMs: 5000,
      }),
      tokens: () => Promise.resolve("t"),
    });
    const result = await connector.retrieveDocument({ operationKey: "op-206-loopback", documentId: "blob-1" });
    assert.equal(result.status, "succeeded", "a real HTTP 206 proving complete coverage is accepted");
    if (result.status !== "succeeded") return;
    assert.equal(result.data.document.text, body);
    assert.equal(Buffer.byteLength(result.data.document.text, "utf-8"), 817);
  } finally {
    server.close();
  }
});
