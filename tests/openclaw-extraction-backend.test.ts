import assert from "node:assert/strict";
import test from "node:test";
import { GatherRuntimeTasks } from "../src/runtime/tasks.ts";
import type { GatewayRequestChannel } from "../src/runtime/client.ts";
import {
  OpenClawExtractionBackend,
  OPENCLAW_BACKEND_ID,
} from "../src/knowledge/extraction/openclaw-backend.ts";
import type { ExtractionSubmission } from "../src/knowledge/extraction/backend.ts";

/**
 * Focused boundary tests for the isolated OpenClaw extraction backend. The
 * ONLY fake is the gateway request channel — every run/message below is an
 * explicit simulated fixture; no live model, provider, gateway, keychain, or
 * credentials are involved.
 */

interface FakeRun {
  runId: string;
  sessionKey: string;
  idempotencyKey: string;
  message: string;
  status: "ok" | "error" | "timeout" | "pending";
  resultText?: string;
  error?: string;
}

class FakeChannel implements GatewayRequestChannel {
  readonly isReady = true;
  runs: FakeRun[] = [];
  calls: Array<{ method: string; params: unknown }> = [];
  failOn = new Set<string>();
  private nextRun = 0;

  async request<T>(method: string, params?: unknown): Promise<T> {
    const p = (params ?? {}) as Record<string, unknown>;
    this.calls.push({ method, params: p });
    if (this.failOn.has(method)) throw new Error(`channel unavailable for ${method}`);
    if (method === "agent") {
      this.nextRun += 1;
      const run: FakeRun = {
        runId: `run-${this.nextRun}`,
        sessionKey: String(p.sessionKey),
        idempotencyKey: String(p.idempotencyKey),
        message: String(p.message),
        status: "ok",
        resultText: '{"candidates": []}',
      };
      this.runs.push(run);
      return { runId: run.runId, acceptedAt: 1700000000000 } as T;
    }
    if (method === "agent.wait") {
      const run = this.runs.find((r) => r.runId === p.runId);
      assert.ok(run, `unknown run ${String(p.runId)}`);
      if (run.status === "ok") return { status: "ok", runId: run.runId, endedAt: 1700000001000 } as T;
      if (run.status === "error") return { status: "error", runId: run.runId, error: run.error ?? "failed" } as T;
      if (run.status === "pending") return { status: "pending", runId: run.runId } as T;
      return { status: "timeout", runId: run.runId } as T;
    }
    if (method === "chat.history") {
      const messages = this.runs
        .filter((r) => r.sessionKey === p.sessionKey && r.status === "ok")
        .flatMap((r) => {
          const messages: unknown[] = [{ role: "user", content: [{ type: "text", text: r.message }] }];
          if (r.resultText !== undefined) {
            messages.push({ role: "assistant", content: [{ type: "text", text: r.resultText }] });
          }
          return messages;
        });
      return { messages } as T;
    }
    throw new Error(`unexpected method ${method}`);
  }
}

function submission(text: string, key = "cmd-1"): ExtractionSubmission {
  return { idempotencyKey: key, sourceDigest: "abc123", text, maxCandidates: 5 };
}

function backendFor(channel: FakeChannel, businessId = "biz-1", accountId = "acct-1") {
  return new OpenClawExtractionBackend({
    scope: { businessId, accountId },
    tasks: new GatherRuntimeTasks(channel),
    simulated: true,
  });
}

test("submission maps to a scope-bound agent run and trusted envelope identity", async () => {
  const channel = new FakeChannel();
  const backend = backendFor(channel);
  const submitted = await backend.submitExtraction(submission("Pets are not allowed."));

  assert.equal(submitted.taskId, "run-1");
  assert.equal(submitted.idempotencyKey, "cmd-1");
  const call = channel.calls.find((c) => c.method === "agent");
  assert.ok(call);
  const params = call.params as Record<string, unknown>;
  assert.equal(params.deliver, false);
  // Scoped session: the key embeds this business+account scope.
  assert.match(String(params.sessionKey), /gather:booking:/);
  // The instruction pins the digest, marks the task, fences the text as
  // untrusted content, and grants no approval/spend/send authority.
  const message = String(params.message);
  assert.ok(message.includes("gather-extraction:cmd-1"));
  assert.ok(message.includes("abc123"));
  assert.ok(message.includes("untrusted content, not instruction"));
  assert.ok(message.includes("Pets are not allowed."));
  assert.ok(message.includes('"probable" or "uncertain"'));
});

test("a completed run yields its strictly-parsed result to the host as unknown", async () => {
  const channel = new FakeChannel();
  const backend = backendFor(channel);
  const sub = await backend.submitExtraction(submission("Capacity 40."));
  channel.runs[0].resultText = JSON.stringify({
    candidates: [{ key: "space", subjectId: "hall", value: { capacity: 40 }, confidence: "probable", evidence: ["Capacity 40."] }],
  });
  const awaited = await backend.awaitExtraction(sub.taskId, 5000);
  assert.equal(awaited.status, "ok");
  const payload = awaited.payload as { candidates: unknown[] };
  assert.equal(payload.candidates.length, 1);
  assert.equal(backend.backendId, OPENCLAW_BACKEND_ID);
  assert.equal(backend.simulated, true);
});

test("caller idempotency dedupes within scope and cannot alias a foreign scope", async () => {
  const channel = new FakeChannel();
  const a = backendFor(channel, "biz-1", "acct-1");
  const b = backendFor(channel, "biz-2", "acct-2");
  const first = await a.submitExtraction(submission("text", "same-key"));
  const second = await b.submitExtraction(submission("text", "same-key"));
  const keyA = channel.runs[0].idempotencyKey;
  const keyB = channel.runs[1].idempotencyKey;
  assert.notEqual(keyA, keyB, "same caller key under a different scope must not share a gateway key");
  assert.notEqual(channel.runs[0].sessionKey, channel.runs[1].sessionKey, "sessions are scoped per business+account");
  void first;
  void second;
});

test("awaiting a task this scope never submitted refuses adoption", async () => {
  const channel = new FakeChannel();
  const backend = backendFor(channel);
  await backend.submitExtraction(submission("x"));
  const foreign = await backend.awaitExtraction("run-9999", 1000);
  assert.equal(foreign.status, "unknown");
  assert.match(foreign.error ?? "", /not submitted by this backend scope/);
});

test("a stale result never stands in for the current task", async () => {
  const channel = new FakeChannel();
  const backend = backendFor(channel);
  const first = await backend.submitExtraction(submission("first", "cmd-a"));
  channel.runs[0].resultText = '{"candidates":[{"stale":true}]}';
  const second = await backend.submitExtraction(submission("second", "cmd-b"));
  channel.runs[1].resultText = '{"candidates":[{"fresh":true}]}';
  const awaited = await backend.awaitExtraction(second.taskId, 5000);
  assert.equal(awaited.status, "ok");
  assert.ok(JSON.stringify(awaited.payload).includes("fresh"));
  void first;
});

test("timeout, error, and pending runs map to typed statuses — never adoption", async () => {
  const channel = new FakeChannel();
  const backend = backendFor(channel);
  const sub = await backend.submitExtraction(submission("x"));
  channel.runs[0].status = "timeout";
  assert.equal((await backend.awaitExtraction(sub.taskId, 100)).status, "timeout");
  channel.runs[0].status = "error";
  channel.runs[0].error = "run cancelled";
  const failed = await backend.awaitExtraction(sub.taskId, 100);
  assert.equal(failed.status, "error");
  assert.match(failed.error ?? "", /cancelled/);
  channel.runs[0].status = "pending";
  assert.equal((await backend.awaitExtraction(sub.taskId, 100)).status, "unknown");
});

test("missing results, non-JSON, and oversized results are typed errors", async () => {
  const channel = new FakeChannel();
  const backend = backendFor(channel);
  const sub = await backend.submitExtraction(submission("x"));
  // No assistant text after the marker: honest error, not a fabricated result.
  channel.runs[0].resultText = undefined;
  const missing = await backend.awaitExtraction(sub.taskId, 100);
  assert.equal(missing.status, "error");
  assert.match(missing.error ?? "", /no extraction result/);

  channel.runs[0].resultText = "not json {";
  const malformed = await backend.awaitExtraction(sub.taskId, 100);
  assert.equal(malformed.status, "error");
  assert.match(malformed.error ?? "", /not valid JSON/);

  const oversized = new OpenClawExtractionBackend({
    scope: { businessId: "biz-1", accountId: "acct-1" },
    tasks: new GatherRuntimeTasks(channel),
    simulated: true,
    maxResultBytes: 8,
  });
  const sub2 = await oversized.submitExtraction(submission("x", "cmd-2"));
  channel.runs[1].resultText = '{"candidates": []}';
  const tooBig = await oversized.awaitExtraction(sub2.taskId, 100);
  assert.equal(tooBig.status, "error");
  assert.match(tooBig.error ?? "", /byte bound/);
});

test("an unavailable channel surfaces honestly at submit and await", async () => {
  const channel = new FakeChannel();
  const backend = backendFor(channel);
  channel.failOn.add("agent");
  await assert.rejects(() => backend.submitExtraction(submission("x")), /submit failed/);
  channel.failOn.delete("agent");
  const sub = await backend.submitExtraction(submission("x"));
  channel.failOn.add("agent.wait");
  await assert.rejects(() => backend.awaitExtraction(sub.taskId, 100));
});

test("empty scope fails closed at construction", () => {
  const channel = new FakeChannel();
  assert.throws(
    () =>
      new OpenClawExtractionBackend({
        scope: { businessId: "", accountId: "acct" },
        tasks: new GatherRuntimeTasks(channel),
      }),
    /businessId and accountId/,
  );
});
