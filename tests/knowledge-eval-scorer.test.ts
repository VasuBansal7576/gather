import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

// Focused scorer tests. Fixtures are synthetic scorer inputs only and are
// never provider results; assertions below check the scorer's arithmetic,
// gates, and unmeasured handling.

const SCRIPT = join(process.cwd(), "scripts", "evaluate-knowledge.mjs");
const FIXTURES = join(process.cwd(), "evaluation", "knowledge", "fixtures");

function score(responsesPath: string) {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, "--responses", responsesPath, "--format", "json"], {
      encoding: "utf8",
    });
    return { code: 0, report: JSON.parse(out) as Record<string, any> };
  } catch (error) {
    const err = error as { stdout?: string; status?: number };
    return { code: err.status ?? 1, report: JSON.parse(String(err.stdout)) as Record<string, any> };
  }
}

test("correct fixture passes every gate with exact denominators", () => {
  const { code, report } = score(join(FIXTURES, "scorer-fixture-correct.json"));
  assert.equal(code, 0);
  assert.equal(report.pass, true);
  assert.deepEqual(report.gates, {
    noLeakage: true,
    noUnsupportedAuthority: true,
    criticalCorrectness: true,
    factPrecision: true,
    importantRecall: true,
  });
  // 8 assertions, all supported; 8 expected fact slots, all matched (F1 in Q01 and Q03).
  assert.equal(report.metrics.factPrecision.total, 8);
  assert.equal(report.metrics.factPrecision.supported, 8);
  assert.equal(report.metrics.factPrecision.rate, 1);
  assert.equal(report.metrics.importantRecall.total, 8);
  assert.equal(report.metrics.importantRecall.matched, 8);
  assert.equal(report.metrics.criticalCorrectness.total, 5);
  assert.equal(report.metrics.criticalCorrectness.matched, 5);
  assert.equal(report.metrics.linking.correct, 8);
  assert.equal(report.metrics.versionCorrectness.correct, 5);
  assert.equal(report.metrics.versionCorrectness.total, 5);
  assert.equal(report.metrics.unsupportedAssertions, 0);
  assert.equal(report.metrics.crossBusinessLeakage, 0);
  assert.equal(report.metrics.deletionBehavior.passed, 1);
  assert.equal(report.metrics.deletionBehavior.deletedCitations, 0);
  assert.deepEqual(report.metrics.unmeasured, []);
  // One supplied timestamp pair yields honest measured latency.
  assert.equal(report.metrics.latency.status, "measured");
  assert.equal(report.metrics.latency.count, 1);
  assert.equal(report.metrics.latency.meanMs, 500);
  assert.match(String(report.fixtureWarning ?? ""), /fixture/);
});

test("flawed fixture fails every gate and names each failure", () => {
  const { code, report } = score(join(FIXTURES, "scorer-fixture-flawed.json"));
  assert.equal(code, 1);
  assert.equal(report.pass, false);
  assert.equal(report.gates.noLeakage, false);
  assert.equal(report.gates.noUnsupportedAuthority, false);
  assert.equal(report.gates.criticalCorrectness, false);
  assert.equal(report.gates.factPrecision, false);
  assert.equal(report.gates.importantRecall, false);
  // Stale version, deleted citation, invented commercial fact, cross-scope answer.
  assert.equal(report.metrics.deletionBehavior.deletedCitations, 1);
  assert.equal(report.metrics.crossBusinessLeakage, 1);
  assert.ok(report.metrics.unsupportedAuthorityFailures >= 1);
  assert.ok(report.failures.length >= 6);
  // Q02-Q07, Q10-Q14 answered by nobody: unmeasured, never scored.
  assert.ok(report.metrics.unmeasured.includes("Q02"));
  assert.ok(report.metrics.unmeasured.includes("Q11"));
  // Only Q01 carries expected facts among answered questions (Q08/Q09/Q15 have none).
  assert.equal(report.metrics.importantRecall.total, 1);
  // No timestamps supplied anywhere: latency honestly unmeasured.
  assert.equal(report.metrics.latency.status, "unmeasured");
});

test("absent responses file is a usage error, not a silent pass", () => {
  const dir = mkdtempSync(join(tmpdir(), "gather-eval-spot-"));
  const spot = join(dir, "spot.json");
  writeFileSync(
    spot,
    JSON.stringify({ provider: "scorer-fixture-spot", responses: [{ questionId: "Q11", abstained: false, assertions: [] }] }),
  );
  const { code, report } = score(spot);
  assert.equal(code, 1);
  // Only Q11 scored: its one expected fact unmatched, zero assertions made.
  assert.equal(report.metrics.importantRecall.total, 1);
  assert.equal(report.metrics.importantRecall.matched, 0);
  assert.equal(report.metrics.factPrecision.total, 0);
  assert.equal(report.metrics.factPrecision.rate, null);
  assert.ok(report.metrics.unmeasured.length === 14);
});
