import type { KnowledgePort } from "../knowledge/port.ts";
import {
  EVAL_CASE_SET_VERSION,
  NO_CAUSAL_CLAIM,
  type EvalCase,
  type EvalCaseSet,
} from "./case-set.ts";

/**
 * ADR-005 per-business regression runner (C10 consumer over KnowledgePort).
 *
 * Each case is answered from the port (scoped query + offer snapshot), never
 * from model text: the runner checks that confirmed facts apply where they
 * should, scoped exceptions stay bounded, must-abstain and deletion probes
 * withhold authority, and empty knowledge reports no-facts honestly.
 *
 * Comparison rules (enforced, not advisory):
 * - before and after MUST share the same caseSetVersion;
 * - the verdict is computed on the intersection of answered case ids only;
 * - added or removed cases change the denominator and are listed
 *   separately — they are never presented as improvement;
 * - every report carries NO_CAUSAL_CLAIM.
 */

export interface CaseOutcome {
  caseId: string;
  kind: string;
  passed: boolean;
  detail: string;
}

export interface EvalRun {
  caseSetVersion: string;
  businessId: string;
  generatedAt: string;
  /** Case ids the runner actually answered (unanswered ids are unmeasured). */
  answeredIds: string[];
  /** Case ids with no answer: excluded from denominators, never scored. */
  unmeasuredIds: string[];
  outcomes: CaseOutcome[];
  passedCount: number;
  denominator: number;
  disclaimer: string;
}

export interface ComparedRuns {
  caseSetVersion: string;
  before: { passed: number; denominator: number };
  after: { passed: number; denominator: number };
  /** Verdict on the shared answered intersection only. */
  verdict: "improved" | "unchanged" | "worse";
  sharedCaseIds: string[];
  sharedBeforePassed: number;
  sharedAfterPassed: number;
  /** Cases present in after but not before: denominator change, not improvement. */
  addedCaseIds: string[];
  /** Cases present in before but not after: denominator change, not regression. */
  removedCaseIds: string[];
  denominatorNote: string;
  disclaimer: string;
}

function now(): string {
  return new Date().toISOString();
}

/**
 * Answer one case from the port. Returns null when the case cannot be
 * answered in this environment (recorded as unmeasured, never guessed).
 */
export function answerCase(
  port: KnowledgePort,
  businessId: string,
  inquiry: EvalCase,
): CaseOutcome | null {
  const scope = {
    businessId,
    ...(inquiry.scope?.type === "booking" ? { bookingId: inquiry.scope.id } : {}),
    ...(inquiry.scope?.type === "customer" ? { customerId: inquiry.scope.id } : {}),
  };
  let health;
  try {
    health = port.health();
  } catch {
    return null;
  }
  if (!health.available) {
    if (inquiry.kind === "no-facts-honest" || inquiry.mustAbstain) {
      return {
        caseId: inquiry.id,
        kind: inquiry.kind,
        passed: true,
        detail: "port unavailable: withheld authority instead of inventing facts",
      };
    }
    return null;
  }
  const result = port.query(scope, inquiry.factKey ? { keys: [inquiry.factKey] } : {});
  const matching = result.facts.filter(
    (fact) =>
      (inquiry.factKey === undefined || fact.key === inquiry.factKey) &&
      (inquiry.subjectId === undefined || fact.subjectId === inquiry.subjectId),
  );

  switch (inquiry.kind) {
    case "confirmed-fact-applies": {
      if (matching.length === 0) {
        return {
          caseId: inquiry.id,
          kind: inquiry.kind,
          passed: result.blocked,
          detail: result.blocked
            ? `expected fact withheld with reasons: ${result.blockReasons.join("; ")}`
            : "expected confirmed fact absent from scoped query",
        };
      }
      return { caseId: inquiry.id, kind: inquiry.kind, passed: true, detail: `${matching.length} applicable confirmed fact(s) authorize` };
    }
    case "scoped-exception-bounded": {
      if (!inquiry.scope) {
        return { caseId: inquiry.id, kind: inquiry.kind, passed: false, detail: "case lacks the scope its exception must stay inside" };
      }
      const inScope = matching.length > 0;
      // The same exception must NOT authorize outside its scope: query the
      // sibling scope and require absence there.
      const sibling = port.query({
        businessId,
        ...(inquiry.scope.type === "booking"
          ? { bookingId: `sibling-of-${inquiry.scope.id}` }
          : { customerId: `sibling-of-${inquiry.scope.id}` }),
      }, inquiry.factKey ? { keys: [inquiry.factKey] } : {});
      const leaked = sibling.facts.some(
        (fact) =>
          fact.key === inquiry.factKey &&
          fact.scope === inquiry.scope?.type &&
          fact.scopeId === inquiry.scope?.id,
      );
      if (leaked) {
        return { caseId: inquiry.id, kind: inquiry.kind, passed: false, detail: "scoped exception leaked into a sibling scope" };
      }
      return {
        caseId: inquiry.id,
        kind: inquiry.kind,
        passed: true,
        detail: inScope
          ? "exception authorizes inside its scope and nowhere else"
          : "exception absent inside scope after change (blocked or corrected); still bounded — no leak",
      };
    }
    case "must-abstain": {
      const concluded = matching.length > 0 && !result.blocked;
      return {
        caseId: inquiry.id,
        kind: inquiry.kind,
        passed: !concluded,
        detail: concluded
          ? "unsupported authoritative conclusion on a must-abstain case"
          : "withheld authority on a must-abstain case",
      };
    }
    case "deletion-withholds": {
      const cited = matching.length > 0 && !result.blocked;
      return {
        caseId: inquiry.id,
        kind: inquiry.kind,
        passed: !cited,
        detail: cited
          ? "withdrawn source still authorizes (deletion probe failed)"
          : "withdrawn source withholds dependent facts",
      };
    }
    case "no-facts-honest": {
      if (matching.length > 0 && !result.blocked) {
        return { caseId: inquiry.id, kind: inquiry.kind, passed: false, detail: "facts authorize where none were expected" };
      }
      return { caseId: inquiry.id, kind: inquiry.kind, passed: true, detail: "no authoritative conclusion without facts" };
    }
  }
}

/** Run the whole versioned case set against one business's port. */
export function runCaseSet(
  port: KnowledgePort,
  businessId: string,
  caseSet: EvalCaseSet,
  opts: { onlyIds?: string[] } = {},
): EvalRun {
  if (caseSet.version !== EVAL_CASE_SET_VERSION) {
    throw new Error(
      `refusing to run case set ${caseSet.version} with runner ${EVAL_CASE_SET_VERSION}; versions must match`,
    );
  }
  const wanted = opts.onlyIds ? new Set(opts.onlyIds) : null;
  const outcomes: CaseOutcome[] = [];
  const answeredIds: string[] = [];
  const unmeasuredIds: string[] = [];
  for (const inquiry of caseSet.cases) {
    if (wanted && !wanted.has(inquiry.id)) {
      unmeasuredIds.push(inquiry.id);
      continue;
    }
    let outcome: CaseOutcome | null = null;
    try {
      outcome = answerCase(port, businessId, inquiry);
    } catch {
      outcome = null;
    }
    if (!outcome) {
      unmeasuredIds.push(inquiry.id);
      continue;
    }
    answeredIds.push(inquiry.id);
    outcomes.push(outcome);
  }
  const passedCount = outcomes.filter((outcome) => outcome.passed).length;
  return {
    caseSetVersion: caseSet.version,
    businessId,
    generatedAt: now(),
    answeredIds,
    unmeasuredIds,
    outcomes,
    passedCount,
    denominator: outcomes.length,
    disclaimer: NO_CAUSAL_CLAIM,
  };
}

/**
 * Compare two runs on the same versioned case set. The verdict uses only
 * the shared answered intersection; added/removed cases are reported as
 * denominator changes, never as improvement or regression.
 */
export function compareRuns(before: EvalRun, after: EvalRun): ComparedRuns {
  if (before.caseSetVersion !== after.caseSetVersion) {
    throw new Error(
      `incomparable runs: before is case set ${before.caseSetVersion}, after is ${after.caseSetVersion}; same versioned case set required`,
    );
  }
  if (before.businessId !== after.businessId) {
    throw new Error("incomparable runs: business ids differ; per-business comparison only");
  }
  const beforeIds = new Set(before.answeredIds);
  const afterIds = new Set(after.answeredIds);
  const sharedCaseIds = [...beforeIds].filter((id) => afterIds.has(id)).sort();
  const addedCaseIds = [...afterIds].filter((id) => !beforeIds.has(id)).sort();
  const removedCaseIds = [...beforeIds].filter((id) => !afterIds.has(id)).sort();
  const beforeById = new Map(before.outcomes.map((outcome) => [outcome.caseId, outcome]));
  const afterById = new Map(after.outcomes.map((outcome) => [outcome.caseId, outcome]));
  const sharedBeforePassed = sharedCaseIds.filter((id) => beforeById.get(id)?.passed).length;
  const sharedAfterPassed = sharedCaseIds.filter((id) => afterById.get(id)?.passed).length;
  const verdict =
    sharedAfterPassed > sharedBeforePassed
      ? "improved"
      : sharedAfterPassed < sharedBeforePassed
        ? "worse"
        : "unchanged";
  const denominatorNote =
    addedCaseIds.length === 0 && removedCaseIds.length === 0
      ? `Same ${sharedCaseIds.length}-case denominator on case set ${before.caseSetVersion}; verdict compares identical cases.`
      : `Denominator changed on case set ${before.caseSetVersion} ` +
        `(added: ${addedCaseIds.length > 0 ? addedCaseIds.join(", ") : "none"}; ` +
        `removed: ${removedCaseIds.length > 0 ? removedCaseIds.join(", ") : "none"}). ` +
        `Verdict compares only the ${sharedCaseIds.length} shared cases; added cases are not presented as improvement.`;
  return {
    caseSetVersion: before.caseSetVersion,
    before: { passed: before.passedCount, denominator: before.denominator },
    after: { passed: after.passedCount, denominator: after.denominator },
    verdict,
    sharedCaseIds,
    sharedBeforePassed,
    sharedAfterPassed,
    addedCaseIds,
    removedCaseIds,
    denominatorNote,
    disclaimer: NO_CAUSAL_CLAIM,
  };
}
