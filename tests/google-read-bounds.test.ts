/**
 * SIMULATED tests for bound cursors, bootstrap catch-up, explicit body
 * completeness, and streaming byte caps. Scripted transports only; no live
 * account verification has been performed; the live gate is BLOCKED.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { GoogleGmailConnector } from "../src/connectors/google/gmail.ts";
import { GoogleDocumentRetriever } from "../src/connectors/google/documents.ts";
import { GmailInboxPoller, encodeCursor } from "../src/connectors/google/incremental.ts";
import { createFetchTransport, TransportBodyTooLargeError } from "../src/connectors/google/transport.ts";
import type { GoogleHttpRequest, GoogleHttpResponse, GoogleHttpTransport } from "../src/connectors/google/transport.ts";

function json(status: number, body: unknown): GoogleHttpResponse {
  return { status, headers: { "Content-Type": "application/json" }, text: JSON.stringify(body) };
}

function scripted(handler: (req: GoogleHttpRequest) => GoogleHttpResponse | Promise<GoogleHttpResponse>) {
  const log: GoogleHttpRequest[] = [];
  return {
    log,
    transport: {
      request: (req: GoogleHttpRequest) => {
        log.push(req);
        return Promise.resolve(handler(req)).then((res) => res);
      },
    } as GoogleHttpTransport,
  };
}

function boundCursor(historyId: string, scope: { account?: string; query?: string; pageToken?: string; seen?: string[] } = {}): string {
  return encodeCursor(historyId, { account: "me", ...scope });
}

function b64url(text: string): string {
  return Buffer.from(text, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

test("capped two-page delta resumes the exact second page", async () => {
  const { transport, log } = scripted((req) => {
    if (req.url.includes("pageToken=second")) {
      return json(200, { historyId: "9003", history: [{ id: "9003", messagesAdded: [{ message: { id: "m-2", threadId: "t-2" } }] }] });
    }
    return json(200, {
      historyId: "9002",
      history: [{ id: "9001", messagesAdded: [{ message: { id: "m-1", threadId: "t-1" } }] }],
      nextPageToken: "second",
    });
  });
  const poll = new GmailInboxPoller({ transport, tokens: () => Promise.resolve("t"), accountId: "me" });
  const first = await poll.pollInbox("op-cap-1", { cursor: boundCursor("9000"), maxPages: 1 });
  assert.equal(first.status, "succeeded");
  if (first.status !== "succeeded") return;
  // First page fully consumed but a second page remains: truncated with a
  // continuation naming the exact page, not the mailbox-max watermark.
  assert.deepEqual(first.data.changes.map((change) => change.messageId), ["m-1"]);
  assert.equal(first.data.truncated, true);
  assert.ok(first.data.nextCursor !== undefined);
  const second = await poll.pollInbox("op-cap-2", { cursor: first.data.nextCursor, maxPages: 5 });
  assert.equal(second.status, "succeeded");
  if (second.status !== "succeeded") return;
  assert.deepEqual(second.data.changes.map((change) => change.messageId), ["m-2"]);
  assert.equal(second.data.truncated, false);
  assert.equal(second.data.nextCursor, boundCursor("9003"));
  assert.ok(log.some((entry) => entry.url.includes("pageToken=second")), "resume must name the unvisited page");
});

test("mid-page message cap resumes within the same page without loss", async () => {
  const page = {
    historyId: "4242",
    history: [
      { id: "4242", messagesAdded: [{ message: { id: "m-1", threadId: "t-1" } }, { message: { id: "m-2", threadId: "t-2" } }] },
      { id: "4242", messagesAdded: [{ message: { id: "m-3", threadId: "t-3" } }] },
    ],
  };
  const { transport } = scripted(() => json(200, page));
  const poll = new GmailInboxPoller({ transport, tokens: () => Promise.resolve("t"), accountId: "me" });
  const first = await poll.pollInbox("op-mid-1", { cursor: boundCursor("1"), maxMessages: 2 });
  assert.equal(first.status, "succeeded");
  if (first.status !== "succeeded") return;
  assert.deepEqual(first.data.changes.map((change) => change.messageId), ["m-1", "m-2"]);
  assert.equal(first.data.truncated, true);
  const second = await poll.pollInbox("op-mid-2", { cursor: first.data.nextCursor, maxMessages: 2 });
  assert.equal(second.status, "succeeded");
  if (second.status !== "succeeded") return;
  assert.deepEqual(second.data.changes.map((change) => change.messageId), ["m-3"]);
  assert.equal(second.data.truncated, false);
  assert.equal(second.data.nextCursor, boundCursor("4242"));
});

test("cursors bound to another account or query are rejected without HTTP", async () => {
  const { transport, log } = scripted(() => json(200, {}));
  const otherAccount = new GmailInboxPoller({ transport, tokens: () => Promise.resolve("t"), userId: "someone@example.test", accountId: "someone@example.test" });
  const foreign = await otherAccount.pollInbox("op-bind-1", { cursor: boundCursor("5") });
  assert.equal(foreign.status, "failed");
  if (foreign.status !== "failed") return;
  assert.equal(foreign.error.kind, "invalid_request");
  const poll = new GmailInboxPoller({ transport, tokens: () => Promise.resolve("t"), accountId: "me" });
  const scoped = await poll.pollInbox("op-bind-2", { cursor: encodeCursor("5", { account: "me", query: "from:x" }), query: "from:y" });
  assert.equal(scoped.status, "failed");
  if (scoped.status !== "failed") return;
  assert.equal(scoped.error.kind, "invalid_request");
  const unscoped = await poll.pollInbox("op-bind-3", { cursor: encodeCursor("5", { account: "me", query: "from:x" }) });
  assert.equal(unscoped.status, "failed");
  if (unscoped.status !== "failed") return;
  assert.equal(unscoped.error.kind, "invalid_request");
  assert.equal(log.length, 0);
});

test("bootstrap catch-up returns arrivals during the snapshot", async () => {
  const { transport } = scripted((req) => {
    if (req.url.includes("/profile")) return json(200, { emailAddress: "owner@example.test", historyId: "100" });
    if (req.url.includes("/history")) {
      return json(200, { historyId: "102", history: [{ id: "102", messagesAdded: [{ message: { id: "m-new", threadId: "t-new" } }] }] });
    }
    return json(200, { messages: [{ id: "m-old", threadId: "t-old" }] });
  });
  const poll = new GmailInboxPoller({ transport, tokens: () => Promise.resolve("t"), accountId: "me" });
  const result = await poll.pollInbox("op-boot-1", {});
  assert.equal(result.status, "succeeded");
  if (result.status !== "succeeded") return;
  assert.deepEqual(result.data.changes.map((change) => change.messageId), ["m-old", "m-new"]);
  assert.equal(result.data.nextCursor, boundCursor("102"));
  assert.equal(result.data.truncated, false);
});

function threadWithParts(parts: unknown[]) {
  return {
    id: "thr-1",
    messages: [{
      id: "m-1",
      threadId: "thr-1",
      labelIds: ["INBOX"],
      snippet: "SNIPPET",
      payload: {
        headers: [
          { name: "From", value: "guest@example.test" },
          { name: "To", value: "venue@example.test" },
          { name: "Subject", value: "Dinner" },
        ],
        mimeType: "multipart/mixed",
        parts,
      },
    }],
  };
}

function boundedReader(handler: (req: GoogleHttpRequest) => GoogleHttpResponse) {
  const { transport, log } = scripted(handler);
  return { reader: new GoogleGmailConnector({ transport, tokens: () => Promise.resolve("t") }), log };
}

test("malformed base64 parts are flagged incomplete, never mojibake", async () => {
  const { reader } = boundedReader(() => json(200, threadWithParts([
    { mimeType: "text/plain", body: { data: "!!!###$$$" } },
  ])));
  const result = await reader.readThreadBounded({ operationKey: "op-b1", threadId: "thr-1" });
  assert.equal(result.status, "succeeded");
  if (result.status !== "succeeded") return;
  assert.equal(result.data.completeness.complete, false);
  assert.ok(result.data.completeness.messages[0]?.issues.includes("malformed-base64-part"));
  // The plain reader falls back to the snippet for the same input.
  assert.equal(result.data.thread.messages[0]?.body, "SNIPPET");
});

test("unsupported charsets and skipped attachments are flagged", async () => {
  const { reader } = boundedReader(() => json(200, threadWithParts([
    {
      mimeType: "text/plain",
      headers: [{ name: "Content-Type", value: 'text/plain; charset="iso-8859-1"' }],
      body: { data: b64url("café") },
    },
    { mimeType: "application/pdf", filename: "menu.pdf", body: {} },
  ])));
  const result = await reader.readThreadBounded({ operationKey: "op-b2", threadId: "thr-1" });
  assert.equal(result.status, "succeeded");
  if (result.status !== "succeeded") return;
  const issues = result.data.completeness.messages[0]?.issues ?? [];
  assert.ok(issues.includes("unsupported-charset"), `expected charset flag, got ${issues.join(",")}`);
  assert.ok(issues.includes("attachment-skipped"), `expected attachment flag, got ${issues.join(",")}`);
  assert.equal(result.data.completeness.complete, false);
});

test("clean bodies report complete with identical text to the plain reader", async () => {
  const { reader } = boundedReader(() => json(200, threadWithParts([
    { mimeType: "text/plain", body: { data: b64url("Hello, world") } },
  ])));
  const bounded = await reader.readThreadBounded({ operationKey: "op-b3", threadId: "thr-1" });
  const plain = await reader.readInquiryThread({ operationKey: "op-b3b", threadId: "thr-1" });
  assert.equal(bounded.status, "succeeded");
  assert.equal(plain.status, "succeeded");
  if (bounded.status !== "succeeded" || plain.status !== "succeeded") return;
  assert.equal(bounded.data.completeness.complete, true);
  assert.equal(bounded.data.thread.messages[0]?.body, "Hello, world");
  assert.equal(bounded.data.thread.messages[0]?.body, plain.data.thread.messages[0]?.body);
});

test("same userId alias across two accounts still rejects foreign cursors", async () => {
  const { transport, log } = scripted(() => json(200, {
    historyId: "5001",
    history: [{ id: "5001", messagesAdded: [{ message: { id: "m-1", threadId: "t-1" } }] }],
  }));
  const tokens = () => Promise.resolve("t");
  const pollA = new GmailInboxPoller({ transport, tokens, userId: "me", accountId: "acct-A" });
  // Mint a cursor bound to acct-A through a real poll.
  const minted = await pollA.pollInbox("op-acct-2", { cursor: encodeCursor("5000", { account: "acct-A" }) });
  assert.equal(minted.status, "succeeded");
  if (minted.status !== "succeeded") return;
  assert.ok(minted.data.nextCursor !== undefined);
  const callsBefore = log.length;
  // Same "me" alias, different stable account: rejected before any HTTP.
  const pollB = new GmailInboxPoller({ transport, tokens, userId: "me", accountId: "acct-B" });
  const foreign = await pollB.pollInbox("op-acct-3", { cursor: minted.data.nextCursor });
  assert.equal(foreign.status, "failed");
  if (foreign.status !== "failed") return;
  assert.equal(foreign.error.kind, "invalid_request");
  assert.equal(log.length, callsBefore);
});

test("skipped siblings after the chosen text are still flagged", async () => {
  const { reader } = boundedReader(() => json(200, threadWithParts([
    { mimeType: "text/plain", body: { data: b64url("Hello") } },
    { mimeType: "application/pdf", filename: "menu.pdf", body: {} },
  ])));
  const result = await reader.readThreadBounded({ operationKey: "op-sib", threadId: "thr-1" });
  assert.equal(result.status, "succeeded");
  if (result.status !== "succeeded") return;
  assert.equal(result.data.thread.messages[0]?.body, "Hello");
  const issues = result.data.completeness.messages[0]?.issues ?? [];
  assert.ok(issues.includes("attachment-skipped"), `expected attachment flag, got ${issues.join(",")}`);
  assert.equal(result.data.completeness.complete, false);
});

test("valid replacement characters stay text; truly invalid UTF-8 is flagged", async () => {
  const legit = boundedReader(() => json(200, threadWithParts([
    { mimeType: "text/plain", body: { data: b64url("100�% legit � char") } },
  ])));
  const good = await legit.reader.readThreadBounded({ operationKey: "op-uni-1", threadId: "thr-1" });
  assert.equal(good.status, "succeeded");
  if (good.status !== "succeeded") return;
  assert.equal(good.data.thread.messages[0]?.body, "100�% legit � char");
  assert.equal(good.data.completeness.complete, true);

  const invalidBytes = Buffer.from([0xff, 0xfe, 0x41]).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  const corrupt = boundedReader(() => json(200, threadWithParts([
    { mimeType: "text/plain", body: { data: invalidBytes } },
  ])));
  const bad = await corrupt.reader.readThreadBounded({ operationKey: "op-uni-2", threadId: "thr-1" });
  assert.equal(bad.status, "succeeded");
  if (bad.status !== "succeeded") return;
  assert.ok((bad.data.completeness.messages[0]?.issues ?? []).includes("malformed-base64-part"));
  assert.equal(bad.data.completeness.complete, false);
});

test("document caps count bytes, never UTF-16 units or split code points", async () => {
  // "é" is 1 UTF-16 unit but 2 bytes: 5 of them are 10 bytes (at cap),
  // 6 of them are 12 bytes (over a 10-byte cap).
  const atCap = "é".repeat(5);
  const overCap = "é".repeat(6);
  assert.equal(atCap.length, 5);
  assert.equal(Buffer.byteLength(overCap, "utf-8"), 12);
  const world = (text: string) => scripted((req) => {
    if (req.url.includes("alt=media")) return { status: 200, headers: {}, text };
    return json(200, { id: "doc-mb", name: "m.txt", mimeType: "text/plain", capabilities: { canDownload: true } });
  });
  const fitting = world(atCap);
  const fitReader = new GoogleDocumentRetriever({ transport: fitting.transport, tokens: () => Promise.resolve("t"), byteCap: 10 });
  const fit = await fitReader.retrieveDocument({ operationKey: "op-mb-1", documentId: "doc-mb" });
  assert.equal(fit.status, "succeeded");
  if (fit.status !== "succeeded") return;
  assert.equal(fit.data.document.text, atCap);
  const overflowing = world(overCap);
  const overReader = new GoogleDocumentRetriever({ transport: overflowing.transport, tokens: () => Promise.resolve("t"), byteCap: 10 });
  const over = await overReader.retrieveDocument({ operationKey: "op-mb-2", documentId: "doc-mb" });
  assert.equal(over.status, "failed");
});

test("streaming byte cap aborts over-cap bodies; default path buffers as before", async () => {
  const big = "x".repeat(3000);
  const chunked = createFetchTransport({
    fetchImpl: async () => ({
      status: 200,
      headers: {},
      text: async () => big,
      streamBytes: (async function *() { yield Buffer.from(big.slice(0, 2000)); yield Buffer.from(big.slice(2000)); })(),
    }),
    maxBytes: 1024,
  });
  const over = await chunked.request({ method: "GET", url: "https://example.test/big", headers: {} }).then(
    () => "buffered",
    (error: unknown) => (error as Error).name,
  );
  assert.equal(over, "TransportBodyTooLargeError");
  const small = createFetchTransport({
    fetchImpl: async () => ({
      status: 200,
      headers: {},
      text: async () => "small",
      streamBytes: (async function *() { yield Buffer.from("small"); })(),
    }),
    maxBytes: 1024,
  });
  const under = await small.request({ method: "GET", url: "https://example.test/small", headers: {} });
  assert.equal(under.text, "small");
  // No cap configured: legacy buffering behavior is untouched.
  const legacy = createFetchTransport({
    fetchImpl: async () => ({ status: 200, headers: {}, text: async () => big }),
  });
  const buffered = await legacy.request({ method: "GET", url: "https://example.test/big", headers: {} });
  assert.equal(buffered.text, big);
});
