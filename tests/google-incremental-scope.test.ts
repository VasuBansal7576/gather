/**
 * SIMULATED query-scope tests for Gmail history polling.
 *
 * Regression: `users.history.list` documents `maxResults`, `pageToken`,
 * `startHistoryId`, `labelId`, and `historyTypes` — it has NO `q`
 * parameter. The poller previously sent `q` on history calls and assumed
 * scoped results; an accurate server ignores the unknown parameter and
 * returns unscoped changes, so off-topic mail leaked into scoped polls.
 * The scripted transport below models that accurate server: history
 * filtering happens ONLY via `labelId` (per-message label membership),
 * `q` on history is ignored (and its presence is recorded so tests can
 * assert it is never sent), and `messages.list` honors `q` (it documents
 * it). No live account verification has been performed; the live gate is
 * BLOCKED.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { GmailInboxPoller, encodeCursor, resolveHistoryLabelScope } from "../src/connectors/google/incremental.ts";
import type { GoogleHttpRequest, GoogleHttpResponse, GoogleHttpTransport } from "../src/connectors/google/transport.ts";

function json(status: number, body: unknown): GoogleHttpResponse {
  return { status, headers: { "Content-Type": "application/json" }, text: JSON.stringify(body) };
}

interface FakeMessage {
  id: string;
  threadId: string;
  labels: string[];
}

function historyRecord(hid: string, message: FakeMessage): unknown {
  return { id: hid, messagesAdded: [{ message: { id: message.id, threadId: message.threadId } }] };
}

interface FakeWorld {
  transport: GoogleHttpTransport;
  log: GoogleHttpRequest[];
  historyUrls: URL[];
  sawHistoryQ: boolean;
}

/**
 * Accurate loopback server: history honors `labelId` only (never `q`);
 * messages.list honors `q` for exact single-label scopes.
 */
function world(pages: Array<{ historyId: string; records: Array<{ hid: string; message: FakeMessage }>; nextPageToken?: string }>, snapshot: FakeMessage[], watermark = "100"): FakeWorld {
  const log: GoogleHttpRequest[] = [];
  const historyUrls: URL[] = [];
  let sawHistoryQ = false;
  const transport: GoogleHttpTransport = {
    request: (req: GoogleHttpRequest): Promise<GoogleHttpResponse> => {
      log.push(req);
      const url = new URL(req.url);
      if (url.pathname.endsWith("/profile")) {
        return Promise.resolve(json(200, { emailAddress: "owner@example.test", historyId: watermark }));
      }
      if (url.pathname.endsWith("/history")) {
        historyUrls.push(url);
        if (url.searchParams.has("q")) sawHistoryQ = true;
        const labelId = url.searchParams.get("labelId");
        const token = url.searchParams.get("pageToken") ?? undefined;
        const index = token === undefined ? 0 : Number(token);
        const page = pages[index];
        if (page === undefined) return Promise.resolve(json(200, { historyId: watermark }));
        const kept = page.records.filter((record) => labelId === null || record.message.labels.includes(labelId));
        const body: Record<string, unknown> = {
          historyId: page.historyId,
          history: kept.map((record) => historyRecord(record.hid, record.message)),
        };
        const next = page.nextPageToken ?? (index + 1 < pages.length ? String(index + 1) : undefined);
        if (kept.length === 0 && next !== undefined) {
          // Server still advances paging past fully filtered pages.
          body.nextPageToken = next;
        } else if (next !== undefined && page.nextPageToken !== undefined) {
          body.nextPageToken = next;
        } else if (index + 1 < pages.length) {
          body.nextPageToken = String(index + 1);
        }
        return Promise.resolve(json(200, body));
      }
      if (url.pathname.endsWith("/messages")) {
        const q = url.searchParams.get("q");
        let ids = snapshot;
        if (q !== null) {
          const scope = resolveHistoryLabelScope(q);
          if (scope === null) throw new Error(`fake server received a query the client must have rejected: ${q}`);
          if (scope !== undefined) ids = ids.filter((message) => message.labels.includes(scope));
        }
        return Promise.resolve(json(200, { messages: ids.map((message) => ({ id: message.id, threadId: message.threadId })) }));
      }
      return Promise.resolve(json(404, { error: { message: "unknown fake path" } }));
    },
  };
  return { transport, log, historyUrls, get sawHistoryQ() { return sawHistoryQ; } };
}

function scopedPoller(fake: FakeWorld): GmailInboxPoller {
  return new GmailInboxPoller({ transport: fake.transport, tokens: () => Promise.resolve("t"), accountId: "me" });
}

function scopedCursor(historyId: string, query = "in:inbox"): string {
  return encodeCursor(historyId, { account: "me", query });
}

const IN1: FakeMessage = { id: "m-in-1", threadId: "t-in-1", labels: ["INBOX"] };
const IN2: FakeMessage = { id: "m-in-2", threadId: "t-in-2", labels: ["INBOX"] };
const OFF: FakeMessage = { id: "m-off", threadId: "t-off", labels: ["SENT"] };

test("delta pagination retains relevant changes and excludes off-topic ones", async () => {
  const fake = world([
    { historyId: "101", records: [{ hid: "101", message: IN1 }, { hid: "101", message: OFF }] },
    { historyId: "102", records: [{ hid: "102", message: IN2 }] },
  ], []);
  const poll = scopedPoller(fake);
  const result = await poll.pollInbox("op-scope-1", { cursor: scopedCursor("100"), query: "in:inbox", maxMessages: 10 });
  assert.equal(result.status, "succeeded");
  if (result.status !== "succeeded") return;
  assert.deepEqual(result.data.changes.map((change) => change.messageId), ["m-in-1", "m-in-2"]);
  assert.equal(result.data.resetRequired, false);
  assert.equal(result.data.truncated, false);
  // Exact server scoping, never the unsupported parameter.
  assert.equal(fake.sawHistoryQ, false);
  assert.ok(fake.historyUrls.length > 0);
  assert.ok(fake.historyUrls.every((url) => url.searchParams.get("labelId") === "INBOX"));
});

test("initial catch-up excludes off-topic arrivals and retains relevant ones", async () => {
  const OLD: FakeMessage = { id: "m-old", threadId: "t-old", labels: ["INBOX"] };
  const NEW: FakeMessage = { id: "m-new", threadId: "t-new", labels: ["INBOX"] };
  const fake = world(
    [{ historyId: "102", records: [{ hid: "102", message: NEW }, { hid: "102", message: OFF }] }],
    [OLD, { id: "m-old-off", threadId: "t-old-off", labels: ["SENT"] }],
  );
  const poll = scopedPoller(fake);
  const result = await poll.pollInbox("op-scope-2", { query: "in:inbox", maxMessages: 10 });
  assert.equal(result.status, "succeeded");
  if (result.status !== "succeeded") return;
  assert.deepEqual(result.data.changes.map((change) => change.messageId), ["m-old", "m-new"]);
  assert.equal(result.data.resetRequired, false);
  assert.equal(result.data.truncated, false);
  assert.equal(fake.sawHistoryQ, false);
});

test("truncated scoped polls resume without loss, duplication, or broadening", async () => {
  const fake = world([
    { historyId: "101", records: [{ hid: "101", message: IN1 }, { hid: "101", message: OFF }, { hid: "101", message: IN2 }] },
  ], []);
  const poll = scopedPoller(fake);
  const first = await poll.pollInbox("op-scope-3", { cursor: scopedCursor("100"), query: "in:inbox", maxMessages: 1 });
  assert.equal(first.status, "succeeded");
  if (first.status !== "succeeded") return;
  assert.deepEqual(first.data.changes.map((change) => change.messageId), ["m-in-1"]);
  assert.equal(first.data.truncated, true);
  assert.ok(first.data.nextCursor !== undefined);
  // Retry / cursor recovery replays the same scoped page and dedupes.
  const second = await poll.pollInbox("op-scope-4", { cursor: first.data.nextCursor, query: "in:inbox", maxMessages: 10 });
  assert.equal(second.status, "succeeded");
  if (second.status !== "succeeded") return;
  assert.deepEqual(second.data.changes.map((change) => change.messageId), ["m-in-2"]);
  assert.equal(second.data.truncated, false);
  assert.equal(fake.sawHistoryQ, false);
  assert.ok(fake.historyUrls.every((url) => url.searchParams.get("labelId") === "INBOX"));
});

test("capped history pages resume the exact next page under scope", async () => {
  const fake = world([
    { historyId: "101", records: [{ hid: "101", message: IN1 }] },
    { historyId: "102", records: [{ hid: "102", message: OFF }, { hid: "102", message: IN2 }] },
  ], []);
  const poll = scopedPoller(fake);
  const first = await poll.pollInbox("op-scope-5", { cursor: scopedCursor("100"), query: "in:inbox", maxPages: 1 });
  assert.equal(first.status, "succeeded");
  if (first.status !== "succeeded") return;
  assert.deepEqual(first.data.changes.map((change) => change.messageId), ["m-in-1"]);
  assert.equal(first.data.truncated, true);
  const second = await poll.pollInbox("op-scope-6", { cursor: first.data.nextCursor, query: "in:inbox", maxPages: 5 });
  assert.equal(second.status, "succeeded");
  if (second.status !== "succeeded") return;
  assert.deepEqual(second.data.changes.map((change) => change.messageId), ["m-in-2"]);
  assert.equal(second.data.truncated, false);
  assert.equal(fake.sawHistoryQ, false);
});

test("unsupported and changed queries are rejected before any HTTP call", async () => {
  const fake = world([{ historyId: "101", records: [{ hid: "101", message: IN1 }] }], [IN1]);
  const poll = scopedPoller(fake);
  const calls = () => fake.log.length;
  // Arbitrary search syntax has no exact history equivalent: rejected, never broadened.
  for (const query of ["from:someone@example.test", "in:inbox from:x", "-in:inbox", "", "   ", "label:custom-label", "in:inbox OR in:sent"]) {
    const before = calls();
    const bootstrap = await poll.pollInbox("op-scope-reject", { query });
    assert.equal(bootstrap.status, "failed", `bootstrap must reject ${JSON.stringify(query)}`);
    if (bootstrap.status !== "failed") return;
    assert.equal(bootstrap.error.kind, "invalid_request");
    const delta = await poll.pollInbox("op-scope-reject", { cursor: scopedCursor("100", query), query });
    assert.equal(delta.status, "failed", `delta must reject ${JSON.stringify(query)}`);
    if (delta.status !== "failed") return;
    assert.equal(delta.error.kind, "invalid_request");
    assert.equal(calls(), before, `rejected query ${JSON.stringify(query)} must not trigger HTTP`);
  }
  // A cursor minted under one scope never polls another scope.
  const changed = await poll.pollInbox("op-scope-changed", { cursor: scopedCursor("100", "in:inbox"), query: "in:sent" });
  assert.equal(changed.status, "failed");
  if (changed.status !== "failed") return;
  assert.equal(changed.error.kind, "invalid_request");
  assert.equal(fake.sawHistoryQ, false);
});

test("unfiltered polls send neither q nor labelId and return everything", async () => {
  const fake = world(
    [{ historyId: "101", records: [{ hid: "101", message: IN1 }, { hid: "101", message: OFF }] }],
    [IN1, OFF],
  );
  const poll = scopedPoller(fake);
  const delta = await poll.pollInbox("op-scope-7", { cursor: encodeCursor("100", { account: "me" }), maxMessages: 10 });
  assert.equal(delta.status, "succeeded");
  if (delta.status !== "succeeded") return;
  assert.deepEqual(delta.data.changes.map((change) => change.messageId), ["m-in-1", "m-off"]);
  const boot = await poll.pollInbox("op-scope-8", { maxMessages: 10 });
  assert.equal(boot.status, "succeeded");
  if (boot.status !== "succeeded") return;
  assert.ok(boot.data.changes.some((change) => change.messageId === "m-off"));
  assert.equal(fake.sawHistoryQ, false);
  assert.ok(fake.historyUrls.length > 0);
  assert.ok(fake.historyUrls.every((url) => !url.searchParams.has("labelId")));
});

test("scoped history expiry still demands reset, never partial progress", async () => {
  const log: GoogleHttpRequest[] = [];
  const transport: GoogleHttpTransport = {
    request: (req: GoogleHttpRequest): Promise<GoogleHttpResponse> => {
      log.push(req);
      return Promise.resolve(json(404, { error: { code: 404, message: "History expired" } }));
    },
  };
  const poll = new GmailInboxPoller({ transport, tokens: () => Promise.resolve("t"), accountId: "me" });
  const result = await poll.pollInbox("op-scope-9", { cursor: scopedCursor("1"), query: "in:inbox" });
  assert.equal(result.status, "succeeded");
  if (result.status !== "succeeded") return;
  assert.equal(result.data.resetRequired, true);
  assert.deepEqual(result.data.changes, []);
  assert.ok(log[0] !== undefined && log[0].url.includes("labelId=INBOX") && !log[0].url.includes("q="));
});

test("resolveHistoryLabelScope maps exactly the supported boundary", async () => {
  assert.equal(resolveHistoryLabelScope(undefined), undefined);
  assert.equal(resolveHistoryLabelScope("in:inbox"), "INBOX");
  assert.equal(resolveHistoryLabelScope(" IN:Sent "), "SENT");
  assert.equal(resolveHistoryLabelScope("in:trash"), "TRASH");
  assert.equal(resolveHistoryLabelScope("in:spam"), "SPAM");
  assert.equal(resolveHistoryLabelScope("in:draft"), "DRAFT");
  assert.equal(resolveHistoryLabelScope("in:drafts"), "DRAFT");
  assert.equal(resolveHistoryLabelScope("label:inbox"), "INBOX");
  assert.equal(resolveHistoryLabelScope("is:unread"), "UNREAD");
  assert.equal(resolveHistoryLabelScope("is:starred"), "STARRED");
  assert.equal(resolveHistoryLabelScope("is:important"), "IMPORTANT");
  for (const unsupported of ["", "   ", "from:x", "in:inbox from:x", "-in:inbox", "label:my-label", "in:inbox OR in:sent", "\"in:inbox\""]) {
    assert.equal(resolveHistoryLabelScope(unsupported), null, `must reject ${JSON.stringify(unsupported)}`);
  }
});
