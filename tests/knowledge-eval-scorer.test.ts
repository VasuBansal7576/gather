import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

// Focused scorer tests. Fixtures are synthetic scorer inputs only and are
// never provider results; assertions below check the scorer's arithmetic,
// gates, and unmeasured handling. Temporary response files are created in
// test-owned temp dirs and removed by each test.

// Narrowed public shape of the scorer JSON report. Parsed output is
// validated field by field (parseReport) instead of cast, so a scorer
// output change fails loudly here rather than passing silently.
interface RateMetric {
  rate: number | null;
}
interface CountMetric extends RateMetric {
  total: number;
}
interface FactPrecisionMetric extends CountMetric {
  supported: number;
}
interface RecallMetric extends CountMetric {
  matched: number;
}
interface LinkingMetric extends CountMetric {
  correct: number;
}
interface ScorerReport {
  pass: boolean;
  gates: Record<string, boolean>;
  failures: Array<{ questionId: string; reason: string }>;
  fixtureWarning: string | null;
  metrics: {
    factPrecision: FactPrecisionMetric;
    importantRecall: RecallMetric;
    criticalCorrectness: RecallMetric;
    linking: LinkingMetric;
    versionCorrectness: LinkingMetric;
    unsupportedAssertions: number;
    crossBusinessLeakage: number;
    unsupportedAuthorityFailures: number;
    deletionBehavior: { passed: number; probes: number; deletedCitations: number };
    abstentionViolations: number;
    inputErrors: string[];
    coverage: { required: number; answered: number; unmeasured: number };
    latency: { status: string; count?: number; meanMs?: number };
    rawTextSemantics: { status: string; evaluatedAssertions: number };
    semanticAdjudication: { status: string };
    unmeasured: string[];
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRateMetric(value: unknown, what: string): RateMetric & Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`report metrics.${what} is not an object`);
  return value as RateMetric & Record<string, unknown>;
}

function parseReport(value: unknown): ScorerReport {
  if (!isRecord(value)) throw new Error("scorer output is not a JSON object");
  if (typeof value.pass !== "boolean") throw new Error("report.pass is not boolean");
  if (!isRecord(value.gates)) throw new Error("report.gates is not an object");
  for (const [k, v] of Object.entries(value.gates)) {
    if (typeof v !== "boolean") throw new Error(`report.gates.${k} is not boolean`);
  }
  if (!Array.isArray(value.failures)) throw new Error("report.failures is not an array");
  for (const f of value.failures) {
    if (!isRecord(f) || typeof f.questionId !== "string" || typeof f.reason !== "string") {
      throw new Error("report.failures entry lacks string questionId/reason");
    }
  }
  if (!isRecord(value.metrics)) throw new Error("report.metrics is not an object");
  const m = value.metrics;
  const num = (key: string): number => {
    if (typeof m[key] !== "number") throw new Error(`report.metrics.${key} is not a number`);
    return m[key] as number;
  };
  const strArray = (key: string): string[] => {
    if (!Array.isArray(m[key]) || !(m[key] as unknown[]).every((e) => typeof e === "string")) {
      throw new Error(`report.metrics.${key} is not a string array`);
    }
    return m[key] as string[];
  };
  const deletion = m.deletionBehavior;
  if (!isRecord(deletion) || typeof deletion.passed !== "number" || typeof deletion.probes !== "number" || typeof deletion.deletedCitations !== "number") {
    throw new Error("report.metrics.deletionBehavior is malformed");
  }
  const coverage = m.coverage;
  if (!isRecord(coverage) || typeof coverage.required !== "number" || typeof coverage.answered !== "number" || typeof coverage.unmeasured !== "number") {
    throw new Error("report.metrics.coverage is malformed");
  }
  const latency = m.latency;
  if (!isRecord(latency) || typeof latency.status !== "string") throw new Error("report.metrics.latency is malformed");
  const rawText = m.rawTextSemantics;
  if (!isRecord(rawText) || typeof rawText.status !== "string" || typeof rawText.evaluatedAssertions !== "number") {
    throw new Error("report.metrics.rawTextSemantics is malformed");
  }
  const adjudication = m.semanticAdjudication;
  if (!isRecord(adjudication) || typeof adjudication.status !== "string") {
    throw new Error("report.metrics.semanticAdjudication is malformed");
  }
  if (value.fixtureWarning !== null && typeof value.fixtureWarning !== "string") {
    throw new Error("report.fixtureWarning is neither null nor string");
  }
  return {
    pass: value.pass,
    gates: value.gates as Record<string, boolean>,
    failures: value.failures as Array<{ questionId: string; reason: string }>,
    fixtureWarning: value.fixtureWarning,
    metrics: {
      factPrecision: asRateMetric(m.factPrecision, "factPrecision") as unknown as FactPrecisionMetric,
      importantRecall: asRateMetric(m.importantRecall, "importantRecall") as unknown as RecallMetric,
      criticalCorrectness: asRateMetric(m.criticalCorrectness, "criticalCorrectness") as unknown as RecallMetric,
      linking: asRateMetric(m.linking, "linking") as unknown as LinkingMetric,
      versionCorrectness: asRateMetric(m.versionCorrectness, "versionCorrectness") as unknown as LinkingMetric,
      unsupportedAssertions: num("unsupportedAssertions"),
      crossBusinessLeakage: num("crossBusinessLeakage"),
      unsupportedAuthorityFailures: num("unsupportedAuthorityFailures"),
      deletionBehavior: {
        passed: deletion.passed as number,
        probes: deletion.probes as number,
        deletedCitations: deletion.deletedCitations as number,
      },
      abstentionViolations: num("abstentionViolations"),
      inputErrors: strArray("inputErrors"),
      coverage: {
        required: coverage.required as number,
        answered: coverage.answered as number,
        unmeasured: coverage.unmeasured as number,
      },
      latency: { status: latency.status as string, ...(latency as Record<string, unknown>) },
      rawTextSemantics: {
        status: rawText.status as string,
        evaluatedAssertions: rawText.evaluatedAssertions as number,
      },
      semanticAdjudication: { status: adjudication.status as string },
      unmeasured: strArray("unmeasured"),
    },
  };
}

const SCRIPT = join(process.cwd(), "scripts", "evaluate-knowledge.mjs");
const FIXTURES = join(process.cwd(), "evaluation", "knowledge", "fixtures");

function score(responsesPath: string): { code: number; report: ScorerReport } {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, "--responses", responsesPath, "--format", "json"], {
      encoding: "utf8",
    });
    const parsed: unknown = JSON.parse(out);
    return { code: 0, report: parseReport(parsed) };
  } catch (error) {
    if (!isRecord(error)) throw error;
    const stdout = error.stdout;
    if (typeof stdout !== "string") throw error;
    const parsed: unknown = JSON.parse(stdout);
    const status = error.status;
    return { code: typeof status === "number" ? status : 1, report: parseReport(parsed) };
  }
}

/** Write a temp response file in a test-owned dir; caller removes the dir. */
function writeTempResponses(responses: unknown): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "gather-eval-repro-"));
  const path = join(dir, "responses.json");
  writeFileSync(path, JSON.stringify({ provider: "scorer-fixture-temp", responses }));
  return { dir, path };
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
    linkingCorrectness: true,
    versionCorrectness: true,
    deletionBehavior: true,
    abstentionIntegrity: true,
    inputValidity: true,
    completeCoverage: true,
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
  try {
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
    assert.equal(report.gates.completeCoverage, false);
    assert.equal(report.pass, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("free-pricing text swap with retained fact IDs fails: IDs never self-certify", () => {
  const { code, report } = score(join(FIXTURES, "scorer-fixture-freetext-swap.json"));
  assert.equal(code, 1);
  assert.equal(report.pass, false);
  assert.equal(report.gates.factPrecision, false);
  assert.equal(report.gates.importantRecall, false);
  assert.equal(report.gates.criticalCorrectness, false);
  // Links still resolve, but structured values are gone: zero supported.
  assert.equal(report.metrics.linking.correct, report.metrics.linking.total);
  assert.equal(report.metrics.factPrecision.supported, 0);
  assert.equal(report.metrics.factPrecision.total, 8);
  assert.ok(report.failures.some((f) => f.reason.includes("structured value mismatch")));
  assert.match(String(report.fixtureWarning ?? ""), /fixture/);
});

test("single retained answer cannot pass: partial metrics report but coverage fails", () => {
  const { code, report } = score(join(FIXTURES, "scorer-fixture-partial-coverage.json"));
  assert.equal(code, 1);
  assert.equal(report.pass, false);
  assert.equal(report.gates.completeCoverage, false);
  // The answered subset is honestly correct, yet overall must not pass.
  assert.equal(report.metrics.factPrecision.rate, 1);
  assert.deepEqual(report.metrics.unmeasured.length, 14);
  assert.equal(report.metrics.coverage.answered, 1);
  assert.equal(report.metrics.coverage.required, 15);
});

test("foreign claims on abstained responses fail abstention integrity", () => {
  const { code, report } = score(join(FIXTURES, "scorer-fixture-abstain-plus-claims.json"));
  assert.equal(code, 1);
  assert.equal(report.pass, false);
  assert.equal(report.gates.abstentionIntegrity, false);
  // Both contradictory responses sit on mustAbstain questions, so each
  // counts twice: contradictory abstention plus violated required abstention.
  assert.equal(report.metrics.abstentionViolations, 4);
  assert.equal(report.gates.deletionBehavior, false);
  assert.ok(
    report.failures.some((f) => f.reason.includes("abstained yet supplied assertions")),
  );
});

test("duplicate, unknown, and malformed inputs fail input validity", () => {
  const { code, report } = score(join(FIXTURES, "scorer-fixture-bad-shape.json"));
  assert.equal(code, 1);
  assert.equal(report.pass, false);
  assert.equal(report.gates.inputValidity, false);
  assert.ok(report.metrics.inputErrors.length >= 4);
  assert.ok(report.metrics.inputErrors.some((e) => e.includes("duplicate")));
  assert.ok(report.metrics.inputErrors.some((e) => e.includes("unknown questionId")));
  assert.ok(report.metrics.inputErrors.some((e) => e.includes("questionId") && e.includes("missing")));
  assert.equal(report.gates.completeCoverage, false);
});

test("answering the deletion probe with a deleted citation fails deletion gate", () => {
  const { code, report } = score(join(FIXTURES, "scorer-fixture-deletion-gap.json"));
  assert.equal(code, 1);
  assert.equal(report.pass, false);
  assert.equal(report.gates.deletionBehavior, false);
  assert.equal(report.metrics.deletionBehavior.probes, 1);
  assert.equal(report.metrics.deletionBehavior.passed, 0);
  assert.equal(report.metrics.deletionBehavior.deletedCitations, 1);
  assert.equal(report.gates.factPrecision, false);
});

test("raw assertion text is never scored as correct", () => {
  const { code, report } = score(join(FIXTURES, "scorer-fixture-correct.json"));
  assert.equal(code, 0);
  assert.equal(report.metrics.rawTextSemantics.status, "unmeasured");
  assert.equal(report.metrics.rawTextSemantics.evaluatedAssertions, 0);
  assert.equal(report.metrics.semanticAdjudication.status, "unmeasured");
});

test("silent non-answer on a required abstention fails abstention integrity", () => {
  // Regression for the false pass: Q05 (mustAbstain, non-commercial) answered
  // with abstained:false and zero assertions recorded a failure but passed
  // every gate. A silent non-answer is still an answer.
  const { dir, path } = writeTempResponses([{ questionId: "Q05", abstained: false, assertions: [] }]);
  try {
    const { code, report } = score(path);
    assert.equal(code, 1);
    assert.equal(report.pass, false);
    assert.equal(report.gates.abstentionIntegrity, false);
    assert.equal(report.metrics.abstentionViolations, 1);
    assert.ok(
      report.failures.some((f) => f.questionId === "Q05" && f.reason.includes("mustAbstain")),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("answered mustAbstain questions with assertions fail integrity on every scope", () => {
  // Q06 and Q14 are required abstentions without commercial or deletion
  // flags; answering either with assertions must fail a gate, not just log.
  const { dir, path } = writeTempResponses([
    {
      questionId: "Q06",
      abstained: false,
      assertions: [{ text: "raw prose, never scored", factId: "F3", value: { discount: "none" }, documentId: "harbor-packages-2026", version: 2, businessId: "biz-harbor" }],
    },
    { questionId: "Q14", abstained: false, assertions: [] },
  ]);
  try {
    const { code, report } = score(path);
    assert.equal(code, 1);
    assert.equal(report.pass, false);
    assert.equal(report.gates.abstentionIntegrity, false);
    assert.equal(report.metrics.abstentionViolations, 2);
    assert.ok(report.failures.some((f) => f.questionId === "Q06"));
    assert.ok(report.failures.some((f) => f.questionId === "Q14"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("responses missing abstained or assertions fields fail input validity", () => {
  const { dir, path } = writeTempResponses([
    { questionId: "Q11", assertions: [] },
    { questionId: "Q12", abstained: true },
    { questionId: "Q13", abstained: false, assertions: "not-an-array" },
  ]);
  try {
    const { code, report } = score(path);
    assert.equal(code, 1);
    assert.equal(report.pass, false);
    assert.equal(report.gates.inputValidity, false);
    assert.ok(report.metrics.inputErrors.some((e) => e.includes("Q11") && e.includes("missing abstained")));
    assert.ok(report.metrics.inputErrors.some((e) => e.includes("Q12") && e.includes("missing assertions")));
    assert.ok(report.metrics.inputErrors.some((e) => e.includes("Q13") && e.includes("must be an array")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
