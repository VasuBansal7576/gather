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
