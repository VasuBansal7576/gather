import type { SourceReference } from "../domain/contracts.ts";
import type { DecisionCommand } from "./service.ts";
import { KnowledgeError, KnowledgeService } from "./service.ts";
import type { FactScope, KnowledgeActor } from "./types.ts";

/**
 * ADR-005 plain-language owner rule parsing (consumer over KnowledgeService).
 *
 * `parseOwnerRuleText` is a pure deterministic function: it never touches
 * storage and can never mint policy by itself. An owner still confirms the
 * parsed draft through `confirmParsedRule`, which routes into the existing
 * versioned decisions (correctFact / addScopedException) with the
 * host-derived owner actor. Model/content actors are denied at confirm
 * time, and ambiguous text returns clarification questions instead of a
 * guess. No parser output ever grants send authority.
 */

export type ParsedRuleKind = "concession-policy" | "price-floor" | "capacity";

export interface ParsedRuleScope {
  /** Booking/customer scope, or global for business-wide price/capacity facts. */
  type: FactScope;
  /** Required when type is booking or customer. */
  id?: string;
  /** Human-readable scope shown to the owner before confirmation. */
  label: string;
}

export interface ParsedRuleDraft {
  kind: ParsedRuleKind;
  /** Knowledge fact key this draft would write. */
  key: string;
  subjectId: string;
  scope: ParsedRuleScope;
  /** Canonical value the confirm path would write (never free text). */
  value: Record<string, unknown>;
  /** Plain-language limits restated for the confirmation screen. */
  limits: string[];
  /** Warnings the owner must see (e.g. unknown costs block profit claims). */
  warnings: string[];
  /** Always 'none': parsing never carries send authority. */
  sendAuthority: "none";
}

export type ParseOwnerRuleResult =
  | { status: "parsed"; draft: ParsedRuleDraft; echo: string }
  | { status: "needs_clarification"; questions: string[]; echo: string };

function echoOf(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length > 280 ? `${trimmed.slice(0, 277)}...` : trimmed;
}

function scopeLabel(type: FactScope, id?: string): string {
  if (type === "booking") return `booking ${id ?? "(missing id)"} only`;
  if (type === "customer") return `customer ${id ?? "(missing id)"} only`;
  return "whole business";
}

function findScopeId(text: string, noun: "booking" | "customer"): string | undefined {
  const match = text.match(new RegExp(`${noun}\\s+([A-Za-z0-9][A-Za-z0-9_-]{0,63})`, "i"));
  return match?.[1];
}

function parseMoneyMinor(text: string): { minor: number; currency: string } | null {
  // Explicit USD only. Any other currency marker, or a bare amount with no
  // currency evidence, returns null so the caller asks instead of assuming.
  const usd = text.match(/\$\s*([\d,]+(?:\.\d{1,2})?)/);
  if (usd?.[1]) {
    const major = Number(usd[1].replace(/,/g, ""));
    if (Number.isFinite(major) && major >= 0) {
      return { minor: Math.round(major * 100), currency: "USD" };
    }
  }
  return null;
}

function mentionsMoney(text: string): boolean {
  return /[$€£¥]|dollars?|cents?|\bUSD\b|\bEUR\b/i.test(text);
}

/**
 * Deterministically parse an owner-typed rule into a confirmable draft.
 * Anything ambiguous — unknown intent, missing scope for a concession,
 * money without explicit currency, percentages without a base — returns
 * clarification questions. Parsing alone changes nothing.
 */
export function parseOwnerRuleText(text: string): ParseOwnerRuleResult {
  const echo = echoOf(text);
  const lowered = ` ${text.toLowerCase()} `;
  if (echo.length === 0) {
    return {
      status: "needs_clarification",
      echo,
      questions: ["The rule text is empty. Describe the price, capacity, or concession policy to set."],
    };
  }

  const isConcession =
    /concession|discount|%|\boff\b|reduce|reduction|waiv|free\b|deal|comp\b/i.test(text);
  const isFloor =
    /floor|minimum|min total|never below|at least|no less than/i.test(text) && !isConcession;
  const isCapacity =
    /(capacity|holds?|seats?|fits?|room|space|guests?)/i.test(text) &&
    /\d+/.test(text) &&
    !isConcession &&
    !isFloor;

  // ---------- concession policy ----------
  if (isConcession) {
    const questions: string[] = [];
    const percent = lowered.match(/(\d+(?:\.\d+)?)\s*%/);
    const upToMoney = /up\s*to/i.test(text) ? parseMoneyMinor(text) : null;
    const flatMoney = !/up\s*to/i.test(text) && /max|cap|limit|total/i.test(text)
      ? parseMoneyMinor(text)
      : null;
    const capMinor = upToMoney?.minor ?? flatMoney?.minor ?? null;
    if (mentionsMoney(text) && capMinor === null) {
      questions.push(
        "The amount needs an explicit currency (e.g. $500 USD). Which currency applies, with no assumption?",
      );
    }
    if (!percent && capMinor === null) {
      questions.push(
        "How large may the concession be — a percentage (e.g. 10%), a capped total (e.g. up to $500 USD), or both?",
      );
    }
    const scopeType: FactScope | null = /booking/i.test(text)
      ? "booking"
      : /customer/i.test(text)
        ? "customer"
        : /everyone|all bookings|business-wide|anyone|whole business/i.test(text)
          ? "global"
          : null;
    let scopeId: string | undefined;
    if (scopeType === "booking") scopeId = findScopeId(text, "booking");
    if (scopeType === "customer") scopeId = findScopeId(text, "customer");
    if (scopeType === null) {
      questions.push(
        "Which scope does this concession cover — a specific booking id, a specific customer id, or the whole business?",
      );
    } else if (scopeType !== "global" && !scopeId) {
      questions.push(
        `A ${scopeType}-scoped concession needs the exact ${scopeType} id it applies to. Which ${scopeType} id?`,
      );
    }
    if (scopeType === "global") {
      questions.push(
        "A business-wide concession needs explicit bounds (dates, packages, or a cap) before it can be confirmed. What bounds apply?",
      );
    }
    if (questions.length > 0) return { status: "needs_clarification", echo, questions };
    const confirmedScope: ParsedRuleScope = {
      type: scopeType as "booking" | "customer",
      id: scopeId,
      label: scopeLabel(scopeType as FactScope, scopeId),
    };
    const limits: string[] = [];
    if (percent) limits.push(`at most ${percent[1]}% per proposal`);
    if (capMinor !== null) limits.push(`at most ${(capMinor / 100).toFixed(2)} USD cumulative`);
    const value: Record<string, unknown> = {
      allowed: true,
      ...(percent ? { maxReductionBps: Math.round(Number(percent[1]) * 100) } : {}),
      ...(capMinor !== null ? { maxCumulativeReductionMinor: capMinor, currency: "USD" } : {}),
    };
    return {
      status: "parsed",
      echo,
      draft: {
        kind: "concession-policy",
        key: "policy",
        subjectId: "concessions",
        scope: confirmedScope,
        value,
        limits,
        warnings: [
          "Commercial permission to propose a discount does not authorize sending; every outbound action still needs its own exact approval.",
          "Unknown costs permit no profit claim; a margin rule with unknown costs blocks.",
        ],
        sendAuthority: "none",
      },
    };
  }

  // ---------- price floor ----------
  if (isFloor) {
    const questions: string[] = [];
    const money = parseMoneyMinor(text);
    if (!money) {
      questions.push(
        mentionsMoney(text)
          ? "The floor amount needs an explicit currency (e.g. $1,000 USD). Which currency applies?"
          : "What floor amount applies (e.g. $1,000 USD, stated with currency)?",
      );
    }
    if (questions.length > 0) return { status: "needs_clarification", echo, questions };
    const amount = money as { minor: number; currency: string };
    return {
      status: "parsed",
      echo,
      draft: {
        kind: "price-floor",
        key: "pricing_bounds",
        subjectId: "",
        scope: { type: "global", label: scopeLabel("global") },
        value: { currency: amount.currency, floorCents: amount.minor, costsComplete: false },
        limits: [`no proposal below ${(amount.minor / 100).toFixed(2)} ${amount.currency}`],
        warnings: ["Costs are not stated complete, so no profit claim may be made from this floor."],
        sendAuthority: "none",
      },
    };
  }

  // ---------- capacity ----------
  if (isCapacity) {
    const count = lowered.match(/(\d+)\s*(guests?|people|seats?|capacity)?/);
    const room = text.match(/(room|space|hall)\s+([A-Za-z0-9][A-Za-z0-9 _-]{0,63})/i);
    const questions: string[] = [];
    if (!count?.[1]) questions.push("How many guests does the space hold?");
    if (!room?.[2]) questions.push("Which room or space does this capacity describe?");
    if (questions.length > 0) return { status: "needs_clarification", echo, questions };
    const capacity = Number(count?.[1]);
    const spaceId = (room?.[2] ?? "main").trim().toLowerCase().replace(/\s+/g, "-");
    return {
      status: "parsed",
      echo,
      draft: {
        kind: "capacity",
        key: "space",
        subjectId: spaceId,
        scope: { type: "global", label: scopeLabel("global") },
        value: { spaceId, capacityMax: capacity, capacityMin: 1 },
        limits: [`${spaceId} holds at most ${capacity} guests`],
        warnings: [],
        sendAuthority: "none",
      },
    };
  }

  return {
    status: "needs_clarification",
    echo,
    questions: [
      "This does not read as a price, capacity, or concession rule. Restate it as one of: a price floor with currency, a room capacity, or a scoped concession with an explicit limit.",
    ],
  };
}

// ---------- confirmation ----------

export interface ConfirmParsedRuleInput {
  businessId: string;
  actor: KnowledgeActor;
  draft: ParsedRuleDraft;
  /** Current revision when overwriting a global fact (price-floor/capacity). */
  expectedRevision?: number;
  commandId?: string;
  sourceReferences?: SourceReference[];
}

function assertOwner(actor: KnowledgeActor): void {
  if (actor.kind !== "owner") {
    throw new KnowledgeError(
      "denied",
      `actor kind "${actor.kind}" can never confirm a rule; only an explicit owner command has that authority`,
    );
  }
  if (typeof actor.id !== "string" || actor.id.trim().length === 0) {
    throw new KnowledgeError("denied", "owner actor requires a non-empty id");
  }
}

/**
 * Confirm a parsed draft into versioned policy. Concession drafts become
 * booking/customer-scoped exceptions (they can never silently globalize);
 * price and capacity drafts become versioned global corrections. Content or
 * model actors are denied, and no path grants send authority.
 */
export function confirmParsedRule(
  service: KnowledgeService,
  input: ConfirmParsedRuleInput,
): { kind: ParsedRuleKind; factId: string; revision: number; duplicate: boolean } {
  assertOwner(input.actor);
  const command: DecisionCommand = {
    businessId: input.businessId,
    actor: input.actor,
    ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
  };
  const sources = input.sourceReferences ?? [
    {
      kind: "manual" as const,
      locator: `gather://owner-rule/${input.draft.kind}`,
      label: "Owner-typed plain-language rule",
    },
  ];
  if (input.draft.sendAuthority !== "none") {
    throw new KnowledgeError("invalid", "parsed rules never carry send authority");
  }
  if (input.draft.kind === "concession-policy") {
    if (input.draft.scope.type === "global" || !input.draft.scope.id) {
      throw new KnowledgeError(
        "invalid",
        "concession drafts require an explicit booking or customer scope id; they can never silently globalize",
      );
    }
    const result = service.addScopedException({
      ...command,
      policyId: `owner-rule:${input.draft.kind}`,
      effect: "allow",
      scope: input.draft.scope.type,
      scopeId: input.draft.scope.id,
      subjectId: input.draft.subjectId,
      value: input.draft.value,
    });
    return { kind: input.draft.kind, factId: result.fact.id, revision: result.revision.revision, duplicate: result.duplicate };
  }
  if (input.expectedRevision === undefined) {
    throw new KnowledgeError(
      "invalid",
      "price and capacity drafts overwrite a global fact and require its current expectedRevision; re-read before confirming",
    );
  }
  const result = service.correctFact({
    ...command,
    key: input.draft.key,
    ...(input.draft.subjectId ? { subjectId: input.draft.subjectId } : {}),
    expectedRevision: input.expectedRevision,
    value: input.draft.value,
    sourceReferences: sources,
  });
  return { kind: input.draft.kind, factId: result.fact.id, revision: result.revision.revision, duplicate: result.duplicate };
}
