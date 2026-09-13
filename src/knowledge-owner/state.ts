import type { KnowledgeCandidate, KnowledgeFact, KnowledgeSourceReference, WithheldFact, WorkspaceBooking } from "./types.ts";

/**
 * Pure review-shaping helpers for the owner knowledge view. No React, no
 * fetch — safe to unit-test in plain node.
 *
 * Review policy: consequential candidates (prices, bounds, costs, policies)
 * and conflicting observations come first. Reviewing is always optional per
 * item: unreviewed candidates simply stay pending and confirmed facts stay
 * in force — nothing here forces approving every snippet.
 */

/** Consequential keys first; the order is a review priority, not a mandate. */
const REVIEW_PRIORITY: readonly string[] = [
  "price_line",
  "pricing_bounds",
  "cost",
  "policy",
  "scoped_exception",
  "space",
  "service",
  "business",
];

function priorityOf(key: string): number {
  const index = REVIEW_PRIORITY.indexOf(key);
  return index === -1 ? REVIEW_PRIORITY.length : index;
}

export type ReviewGroup = "needs-review" | "stale" | "decided";

export function groupOf(candidate: KnowledgeCandidate): ReviewGroup {
  if (candidate.status === "pending") return "needs-review";
  if (candidate.status === "stale") return "stale";
  return "decided";
}

const GROUP_ORDER: Record<ReviewGroup, number> = { "needs-review": 0, stale: 1, decided: 2 };

/**
 * Focused queue order: needs-review before stale before decided; within
 * needs-review, conflicting candidates first, then consequential keys, then
 * oldest observation. Stable and total — every candidate appears exactly
 * once, so nothing can be silently dropped from review.
 */
export function sortCandidatesForReview(candidates: readonly KnowledgeCandidate[]): KnowledgeCandidate[] {
  return [...candidates].sort((a, b) => {
    const group = GROUP_ORDER[groupOf(a)] - GROUP_ORDER[groupOf(b)];
    if (group !== 0) return group;
    const conflict = Number(b.conflictsWith.length > 0) - Number(a.conflictsWith.length > 0);
    if (conflict !== 0) return conflict;
    const priority = priorityOf(a.key) - priorityOf(b.key);
    if (priority !== 0) return priority;
    if (a.ingestedAt < b.ingestedAt) return -1;
    if (a.ingestedAt > b.ingestedAt) return 1;
    return a.id < b.id ? -1 : 1;
  });
}

export function countNeedsReview(candidates: readonly KnowledgeCandidate[]): number {
  return candidates.filter((candidate) => groupOf(candidate) === "needs-review").length;
}

export function conflictingCandidates(
  candidates: readonly KnowledgeCandidate[],
  candidate: KnowledgeCandidate,
): KnowledgeCandidate[] {
  const ids = new Set(candidate.conflictsWith);
  return candidates.filter((other) => ids.has(other.id));
}

export function withheldForFact(withheld: readonly WithheldFact[], factId: string): WithheldFact | undefined {
  return withheld.find((entry) => entry.factId === factId);
}

/**
 * Meaningful label for an exception scope target: the booking event name
 * when the id matches an owned-business booking, otherwise the raw id.
 * Never invents a record — unknown ids render as-is.
 */
export function scopeTargetLabel(
  scope: "booking" | "customer" | string,
  scopeId: string | undefined,
  bookings: readonly WorkspaceBooking[],
): string {
  if (!scopeId) return scope;
  if (scope !== "booking") return `${scope} ${scopeId}`;
  const match = bookings.find((booking) => booking.id === scopeId);
  return match ? `${match.eventName} (${match.id})` : scopeId;
}

/** Bookings of one business, oldest first, for scope selection. */
export function bookingsForBusiness(
  bookings: readonly WorkspaceBooking[],
  businessId: string,
): WorkspaceBooking[] {
  return bookings.filter((booking) => booking.businessId === businessId);
}

export function scopedFacts(facts: readonly KnowledgeFact[]): KnowledgeFact[] {
  return facts.filter((fact) => fact.key === "scoped_exception");
}

export function globalFacts(facts: readonly KnowledgeFact[]): KnowledgeFact[] {
  return facts.filter((fact) => fact.key !== "scoped_exception");
}

export function policyFacts(facts: readonly KnowledgeFact[]): KnowledgeFact[] {
  return facts.filter((fact) => fact.key === "policy");
}

/** Short human key label for headings. */
export function keyLabel(key: string): string {
  switch (key) {
    case "price_line": return "Price";
    case "pricing_bounds": return "Pricing bounds";
    case "cost": return "Cost";
    case "policy": return "Policy";
    case "scoped_exception": return "Scoped exception";
    case "space": return "Space";
    case "service": return "Service";
    case "business": return "Business";
    default: return key;
  }
}

/** Subject fallback when no subject id is recorded. */
export function subjectLabel(candidate: Pick<KnowledgeCandidate, "subjectId" | "key">): string {
  return candidate.subjectId.trim().length > 0 ? candidate.subjectId : `${candidate.key} (general)`;
}

/**
 * Monetary rendering with explicit source currency only. A numeric
 * amountCents paired with a usable currency renders via Intl in that
 * currency; without one it renders an honest minor-unit label. Currency is
 * never guessed and profit is never claimed here.
 */
export function formatMoneyPart(amountCents: number, currency: unknown): string {
  if (typeof currency === "string" && currency.trim().length > 0) {
    try {
      return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.trim() }).format(amountCents / 100);
    } catch {
      // Invalid currency code: fall through to the honest label below.
    }
  }
  return `${amountCents} minor units (currency not stated)`;
}

/**
 * Load generation guard: each async load carries a monotonically
 * increasing generation and only the latest generation may commit its
 * success, error, or cleanup. Late responses from a superseded business
 * selection are dropped so out-of-order delivery can never overwrite the
 * current business view, loading state, or action state.
 */
export class LoadGeneration {
  private current = 0;
  next(): number {
    this.current += 1;
    return this.current;
  }
  isCurrent(generation: number): boolean {
    return generation === this.current;
  }
}

/**
 * Bounded one-line summary of a fact value. Known monetary values render
 * through formatMoneyPart; other objects render as `k: v` pairs; long text
 * is truncated so a large document value cannot blow out the card.
 */
export function formatValue(value: Record<string, unknown>, maxLength = 160): string {
  const parts: string[] = [];
  const amount = value.amountCents;
  if (typeof amount === "number" && Number.isFinite(amount)) {
    parts.push(formatMoneyPart(amount, value.currency));
    for (const [key, entry] of Object.entries(value)) {
      if (key === "amountCents" || key === "currency") continue;
      parts.push(`${key}: ${formatScalar(entry)}`);
    }
  } else {
    for (const [key, entry] of Object.entries(value)) {
      parts.push(`${key}: ${formatScalar(entry)}`);
    }
  }
  const joined = parts.join(" · ");
  return joined.length > maxLength ? `${joined.slice(0, maxLength - 1)}…` : joined;
}

function formatScalar(value: unknown): string {
  if (value === null) return "—";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  const text = JSON.stringify(value) ?? "—";
  return text.length > 48 ? `${text.slice(0, 47)}…` : text;
}

/** Source kind label for attribution lines. */
export function sourceKindLabel(kind: string): string {
  switch (kind) {
    case "document": return "Document";
    case "email": return "Email";
    case "calendar": return "Calendar";
    case "connected_account": return "Connected app";
    case "manual": return "Owner-entered";
    case "fixture": return "Fixture";
    default: return kind;
  }
}

/** True when every source is explicitly fictional fixture data. */
export function isFixtureOnly(sources: readonly KnowledgeSourceReference[]): boolean {
  return sources.length > 0 && sources.every((source) => source.fictional === true);
}

export type DecisionEffect =
  | { kind: "confirm"; headline: string; detail: string }
  | { kind: "reject"; headline: string; detail: string }
  | { kind: "correct"; headline: string; detail: string }
  | { kind: "exception"; headline: string; detail: string };

/**
 * Plain-language consequence for each decision, shown next to the action so
 * the owner approves an exact effect — never a vague "approve" button.
 */
export function describeConfirmEffect(candidate: KnowledgeCandidate): DecisionEffect {
  return {
    kind: "confirm",
    headline: `Use this ${keyLabel(candidate.key).toLowerCase()} for ${subjectLabel(candidate)} business-wide`,
    detail: "Confirmed facts feed offers and proposals. Other unconfirmed observations stay pending — nothing else changes.",
  };
}

export function describeRejectEffect(candidate: KnowledgeCandidate): DecisionEffect {
  void candidate;
  return {
    kind: "reject",
    headline: "Dismiss this observation",
    detail: "The candidate is marked rejected and will never become a fact. Confirmed facts and other candidates are untouched.",
  };
}

export function describeCorrectEffect(key: string, subjectId: string, revision: number): DecisionEffect {
  return {
    kind: "correct",
    headline: `Replace revision ${revision} of ${subjectLabel({ subjectId, key })}`,
    detail: "A new revision becomes the active confirmed fact. The previous revision is kept as superseded history.",
  };
}

export function describeExceptionEffect(scope: "booking" | "customer", scopeId: string): DecisionEffect {
  return {
    kind: "exception",
    headline: `Exception for this ${scope} only (${scopeId})`,
    detail: "The global policy stays exactly as confirmed. This exception applies to one booking or customer and is listed separately.",
  };
}

/** Parse owner-typed JSON object values with a friendly error. */
export function parseValueJson(text: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, error: "That is not valid JSON — check commas and quotes, then try again." };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "The value must be a JSON object (starting with { and ending with })." };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

/** Idempotency key for owner decisions (retries reuse the same key). */
export function newCommandId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `cmd_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`;
}
