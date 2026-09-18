import type { SourceCoverage } from "./types.ts";

/**
 * C03 honest-absence messages (ADR-007 step 3).
 *
 * The exact wording is contract-fixed: a failed or in-progress scan must
 * never read as a completed empty one, and an absent scan is not a lead
 * count. Counts come from durable evidence (coverage + domain decisions),
 * never from a guess.
 */
export interface ScanStateMessage {
  /** One machine-checkable state token plus the owner-facing sentence. */
  state: "no_scan" | "failed" | "in_progress" | "no_leads" | "has_leads";
  message: string;
  scopeNote: string;
}

export function describeScanState(input: {
  coverage: SourceCoverage | undefined;
  /** Emails observed in scope (durable coverage or intake evidence). */
  emailsScanned: number;
  /** Eligible event inquiries recorded by the ADR-003 domain gate. */
  eligibleInquiries: number;
}): ScanStateMessage {
  const coverage = input.coverage;
  const scopeNote = coverage === undefined
    ? ""
    : `scope: ${coverage.windowDays}-day window ending ${coverage.windowStart ?? "unknown"}${
        coverage.excluded.count > 0 ? `, ${coverage.excluded.count} older record(s) excluded (expandable)` : ""
      }`;
  if (coverage === undefined) {
    return { state: "no_scan", message: "No scan has completed yet", scopeNote: "no source coverage recorded" };
  }
  if (coverage.state === "failed") {
    return {
      state: "failed",
      message: `The source scan could not complete${coverage.lastSuccessAt === undefined ? "" : `; last successful coverage ${coverage.lastSuccessAt}`}`,
      scopeNote: coverage.detail ?? scopeNote,
    };
  }
  if (input.eligibleInquiries > 0) {
    return {
      state: "has_leads",
      message: `${input.eligibleInquiries} event inquiry(ies) found`,
      scopeNote,
    };
  }
  if (coverage.state === "complete") {
    return {
      state: "no_leads",
      message: `Scanned ${input.emailsScanned} emails. No event inquiries found`,
      scopeNote,
    };
  }
  return {
    state: "in_progress",
    message: "No event inquiries found yet; scanning continues",
    scopeNote,
  };
}

/** C03 zero-facts honesty: absent knowledge is stated, never implied. */
export function describeFactsState(businessFacts: number): string {
  return businessFacts > 0 ? `${businessFacts} business fact(s) on record` : "No business information found yet";
}
