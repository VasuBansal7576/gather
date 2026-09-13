#!/usr/bin/env node
/**
 * Deterministic fictional-knowledge evaluation scorer (plain Node, no deps).
 *
 * Reads ground truth + corpus + a SUPPLIED response file and reports
 * retrieval-quality metrics. It never calls a provider and never invents
 * results: questions with no supplied response are reported as unmeasured
 * and excluded from every denominator.
 *
 * Usage:
 *   node scripts/evaluate-knowledge.mjs --responses <path> [--format json|text]
 *     [--ground-truth <path>] [--corpus <path>] [--thresholds <path>]
 * Defaults resolve under evaluation/knowledge/.
 *
 * Response file shape:
 *   { "provider": "informational label only, never scored",
 *     "responses": [ { "questionId": "Q01",
 *                      "abstained": true|false,
 *                      "assertions": [ { "text": "...",
 *                                        "factId": "F1",
 *                                        "documentId": "harbor-packages-2026",
 *                                        "version": 2,
 *                                        "businessId": "biz-harbor",
 *                                        "commercialConclusion": true|false } ],
 *                      "timestampsMs": { "startedAt": <epoch ms or ISO>,
 *                                        "finishedAt": <epoch ms or ISO> } } ] }
 *
 * Exit codes: 0 gates pass, 1 gates fail, 2 usage or unreadable input.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EVAL_DIR = join(HERE, "..", "evaluation", "knowledge");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

function loadJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    console.error(`cannot read JSON at ${path}: ${error.message}`);
    process.exit(2);
  }
}

function toMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

function main() {
  const responsesPath = arg("--responses", null);
  if (!responsesPath) {
    console.error("usage: evaluate-knowledge.mjs --responses <path> [--format json|text]");
    process.exit(2);
  }
  const format = arg("--format", "text");
  const groundTruth = loadJson(arg("--ground-truth", join(EVAL_DIR, "ground-truth.json")));
  const corpus = loadJson(arg("--corpus", join(EVAL_DIR, "corpus.json")));
  const thresholds = loadJson(arg("--thresholds", join(EVAL_DIR, "thresholds.json")));
  const supplied = loadJson(resolve(responsesPath));

  const docById = new Map((corpus.documents ?? []).map((d) => [d.documentId, d]));
  // Fact ids may repeat across questions (F1 is expected in Q01 and Q03),
  // so resolution is always per-question: an assertion is checked against
  // the expected facts of its own question, never a global map where the
  // last writer would win.
  const responseByQ = new Map((supplied.responses ?? []).map((r) => [r.questionId, r]));

  const failures = [];
  const unmeasured = [];
  let supportedAssertions = 0;
  let totalAssertions = 0;
  let linkedCorrect = 0;
  let linkedTotal = 0;
  let matchedFacts = 0;
  let totalFacts = 0;
  let criticalMatched = 0;
  let criticalTotal = 0;
  let leakages = 0;
  let unsupportedCount = 0;
  let authorityFailures = 0;
  let deletionFailures = 0;
  let deletionProbes = 0;
  let deletionPassed = 0;
  let versionQuestions = 0;
  let versionCorrect = 0;
  const latencies = [];

  for (const q of groundTruth.questions ?? []) {
    const response = responseByQ.get(q.questionId);
    if (!response) {
      unmeasured.push(q.questionId);
      continue;
    }
    const expected = q.expectedFacts ?? [];
    totalFacts += expected.length;
    criticalTotal += expected.filter((f) => f.critical).length;
    const matched = new Set();
    const assertions = response.abstained ? [] : (response.assertions ?? []);
    if (response.abstained && assertions.length > 0) {
      failures.push({ questionId: q.questionId, reason: "abstained yet supplied assertions" });
    }

    let questionVersionOk = true;
    for (const a of assertions) {
      totalAssertions += 1;
      const citedFact = expected.find((f) => f.factId === a.factId) ?? null;
      const doc = docById.get(a.documentId);
      // Cross-business leakage: wrong business scope or another business doc.
      if (a.businessId !== q.businessId || (doc && doc.businessId !== q.businessId)) {
        leakages += 1;
        failures.push({ questionId: q.questionId, reason: `cross-business leakage: assertion cites ${a.documentId ?? "?"} for ${q.businessId} scope` });
      }
      // Deleted documents must never be cited.
      if (doc && doc.status === "deleted") {
        deletionFailures += 1;
        failures.push({ questionId: q.questionId, reason: `cites deleted document ${a.documentId}` });
      }
      const isExpected = citedFact !== null;
      const sourceOk =
        !!citedFact &&
        citedFact.documentId === a.documentId &&
        citedFact.version === a.version;
      if (a.factId) {
        linkedTotal += 1;
        if (sourceOk) linkedCorrect += 1;
        else failures.push({ questionId: q.questionId, reason: `linking error: ${a.factId} does not resolve to ${a.documentId} v${a.version}` });
      }
      if (isExpected && sourceOk && a.businessId === q.businessId) {
        supportedAssertions += 1;
        if (!matched.has(a.factId)) {
          matched.add(a.factId);
          matchedFacts += 1;
          const fact = expected.find((f) => f.factId === a.factId);
          if (fact && fact.critical) criticalMatched += 1;
        }
      } else {
        unsupportedCount += 1;
        failures.push({ questionId: q.questionId, reason: `unsupported assertion: ${a.factId ?? "(no factId)"} with ${a.documentId ?? "no source"}` });
        if (q.commercialAuthority && a.commercialConclusion !== false) {
          authorityFailures += 1;
          failures.push({ questionId: q.questionId, reason: "unsupported authoritative commercial conclusion" });
        }
      }
      if (q.versionSensitive && citedFact) {
        const srcDoc = docById.get(citedFact.documentId);
        if (!srcDoc || srcDoc.status !== "active" || citedFact.version !== srcDoc.version) questionVersionOk = false;
        if (a.version !== citedFact.version) questionVersionOk = false;
      }
    }

    if (q.mustAbstain) {
      if (!response.abstained || assertions.length > 0) {
        failures.push({ questionId: q.questionId, reason: "mustAbstain question was answered instead of abstained" });
        if (q.commercialAuthority) {
          authorityFailures += 1;
          failures.push({ questionId: q.questionId, reason: "unsupported authoritative commercial conclusion" });
        }
      }
    }
    // Deletion behavior: questions whose only honest outcome is abstention
    // because the cited source is withdrawn (Q08) pass when nothing deleted
    // is cited and nothing is asserted.
    if (q.questionId === "Q08") {
      deletionProbes += 1;
      if (response.abstained && assertions.length === 0 && deletionFailures === 0) deletionPassed += 1;
    }
    if (q.versionSensitive) {
      versionQuestions += 1;
      const allMatched = expected.length > 0 && expected.every((f) => matched.has(f.factId));
      if (allMatched && questionVersionOk) versionCorrect += 1;
      else if (!allMatched || !questionVersionOk) {
        failures.push({ questionId: q.questionId, reason: "version-sensitive question not answered with the applicable version" });
      }
    }

    const ts = response.timestampsMs ?? {};
    const start = toMs(ts.startedAt);
    const end = toMs(ts.finishedAt);
    if (start !== null && end !== null && end >= start) latencies.push(end - start);
  }

  const precision = totalAssertions === 0 ? null : supportedAssertions / totalAssertions;
  const recall = totalFacts === 0 ? null : matchedFacts / totalFacts;
  const criticalRate = criticalTotal === 0 ? null : criticalMatched / criticalTotal;
  const gates = thresholds.gates ?? {};
  const gateResults = {
    noLeakage: leakages === (gates.noLeakage?.threshold ?? 0),
    noUnsupportedAuthority: authorityFailures === (gates.noUnsupportedAuthority?.threshold ?? 0),
    criticalCorrectness: (criticalRate ?? 0) >= (gates.criticalCorrectness?.threshold ?? 1),
    factPrecision: precision !== null && precision >= (gates.factPrecision?.minimum ?? 1),
    importantRecall: recall !== null && recall >= (gates.importantRecall?.minimum ?? 1),
  };
  const pass = Object.values(gateResults).every(Boolean);
  const latency =
    latencies.length === 0
      ? { status: "unmeasured", reason: "no response supplied valid startedAt/finishedAt timestamps" }
      : {
          status: "measured",
          count: latencies.length,
          minMs: Math.min(...latencies),
          maxMs: Math.max(...latencies),
          meanMs: Math.round((latencies.reduce((a, b) => a + b, 0) / latencies.length) * 10) / 10,
        };

  const report = {
    notice: "FICTIONAL evaluation scoring. Denominators cover supplied responses only; unmeasured questions are excluded, never scored as pass.",
    provider: supplied.provider ?? "(unlabeled)",
    fixtureWarning: String(supplied.provider ?? "").toLowerCase().includes("fixture")
      ? "response file is labeled a scorer fixture: results test the scorer, never a provider"
      : null,
    gates: gateResults,
    pass,
    metrics: {
      factPrecision: { supported: supportedAssertions, total: totalAssertions, rate: precision },
      importantRecall: { matched: matchedFacts, total: totalFacts, rate: recall },
      criticalCorrectness: { matched: criticalMatched, total: criticalTotal, rate: criticalRate },
      linking: { correct: linkedCorrect, total: linkedTotal },
      versionCorrectness: { correct: versionCorrect, total: versionQuestions },
      unsupportedAssertions: unsupportedCount,
      crossBusinessLeakage: leakages,
      unsupportedAuthorityFailures: authorityFailures,
      deletionBehavior: { passed: deletionPassed, probes: deletionProbes, deletedCitations: deletionFailures },
      latency,
      unmeasured,
    },
    failures,
  };

  if (format === "json") {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const line = (label, m) =>
      `  ${label}: ${m.rate === null ? "unmeasured" : `${Math.round(m.rate * 1000) / 10}%`} (${m.supported ?? m.matched ?? m.correct ?? "?"} / ${m.total})`;
    console.log(`knowledge evaluation: ${pass ? "PASS" : "FAIL"} (provider label: ${report.provider})`);
    for (const [gate, ok] of Object.entries(gateResults)) console.log(`  gate ${gate}: ${ok ? "PASS" : "FAIL"}`);
    console.log(line("fact precision", report.metrics.factPrecision));
    console.log(line("important recall", report.metrics.importantRecall));
    console.log(line("critical correctness", report.metrics.criticalCorrectness));
    console.log(`  linking: ${linkedCorrect} / ${linkedTotal}`);
    console.log(`  version correctness: ${versionCorrect} / ${versionQuestions}`);
    console.log(`  unsupported assertions: ${unsupportedCount}, leakage: ${leakages}, authority failures: ${authorityFailures}`);
    console.log(`  deletion: ${deletionPassed} / ${deletionProbes} probes, deleted citations: ${deletionFailures}`);
    console.log(`  latency: ${latency.status === "measured" ? `measured n=${latency.count} min=${latency.minMs}ms max=${latency.maxMs}ms mean=${latency.meanMs}ms` : "unmeasured (no timestamps supplied)"}`);
    console.log(`  unmeasured questions: ${unmeasured.length === 0 ? "none" : unmeasured.join(", ")}`);
    if (report.fixtureWarning) console.log(`  note: ${report.fixtureWarning}`);
    for (const f of failures) console.log(`  FAIL ${f.questionId}: ${f.reason}`);
  }
  process.exit(pass ? 0 : 1);
}

main();
