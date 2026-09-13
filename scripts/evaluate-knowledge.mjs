#!/usr/bin/env node
/**
 * Deterministic fictional-knowledge evaluation scorer (plain Node, no deps).
 *
 * Reads ground truth + corpus + a SUPPLIED response file and reports
 * retrieval-quality metrics. It never calls a provider and never invents
 * results.
 *
 * INTEGRITY MODEL (read before trusting a PASS):
 * - Provider `factId` links are claims, never proof. An assertion counts as
 *   supported ONLY when its explicit structured `value` deep-equals the
 *   trusted ground-truth `value` for that fact AND its source link
 *   (documentId, version, businessId) resolves exactly. Retaining a correct
 *   fact ID while writing a different claim (or omitting `value`) is scored
 *   as an unsupported assertion.
 * - Provider `text` is raw prose and is NEVER scored. Raw-text correctness
 *   is reported as unmeasured unless a separately adjudicated semantic-label
 *   file is supplied via --semantic-labels; adjudicated results are reported
 *   separately and never merged into the structured gates.
 * - Whole-corpus acceptance requires complete coverage: any unmeasured
 *   required question fails the `completeCoverage` gate. Partial metrics are
 *   still reported for diagnosis but can never pass overall.
 * - Abstention contradicts assertion: `abstained:true` with any supplied
 *   assertions fails the `abstentionIntegrity` gate.
 * - Deletion, version, and linking checks are gates, not diagnostics.
 * - Duplicate, unknown, or malformed inputs fail the `inputValidity` gate.
 *
 * Usage:
 *   node scripts/evaluate-knowledge.mjs --responses <path> [--format json|text]
 *     [--ground-truth <path>] [--corpus <path>] [--thresholds <path>]
 *     [--semantic-labels <path>]
 * Defaults resolve under evaluation/knowledge/.
 *
 * Response file shape:
 *   { "provider": "informational label only, never scored",
 *     "responses": [ { "questionId": "Q01",
 *                      "abstained": true|false,
 *                      "assertions": [ { "text": "raw prose, never scored",
 *                                        "factId": "F1",
 *                                        "value": { "kind": "...", ... },
 *                                        "documentId": "harbor-packages-2026",
 *                                        "version": 2,
 *                                        "businessId": "biz-harbor",
 *                                        "commercialConclusion": true|false } ],
 *                      "timestampsMs": { "startedAt": <epoch ms or ISO>,
 *                                        "finishedAt": <epoch ms or ISO> } } ] }
 *
 * Semantic-label file shape (separate adjudication only, never authoritative
 * for structured gates):
 *   { "adjudicator": "who/what produced the labels (human panel, ...)",
 *     "basis": "how labels were produced",
 *     "labels": [ { "questionId": "Q01", "factId": "F1",
 *                    "verdict": "supported"|"unsupported" } ] }
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

// Key-order-insensitive canonical form for structured value comparison.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function valuesEqual(a, b) {
  return canonical(a) === canonical(b);
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
  const semanticLabelsPath = arg("--semantic-labels", null);
  const semanticFile = semanticLabelsPath ? loadJson(resolve(semanticLabelsPath)) : null;

  if (supplied === null || typeof supplied !== "object" || Array.isArray(supplied)) {
    console.error("response file must be a JSON object with a responses array");
    process.exit(2);
  }
  if (!Array.isArray(supplied.responses)) {
    console.error("response file must contain a responses array");
    process.exit(2);
  }

  const docById = new Map((corpus.documents ?? []).map((d) => [d.documentId, d]));
  const questionById = new Map((groundTruth.questions ?? []).map((q) => [q.questionId, q]));
  // Fact ids may repeat across questions (F1 is expected in Q01 and Q03),
  // so resolution is always per-question: an assertion is checked against
  // the expected facts of its own question, never a global map where the
  // last writer would win.
  const responseByQ = new Map();
  const inputErrors = [];
  const failures = [];
  const unmeasured = [];
  const seenQuestionIds = new Set();

  for (let i = 0; i < supplied.responses.length; i += 1) {
    const r = supplied.responses[i];
    const where = `responses[${i}]`;
    if (r === null || typeof r !== "object" || Array.isArray(r)) {
      inputErrors.push(`${where}: response is not an object`);
      continue;
    }
    if (typeof r.questionId !== "string" || r.questionId.trim() === "") {
      inputErrors.push(`${where}: missing or non-string questionId`);
      continue;
    }
    if (!questionById.has(r.questionId)) {
      inputErrors.push(`${where}: unknown questionId ${JSON.stringify(r.questionId)}`);
      failures.push({ questionId: String(r.questionId), reason: `unknown questionId ${r.questionId}: not in ground truth` });
      continue;
    }
    if (seenQuestionIds.has(r.questionId)) {
      inputErrors.push(`${where}: duplicate response for ${r.questionId}; only the first is scored`);
      failures.push({ questionId: r.questionId, reason: "duplicate response for question; only the first is scored" });
      continue;
    }
    seenQuestionIds.add(r.questionId);
    if ("abstained" in r && typeof r.abstained !== "boolean") {
      inputErrors.push(`${where} (${r.questionId}): abstained must be boolean`);
    }
    if ("assertions" in r && !Array.isArray(r.assertions)) {
      inputErrors.push(`${where} (${r.questionId}): assertions must be an array`);
    }
    responseByQ.set(r.questionId, r);
  }

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
  let abstentionViolations = 0;
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
    // Raw supplied assertions: abstention never hides them. An abstained
    // response carrying assertions is contradictory input, scored below.
    const raw = Array.isArray(response.assertions) ? response.assertions : [];
    const abstained = response.abstained === true;
    if (abstained && raw.length > 0) {
      abstentionViolations += 1;
      failures.push({ questionId: q.questionId, reason: "abstained yet supplied assertions: abstention contradicts assertion" });
    }

    let questionVersionOk = true;
    for (let ai = 0; ai < raw.length; ai += 1) {
      const a = raw[ai];
      const where = `${q.questionId} assertions[${ai}]`;
      if (a === null || typeof a !== "object" || Array.isArray(a)) {
        inputErrors.push(`${where}: assertion is not an object`);
        totalAssertions += 1;
        unsupportedCount += 1;
        failures.push({ questionId: q.questionId, reason: "unsupported assertion: malformed (not an object)" });
        continue;
      }
      for (const field of ["documentId", "businessId"]) {
        if (field in a && typeof a[field] !== "string") {
          inputErrors.push(`${where}: ${field} must be a string`);
        }
      }
      if ("version" in a && (typeof a.version !== "number" || !Number.isFinite(a.version))) {
        inputErrors.push(`${where}: version must be a finite number`);
      }
      totalAssertions += 1;
      const citedFact = expected.find((f) => f.factId === a.factId) ?? null;
      const doc = typeof a.documentId === "string" ? docById.get(a.documentId) : undefined;
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
      // Source-link resolution: the claimed factId must resolve to exactly
      // the expected document and version within this question.
      const linkOk =
        !!citedFact &&
        citedFact.documentId === a.documentId &&
        citedFact.version === a.version;
      // Structured value match: the provider's normalized value must equal
      // the trusted ground-truth value. IDs alone never self-certify; raw
      // text is never consulted here.
      const valueOk = !!citedFact && "value" in a && valuesEqual(a.value, citedFact.value);
      if (a.factId) {
        linkedTotal += 1;
        if (linkOk) linkedCorrect += 1;
        else failures.push({ questionId: q.questionId, reason: `linking error: ${a.factId} does not resolve to ${a.documentId} v${a.version}` });
      } else {
        failures.push({ questionId: q.questionId, reason: `linking error: assertion carries no factId (source ${a.documentId ?? "unknown"})` });
      }
      if (!valueOk) {
        failures.push({
          questionId: q.questionId,
          reason: `structured value mismatch: ${a.factId ?? "(no factId)"} supplies ${canonical("value" in a ? a.value : null)} but ground truth requires ${citedFact ? canonical(citedFact.value) : "no such expected fact"}`,
        });
      }
      const businessOk = a.businessId === q.businessId && (!doc || doc.businessId === q.businessId);
      const docOk = !doc || doc.status !== "deleted";
      // Assertions under abstention:true are contradictory and never
      // supported, even when their links and values would otherwise match.
      if (!abstained && linkOk && valueOk && businessOk && docOk) {
        supportedAssertions += 1;
        if (!matched.has(a.factId)) {
          matched.add(a.factId);
          matchedFacts += 1;
          const fact = expected.find((f) => f.factId === a.factId);
          if (fact && fact.critical) criticalMatched += 1;
        }
      } else {
        unsupportedCount += 1;
        if (abstained) {
          failures.push({ questionId: q.questionId, reason: `unsupported assertion: supplied under abstention (${a.factId ?? "no factId"})` });
        } else if (linkOk && valueOk && (!businessOk || !docOk)) {
          failures.push({ questionId: q.questionId, reason: `unsupported assertion: ${a.factId ?? "(no factId)"} with ${a.documentId ?? "no source"}` });
        } else if (!(linkOk && valueOk)) {
          failures.push({ questionId: q.questionId, reason: `unsupported assertion: ${a.factId ?? "(no factId)"} with ${a.documentId ?? "no source"}` });
        }
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
      if (!abstained || raw.length > 0) {
        failures.push({ questionId: q.questionId, reason: "mustAbstain question was answered instead of abstained" });
        if (q.commercialAuthority) {
          authorityFailures += 1;
          failures.push({ questionId: q.questionId, reason: "unsupported authoritative commercial conclusion" });
        }
      }
    }
    // Deletion behavior: any question flagged deletionProbe in ground truth
    // (no hardcoded question IDs) passes only when the response abstains
    // with zero assertions and no deleted document is cited anywhere.
    if (q.deletionProbe === true) {
      deletionProbes += 1;
      if (abstained && raw.length === 0 && deletionFailures === 0) deletionPassed += 1;
      else {
        failures.push({ questionId: q.questionId, reason: "deletion probe not honored: withdrawn source requires abstention with no assertions" });
      }
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

  // Separately adjudicated raw-text semantics: reported only, never gated,
  // never merged into structured correctness.
  let semanticAdjudication = {
    status: "unmeasured",
    reason: "assertion.text is raw provider prose and is never scored; supply --semantic-labels from a separate adjudicator to evaluate it",
    evaluated: 0,
  };
  if (semanticFile) {
    const labels = Array.isArray(semanticFile.labels) ? semanticFile.labels : [];
    let supported = 0;
    let unsupported = 0;
    for (const l of labels) {
      if (l && l.verdict === "supported") supported += 1;
      else if (l && l.verdict === "unsupported") unsupported += 1;
    }
    semanticAdjudication = {
      status: "adjudicated-separately",
      adjudicator: semanticFile.adjudicator ?? "(unlabeled adjudicator)",
      basis: semanticFile.basis ?? "(unlabeled basis)",
      supported,
      unsupported,
      evaluated: labels.length,
      note: "adjudicated text labels describe prose only; structured gates above are unaffected",
    };
  }

  const precision = totalAssertions === 0 ? null : supportedAssertions / totalAssertions;
  const recall = totalFacts === 0 ? null : matchedFacts / totalFacts;
  const criticalRate = criticalTotal === 0 ? null : criticalMatched / criticalTotal;
  const linkingRate = linkedTotal === 0 ? null : linkedCorrect / linkedTotal;
  const versionRate = versionQuestions === 0 ? null : versionCorrect / versionQuestions;
  const gates = thresholds.gates ?? {};
  const gateResults = {
    noLeakage: leakages === (gates.noLeakage?.threshold ?? 0),
    noUnsupportedAuthority: authorityFailures === (gates.noUnsupportedAuthority?.threshold ?? 0),
    criticalCorrectness: (criticalRate ?? 0) >= (gates.criticalCorrectness?.threshold ?? 1),
    factPrecision: precision !== null && precision >= (gates.factPrecision?.minimum ?? 1),
    importantRecall: recall !== null && recall >= (gates.importantRecall?.minimum ?? 1),
    linkingCorrectness:
      linkedTotal > 0 && linkingRate !== null && linkingRate >= (gates.linkingCorrectness?.minimum ?? 1),
    versionCorrectness:
      versionQuestions > 0 && versionRate !== null && versionRate >= (gates.versionCorrectness?.minimum ?? 1),
    deletionBehavior:
      deletionProbes > 0 &&
      deletionPassed === deletionProbes &&
      deletionFailures === (gates.deletionBehavior?.deletedCitationsThreshold ?? 0),
    abstentionIntegrity: abstentionViolations === (gates.abstentionIntegrity?.threshold ?? 0),
    inputValidity: inputErrors.length === 0,
    completeCoverage: unmeasured.length === 0,
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
    notice:
      "FICTIONAL evaluation scoring. Structured-answer correctness only: supported means the supplied structured value matched trusted ground truth with an exact source link. Raw assertion text is never scored (see rawTextSemantics). Partial metrics cover supplied responses only; whole-corpus PASS requires completeCoverage.",
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
      linking: { correct: linkedCorrect, total: linkedTotal, rate: linkingRate },
      versionCorrectness: { correct: versionCorrect, total: versionQuestions, rate: versionRate },
      unsupportedAssertions: unsupportedCount,
      crossBusinessLeakage: leakages,
      unsupportedAuthorityFailures: authorityFailures,
      deletionBehavior: { passed: deletionPassed, probes: deletionProbes, deletedCitations: deletionFailures },
      abstentionViolations,
      inputErrors,
      coverage: {
        required: (groundTruth.questions ?? []).length,
        answered: (groundTruth.questions ?? []).length - unmeasured.length,
        unmeasured: unmeasured.length,
      },
      rawTextSemantics: {
        status: "unmeasured",
        reason: "assertion.text is raw provider prose and is never scored as correct; correctness requires a structured value match or separate adjudication",
        evaluatedAssertions: 0,
      },
      semanticAdjudication,
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
    console.log(line("fact precision (structured values only)", report.metrics.factPrecision));
    console.log(line("important recall (structured values only)", report.metrics.importantRecall));
    console.log(line("critical correctness (structured values only)", report.metrics.criticalCorrectness));
    console.log(`  linking: ${linkedCorrect} / ${linkedTotal}`);
    console.log(`  version correctness: ${versionCorrect} / ${versionQuestions}`);
    console.log(`  unsupported assertions: ${unsupportedCount}, leakage: ${leakages}, authority failures: ${authorityFailures}`);
    console.log(`  deletion: ${deletionPassed} / ${deletionProbes} probes, deleted citations: ${deletionFailures}`);
    console.log(`  abstention violations: ${abstentionViolations}, input errors: ${inputErrors.length}`);
    console.log(`  coverage: ${report.metrics.coverage.answered} / ${report.metrics.coverage.required} required questions answered`);
    console.log(`  raw text semantics: unmeasured (never scored; see --semantic-labels for separate adjudication)`);
    console.log(`  latency: ${latency.status === "measured" ? `measured n=${latency.count} min=${latency.minMs}ms max=${latency.maxMs}ms mean=${latency.meanMs}ms` : "unmeasured (no timestamps supplied)"}`);
    console.log(`  unmeasured questions: ${unmeasured.length === 0 ? "none" : unmeasured.join(", ")}`);
    if (report.fixtureWarning) console.log(`  note: ${report.fixtureWarning}`);
    for (const e of inputErrors) console.log(`  INPUT ${e}`);
    for (const f of failures) console.log(`  FAIL ${f.questionId}: ${f.reason}`);
  }
  process.exit(pass ? 0 : 1);
}

main();
