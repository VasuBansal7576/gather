/**
 * Focused business-wide conflict regressions (fictional fixtures only).
 *
 * Account lineage stays distinct, but same applicable fact keys across
 * accounts are detected business-wide: pending conflicts surface in
 * conflictsWith, confirmed conflicts withhold consequential terms from
 * offer preparation until an owner resolution pins an exact winning
 * revision, and agreement dedupes presentation without erasing provenance.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GatherStore } from "../src/server/sqlite-store.ts";
import { KnowledgeService } from "../src/knowledge/index.ts";
import { adaptBusinessFacts } from "../src/offers/adapters.ts";

const OWNER = { kind: "owner" as const, id: "fictional-owner-1" };
const NON_OWNER = { kind: "agent" as const, id: "fictional-agent-1" };
const DOC = { kind: "manual" as const, locator: "fixture://fictional/menus/dinner", label: "Fictional menu" };
const EMAIL = { kind: "manual" as const, locator: "fixture://fictional/email/thread-7", label: "Fictional email" };

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "gather-conflicts-"));
  const dbPath = join(directory, "gather.sqlite");
  const store = new GatherStore(dbPath);
  const business = store.createBusiness({ name: "Fictional Cedar Hall", timezone: "America/New_York" });
  return {
    directory,
    dbPath,
    store,
    service: new KnowledgeService(store),
    businessId: business.id,
    cleanup: () => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function confirmPrice(service: KnowledgeService, businessId: string, accountId: string, unitCents: number, locator: string) {
  const candidate = service.intakeCandidate({
    businessId,
    key: "price_line",
    subjectId: "plated-dinner",
    accountId,
    value: { unitCents },
    confidence: "probable",
    sourceReferences: [{ ...DOC, locator }],
  });
  return service.confirmCandidate({ businessId, actor: OWNER, candidateId: candidate.id });
}

test("competing prices across accounts are withheld from offer preparation", () => {
  const fx = fixture();
  try {
    confirmPrice(fx.service, fx.businessId, "acct-A", 9500, "fixture://fictional/menus/a");
    confirmPrice(fx.service, fx.businessId, "acct-B", 12500, "fixture://fictional/menus/b");

    const conflicts = fx.service.listConflicts(fx.businessId);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0]!.status, "conflicted");
    assert.deepEqual(conflicts[0]!.revisions.map((r) => r.accountId).sort(), ["acct-A", "acct-B"]);

    const snapshot = fx.service.snapshotForOffers(fx.businessId);
    // Both competing values blocked: neither reaches offer preparation.
    assert.equal(snapshot.facts.filter((f) => f.key === "price_line").length, 0);
    assert.equal(snapshot.withheld.filter((w) => w.key === "price_line").length, 2);
    assert.ok(snapshot.withheld.every((w) => /owner resolution required/.test(w.reason)));
    // Offer preparation proceeds without the conflicted terms (no invented price).
    const adapted = adaptBusinessFacts(snapshot.facts, { businessId: fx.businessId });
    assert.equal(adapted.knowledge.priceBook.lines.length, 0);
    // Provenance survives: both account lines stay readable.
    const facts = fx.service.listFacts(fx.businessId).filter((f) => f.key === "price_line");
    assert.equal(facts.length, 2);
  } finally {
    fx.cleanup();
  }
});

test("pending conflicts cross account lines in conflictsWith", () => {
  const fx = fixture();
  try {
    const a = fx.service.intakeCandidate({
      businessId: fx.businessId, key: "policy", subjectId: "pets", accountId: "acct-A",
      value: { allowed: true }, confidence: "probable", sourceReferences: [DOC],
    });
    const b = fx.service.intakeCandidate({
      businessId: fx.businessId, key: "policy", subjectId: "pets", accountId: "acct-B",
      value: { allowed: false }, confidence: "probable", sourceReferences: [EMAIL],
    });
    const pending = fx.service.listCandidates(fx.businessId, { status: "pending" });
    assert.deepEqual(pending.find((c) => c.id === a.id)!.conflictsWith, [b.id]);
    assert.deepEqual(pending.find((c) => c.id === b.id)!.conflictsWith, [a.id]);
  } finally {
    fx.cleanup();
  }
});

test("owner resolution pins an exact winner; revision updates reopen the conflict", () => {
  const fx = fixture();
  try {
    const won = confirmPrice(fx.service, fx.businessId, "acct-A", 9500, "fixture://fictional/menus/a");
    const lost = confirmPrice(fx.service, fx.businessId, "acct-B", 12500, "fixture://fictional/menus/b");
    const viewed = [won.revision.id, lost.revision.id];

    const resolved = fx.service.resolveConflict({
      businessId: fx.businessId,
      actor: OWNER,
      key: "price_line",
      subjectId: "plated-dinner",
      winningRevisionId: won.revision.id,
      consideredRevisionIds: viewed,
      commandId: "resolve-1",
    });
    assert.equal(resolved.winningRevisionId, won.revision.id);
    assert.equal(resolved.consideredRevisionIds.length, 2);
    assert.equal(resolved.duplicate, false);

    assert.deepEqual(fx.service.listConflicts(fx.businessId).map((c) => c.status), ["resolved"]);
    const snapshot = fx.service.snapshotForOffers(fx.businessId);
    const lines = snapshot.facts.filter((f) => f.key === "price_line");
    assert.equal(lines.length, 1);
    assert.deepEqual(lines[0]!.value, { unitCents: 9500 });
    assert.ok(snapshot.withheld.some((w) => /resolved in favor of/.test(w.reason)));

    // Same commandId replays the recorded outcome instead of duplicating.
    const replay = fx.service.resolveConflict({
      businessId: fx.businessId,
      actor: OWNER,
      key: "price_line",
      subjectId: "plated-dinner",
      winningRevisionId: won.revision.id,
      consideredRevisionIds: viewed,
      commandId: "resolve-1",
    });
    assert.equal(replay.duplicate, true);
    assert.equal(replay.winningRevisionId, won.revision.id);

    // A correction on the losing line mints a new revision id: the exact
    // revision set changes, so the conflict reopens automatically.
    fx.service.correctFact({
      businessId: fx.businessId, actor: OWNER, key: "price_line", subjectId: "plated-dinner",
      accountId: "acct-B", expectedRevision: 1, value: { unitCents: 11000 },
    });
    assert.deepEqual(fx.service.listConflicts(fx.businessId).map((c) => c.status), ["conflicted"]);
    assert.equal(fx.service.snapshotForOffers(fx.businessId).facts.filter((f) => f.key === "price_line").length, 0);
  } finally {
    fx.cleanup();
  }
});

test("resolution rejects non-owners, unknown revisions, and altered replays", () => {
  const fx = fixture();
  try {
    const won = confirmPrice(fx.service, fx.businessId, "acct-A", 9500, "fixture://fictional/menus/a");
    const lost = confirmPrice(fx.service, fx.businessId, "acct-B", 12500, "fixture://fictional/menus/b");
    const viewed = [won.revision.id, lost.revision.id];

    assert.throws(
      () => fx.service.resolveConflict({
        businessId: fx.businessId, actor: NON_OWNER, key: "price_line",
        subjectId: "plated-dinner", winningRevisionId: won.revision.id,
        consideredRevisionIds: viewed,
      }),
      (error: unknown) => (error as { code?: string }).code === "denied",
    );
    assert.throws(
      () => fx.service.resolveConflict({
        businessId: fx.businessId, actor: OWNER, key: "price_line",
        subjectId: "plated-dinner", winningRevisionId: "kr_missing",
        consideredRevisionIds: [...viewed, "kr_missing"],
      }),
      (error: unknown) => (error as { code?: string }).code === "not_found",
    );
    // A failed resolution records its typed rejection but stores no
    // resolution row: the conflict stays open and auditable.
    assert.deepEqual(fx.service.listConflicts(fx.businessId).map((c) => c.status), ["conflicted"]);

    fx.service.resolveConflict({
      businessId: fx.businessId, actor: OWNER, key: "price_line",
      subjectId: "plated-dinner", winningRevisionId: won.revision.id,
      consideredRevisionIds: viewed, commandId: "resolve-x",
    });
    assert.throws(
      () => fx.service.resolveConflict({
        businessId: fx.businessId, actor: OWNER, key: "price_line",
        subjectId: "other-subject", winningRevisionId: won.revision.id,
        consideredRevisionIds: viewed, commandId: "resolve-x",
      }),
      (error: unknown) => (error as { code?: string }).code === "command_conflict",
    );
  } finally {
    fx.cleanup();
  }
});

test("identical values across accounts dedupe presentation but keep provenance", () => {
  const fx = fixture();
  try {
    confirmPrice(fx.service, fx.businessId, "acct-A", 9500, "fixture://fictional/menus/a");
    confirmPrice(fx.service, fx.businessId, "acct-B", 9500, "fixture://fictional/menus/b");
    assert.deepEqual(fx.service.listConflicts(fx.businessId), []);
    const snapshot = fx.service.snapshotForOffers(fx.businessId);
    const lines = snapshot.facts.filter((f) => f.key === "price_line");
    assert.equal(lines.length, 1);
    assert.equal(snapshot.agreements.length, 1);
    // Provenance unerased: both account lines remain confirmed and readable.
    const facts = fx.service.listFacts(fx.businessId).filter((f) => f.key === "price_line");
    assert.deepEqual(facts.map((f) => f.accountId).sort(), ["acct-A", "acct-B"]);
  } finally {
    fx.cleanup();
  }
});

test("stale-source revisions neither trigger conflicts nor reach offers", () => {
  const fx = fixture();
  try {
    const candidate = fx.service.intakeCandidate({
      businessId: fx.businessId, key: "policy", subjectId: "pets", accountId: "acct-A",
      value: { allowed: true }, confidence: "probable",
      sourceReferences: [{ ...DOC, locator: "fixture://fictional/policy/v1" }],
    });
    fx.service.confirmCandidate({ businessId: fx.businessId, actor: OWNER, candidateId: candidate.id });
    // Changed source from the same account flags the revision for review.
    fx.service.intakeCandidate({
      businessId: fx.businessId, key: "policy", subjectId: "pets", accountId: "acct-A",
      value: { allowed: false }, confidence: "probable",
      sourceReferences: [{ ...DOC, locator: "fixture://fictional/policy/v1" }],
    });
    const snapshot = fx.service.snapshotForOffers(fx.businessId);
    assert.ok(snapshot.reviewFactIds.length >= 1);
    assert.deepEqual(fx.service.listConflicts(fx.businessId), []);
  } finally {
    fx.cleanup();
  }
});

test("stale view rejects when a new rival arrives before submit", () => {
  const fx = fixture();
  try {
    const won = confirmPrice(fx.service, fx.businessId, "acct-A", 9500, "fixture://fictional/menus/a");
    const seen = confirmPrice(fx.service, fx.businessId, "acct-B", 12500, "fixture://fictional/menus/b");
    const viewed = [won.revision.id, seen.revision.id];

    // Owner reviewed A/B; rival C from a third account arrives before submit.
    confirmPrice(fx.service, fx.businessId, "acct-C", 14000, "fixture://fictional/menus/c");
    assert.throws(
      () => fx.service.resolveConflict({
        businessId: fx.businessId, actor: OWNER, key: "price_line",
        subjectId: "plated-dinner", winningRevisionId: won.revision.id,
        consideredRevisionIds: viewed, commandId: "resolve-stale-new",
      }),
      (error: unknown) => (error as { code?: string }).code === "stale",
    );
    // No resolution row governs anything: the unseen rival is not resolved.
    assert.deepEqual(fx.service.listConflicts(fx.businessId).map((c) => c.status), ["conflicted"]);
    assert.equal(fx.service.snapshotForOffers(fx.businessId).facts.filter((f) => f.key === "price_line").length, 0);

    // Re-reviewing the true current set and resubmitting under a fresh
    // command succeeds and governs exactly the three revisions.
    const current = fx.service.listConflicts(fx.businessId)[0]!.revisions.map((r) => r.revisionId);
    assert.equal(current.length, 3);
    const resolved = fx.service.resolveConflict({
      businessId: fx.businessId, actor: OWNER, key: "price_line",
      subjectId: "plated-dinner", winningRevisionId: won.revision.id,
      consideredRevisionIds: current, commandId: "resolve-stale-new-retry",
    });
    assert.equal(resolved.duplicate, false);
    assert.deepEqual([...resolved.consideredRevisionIds].sort(), [...current].sort());
    assert.deepEqual(fx.service.listConflicts(fx.businessId).map((c) => c.status), ["resolved"]);
  } finally {
    fx.cleanup();
  }
});

test("stale view rejects when a rival is corrected before submit while winner unchanged", () => {
  const fx = fixture();
  try {
    const won = confirmPrice(fx.service, fx.businessId, "acct-A", 9500, "fixture://fictional/menus/a");
    confirmPrice(fx.service, fx.businessId, "acct-B", 12500, "fixture://fictional/menus/b");
    const viewed = fx.service.listConflicts(fx.businessId)[0]!.revisions.map((r) => r.revisionId);

    // Losing line B is corrected (new revision id); winner A untouched.
    fx.service.correctFact({
      businessId: fx.businessId, actor: OWNER, key: "price_line", subjectId: "plated-dinner",
      accountId: "acct-B", expectedRevision: 1, value: { unitCents: 11000 },
    });
    assert.throws(
      () => fx.service.resolveConflict({
        businessId: fx.businessId, actor: OWNER, key: "price_line",
        subjectId: "plated-dinner", winningRevisionId: won.revision.id,
        consideredRevisionIds: viewed, commandId: "resolve-stale-corrected",
      }),
      (error: unknown) => (error as { code?: string }).code === "stale",
    );
    assert.deepEqual(fx.service.listConflicts(fx.businessId).map((c) => c.status), ["conflicted"]);
  } finally {
    fx.cleanup();
  }
});

test("stale view rejects when a rival source goes stale before submit", () => {
  const fx = fixture();
  try {
    const won = confirmPrice(fx.service, fx.businessId, "acct-A", 9500, "fixture://fictional/menus/a");
    confirmPrice(fx.service, fx.businessId, "acct-B", 12500, "fixture://fictional/menus/b");
    const viewed = fx.service.listConflicts(fx.businessId)[0]!.revisions.map((r) => r.revisionId);

    // B's source changes (same locator, different value): B's revision is
    // flagged for review before the owner submits.
    fx.service.intakeCandidate({
      businessId: fx.businessId, key: "price_line", subjectId: "plated-dinner", accountId: "acct-B",
      value: { unitCents: 13000 }, confidence: "probable",
      sourceReferences: [{ ...DOC, locator: "fixture://fictional/menus/b" }],
    });
    assert.throws(
      () => fx.service.resolveConflict({
        businessId: fx.businessId, actor: OWNER, key: "price_line",
        subjectId: "plated-dinner", winningRevisionId: won.revision.id,
        consideredRevisionIds: viewed, commandId: "resolve-stale-source",
      }),
      (error: unknown) => (error as { code?: string }).code === "stale",
    );
    assert.deepEqual(fx.service.listConflicts(fx.businessId), []);
    // B is withheld through the review path instead: nothing conflicted,
    // nothing silently resolved, and only A's uncontested value reaches offers.
    const snapshot = fx.service.snapshotForOffers(fx.businessId);
    assert.ok(snapshot.reviewFactIds.length >= 1);
    const lines = snapshot.facts.filter((f) => f.key === "price_line");
    assert.equal(lines.length, 1);
    assert.deepEqual(lines[0]!.value, { unitCents: 9500 });
  } finally {
    fx.cleanup();
  }
});

test("racing correction through a second handle rejects the first handle's stale submit", () => {
  const fx = fixture();
  try {
    const won = confirmPrice(fx.service, fx.businessId, "acct-A", 9500, "fixture://fictional/menus/a");
    confirmPrice(fx.service, fx.businessId, "acct-B", 12500, "fixture://fictional/menus/b");
    const viewed = fx.service.listConflicts(fx.businessId)[0]!.revisions.map((r) => r.revisionId);

    // A concurrent owner session on the same database corrects the rival
    // between the first session's review and submit.
    const second = new KnowledgeService(fx.store);
    second.correctFact({
      businessId: fx.businessId, actor: OWNER, key: "price_line", subjectId: "plated-dinner",
      accountId: "acct-B", expectedRevision: 1, value: { unitCents: 11000 },
    });
    assert.throws(
      () => fx.service.resolveConflict({
        businessId: fx.businessId, actor: OWNER, key: "price_line",
        subjectId: "plated-dinner", winningRevisionId: won.revision.id,
        consideredRevisionIds: viewed, commandId: "resolve-raced",
      }),
      (error: unknown) => (error as { code?: string }).code === "stale",
    );
    assert.deepEqual(fx.service.listConflicts(fx.businessId).map((c) => c.status), ["conflicted"]);
  } finally {
    fx.cleanup();
  }
});

test("resolution validates the commanded set and rejects altered replays", () => {
  const fx = fixture();
  try {
    const won = confirmPrice(fx.service, fx.businessId, "acct-A", 9500, "fixture://fictional/menus/a");
    const lost = confirmPrice(fx.service, fx.businessId, "acct-B", 12500, "fixture://fictional/menus/b");
    const viewed = [won.revision.id, lost.revision.id];
    const base = {
      businessId: fx.businessId, actor: OWNER, key: "price_line",
      subjectId: "plated-dinner", winningRevisionId: won.revision.id,
    } as const;

    for (const bad of [[], [won.revision.id, won.revision.id], ["  "], "not-an-array"]) {
      assert.throws(
        // @ts-expect-error intentionally malformed commanded set
        () => fx.service.resolveConflict({ ...base, consideredRevisionIds: bad }),
        (error: unknown) => (error as { code?: string }).code === "invalid",
      );
    }
    assert.throws(
      () => fx.service.resolveConflict({ ...base, consideredRevisionIds: [lost.revision.id] }),
      (error: unknown) => (error as { code?: string }).code === "invalid",
    );

    fx.service.resolveConflict({ ...base, consideredRevisionIds: viewed, commandId: "resolve-altered" });
    // Same commandId with a different commanded set is an altered replay:
    // command_conflict, never a duplicate of the unrelated recorded outcome.
    assert.throws(
      () => fx.service.resolveConflict({ ...base, consideredRevisionIds: [won.revision.id], commandId: "resolve-altered" }),
      (error: unknown) => (error as { code?: string }).code === "command_conflict",
    );
    assert.deepEqual(fx.service.listConflicts(fx.businessId).map((c) => c.status), ["resolved"]);
  } finally {
    fx.cleanup();
  }
});
test("conflicts and resolutions persist across restart; rollback stays atomic", () => {
  const fx = fixture();
  try {
    const won = confirmPrice(fx.service, fx.businessId, "acct-A", 9500, "fixture://fictional/menus/a");
    const lost = confirmPrice(fx.service, fx.businessId, "acct-B", 12500, "fixture://fictional/menus/b");
    fx.service.resolveConflict({
      businessId: fx.businessId, actor: OWNER, key: "price_line",
      subjectId: "plated-dinner", winningRevisionId: won.revision.id,
      consideredRevisionIds: [won.revision.id, lost.revision.id], commandId: "resolve-restart",
    });
    fx.store.close();
    // Reopen on the same database file: lineage, conflict, and resolution survive.
    const reopened = new GatherStore(fx.dbPath);
    try {
      const second = new KnowledgeService(reopened);
      assert.deepEqual(second.listConflicts(fx.businessId).map((c) => c.status), ["resolved"]);
      const lines = second.snapshotForOffers(fx.businessId).facts.filter((f) => f.key === "price_line");
      assert.equal(lines.length, 1);
      assert.deepEqual(lines[0]!.value, { unitCents: 9500 });
    } finally {
      reopened.close();
    }
  } finally {
    // store already closed; remove the directory directly.
    rmSync(fx.directory, { recursive: true, force: true });
  }
});
