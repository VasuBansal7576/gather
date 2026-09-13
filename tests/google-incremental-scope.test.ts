/**
 * SIMULATED query-scope tests for Gmail history polling.
 *
 * The scripted in-process transport below models the documented provider
 * semantics independently of the production mapping (it never calls
 * production helpers to decide what the server returns, so it can catch
 * mapping errors instead of mirroring them):
 * - `users.history.list` filters by `labelId` only. The documented
 *   parameter list has no `q`; the fake records its presence so tests can
 *   assert the client never sends it. The precise fact under test is that
 *   `q` is unsupported there — nothing here claims how any particular
 *   server handles unknown parameters.
 * - `users.messages.list` applies `labelIds` (a message must carry every
 *   listed id) and excludes SPAM/TRASH-labeled messages unless
 *   `includeSpamTrash=true`.
 * "Out-of-scope" in these tests means only "outside the selected label",
 * never a judgment of business relevance; no semantic filtering or
 * calibration is claimed, and no live account verification has been
 * performed — the live gate is BLOCKED.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { GmailInboxPoller, encodeCursor, resolveHistoryLabelScope, resolvePollScope } from "../src/connectors/google/incremental.ts";
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
  snapshotUrls: URL[];
  sawHistoryQ: boolean;
  sawSnapshotQ: boolean;
}

/** Labels the documented provider treats as excluded without the flag. */
const SPAM_TRASH = new Set(["SPAM", "TRASH"]);

/**
 * Independent provider model, defined from the API parameter docs rather
 * than the production scope table.
 */
function world(pages: Array<{ historyId: string; records: Array<{ hid: string; message: FakeMessage }>; nextPageToken?: string }>, snapshot: FakeMessage[], watermark = "100"): FakeWorld {
  const log: GoogleHttpRequest[] = [];
  const historyUrls: URL[] = [];
  const snapshotUrls: URL[] = [];
  let sawHistoryQ = false;
  let sawSnapshotQ = false;
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
        if (index + 1 < pages.length) body.nextPageToken = String(index + 1);
        return Promise.resolve(json(200, body));
      }
      if (url.pathname.endsWith("/messages")) {
        snapshotUrls.push(url);
        if (url.searchParams.has("q")) sawSnapshotQ = true;
        const required = url.searchParams.getAll("labelIds");
        const includeSpamTrash = url.searchParams.get("includeSpamTrash") === "true";
        const ids = snapshot.filter((message) => {
          if (!includeSpamTrash && message.labels.some((label) => SPAM_TRASH.has(label))) return false;
          return required.every((label) => message.labels.includes(label));
        });
        return Promise.resolve(json(200, { messages: ids.map((message) => ({ id: message.id, threadId: message.threadId })) }));
      }
      return Promise.resolve(json(404, { error: { message: "unknown fake path" } }));
    },
  };
  return { transport, log, historyUrls, snapshotUrls, get sawHistoryQ() { return sawHistoryQ; }, get sawSnapshotQ() { return sawSnapshotQ; } };
}

function scopedPoller(fake: FakeWorld): GmailInboxPoller {
  return new GmailInboxPoller({ transport: fake.transport, tokens: () => Promise.resolve("t"), accountId: "me" });
}

function scopedCursor(historyId: string, query = "in:inbox"): string {
  return encodeCursor(historyId, { account: "me", query });
}

const IN1: FakeMessage = { id: "m-in-1", threadId: "t-in-1", labels: ["INBOX"] };
const IN2: FakeMessage = { id: "m-in-2", threadId: "t-in-2", labels: ["INBOX"] };
const SENT_OUTSIDE: FakeMessage = { id: "m-outside", threadId: "t-outside", labels: ["SENT"] };
const SPAM1: FakeMessage = { id: "m-spam-1", threadId: "t-spam-1", labels: ["SPAM"] };
const SPAM_NEW: FakeMessage = { id: "m-spam-new", threadId: "t-spam-new", labels: ["SPAM"] };
const TRASH1: FakeMessage = { id: "m-trash-1", threadId: "t-trash-1", labels: ["TRASH"] };
const TRASH_NEW: FakeMessage = { id: "m-trash-new", threadId: "t-trash-new", labels: ["TRASH"] };

test("delta pagination retains in-scope changes and excludes out-of-scope ones", async () => {
  const fake = world([
    { historyId: "101", records: [{ hid: "101", message: IN1 }, { hid: "101", message: SENT_OUTSIDE }] },
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

test("initial catch-up excludes out-of-scope arrivals and retains in-scope ones", async () => {
  const OLD: FakeMessage = { id: "m-old", threadId: "t-old", labels: ["INBOX"] };
  const NEW: FakeMessage = { id: "m-new", threadId: "t-new", labels: ["INBOX"] };
  const fake = world(
    [{ historyId: "102", records: [{ hid: "102", message: NEW }, { hid: "102", message: SENT_OUTSIDE }] }],
    [OLD, { id: "m-old-outside", threadId: "t-old-outside", labels: ["SENT"] }],
  );
  const poll = scopedPoller(fake);
  const result = await poll.pollInbox("op-scope-2", { query: "in:inbox", maxMessages: 10 });
  assert.equal(result.status, "succeeded");
  if (result.status !== "succeeded") return;
  assert.deepEqual(result.data.changes.map((change) => change.messageId), ["m-old", "m-new"]);
  assert.equal(result.data.resetRequired, false);
  assert.equal(result.data.truncated, false);
  assert.equal(fake.sawHistoryQ, false);
  assert.equal(fake.sawSnapshotQ, false);
  assert.ok(fake.snapshotUrls.every((url) => url.searchParams.get("labelIds") === "INBOX"));
});

test("spam scope agrees across snapshot and delta (includeSpamTrash required)", async () => {
  const fake = world(
    [{ historyId: "102", records: [{ hid: "102", message: SPAM_NEW }, { hid: "102", message: IN1 }] }],
    [SPAM1, IN1],
  );
  const poll = scopedPoller(fake);
  const result = await poll.pollInbox("op-scope-spam", { query: "in:spam", maxMessages: 10 });
  assert.equal(result.status, "succeeded");
  if (result.status !== "succeeded") return;
  // Existing spam from the snapshot plus the new spam arrival; the inbox
  // message is out of this scope in both phases.
  assert.deepEqual(result.data.changes.map((change) => change.messageId), ["m-spam-1", "m-spam-new"]);
  assert.equal(result.data.truncated, false);
  assert.equal(fake.sawHistoryQ, false);
  assert.equal(fake.sawSnapshotQ, false);
  assert.ok(fake.snapshotUrls.length > 0);
  assert.ok(fake.snapshotUrls.every((url) => url.searchParams.get("labelIds") === "SPAM" && url.searchParams.get("includeSpamTrash") === "true"));
  assert.ok(fake.historyUrls.every((url) => url.searchParams.get("labelId") === "SPAM"));
});

test("trash scope agrees across snapshot and delta (includeSpamTrash required)", async () => {
  const fake = world(
    [{ historyId: "102", records: [{ hid: "102", message: TRASH_NEW }, { hid: "102", message: IN1 }] }],
    [TRASH1, IN1],
  );
  const poll = scopedPoller(fake);
  const result = await poll.pollInbox("op-scope-trash", { query: "in:trash", maxMessages: 10 });
  assert.equal(result.status, "succeeded");
  if (result.status !== "succeeded") return;
  assert.deepEqual(result.data.changes.map((change) => change.messageId), ["m-trash-1", "m-trash-new"]);
  assert.equal(result.data.truncated, false);
  assert.equal(fake.sawHistoryQ, false);
  assert.equal(fake.sawSnapshotQ, false);
  assert.ok(fake.snapshotUrls.every((url) => url.searchParams.get("labelIds") === "TRASH" && url.searchParams.get("includeSpamTrash") === "true"));
  assert.ok(fake.historyUrls.every((url) => url.searchParams.get("labelId") === "TRASH"));
});

test("unfiltered snapshot and delta both cover the whole mailbox", async () => {
  const fake = world(
    [{ historyId: "102", records: [{ hid: "102", message: SPAM_NEW }, { hid: "102", message: TRASH_NEW }, { hid: "102", message: IN2 }] }],
    [IN1, SPAM1, TRASH1],
  );
  const poll = scopedPoller(fake);
  const result = await poll.pollInbox("op-scope-all", { maxMessages: 10 });
  assert.equal(result.status, "succeeded");
  if (result.status !== "succeeded") return;
  // Unfiltered means all mailbox messages: nothing in the mailbox is
  // dropped from either phase, including spam and trash.
  assert.deepEqual(
    result.data.changes.map((change) => change.messageId),
    ["m-in-1", "m-spam-1", "m-trash-1", "m-spam-new", "m-trash-new", "m-in-2"],
  );
  assert.equal(result.data.truncated, false);
  assert.equal(fake.sawHistoryQ, false);
  assert.equal(fake.sawSnapshotQ, false);
  assert.ok(fake.snapshotUrls.length > 0);
  assert.ok(fake.snapshotUrls.every((url) => !url.searchParams.has("labelIds") && url.searchParams.get("includeSpamTrash") === "true"));
  assert.ok(fake.historyUrls.every((url) => !url.searchParams.has("labelId")));
});

test("non-spam scopes exclude spam-labeled messages in both phases", async () => {
  const fake = world(
    [{ historyId: "102", records: [{ hid: "102", message: SPAM_NEW }, { hid: "102", message: IN2 }] }],
    [IN1, SPAM1],
  );
  const poll = scopedPoller(fake);
  const result = await poll.pollInbox("op-scope-nospam", { query: "in:inbox", maxMessages: 10 });
  assert.equal(result.status, "succeeded");
  if (result.status !== "succeeded") return;
  assert.deepEqual(result.data.changes.map((change) => change.messageId), ["m-in-1", "m-in-2"]);
});

test("truncated scoped polls resume without loss, duplication, or broadening", async () => {
  const fake = world([
    { historyId: "101", records: [{ hid: "101", message: IN1 }, { hid: "101", message: SENT_OUTSIDE }, { hid: "101", message: IN2 }] },
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
    { historyId: "102", records: [{ hid: "102", message: SENT_OUTSIDE }, { hid: "102", message: IN2 }] },
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

test("resolvePollScope carries explicit spam/trash inclusion for every accepted scope", async () => {
  // Unfiltered covers the whole mailbox, spam and trash included.
  assert.deepEqual(resolvePollScope(undefined), { includeSpamTrash: true });
  // SPAM/TRASH scopes would snapshot empty without the flag.
  assert.deepEqual(resolvePollScope("in:spam"), { labelId: "SPAM", includeSpamTrash: true });
  assert.deepEqual(resolvePollScope("in:trash"), { labelId: "TRASH", includeSpamTrash: true });
  // Other label scopes use the same population the history delta observes.
  assert.deepEqual(resolvePollScope("in:inbox"), { labelId: "INBOX", includeSpamTrash: true });
  assert.equal(resolvePollScope("from:x"), null);
  assert.equal(resolvePollScope(""), null);
});
