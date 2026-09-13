import assert from "node:assert/strict";
import test from "node:test";
import {
  createConflictApi,
  formatConflictValue,
  parseConflict,
  parseConflictsResponse,
  parseResolution,
} from "../src/knowledge-owner/conflicts.ts";
import { KnowledgeApiError } from "../src/knowledge-owner/api.ts";

// All fixtures are fictional; nothing here is a real connected source.

const REVISION_A = {
  revisionId: "rev-aaa",
  factId: "fact-1",
  accountId: "acct-A",
  revision: 1,
  value: { unitCents: 9500 },
  reviewState: "none",
  approvedBy: "fictional-owner-1",
  approvedAt: "2026-09-01T10:00:00.000Z",
};

const REVISION_B = {
  ...REVISION_A,
  revisionId: "rev-bbb",
  factId: "fact-2",
  accountId: "acct-B",
  value: { unitCents: 12500 },
};

const CONFLICT = {
  key: "price_line",
  subjectId: "plated-dinner",
  scope: "global",
  revisions: [REVISION_A, REVISION_B],
  status: "conflicted",
};

test("conflict shapes parse; malformed rows rejected", () => {
  const parsed = parseConflict(CONFLICT);
  assert.equal(parsed?.revisions.length, 2);
  assert.equal(parseConflict({ ...CONFLICT, status: "agreed" }), undefined);
  assert.equal(parseConflict({ ...CONFLICT, revisions: [{ ...REVISION_A, accountId: "" }] }), undefined);
  assert.deepEqual(parseConflictsResponse({ conflicts: [CONFLICT] })?.length, 1);
  assert.equal(parseConflictsResponse({ conflicts: "many" }), undefined);
  const resolution = parseResolution({
    resolution: { winningRevisionId: "rev-aaa", consideredRevisionIds: ["rev-aaa", "rev-bbb"], duplicate: false },
  });
  assert.deepEqual(resolution?.consideredRevisionIds, ["rev-aaa", "rev-bbb"]);
  assert.equal(parseResolution({ winningRevisionId: "rev-aaa", consideredRevisionIds: [] }), undefined);
});

test("conflict values never invent currency or profit", () => {
  assert.equal(formatConflictValue({ amountCents: 120000, currency: "USD" }), "$1,200.00");
  const unlabeled = formatConflictValue({ amountCents: 120000 });
  assert.ok(unlabeled.includes("currency not stated"), "missing currency is honest");
  assert.ok(!/[£$₹]/.test(unlabeled), "no currency symbol without source currency");
  assert.ok(!/profit/i.test(formatConflictValue({ unitCents: 9500 })));
  assert.equal(formatConflictValue({ unitCents: 9500 }), "unitCents: 9500");
});

function fixtureFetch(handler: (input: string, init?: RequestInit) => unknown) {
  return (async (input: string, init?: RequestInit) => {
    const result = handler(input, init);
    if (result instanceof Error) throw result;
    const { status, body } = result as { status: number; body: unknown };
    return new Response(JSON.stringify(body), { status });
  });
}

test("resolve posts the exact reviewed set with no actor, and maps 409 stale", async () => {
  const seen: string[] = [];
  const api = createConflictApi(fixtureFetch((input, init) => {
    if (input === "/api/knowledge/conflicts" && init?.method === "POST") {
      seen.push(String(init.body));
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      if (body.winningRevisionId === "rev-stale") {
        return { status: 409, body: { code: "STALE_PROPOSAL", message: "set changed; re-review", retryable: false } };
      }
      return { status: 200, body: { resolution: { winningRevisionId: "rev-aaa", consideredRevisionIds: ["rev-aaa", "rev-bbb"], duplicate: false } } };
    }
    return { status: 404, body: {} };
  }));
  const resolution = await api.resolveConflict({
    businessId: "biz-1",
    key: "price_line",
    subjectId: "plated-dinner",
    winningRevisionId: "rev-aaa",
    consideredRevisionIds: ["rev-aaa", "rev-bbb"],
    commandId: "cmd-1",
  });
  assert.equal(resolution.winningRevisionId, "rev-aaa");
  const sent = JSON.parse(seen[0] ?? "{}") as Record<string, unknown>;
  assert.deepEqual(sent.consideredRevisionIds, ["rev-aaa", "rev-bbb"]);
  assert.equal(sent.actor, undefined, "no actor ever leaves the UI");
  const stale = await api.resolveConflict({
    businessId: "biz-1", key: "price_line", winningRevisionId: "rev-stale",
    consideredRevisionIds: ["rev-stale"], commandId: "cmd-2",
  }).then(() => assert.fail("expected throw"), (error: unknown) => error);
  assert.ok(stale instanceof KnowledgeApiError);
  assert.equal((stale as KnowledgeApiError).httpStatus, 409);
  assert.equal((stale as KnowledgeApiError).apiError.code, "STALE_PROPOSAL");
});
