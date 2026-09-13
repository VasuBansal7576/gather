import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSourceKey,
  decodeSourceKey,
  type IdentityComponents,
} from "../src/identity/source-key.ts";

function comps(overrides: Partial<IdentityComponents> = {}): IdentityComponents {
  return {
    provider: "gmail",
    accountId: "acc-1",
    businessId: "biz-1",
    sourceKind: "email",
    externalId: "msg-1",
    threadId: "thread-1",
    ...overrides,
  };
}

test("delimiter strings in different positions never collide", () => {
  // A naive parts.join("|") key maps both of these to "a|b|c".
  const left = buildSourceKey(comps({ accountId: "a|b", externalId: "c" }));
  const right = buildSourceKey(comps({ accountId: "a", externalId: "b|c" }));
  assert.notEqual(left, right);
  assert.deepEqual(decodeSourceKey(left).accountId, "a|b");
  assert.deepEqual(decodeSourceKey(right).externalId, "b|c");

  const colonLeft = buildSourceKey(comps({ externalId: "x::y", threadId: "z" }));
  const colonRight = buildSourceKey(comps({ externalId: "x", threadId: ":y::z" }));
  assert.notEqual(colonLeft, colonRight);
});

test("empty, unicode, and hostile values round-trip without collision", () => {
  const emptyThread = buildSourceKey(comps({ threadId: "" }));
  const delimiterThread = buildSourceKey(comps({ threadId: "|" }));
  const missingThread = buildSourceKey(comps({ threadId: "v1." }));
  assert.notEqual(emptyThread, delimiterThread);
  assert.notEqual(emptyThread, missingThread);
  assert.equal(decodeSourceKey(emptyThread).threadId, "");

  const unicode = buildSourceKey(comps({ externalId: "més·sâge::😀|☃", threadId: "スレッド|1" }));
  assert.equal(decodeSourceKey(unicode).externalId, "més·sâge::😀|☃");

  const newline = buildSourceKey(comps({ externalId: "a\nb|c\rd" }));
  assert.equal(decodeSourceKey(newline).externalId, "a\nb|c\rd");
  assert.notEqual(newline, buildSourceKey(comps({ externalId: "a", threadId: "b|c\rd" })));
});

test("provider and source kind normalize; scope segments stay exact", () => {
  assert.equal(buildSourceKey(comps({ provider: "GMail" })), buildSourceKey(comps({ provider: "gmail" })));
  assert.equal(
    buildSourceKey(comps({ sourceKind: "Email" })),
    buildSourceKey(comps({ sourceKind: "email" })),
  );
  // Account/business/external ids are case-sensitive: distinct records stay distinct.
  assert.notEqual(buildSourceKey(comps({ accountId: "ACC-1" })), buildSourceKey(comps({ accountId: "acc-1" })));
});

test("scope changes always change the key", () => {
  const base = buildSourceKey(comps());
  for (const variant of [
    comps({ provider: "google_calendar" }),
    comps({ accountId: "acc-2" }),
    comps({ businessId: "biz-2" }),
    comps({ sourceKind: "calendar" }),
    comps({ externalId: "msg-2" }),
    comps({ threadId: "thread-2" }),
  ]) {
    assert.notEqual(buildSourceKey(variant), base, JSON.stringify(variant));
  }
});

test("malformed keys and empty components are rejected", () => {
  assert.throws(() => decodeSourceKey("not-a-key"), /Malformed/);
  assert.throws(() => decodeSourceKey("v2.abc"), /version prefix/);
  assert.throws(() => decodeSourceKey("v1.!!!not-base64!!!"), /Malformed/);
  assert.throws(() => decodeSourceKey("v1." + Buffer.from('["only"]').toString("base64url")), /six string components/);
  assert.throws(() => buildSourceKey(comps({ externalId: "" })), /must not be empty/);
  assert.throws(() => buildSourceKey(comps({ accountId: "   ", businessId: "biz-1" })), /must not be empty/);
});
