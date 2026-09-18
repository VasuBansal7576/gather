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

function poller(handler: (req: GoogleHttpRequest) => GoogleHttpResponse | Promise<GoogleHttpResponse>, userId = "me") {
  const { transport, log } = scripted(handler);
  return { poller: new GmailInboxPoller({ transport, tokens: () => Promise.resolve("t"), userId, accountId: userId }), log };
}

function boundCursor(historyId: string, scope: { query?: string; pageToken?: string; seen?: string[] } = {}): string {
  return encodeCursor(historyId, { account: "me", ...scope });
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
  const result = await poll.pollInbox("op-poll-1", { cursor: boundCursor("9000"), maxMessages: 10 });
  assert.equal(result.status, "succeeded");
  if (result.status !== "succeeded") return;
  assert.equal(result.data.resetRequired, false);
  // m-1 arrived on both pages: reported once, in first-seen order.
  assert.deepEqual(result.data.changes.map((change) => change.messageId), ["m-1", "m-2"]);
  assert.equal(result.data.nextCursor, boundCursor("9003"));
  assert.equal(result.data.truncated, false);
  assert.equal(result.metadata.simulated, false);
  assert.ok(result.data.provenance.every((ref) => ref.fictional === false));
});

test("expired history (404) demands reset, never partial progress", async () => {
  const { poller: poll, log } = poller(() => googleError(404, "notFound", "History expired"));
  const result = await poll.pollInbox("op-poll-2", { cursor: boundCursor("1") });
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

test("message bounds truncate to an exact resume point, never past unread mail", async () => {
  const many = Array.from({ length: 10 }, (_, index) => ({
    id: `90${10 + index}`,
    messagesAdded: [{ message: { id: `m-${index}`, threadId: `t-${index}` } }],
  }));
  const seen: GoogleHttpRequest[] = [];
  const { poller: poll } = poller((req) => {
    seen.push(req);
    return json(200, { historyId: "9999", history: many });
  });
  const result = await poll.pollInbox("op-poll-4", { cursor: boundCursor("1"), maxMessages: 3 });
  assert.equal(result.status, "succeeded");
  if (result.status !== "succeeded") return;
  assert.equal(result.data.changes.length, 3);
  assert.equal(result.data.truncated, true);
  assert.ok(result.data.nextCursor !== undefined);
  // The resume point replays the same base (no page token was consumed), so
  // the follow-up poll returns exactly the remaining messages, none lost.
  const follow = await poll.pollInbox("op-poll-4b", { cursor: result.data.nextCursor, maxMessages: 10 });
  assert.equal(follow.status, "succeeded");
  if (follow.status !== "succeeded") return;
  assert.deepEqual(follow.data.changes.map((change) => change.messageId),
    ["m-3", "m-4", "m-5", "m-6", "m-7", "m-8", "m-9"]);
  assert.equal(follow.data.truncated, false);
  assert.equal(follow.data.nextCursor, boundCursor("9999"));

  const revoked = poller(() => googleError(401, "authError", "Invalid Credentials"));
  const denied = await revoked.poller.pollInbox("op-poll-5", { cursor: boundCursor("1") });
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
  const bad = await broken.poller.pollInbox("op-poll-7", { cursor: boundCursor("1") });
  assert.equal(bad.status, "failed");

  const quiet = poller(() => json(200, { historyId: "4242" }));
  const calm = await quiet.poller.pollInbox("op-poll-8", { cursor: boundCursor("4241") });
  assert.equal(calm.status, "succeeded");
  if (calm.status !== "succeeded") return;
  assert.deepEqual(calm.data.changes, []);
  assert.equal(calm.data.nextCursor, boundCursor("4242"));
});

test("legacy v1 cursors are rejected before any HTTP call", async () => {
  const { poller: poll, log } = poller(() => json(200, {}));
  const legacy = `ghi.${Buffer.from(JSON.stringify({ v: 1, historyId: "99" }), "utf-8").toString("base64url")}`;
  const result = await poll.pollInbox("op-poll-7b", { cursor: legacy });
  assert.equal(result.status, "failed");
  if (result.status !== "failed") return;
  assert.equal(result.error.kind, "invalid_request");
  assert.equal(log.length, 0);
});

test("cursor-less full sync snapshots ids, catches arrivals, then names a cursor", async () => {
  const { poller: poll, log } = poller((req) => {
    if (req.url.includes("/profile")) return json(200, { emailAddress: "owner@example.test", historyId: "7777" });
    if (req.url.includes("/history")) {
      // One message arrived during the snapshot: the catch-up delta must
      // return it instead of letting a post-list cursor skip it.
      return json(200, {
        historyId: "7779",
        history: [{ id: "7779", messagesAdded: [{ message: { id: "m-new", threadId: "t-new" } }] }],
      });
    }
    if (req.url.includes("pageToken=p2")) {
      return json(200, { messages: [{ id: "m-b", threadId: "t-b" }, { id: "m-a", threadId: "t-a" }] });
    }
    return json(200, { messages: [{ id: "m-a", threadId: "t-a" }], nextPageToken: "p2", resultSizeEstimate: 3 });
  });
  const result = await poll.pollInbox("op-poll-9", { maxMessages: 10 });
  assert.equal(result.status, "succeeded");
  if (result.status !== "succeeded") return;
  assert.deepEqual(result.data.changes.map((change) => change.messageId), ["m-a", "m-b", "m-new"]);
  assert.equal(result.data.nextCursor, boundCursor("7779"));
  assert.equal(result.data.truncated, false);
  assert.ok(log[0]?.url.includes("/profile"), "watermark is read before the snapshot");
});

test("history messagesDeleted surface as invalidation signals, not silent absences", async () => {
  const { poller: poll, log } = poller(() =>
    json(200, {
      historyId: "9100",
      history: [
        { id: "9099", messagesDeleted: [{ message: { id: "m-gone", threadId: "t-gone" } }] },
        { id: "9098", messagesAdded: [{ message: { id: "m-new", threadId: "t-new" } }] },
      ],
    }),
  );
  const result = await poll.pollInbox("op-poll-del", { cursor: boundCursor("9000"), maxMessages: 10 });
  assert.equal(result.status, "succeeded");
  if (result.status !== "succeeded") return;
  assert.deepEqual(result.data.deleted.map((change) => change.messageId), ["m-gone"]);
  assert.deepEqual(result.data.changes.map((change) => change.messageId), ["m-new"]);
  assert.equal(result.data.pages, 1);
  assert.ok(log[0]?.url.includes("historyTypes=messageAdded%2CmessagesDeleted") || log[0]?.url.includes("historyTypes=messageAdded,messagesDeleted"));
});

test("a truncated bootstrap resumes the list phase so un-emitted snapshot ids are never skipped", async () => {
  // Snapshot page carries three ids; cap at two. The resume cursor must
  // restart the listing (seen-ids dedupe) rather than poll history —
  // m-c predates the watermark and history would skip it forever.
  const { poller: poll } = poller((req) => {
    if (req.url.includes("/profile")) return json(200, { emailAddress: "owner@example.test", historyId: "8000" });
    if (req.url.includes("/history")) return json(200, { historyId: "8000", history: [] });
    return json(200, {
      messages: [
        { id: "m-a", threadId: "t-a" },
        { id: "m-b", threadId: "t-b" },
        { id: "m-c", threadId: "t-c" },
      ],
      resultSizeEstimate: 3,
    });
  });
  const first = await poll.pollInbox("op-poll-list", { maxMessages: 2 });
  assert.equal(first.status, "succeeded");
  if (first.status !== "succeeded") return;
  assert.deepEqual(first.data.changes.map((change) => change.messageId), ["m-a", "m-b"]);
  assert.equal(first.data.truncated, true);
  const resumed = await poll.pollInbox("op-poll-list-2", { cursor: first.data.nextCursor, maxMessages: 10 });
  assert.equal(resumed.status, "succeeded");
  if (resumed.status !== "succeeded") return;
  assert.deepEqual(resumed.data.changes.map((change) => change.messageId), ["m-c"], "the un-emitted snapshot id replays instead of skipping");
  assert.equal(resumed.data.truncated, false);
  assert.equal(resumed.data.nextCursor, boundCursor("8000"));
});

test("message metadata read returns provider-internalDate bucketing evidence", async () => {
  const { transport, log } = scripted(() =>
    json(200, {
      id: "m-meta",
      threadId: "t-meta",
      labelIds: ["INBOX", "UNREAD"],
      internalDate: "1777881600000",
      payload: {
        headers: [
          { name: "From", value: "guest@example.test" },
          { name: "Subject", value: "Meta read" },
          { name: "Date", value: "Tue, 28 Apr 2026 00:00:00 +0000" },
        ],
      },
    }),
  );
  const reader = new GoogleGmailConnector({ transport, tokens: () => Promise.resolve("t") });
  const result = await reader.readMessageMetadata({ operationKey: "op-meta-1", messageId: "m-meta" });
  assert.equal(result.status, "succeeded");
  if (result.status !== "succeeded") return;
  assert.equal(result.data.message.messageId, "m-meta");
  assert.equal(result.data.message.threadId, "t-meta");
  assert.deepEqual(result.data.message.labelIds, ["INBOX", "UNREAD"]);
  assert.equal(result.data.message.receivedAt, new Date(1777881600000).toISOString(), "internalDate drives windowing");
  assert.equal(result.data.message.from, "guest@example.test");
  assert.ok(log[0]?.url.includes("format=metadata"));
  assert.ok(log[0]?.url.includes("metadataHeaders=Date"));

  const missing = await reader.readMessageMetadata({ operationKey: "op-meta-2", messageId: "" });
  assert.equal(missing.status, "failed");
  if (missing.status !== "failed") return;
  assert.equal(missing.error.kind, "invalid_request");
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
