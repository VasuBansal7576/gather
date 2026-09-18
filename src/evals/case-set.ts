import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * ADR-005 versioned regression case set (C10).
 *
 * Owner corrections create confirmed expectations; those expectations
 * become cases here. Before/after runs MUST use the same case-set version:
 * new cases change the denominator and are reported separately — they can
 * never masquerade as improvement on an unchanged set. Scores describe only
 * this case set; no causal business-improvement claim is ever derived.
 */

export const EVAL_CASE_SET_VERSION = "005-v1";

export const NO_CAUSAL_CLAIM =
  "Scores describe only this versioned case set. A higher score does not " +
  "claim causal business improvement, and an unchanged or worse score is " +
  "reported honestly, never forced to rise.";

export type EvalCaseKind =
  | "confirmed-fact-applies"
  | "scoped-exception-bounded"
  | "must-abstain"
  | "deletion-withholds"
  | "no-facts-honest";

export interface EvalCase {
  id: string;
  kind: EvalCaseKind;
  /** Owner-readable question the reviewer would ask. */
  question: string;
  factKey?: string;
  subjectId?: string;
  /** Booking/customer scope the expectation is bounded to, when any. */
  scope?: { type: "booking" | "customer"; id: string };
  /** True when the only honest outcome is abstention (no authoritative conclusion). */
  mustAbstain?: boolean;
  /** True when the backing source is withdrawn (deletion probe). */
  deletionProbe?: boolean;
  detail: string;
}

export interface EvalCaseSet {
  version: string;
  generatedAt: string;
  cases: EvalCase[];
}

/** Default search locations for the checked-in case-set artifact. */
export function loadCaseSet(fromDir?: string): EvalCaseSet {
  const root = fromDir ?? process.cwd();
  const raw = readFileSync(join(root, "evaluation", "knowledge", "caseset-005-v1.json"), "utf8");
  const parsed = JSON.parse(raw) as EvalCaseSet;
  if (parsed.version !== EVAL_CASE_SET_VERSION) {
    throw new Error(
      `case-set version mismatch: artifact is ${parsed.version}, runner expects ${EVAL_CASE_SET_VERSION}`,
    );
  }
  if (!Array.isArray(parsed.cases) || parsed.cases.length === 0) {
    throw new Error("case set carries no cases; refusing to score an empty denominator");
  }
  return parsed;
}
