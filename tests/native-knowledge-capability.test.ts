import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { GatherStore } from "../src/server/sqlite-store.ts";
import { KnowledgeService } from "../src/knowledge/service.ts";
import { PreparedKnowledgePort } from "../src/knowledge/prepared.ts";
import { KnowledgePortError } from "../src/knowledge/port.ts";
import {
  NATIVE_KNOWLEDGE_DOCS,
  REQUIRED_NATIVE_SURFACES,
  describeNativeCapabilities,
  translateUpstreamCapabilities,
} from "../src/runtime/knowledge.ts";
import { loadRuntimeManifest } from "../src/runtime/manifest.ts";
import {
  GATHER_KNOWLEDGE_AUTHORITIES,
  KnowledgeAuthorityError,
  resolveKnowledgeAuthority,
} from "../src/runtime/config.ts";
import {
  NATIVE_GATE_CASES,
  activateLivePort,
  compareMigration,
  evaluateGate,
  exportConfirmedFacts,
  rollbackToPrepared,
} from "../src/knowledge/migration.ts";
import {
  NativeKnowledgePort,
  nativeBlockedDetail,
  verifyNativeCapability,
} from "../src/knowledge/native.ts";

// ADR-008 008-A04: capability absence produces precise blocked evidence
// and leaves live disabled. No second vendor, no destructive migration.
// All fixtures are fictional; nothing here contacts a live runtime.

const OWNER = { kind: "owner" as const, id: "fictional-owner-1" };

test("008-A04 capability mapping on the pinned manifest invents no RPCs", () => {
  const { manifest, path } = loadRuntimeManifest();
  const report = describeNativeCapabilities(manifest, path);

  // Pinned transport surface is exactly the ADR-009 recorded combination.
  assert.ok(report.pinnedMethods.includes("agent"), "pinned agent method present");
  assert.ok(report.pinnedMethods.includes("chat.history"), "pinned chat.history present");
  assert.ok(!report.pinnedMethods.some((method) => method.startsWith("wiki.")), "no wiki RPC in the pinned method table");
  assert.ok(!report.pinnedMethods.some((method) => method.startsWith("memory")), "no memory RPC in the pinned method table");

  // Every required surface is documented upstream — never invented here.
  for (const required of REQUIRED_NATIVE_SURFACES) {
    assert.ok(
      required.documentedAt === NATIVE_KNOWLEDGE_DOCS.embedding || required.documentedAt === NATIVE_KNOWLEDGE_DOCS.memoryWiki,
      `${required.surface} is traceable to a public OpenClaw document`,
    );
  }
  // Every gatewayMethod named is either pinned or a documented wiki.* method.
  const documentedRpcs = new Set(["wiki.overview", "wiki.get", "wiki.importInsights"]);
  for (const entry of report.mapping) {
    const required = REQUIRED_NATIVE_SURFACES.find((item) => item.surface === entry.surface)!;
    if (required.gatewayMethod !== undefined) {
      assert.ok(
        report.pinnedMethods.includes(required.gatewayMethod) || documentedRpcs.has(required.gatewayMethod),
        `${required.gatewayMethod} is a real (pinned or documented) method, not an invented RPC`,
      );
    }
  }

  assert.equal(report.available, false, "native capability is absent on the pinned manifest");
  assert.ok(report.missing.length > 0, "missing evidence is enumerated");
  assert.match(report.missing.join(" "), /wiki_search/, "missing evidence names the wiki search surface");
  assert.match(report.missing.join(" "), /memory_search/, "missing evidence names the recall surface");
  assert.equal(report.liveMethods, null, "no live probe ran by default");

  const translated = translateUpstreamCapabilities(manifest);
  assert.ok(translated.transport.length > 0, "supported transport schemas translate");
  assert.equal(translated.knowledge.length, 0, "no knowledge schema is claimed from the pinned table");
  assert.ok(translated.missing.length > 0);
});

test("008-A04 native port is blocked with exact missing evidence; live stays disabled", () => {
  const port = NativeKnowledgePort.fromManifest();
  assert.equal(port.verified, false);

  const health = port.health();
  assert.equal(health.available, false, "unavailable native recall is unavailable, never empty");
  assert.equal(health.kind, "native-live");
  assert.match(health.detail, /0\/\d+ required surfaces live-verified/);
  assert.match(health.detail, /pinned methods/);

  const operations: Array<[string, () => void]> = [
    ["ingestSource", () => port.ingestSource({} as never)],
    ["invalidateSource", () => port.invalidateSource("key", "deleted")],
    ["proposeCandidates", () => port.proposeCandidates({ businessId: "b", sourceLocator: "l" })],
    ["confirmCandidate", () => port.confirmCandidate({ businessId: "b", actor: OWNER, candidateId: "c" })],
    ["correctFact", () => port.correctFact({ businessId: "b", actor: OWNER, key: "k", expectedRevision: 1, value: {} })],
    ["addScopedException", () => port.addScopedException({ businessId: "b", actor: OWNER, policyId: "p", effect: "allow", scope: "customer", scopeId: "s", value: {} })],
    ["query", () => port.query({ businessId: "b" })],
    ["snapshotForOffer", () => port.snapshotForOffer({ businessId: "b" })],
  ];
  for (const [name, run] of operations) {
    assert.throws(
      run,
      (error: unknown) =>
        error instanceof KnowledgePortError &&
        error.code === "blocked_native_unavailable" &&
        /live knowledge stays disabled/.test(error.message),
      `${name} must fail closed with blocked evidence`,
    );
  }

  const detail = nativeBlockedDetail(port.capabilityReport());
  assert.match(detail, /manifest: .*gather-runtime-manifest\.json/, "evidence names the exact manifest");
  assert.match(detail, /no live method-table probe ran/, "evidence names the missing probe");
});

test("008-A04 real-runtime probe stays honestly skipped without an explicit harness", () => {
  // Default checks never discover a host installation implicitly and never
  // use live credentials. Without an explicit harness there is no probe —
  // recorded here as skipped evidence, not as a pass.
  const harness = process.env.GATHER_TEST_OPENCLAW_BIN;
  const report = verifyNativeCapability({});
  if (harness === undefined) {
    assert.equal(report.liveMethods, null);
    assert.match(
      nativeBlockedDetail(report),
      /no live method-table probe ran/,
      "SKIP (honest): no GATHER_TEST_OPENCLAW_BIN harness — live native proof requires an explicit binary, an enabled memory-wiki plugin, and an observed method table",
    );
  } else {
    // Even with a binary present, a binary is not capability proof: the
    // wiki/memory method table must still be observed before activation.
    assert.equal(report.available, false, "a harness binary alone is not native capability proof");
  }
});

test("008 selection gate: explicit authority choice, no silent second vendor", () => {
  assert.deepEqual([...GATHER_KNOWLEDGE_AUTHORITIES], ["prepared-scripted", "native-live"]);

  assert.equal(
    resolveKnowledgeAuthority("prepared-scripted", { available: false, detail: "n/a" }),
    "prepared-scripted",
    "prepared remains usable while native is blocked",
  );
  assert.throws(
    () => resolveKnowledgeAuthority("native-live", { available: false, detail: "0/11 surfaces verified" }),
    (error: unknown) =>
      error instanceof KnowledgeAuthorityError &&
      error.code === "NATIVE_NOT_VERIFIED" &&
      /live stays disabled/.test(error.message),
    "native-live without verified capability fails closed",
  );
  assert.throws(
    () => resolveKnowledgeAuthority("acme-vector-db", { available: true, detail: "third-party receipt" }),
    (error: unknown) => error instanceof KnowledgeAuthorityError && error.code === "UNKNOWN_AUTHORITY",
    "no second knowledge vendor can be selected",
  );
});

test("008 migration export/compare with atomic activation gated and rollback preserved", () => {
  const directory = mkdtempSync(join(tmpdir(), "gather-native-migration-"));
  const store = new GatherStore(join(directory, "gather.sqlite"));
  try {
    const business = store.createBusiness({ name: "Fictional Migration Hall", timezone: "America/New_York" });
    const service = new KnowledgeService(store);
    const prepared = new PreparedKnowledgePort(service, business.id);
    const native = NativeKnowledgePort.fromManifest();

    const candidate = service.intakeCandidate({
      businessId: business.id,
      key: "space",
      subjectId: "garden-room",
      value: { name: "Garden Room", capacity: 40 },
      confidence: "probable",
      sourceReferences: [{ kind: "fixture", locator: "fixture://fictional/space", fictional: true }],
    });
    prepared.confirmCandidate({ businessId: business.id, actor: OWNER, candidateId: candidate.id });

    // Export through the public service; identical import compares clean.
    const exported = exportConfirmedFacts(service, business.id);
    assert.equal(exported.businessId, business.id);
    assert.equal(exported.provenance, "prepared");
    assert.equal(exported.facts.length, 1);
    const clean = compareMigration(exported, service.listFacts(business.id));
    assert.equal(clean.clean, true);
    assert.equal(clean.matched, 1);

    // A dropped fact compares dirty — never silently adopted.
    const dirty = compareMigration(exported, []);
    assert.equal(dirty.clean, false);
    assert.equal(dirty.missingInTarget.length, 1);

    // Activation refuses while native capability is unverified — live
    // stays disabled and prepared remains the sole authority.
    const gateEvidence = Object.fromEntries(
      NATIVE_GATE_CASES.map((gateCase) => [gateCase, { passed: true, detail: "prepared gate green (labelled)", provenance: "prepared" as const }]),
    );
    assert.throws(
      () => activateLivePort({ prepared, native, gateEvidence, comparison: clean }),
      (error: unknown) => error instanceof KnowledgePortError && error.code === "blocked_native_unavailable",
      "cutover without verified capability is refused",
    );
    assert.equal(prepared.health().available, true, "prepared remains the active authority after refused cutover");

    // Gate evaluation itself fails closed on missing or failed cases.
    assert.deepEqual(evaluateGate(gateEvidence).failures, []);
    const partial = evaluateGate({});
    assert.equal(partial.passed, false);
    assert.equal(partial.failures.length, NATIVE_GATE_CASES.length);

    // Rollback returns the preserved prepared authority (pure handle test
    // with labelled prepared evidence — no live claim).
    const rolledBack = rollbackToPrepared({
      active: prepared,
      rollback: prepared,
      activatedAt: new Date().toISOString(),
      gateEvidence: gateEvidence as never,
      comparison: clean,
    });
    assert.equal(rolledBack.active.health().available, true);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
