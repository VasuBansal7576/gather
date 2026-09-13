/**
 * SIMULATED read tests for Gmail history polling and bounded thread intake.
 * Scripted transports only; thread bodies reuse the reviewed gmail.ts
 * reader by composition (no duplicate inquiry abstraction). No live account
 * verification has been performed; the live gate is BLOCKED.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { GoogleGmailConnector } from "../src/connectors/google/gmail.ts";
import { GmailInboxPoller, encodeCursor } from "../src/connectors/google/incremental.ts";
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

function poller(handler: (req: GoogleHttpRequest) => GoogleHttpResponse | Promise<GoogleHttpResponse>) {
  const { transport, log } = scripted(handler);
  return { poller: new GmailInboxPoller({ transport, tokens: () => Promise.resolve("t") }), log };
}

test("delta poll dedupes, advances the cursor, and flags truncation", async () => {
  const { poller: poll } = poller((req) => {
    if (req.url.includes("pageToken=second")) {
      return json(200, {
        historyId: "9003",
        history: [
          { id: "9003", messagesAdded: [{ message: { id: "m-2", threadId: "t-2" } }] },
          { id: "9002", messagesAdded: [{ message: { id: "m-1", threadId: "t-1" } }] },
        ],
      });
    }
    return json(200, {
      historyId: "9002",
      history: [{ id: "9001", messagesAdded: [{ message: { id: "m-1", threadId: "t-1" } }] }],
      nextPageToken: "second",
    });
  });
  const result = await poll.pollInbox("op-poll-1", { cursor: encodeCursor("9000"), maxMessages: 10 });
  assert.equal(result.status, "succeeded");
  if (result.status !== "succeeded") return;
  assert.equal(result.data.resetRequired, false);
  // m-1 arrived on both pages: reported once, in first-seen order.
  assert.deepEqual(result.data.changes.map((change) => change.messageId), ["m-1", "m-2"]);
  assert.ok(result.data.nextCursor !== undefined && result.data.nextCursor !== encodeCursor("9000"));
  assert.equal(result.data.truncated, false);
  assert.equal(result.metadata.simulated, false);
  assert.ok(result.data.provenance.every((ref) => ref.fictional === false));
});

test("expired history (404) demands reset, never partial progress", async () => {
  const { poller: poll, log } = poller(() => googleError(404, "notFound", "History expired"));
  const result = await poll.pollInbox("op-poll-2", { cursor: encodeCursor("1") });
  assert.equal(result.status, "succeeded");
  if (result.status !== "succeeded") return;
  assert.equal(result.data.resetRequired, true);
  assert.deepEqual(result.data.changes, []);
  assert.equal(result.data.nextCursor, undefined);
  assert.ok(log[0]?.url.includes("startHistoryId="));
});

test("invalid cursors are rejected before any HTTP call", async () => {
  const { poller: poll, log } = poller(() => json(200, {}));
  const result = await poll.pollInbox("op-poll-3", { cursor: "not-a-cursor" });
  assert.equal(result.status, "failed");
  if (result.status !== "failed") return;
  assert.equal(result.error.kind, "invalid_request");
  assert.equal(log.length, 0);
});

test("message bounds truncate honestly and revocation maps cleanly", async () => {
  const many = Array.from({ length: 10 }, (_, index) => ({
    id: `90${10 + index}`,
    messagesAdded: [{ message: { id: `m-${index}`, threadId: `t-${index}` } }],
  }));
  const { poller: poll } = poller(() => json(200, { historyId: "9999", history: many }));
  const result = await poll.pollInbox("op-poll-4", { cursor: encodeCursor("1"), maxMessages: 3 });
  assert.equal(result.status, "succeeded");
  if (result.status !== "succeeded") return;
  assert.equal(result.data.changes.length, 3);
  assert.equal(result.data.truncated, true);
  assert.ok(result.data.nextCursor !== undefined);

  const revoked = poller(() => googleError(401, "authError", "Invalid Credentials"));
  const denied = await revoked.poller.pollInbox("op-poll-5", { cursor: encodeCursor("1") });
  assert.equal(denied.status, "failed");
  if (denied.status !== "failed") return;
  assert.equal(denied.error.kind, "access_revoked");

  const limited = poller(() => googleError(429, "rateLimitExceeded", "Too Many Requests"));
  const throttled = await limited.poller.pollInbox("op-poll-6", {});
  assert.equal(throttled.status, "failed");
  if (throttled.status !== "failed") return;
  assert.equal(throttled.error.kind, "rate_limited");
  assert.equal(throttled.error.retryable, true);
});

test("malformed history JSON fails closed; empty history still advances", async () => {
  const broken = poller(() => ({ status: 200, headers: {}, text: "{\"history\":[}" }));
  const bad = await broken.poller.pollInbox("op-poll-7", { cursor: encodeCursor("1") });
  assert.equal(bad.status, "failed");

  const quiet = poller(() => json(200, { historyId: "4242" }));
  const calm = await quiet.poller.pollInbox("op-poll-8", { cursor: encodeCursor("4241") });
  assert.equal(calm.status, "succeeded");
  if (calm.status !== "succeeded") return;
  assert.deepEqual(calm.data.changes, []);
  assert.equal(calm.data.nextCursor, encodeCursor("4242"));
});

test("cursor-less full sync pages ids then bootstraps from the profile", async () => {
  const { poller: poll, log } = poller((req) => {
    if (req.url.includes("/profile")) return json(200, { emailAddress: "owner@example.test", historyId: "7777" });
    if (req.url.includes("pageToken=p2")) {
      return json(200, { messages: [{ id: "m-b", threadId: "t-b" }, { id: "m-a", threadId: "t-a" }] });
    }
    return json(200, { messages: [{ id: "m-a", threadId: "t-a" }], nextPageToken: "p2", resultSizeEstimate: 3 });
  });
  const result = await poll.pollInbox("op-poll-9", { maxMessages: 10 });
  assert.equal(result.status, "succeeded");
  if (result.status !== "succeeded") return;
  assert.deepEqual(result.data.changes.map((change) => change.messageId), ["m-a", "m-b"]);
  assert.equal(result.data.nextCursor, encodeCursor("7777"));
  assert.ok(log.some((entry) => entry.url.includes("/profile")));
});

function b64url(text: string): string {
  return Buffer.from(text, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

test("thread intake keys identity on threadId, never sender alone", async () => {
  const { transport } = scripted((req) => {
    const match = req.url.match(/threads\/([^/?]+)/);
    const threadId = match?.[1] ?? "thread-same-sender";
    return json(200, {
      id: threadId,
      messages: [
        {
          id: `m-for-${threadId}`,
          threadId,
          labelIds: ["INBOX"],
          payload: {
            headers: [
              { name: "From", value: "guest@example.test" },
              { name: "To", value: "venue@example.test" },
              { name: "Subject", value: "Dinner" },
              { name: "Date", value: "Mon, 12 Oct 2026 09:00:00 +0000" },
            ],
            mimeType: "multipart/alternative",
            parts: [
              { mimeType: "text/plain", body: { data: b64url("Plain part") } },
              { mimeType: "text/html", body: { data: b64url("<b>HTML part</b>") } },
            ],
          },
        },
      ],
    });
  });
  const reader = new GoogleGmailConnector({ transport, tokens: () => Promise.resolve("t") });
  const first = await reader.readInquiryThread({ operationKey: "op-i1", threadId: "thread-same-sender" });
  const second = await reader.readInquiryThread({ operationKey: "op-i2", threadId: "thread-other-same-sender" });
  assert.equal(first.status, "succeeded");
  assert.equal(second.status, "succeeded");
  if (first.status !== "succeeded" || second.status !== "succeeded") return;
  // Nested multipart resolves to the plain-text part.
  assert.equal(first.data.thread.messages[0]?.body, "Plain part");
  // Same sender, different thread: records stay distinct by threadId, so a
  // consumer merging on sender address alone would cross bookings.
  assert.notEqual(first.data.thread.threadId, second.data.thread.threadId);
  assert.notEqual(first.data.thread.messages[0]?.id, second.data.thread.messages[0]?.id);
});
