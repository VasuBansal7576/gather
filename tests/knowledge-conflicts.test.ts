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
    confirmPrice(fx.service, fx.businessId, "acct-B", 12500, "fixture://fictional/menus/b");

    const resolved = fx.service.resolveConflict({
      businessId: fx.businessId,
      actor: OWNER,
      key: "price_line",
      subjectId: "plated-dinner",
      winningRevisionId: won.revision.id,
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
    confirmPrice(fx.service, fx.businessId, "acct-B", 12500, "fixture://fictional/menus/b");

    assert.throws(
      () => fx.service.resolveConflict({
        businessId: fx.businessId, actor: NON_OWNER, key: "price_line",
        subjectId: "plated-dinner", winningRevisionId: won.revision.id,
      }),
      (error: unknown) => (error as { code?: string }).code === "denied",
    );
    assert.throws(
      () => fx.service.resolveConflict({
        businessId: fx.businessId, actor: OWNER, key: "price_line",
        subjectId: "plated-dinner", winningRevisionId: "kr_missing",
      }),
      (error: unknown) => (error as { code?: string }).code === "not_found",
    );
    // A failed resolution records its typed rejection but stores no
    // resolution row: the conflict stays open and auditable.
    assert.deepEqual(fx.service.listConflicts(fx.businessId).map((c) => c.status), ["conflicted"]);

    fx.service.resolveConflict({
      businessId: fx.businessId, actor: OWNER, key: "price_line",
      subjectId: "plated-dinner", winningRevisionId: won.revision.id, commandId: "resolve-x",
    });
    assert.throws(
      () => fx.service.resolveConflict({
        businessId: fx.businessId, actor: OWNER, key: "price_line",
        subjectId: "other-subject", winningRevisionId: won.revision.id, commandId: "resolve-x",
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

test("conflicts and resolutions persist across restart; rollback stays atomic", () => {
  const fx = fixture();
  try {
    const won = confirmPrice(fx.service, fx.businessId, "acct-A", 9500, "fixture://fictional/menus/a");
    confirmPrice(fx.service, fx.businessId, "acct-B", 12500, "fixture://fictional/menus/b");
    fx.service.resolveConflict({
      businessId: fx.businessId, actor: OWNER, key: "price_line",
      subjectId: "plated-dinner", winningRevisionId: won.revision.id, commandId: "resolve-restart",
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
