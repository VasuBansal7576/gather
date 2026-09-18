import { KnowledgeError } from "./service.ts";

/**
 * ADR-005 scoped concession form (consumer-side validation, C05).
 *
 * The form collects the explicit scope and limits an owner must state
 * before any concession policy exists: maximum cumulative reduction, floor,
 * and booking/customer/date/package bounds. Validation is deterministic and
 * runs before anything reaches the knowledge decisions.
 *
 * Hard guarantees:
 * - a concession can never self-authorize from proposal or customer text;
 * - confirmation produces a scoped exception only, never standing send
 *   authority (`sendAuthority` is always 'none' and the UI must render the
 *   exact-approval notice);
 * - commercial permission to propose a discount never authorizes sending.
 */

export interface ConcessionFormInput {
  /** Maximum cumulative reduction, e.g. { percent: 10 } or { minor: 50000, currency: 'USD' }. */
  maxReduction?: { percent?: number; minor?: number; currency?: string };
  /** Floor total in minor units with explicit currency, when any. */
  floor?: { minor?: number; currency?: string };
  /** Scope selection from the form's scope control. */
  scopeType?: string;
  scopeId?: string;
  /** Optional date/package bounds (free text restated verbatim, never parsed into authority). */
  dateBounds?: string;
  packageBounds?: string;
}

export interface ValidatedConcessionForm {
  value: Record<string, unknown>;
  scope: { type: "booking" | "customer"; id: string };
  limits: string[];
  scopeLabel: string;
  /** Always 'none': this form can never grant standing send authority. */
  sendAuthority: "none";
  approvalNotice: string;
}

export const CONCESSION_APPROVAL_NOTICE =
  "A confirmed concession only permits proposing a discount inside these limits. " +
  "Every outbound action still needs its own exact owner approval — there is no standing send authority.";

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Validate the scoped concession form. Returns the canonical draft plus the
 * approval notice, or throws KnowledgeError('invalid') naming each missing
 * field. Throws rather than guessing: an incomplete form never becomes a
 * policy.
 */
export function validateConcessionForm(input: ConcessionFormInput): ValidatedConcessionForm {
  const problems: string[] = [];
  if (input.scopeType !== "booking" && input.scopeType !== "customer") {
    problems.push("scope must be booking or customer; concessions never apply silently business-wide");
  }
  if (!isNonEmpty(input.scopeId)) {
    problems.push("scope id is required; a concession without an explicit booking or customer id cannot be confirmed");
  }
  const percent = input.maxReduction?.percent;
  const minor = input.maxReduction?.minor;
  const currency = input.maxReduction?.currency;
  const hasPercent = typeof percent === "number" && Number.isFinite(percent) && percent > 0 && percent <= 100;
  const hasMinor = typeof minor === "number" && Number.isInteger(minor) && minor > 0;
  if (!hasPercent && !hasMinor) {
    problems.push("a maximum reduction is required: a percent (0-100], a capped minor-unit total with currency, or both");
  }
  if (minor !== undefined && hasMinor && currency !== "USD") {
    problems.push("a capped total needs its explicit currency (USD); amounts without currency are never assumed");
  }
  if (input.floor !== undefined) {
    if (
      typeof input.floor.minor !== "number" ||
      !Number.isInteger(input.floor.minor) ||
      input.floor.minor < 0 ||
      input.floor.currency !== "USD"
    ) {
      problems.push("a floor must be a non-negative minor-unit total with explicit currency (USD)");
    }
  }
  if (problems.length > 0) {
    throw new KnowledgeError("invalid", `Concession form is incomplete: ${problems.join("; ")}`);
  }
  const scope = {
    type: input.scopeType as "booking" | "customer",
    id: (input.scopeId as string).trim(),
  };
  const limits: string[] = [];
  if (hasPercent) limits.push(`at most ${percent as number}% per proposal`);
  if (hasMinor) {
    limits.push(`at most ${((minor as number) / 100).toFixed(2)} ${currency} cumulative`);
  }
  if (input.floor !== undefined) {
    limits.push(`never below ${((input.floor.minor as number) / 100).toFixed(2)} ${input.floor.currency}`);
  }
  if (isNonEmpty(input.dateBounds)) limits.push(`dates: ${input.dateBounds.trim()}`);
  if (isNonEmpty(input.packageBounds)) limits.push(`packages: ${input.packageBounds.trim()}`);
  const value: Record<string, unknown> = {
    allowed: true,
    ...(hasPercent ? { maxReductionBps: Math.round((percent as number) * 100) } : {}),
    ...(hasMinor ? { maxCumulativeReductionMinor: minor, currency } : {}),
    ...(input.floor === undefined
      ? {}
      : { floorCents: input.floor.minor, floorCurrency: input.floor.currency }),
    ...(isNonEmpty(input.dateBounds) ? { dateBounds: input.dateBounds.trim() } : {}),
    ...(isNonEmpty(input.packageBounds) ? { packageBounds: input.packageBounds.trim() } : {}),
  };
  return {
    value,
    scope,
    limits,
    scopeLabel:
      scope.type === "booking" ? `booking ${scope.id} only` : `customer ${scope.id} only`,
    sendAuthority: "none",
    approvalNotice: CONCESSION_APPROVAL_NOTICE,
  };
}
