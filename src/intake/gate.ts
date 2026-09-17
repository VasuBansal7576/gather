/**
 * ADR-003 event-domain gate. The gate classifies an inbox message's DOMAIN —
 * whether it is an event inquiry for this business — which is deliberately
 * separate from qualification completeness (missing date/guest count/event
 * type stay inside an eligible result as `missingFields`).
 *
 * Outcomes:
 * - `eligible`     — recognizably an event inquiry; proceeds into the normal
 *                    identity/ledger flow. Missing qualification fields are
 *                    reported, never invented.
 * - `unrelated`    — recognizably NOT an event inquiry (invoice, newsletter,
 *                    vendor pitch, unrelated instructions, automated mail).
 *                    The item is skipped: no booking write, no ledger event,
 *                    no identity decision.
 * - `needs_review` — ambiguous content, unavailable classifier, or unreadable
 *                    message. Always parked for owner review; unknown is
 *                    never permission and never a fabricated "no leads".
 *
 * A classifier verdict is advisory only: the gate sanitizes it and every
 * failure mode (no classifier, throw, malformed verdict, explicit
 * unknown/unavailable) collapses to `needs_review` — classification output
 * can never mint a booking, an approval, or a pass.
 */

export type DomainOutcome = "eligible" | "unrelated" | "needs_review";

export const DOMAIN_OUTCOMES: readonly DomainOutcome[] = ["eligible", "unrelated", "needs_review"];

/**
 * Qualification gaps for an eligible inquiry — displayable, and never
 * blocking the domain decision itself. Values are stable snake_case field
 * ids ("event_date", "event_time", "guest_count", "event_type").
 */
export interface DomainGateDecision {
  outcome: DomainOutcome;
  /** Displayable, owner-readable reasons for the outcome (empty allowed for eligible). */
  reasons: string[];
  /** Missing qualification fields reported separately from the domain outcome. */
  missingFields: string[];
  /** Fields the classifier positively extracted from the message. */
  extracted: {
    eventType?: string;
    dateHints: string[];
    guestCount?: number;
  };
}

export interface DomainGateInput {
  messageId: string;
  subject: string;
  body: string;
  from?: string;
  /** Source tag durable on the decision row (e.g. the inbox provenance label or "prepared-composer"). */
  sourceTag: string;
}

/**
 * A classifier's raw verdict. `classified` carries a decision; `unknown`
 * means the classifier ran but produced no trustworthy verdict (malformed
 * model output, empty response); `unavailable` means the classifier could
 * not run at all (no adapter, transport failure, model not configured).
 * Both non-classified statuses map to needs_review — never to a silent pass.
 */
export type ClassifierVerdict =
  | { status: "classified"; decision: DomainGateDecision }
  | { status: "unknown"; reason: string }
  | { status: "unavailable"; reason: string };

export interface DomainClassifier {
  /** Stable identity recorded on every decision (e.g. "scripted-prepared" or a model id). */
  readonly id: string;
  /** True when the classifier is scripted/simulated — decisions stay labelled. */
  readonly simulated: boolean;
  classify(input: DomainGateInput): Promise<ClassifierVerdict>;
}

export interface DomainGateResult {
  decision: DomainGateDecision;
  /** The classifier identity behind the decision, or "none" when none ran. */
  classifierId: string;
  /** True when the decision came from a scripted/simulated classifier. */
  simulated: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const MAX_REASONS = 20;
const MAX_MISSING = 20;
const MAX_DATE_HINTS = 10;
const MAX_TEXT = 500;

function cleanStrings(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .slice(0, max)
    .map((entry) => entry.slice(0, MAX_TEXT));
}

/**
 * Sanitize a classified decision. Model/classifier output is never trusted
 * structurally: outcomes outside the known set, malformed fields, or
 * inconsistent shapes are rejected wholesale so a corrupt verdict degrades
 * to needs_review instead of passing through as permission.
 */
function sanitizeDecision(value: unknown): DomainGateDecision | undefined {
  if (!isRecord(value)) return undefined;
  const outcome = value.outcome;
  if (outcome !== "eligible" && outcome !== "unrelated" && outcome !== "needs_review") return undefined;
  const extracted = isRecord(value.extracted) ? value.extracted : {};
  const guestCount = extracted.guestCount;
  const clean: DomainGateDecision = {
    outcome,
    reasons: cleanStrings(value.reasons, MAX_REASONS),
    missingFields: cleanStrings(value.missingFields, MAX_MISSING),
    extracted: {
      dateHints: cleanStrings(extracted.dateHints, MAX_DATE_HINTS),
      ...(typeof extracted.eventType === "string" && extracted.eventType.trim().length > 0
        ? { eventType: extracted.eventType.slice(0, 120) }
        : {}),
      ...(typeof guestCount === "number" && Number.isInteger(guestCount) && guestCount > 0 && guestCount <= 100_000
        ? { guestCount }
        : {}),
    },
  };
  if (clean.reasons.length === 0 && outcome !== "eligible") {
    clean.reasons.push("Classifier gave no displayable reason; parked for owner review.");
  }
  return clean;
}

function review(reason: string, classifierId: string, simulated: boolean): DomainGateResult {
  return {
    decision: { outcome: "needs_review", reasons: [reason], missingFields: [], extracted: { dateHints: [] } },
    classifierId,
    simulated,
  };
}

/**
 * Evaluate the domain gate for one message. Every path resolves to a
 * decision — the function never throws for content/classifier problems, so
 * callers can rely on exactly one outcome per message.
 */
export async function evaluateDomainGate(
  classifier: DomainClassifier | undefined,
  input: DomainGateInput | undefined,
): Promise<DomainGateResult> {
  if (input === undefined) {
    return review(
      "Message content could not be read, so the event domain cannot be established; parked for owner review.",
      "none",
      true,
    );
  }
  if (classifier === undefined) {
    return review(
      "No domain classifier is configured for this intake source; parked for owner review rather than ingested.",
      "none",
      true,
    );
  }
  let verdict: ClassifierVerdict;
  try {
    verdict = await classifier.classify(input);
  } catch (error) {
    return review(
      `Domain classifier threw (${error instanceof Error ? error.message : String(error)}); parked for owner review.`,
      classifier.id,
      classifier.simulated,
    );
  }
  if (verdict.status === "unavailable") {
    return review(`Domain classifier unavailable: ${verdict.reason}.`, classifier.id, classifier.simulated);
  }
  if (verdict.status === "unknown") {
    return review(`Domain classification unknown: ${verdict.reason}.`, classifier.id, classifier.simulated);
  }
  const decision = sanitizeDecision(verdict.decision);
  if (decision === undefined) {
    return review(
      "Domain classifier returned a malformed verdict; parked for owner review rather than trusted.",
      classifier.id,
      classifier.simulated,
    );
  }
  return { decision, classifierId: classifier.id, simulated: classifier.simulated };
}
