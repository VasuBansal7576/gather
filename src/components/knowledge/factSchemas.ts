import { formatMoneyPart } from "../../knowledge-owner/state.ts";

/**
 * Business-labelled correction inputs driven by the authoritative fact
 * vocabulary and value schemas (src/offers/prepare.ts readers and the
 * pricing-bounds record in src/offers/adapters.ts — mirrored here, never
 * imported, so this client bundle carries no server machinery; any
 * divergence only narrows what the form accepts).
 *
 * Rules honored from the authoritative readers:
 * - price_line: lineId/label identity + label, pricingBasis
 *   per_event|per_guest|per_hour, unitCents non-negative integer or null.
 * - cost: costId/label, amountCents non-negative integer or null.
 * - policy: policyId/statement, effect allow|deny|require_owner_decision,
 *   optional guest bounds and applies-to lists.
 * - space: spaceId/name, capacityMin/Max non-negative integers,
 *   capacityMax >= capacityMin.
 * - service: serviceId/label, available boolean.
 * - pricing_bounds: explicit ISO 4217 currency (never defaulted), nullable
 *   floorCents/minMarginBps/depositBps, explicit costsComplete boolean.
 * - confidence and sourceReferences are host-managed (verified + inherited
 *   attribution) and never appear as inputs.
 *
 * Unknown extra fields on a supported key are preserved untouched on
 * submit. Unsupported keys fail closed with an unavailable panel — the
 * form never guesses a structure and offers no raw JSON editor.
 */

export type FactFieldType =
  | "readonly"
  | "text"
  | "textarea"
  | "int"
  | "intOrNull"
  | "moneyOrNull"
  | "currency"
  | "select"
  | "checkbox"
  | "csv";

export interface FactField {
  name: string;
  label: string;
  hint?: string;
  type: FactFieldType;
  options?: readonly string[];
}

const PRICING_BASIS = ["per_event", "per_guest", "per_hour"] as const;
const POLICY_EFFECTS = ["allow", "deny", "require_owner_decision"] as const;

const FIELDS: Record<string, FactField[]> = {
  price_line: [
    { name: "lineId", label: "Price line ID", hint: "Identity — shown for reference, never edited.", type: "readonly" },
    { name: "label", label: "Price label", hint: "e.g. Plated dinner, per guest.", type: "text" },
    { name: "pricingBasis", label: "Charged", type: "select", options: PRICING_BASIS },
    { name: "unitCents", label: "Price (minor units)", hint: "Whole number in minor units, e.g. cents. Leave empty when the price is unknown — never 0 as a guess.", type: "moneyOrNull" },
  ],
  cost: [
    { name: "costId", label: "Cost ID", hint: "Identity — shown for reference, never edited.", type: "readonly" },
    { name: "label", label: "Cost label", hint: "e.g. Linen hire.", type: "text" },
    { name: "amountCents", label: "Cost (minor units)", hint: "Whole number in minor units. Leave empty when unknown — never 0 as a guess.", type: "moneyOrNull" },
  ],
  policy: [
    { name: "policyId", label: "Policy ID", hint: "Identity — shown for reference, never edited.", type: "readonly" },
    { name: "statement", label: "Policy statement", hint: "The rule in plain words.", type: "textarea" },
    { name: "effect", label: "Effect", type: "select", options: POLICY_EFFECTS },
    { name: "minGuests", label: "Applies from (guests)", hint: "Optional.", type: "intOrNull" },
    { name: "maxGuests", label: "Applies up to (guests)", hint: "Optional.", type: "intOrNull" },
    { name: "appliesToEventTypes", label: "Event types", hint: "Optional, comma-separated.", type: "csv" },
    { name: "appliesToServices", label: "Services", hint: "Optional, comma-separated.", type: "csv" },
  ],
  space: [
    { name: "spaceId", label: "Space ID", hint: "Identity — shown for reference, never edited.", type: "readonly" },
    { name: "name", label: "Space name", hint: "e.g. Garden Room.", type: "text" },
    { name: "capacityMin", label: "Minimum capacity (guests)", type: "int" },
    { name: "capacityMax", label: "Maximum capacity (guests)", type: "int" },
  ],
  service: [
    { name: "serviceId", label: "Service ID", hint: "Identity — shown for reference, never edited.", type: "readonly" },
    { name: "label", label: "Service label", hint: "e.g. Welcome drinks.", type: "text" },
    { name: "available", label: "Offered", hint: "Uncheck when this service is no longer offered.", type: "checkbox" },
  ],
  pricing_bounds: [
    { name: "currency", label: "Currency", hint: "Explicit three-letter code, e.g. GBP. Never guessed.", type: "currency" },
    { name: "floorCents", label: "Minimum total (minor units)", hint: "Optional.", type: "intOrNull" },
    { name: "minMarginBps", label: "Minimum margin (basis points)", hint: "Optional.", type: "intOrNull" },
    { name: "depositBps", label: "Deposit (basis points)", hint: "Optional.", type: "intOrNull" },
    { name: "costsComplete", label: "Cost ledger complete", hint: "Check only when every cost is recorded — unknown costs must never read as complete.", type: "checkbox" },
  ],
};

/** Business-labelled fields for a correctable key, or null when the format has no guided inputs. */
export function correctFieldsFor(key: string): FactField[] | null {
  return FIELDS[key] ?? null;
}

export type FieldValues = Record<string, string | boolean>;

/** Stringify the current value into form inputs; unknown fields are left out (preserved separately). */
export function extractFieldValues(key: string, value: Record<string, unknown>): FieldValues {
  const fields = correctFieldsFor(key) ?? [];
  const out: FieldValues = {};
  for (const field of fields) {
    const entry = value[field.name];
    if (field.type === "checkbox") {
      out[field.name] = entry === true;
      continue;
    }
    if (field.type === "csv") {
      out[field.name] = Array.isArray(entry) ? entry.filter((item): item is string => typeof item === "string").join(", ") : "";
      continue;
    }
    if (entry === null || entry === undefined) {
      out[field.name] = "";
      continue;
    }
    out[field.name] = typeof entry === "string" ? entry : String(entry);
  }
  return out;
}

/** Value keys the guided form does not render — carried through untouched. */
export function preservedUnknownKeys(key: string, value: Record<string, unknown>): string[] {
  const known = new Set((correctFieldsFor(key) ?? []).map((field) => field.name));
  return Object.keys(value).filter((name) => !known.has(name) && name !== "confidence" && name !== "sourceReferences");
}

/** Mirror of the authoritative readCurrency: explicit ISO 4217 only, never defaulted. */
export function isSupportedCurrencyCode(code: string): boolean {
  if (!/^[A-Z]{3}$/.test(code)) return false;
  try {
    new Intl.NumberFormat("en-US", { style: "currency", currency: code });
  } catch {
    return false;
  }
  return true;
}

function readInt(raw: string, label: string): { ok: true; value: number } | { ok: false; error: string } {
  if (!/^\d+$/.test(raw.trim())) return { ok: false, error: `${label} must be a whole non-negative number.` };
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value)) return { ok: false, error: `${label} is too large.` };
  return { ok: true, value };
}

export type AssembleResult = { ok: true; value: Record<string, unknown> } | { ok: false; error: string };

/**
 * Validate guided inputs and merge them over the original value. Unknown
 * original fields survive untouched; optional fields cleared by the owner
 * are omitted (matching the schema's "when present" semantics).
 */
export function assembleFieldValues(
  key: string,
  original: Record<string, unknown>,
  inputs: FieldValues,
): AssembleResult {
  const fields = correctFieldsFor(key);
  if (!fields) return { ok: false, error: "Guided correction is unavailable for this format." };
  const next: Record<string, unknown> = { ...original };
  for (const field of fields) {
    if (field.type === "readonly") continue;
    const raw = inputs[field.name];
    switch (field.type) {
      case "text":
      case "textarea": {
        const text = typeof raw === "string" ? raw.trim() : "";
        if (text.length === 0) return { ok: false, error: `${field.label} is required.` };
        next[field.name] = text;
        break;
      }
      case "int": {
        if (typeof raw !== "string") return { ok: false, error: `${field.label} is required.` };
        const parsed = readInt(raw, field.label);
        if (!parsed.ok) return parsed;
        next[field.name] = parsed.value;
        break;
      }
      case "intOrNull":
      case "moneyOrNull": {
        if (typeof raw !== "string" || raw.trim().length === 0) {
          next[field.name] = null;
          break;
        }
        const parsed = readInt(raw, field.label);
        if (!parsed.ok) return parsed;
        next[field.name] = parsed.value;
        break;
      }
      case "currency": {
        const code = typeof raw === "string" ? raw.trim().toUpperCase() : "";
        if (!isSupportedCurrencyCode(code)) {
          return { ok: false, error: `${field.label} must be an explicit supported three-letter code (e.g. GBP) — it is never guessed.` };
        }
        next[field.name] = code;
        break;
      }
      case "select": {
        if (typeof raw !== "string" || !(field.options ?? []).includes(raw)) {
          return { ok: false, error: `${field.label} must be one of ${(field.options ?? []).join(", ")}.` };
        }
        next[field.name] = raw;
        break;
      }
      case "checkbox": {
        next[field.name] = raw === true;
        break;
      }
      case "csv": {
        const items = typeof raw === "string"
          ? raw.split(",").map((item) => item.trim()).filter((item) => item.length > 0)
          : [];
        if (items.length === 0) delete next[field.name];
        else next[field.name] = items;
        break;
      }
    }
  }
  if (key === "space") {
    const min = next.capacityMin;
    const max = next.capacityMax;
    if (typeof min === "number" && typeof max === "number" && max < min) {
      return { ok: false, error: "Maximum capacity must be at least the minimum capacity." };
    }
  }
  return { ok: true, value: next };
}

/** Honest money preview for minor-unit inputs using the bounds currency when known. */
export function moneyPreview(amountCents: number, currencyHint: string | undefined): string {
  return formatMoneyPart(amountCents, currencyHint ?? "");
}

/** Focused question shown above each guided correction. */
export function correctQuestionFor(key: string, subject: string): string {
  switch (key) {
    case "price_line":
      return `What is the correct price for ${subject}?`;
    case "cost":
      return `What is the correct cost for ${subject}?`;
    case "policy":
      return `How should the policy for ${subject} read?`;
    case "space":
      return `What are the correct details for ${subject}?`;
    case "service":
      return `How should the service ${subject} be described?`;
    case "pricing_bounds":
      return "What are the correct pricing bounds for this business?";
    default:
      return `How should ${subject} read?`;
  }
}
