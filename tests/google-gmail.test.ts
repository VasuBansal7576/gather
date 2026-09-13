/**
 * SIMULATED contract tests for the live Gmail adapter.
 * Every HTTP exchange below is scripted through an injected fake transport;
 * Gmail documents no idempotent send, so these tests assert Message-ID
 * correlation and uncertain-on-ambiguity instead of exactly-once delivery.
 * No live account verification has been performed; the live gate is BLOCKED.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { escapeGmailQuery, gmailMessageIdFor, GoogleGmailConnector } from "../src/connectors/google/gmail.ts";
import { TransportTimeoutError, type GoogleHttpRequest, type GoogleHttpResponse, type GoogleHttpTransport } from "../src/connectors/google/transport.ts";

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

function gmail(options: { handler: (req: GoogleHttpRequest) => GoogleHttpResponse | Promise<GoogleHttpResponse>; tokens?: () => Promise<string> }) {
  const { transport, log } = scripted(options.handler);
  const connector = new GoogleGmailConnector({ transport, tokens: options.tokens ?? (() => Promise.resolve("approved-test-token")) });
  return { connector, log };
}

function b64url(text: string): string {
  return Buffer.from(text, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function threadMessage(id: string, subject: string, bodyText: string) {
  return {
    id,
    threadId: "thread-1",
    labelIds: ["INBOX"],
    snippet: bodyText.slice(0, 20),
    payload: {
      headers: [
        { name: "From", value: "guest@example.test" },
        { name: "To", value: "venue@example.test" },
        { name: "Subject", value: subject },
        { name: "Date", value: "Mon, 12 Oct 2026 09:00:00 +0000" },
      ],
      mimeType: "text/plain",
      body: { data: b64url(bodyText) },
    },
  };
}

test("send builds a valid raw message and returns a live sent receipt", async () => {
  const { connector, log } = gmail({
    handler: (req) => {
      assert.match(req.url, /messages\/send/);
      assert.equal(req.headers.Authorization, "Bearer approved-test-token");
      const body = JSON.parse(req.body ?? "{}") as { raw?: string; threadId?: string };
      assert.ok(typeof body.raw === "string");
      const decoded = Buffer.from(body.raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
      assert.match(decoded, new RegExp(`Message-ID: ${gmailMessageIdFor("op-mail-1").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      assert.match(decoded, /To: guest@example\.test/);
      assert.ok(!decoded.includes("approved-test-token"));
      return json(200, { id: "gmail-msg-1", threadId: "thread-9", labelIds: ["SENT"] });
    },
  });
  const result = await connector.sendEmail({
    operationKey: "op-mail-1",
    to: ["guest@example.test"],
    subject: "Your proposal",
    body: "Hello",
  });
  assert.equal(result.status, "succeeded");
  if (result.status !== "succeeded") return;
  // Receipt proves sent, not delivery; Gmail immutable id is the provider anchor.
  assert.equal(result.data.sentEmail.messageId, "gmail-msg-1");
  assert.equal(result.data.sentEmail.threadId, "thread-9");
  assert.equal(result.metadata.mode.mode, "live");
  assert.equal(result.metadata.simulated, false);
  assert.ok(result.data.provenance.every((ref) => ref.fictional === false && ref.kind === "email"));
  assert.ok(log.every((entry) => !JSON.stringify(entry).includes("approved-test-token") || entry.headers.Authorization !== undefined));
});

test("send passes threadId for replies and validates headers", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const { connector, log } = gmail({
    handler: (req) => {
      seen.push(JSON.parse(req.body ?? "{}") as Record<string, unknown>);
      return json(200, { id: "gmail-msg-2", threadId: "thread-1", labelIds: ["SENT"] });
    },
  });
  const result = await connector.sendEmail({
    operationKey: "op-mail-2",
    threadId: "thread-1",
    to: ["guest@example.test"],
    subject: "Re: inquiry",
    body: "Reply",
  });
  assert.equal(result.status, "succeeded");
  assert.equal(seen[0]?.threadId, "thread-1");

  // CRLF injection is rejected before any HTTP call.
  const evil = await connector.sendEmail({
    operationKey: "op-mail-3",
    to: ["guest@example.test"],
    subject: "Hi\r\nBcc: attacker@example.test",
    body: "x",
  });
  assert.equal(evil.status, "failed");
  if (evil.status !== "failed") return;
  assert.equal(evil.error.kind, "invalid_request");
  assert.equal(log.length, 1);
});

test("send maps revoked, rate limits, and ambiguous failures honestly", async () => {
  const revoked = gmail({ handler: () => googleError(401, "authError", "Invalid Credentials") });
  const denied = await revoked.connector.sendEmail({ operationKey: "op-r", to: ["a@example.test"], subject: "s", body: "b" });
  assert.equal(denied.status, "failed");
  if (denied.status !== "failed") return;
  assert.equal(denied.error.kind, "access_revoked");

  const limited = gmail({ handler: () => googleError(429, "rateLimitExceeded", "Too Many Requests") });
  const throttled = await limited.connector.sendEmail({ operationKey: "op-l", to: ["a@example.test"], subject: "s", body: "b" });
  assert.equal(throttled.status, "failed");
  if (throttled.status !== "failed") return;
  assert.equal(throttled.error.kind, "rate_limited");
  assert.equal(throttled.error.retryable, true);

  // 5xx after dispatch may follow acceptance: uncertain, never blind-retryable failure.
  const crashed = gmail({ handler: () => googleError(500, "backendError", "Backend Error") });
  const ambiguous = await crashed.connector.sendEmail({ operationKey: "op-5", to: ["a@example.test"], subject: "s", body: "b" });
  assert.equal(ambiguous.status, "uncertain");
});

test("timeout after acceptance reconciles by Message-ID without resending", async () => {
  const accepted = new Map<string, { id: string; raw: string }>();
  const { transport } = scripted((req) => {
    if (req.url.includes("messages/send")) {
      accepted.set("sent", { id: "gmail-msg-9", raw: (JSON.parse(req.body ?? "{}") as { raw: string }).raw });
      throw new TransportTimeoutError();
    }
    if (req.url.includes("messages?q=")) {
      const items = accepted.has("sent") ? [{ id: "gmail-msg-9", threadId: "thread-9" }] : [];
      return json(200, { messages: items, resultSizeEstimate: items.length });
    }
    const stored = accepted.get("sent");
    assert.ok(stored !== undefined);
    return json(200, {
      id: "gmail-msg-9",
      threadId: "thread-9",
      labelIds: ["SENT"],
      internalDate: "1780000000000",
      payload: {
        headers: [
          { name: "Message-ID", value: gmailMessageIdFor("op-mail-9") },
          { name: "Subject", value: "Your proposal" },
          { name: "To", value: "guest@example.test" },
        ],
        mimeType: "text/plain",
        body: { data: b64url("Hello") },
      },
    });
  });
  const connector = new GoogleGmailConnector({ transport, tokens: () => Promise.resolve("t") });
  const sent = await connector.sendEmail({ operationKey: "op-mail-9", to: ["guest@example.test"], subject: "Your proposal", body: "Hello" });
  assert.equal(sent.status, "uncertain");
  if (sent.status !== "uncertain") return;
  assert.equal(sent.reconciliationRequired, true);
  const reconciled = await connector.reconcileSentEmail({ operationKey: "op-mail-9" });
  assert.equal(reconciled.status, "succeeded");
  if (reconciled.status !== "succeeded") return;
  assert.equal(reconciled.data.sentEmail.messageId, "gmail-msg-9");
  assert.equal(accepted.size, 1);
});

test("empty reconcile search stays retryably pending (indexing delay)", async () => {
  const { connector } = gmail({
    handler: (req) => {
      assert.match(req.url, /rfc822msgid%3A/);
      return json(200, {});
    },
  });
  const result = await connector.reconcileSentEmail({ operationKey: "op-missing" });
  assert.equal(result.status, "failed");
  if (result.status !== "failed") return;
  assert.equal(result.error.kind, "not_found");
  assert.equal(result.error.retryable, true);
});

test("reconcile skips records with a different Message-ID and pages on", async () => {
  const { connector, log } = gmail({
    handler: (req) => {
      if (req.url.includes("messages?q=")) {
        if (req.url.includes("pageToken=second")) {
          return json(200, { messages: [{ id: "gmail-right", threadId: "t" }] });
        }
        return json(200, { messages: [{ id: "gmail-wrong", threadId: "t" }], nextPageToken: "second" });
      }
      if (req.url.includes("gmail-wrong")) {
        return json(200, {
          id: "gmail-wrong",
          threadId: "t",
          labelIds: ["SENT"],
          payload: { headers: [{ name: "Message-ID", value: "<unrelated@gather-booking.local>" }], mimeType: "text/plain", body: { data: b64url("nope") } },
        });
      }
      return json(200, {
        id: "gmail-right",
        threadId: "t",
        labelIds: ["SENT"],
        internalDate: "1780000000000",
        payload: {
          headers: [
            { name: "Message-ID", value: gmailMessageIdFor("op-mail-p") },
            { name: "Subject", value: "s" },
            { name: "To", value: "a@example.test" },
          ],
          mimeType: "text/plain",
          body: { data: b64url("yes") },
        },
      });
    },
  });
  const result = await connector.reconcileSentEmail({ operationKey: "op-mail-p" });
  assert.equal(result.status, "succeeded");
  if (result.status !== "succeeded") return;
  assert.equal(result.data.sentEmail.messageId, "gmail-right");
  assert.ok(log.some((entry) => entry.url.includes("pageToken=second")));
});

test("thread reads parse ordered messages with bodies and provenance", async () => {
  const { connector } = gmail({
    handler: () => json(200, {
      id: "thread-1",
      messages: [threadMessage("m-1", "June dinner inquiry", "Could you host 40 guests?"), threadMessage("m-2", "June dinner inquiry", "Yes, we can.")],
    }),
  });
  const result = await connector.readInquiryThread({ operationKey: "op-thread-1", threadId: "thread-1" });
  assert.equal(result.status, "succeeded");
  if (result.status !== "succeeded") return;
  assert.equal(result.data.thread.messages.length, 2);
  assert.equal(result.data.thread.messages[0]?.from, "guest@example.test");
  assert.equal(result.data.thread.messages[0]?.body, "Could you host 40 guests?");
  assert.deepEqual(result.data.thread.messages[0]?.to, ["venue@example.test"]);
  assert.ok(result.data.thread.messages.every((message) => message.threadId === "thread-1"));
  assert.ok(result.data.provenance.every((ref) => ref.kind === "email" && ref.fictional === false));
  assert.equal(result.metadata.simulated, false);

  const gone = gmail({ handler: () => googleError(404, "notFound", "Not Found") });
  const missing = await gone.connector.readInquiryThread({ operationKey: "op-t2", threadId: "nope" });
  assert.equal(missing.status, "failed");
  if (missing.status !== "failed") return;
  assert.equal(missing.error.kind, "not_found");
});

test("query escaping neutralizes quote injection", () => {
  assert.equal(escapeGmailQuery("<abc@x>"), '"<abc@x>"');
  assert.equal(escapeGmailQuery('a"b\\c'), '"a\\"b\\\\c"');
  assert.equal(gmailMessageIdFor("op-x"), gmailMessageIdFor("op-x"));
  assert.match(gmailMessageIdFor("op-x"), /^<[0-9a-f]{64}@gather-booking\.local>$/);
});
