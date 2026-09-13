import type { SourceReference } from "../domain/contracts.ts";
import { readAvailabilityEvidence, readBusinessKnowledge } from "./prepare.ts";
import type {
  AvailabilityEvidence,
  BusinessKnowledge,
  FactConfidence,
} from "./types.ts";

/**
 * Adapter contract: convert shared durable records and fresh connector
 * observations into the offer module's inputs WITHOUT mutating shared
 * domain or connector types.
 *
 * The host/runtime owns fetching (fresh availability immediately before the
 * call), authentication, persistence, and approval. This adapter only
 * reshapes and validates data, keeping every consequential fact
 * attributable to its source references.
 */

/** Structural subset of the domain BusinessFact: any record with these fields adapts. */
export interface AdaptableFact {
  id: string;
  key: string;
  value: unknown;
  confidence: FactConfidence;
  sourceReferences: SourceReference[];
}

export interface AdaptedKnowledge {
  knowledge: BusinessKnowledge;
  /** Facts that could not be interpreted; never silently dropped. */
  unparseable: { factId: string; key: string; reason: string }[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

const DEFAULT_FRESHNESS_MS = 15 * 60 * 1_000;

function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : "Unparseable fact value";
}

/**
 * Build offer-ready business knowledge from attributable facts.
 * Unknown fact keys and malformed values are reported in `unparseable`
 * instead of being silently ignored or invented.
 */
export function adaptBusinessFacts(input: unknown): AdaptedKnowledge {
  if (!Array.isArray(input)) throw new Error("adaptBusinessFacts input must be an array of facts");
  const spaces: BusinessKnowledge["spaces"] = [];
  const policies: BusinessKnowledge["policies"] = [];
  const scopedExceptions: BusinessKnowledge["scopedExceptions"] = [];
  const lines: BusinessKnowledge["priceBook"]["lines"] = [];
  const costs: BusinessKnowledge["priceBook"]["costs"] = [];
  const services: BusinessKnowledge["services"] = [];
  const unparseable: AdaptedKnowledge["unparseable"] = [];
  const seenSources: SourceReference[] = [];
  let currency = "USD";
  let floorCents: number | null = null;
  let minMarginBps: number | null = null;
  let depositBps: number | null = null;
  const priceBookSources: SourceReference[] = [];

  for (const [index, entry] of input.entries()) {
    if (!isRecord(entry)) {
      unparseable.push({ factId: `#${index}`, key: "unknown", reason: "Fact must be an object" });
      continue;
    }
    const fact = entry as Partial<AdaptableFact> & { id?: unknown; key?: unknown };
    if (!isNonEmptyString(fact.id) || !isNonEmptyString(fact.key) || !isRecord(fact.value)) {
      unparseable.push({
        factId: typeof fact.id === "string" ? fact.id : `#${index}`,
        key: typeof fact.key === "string" ? fact.key : "unknown",
        reason: "Fact needs a string id, string key, and object value",
      });
      continue;
    }
    const confidence = fact.confidence;
    if (confidence !== "verified" && confidence !== "probable" && confidence !== "uncertain") {
      unparseable.push({ factId: fact.id, key: fact.key, reason: "confidence must be verified, probable, or uncertain" });
      continue;
    }
    if (!Array.isArray(fact.sourceReferences)) {
      unparseable.push({ factId: fact.id, key: fact.key, reason: "sourceReferences must be an array" });
      continue;
    }
    const value = fact.value as Record<string, unknown>;
    const sources = fact.sourceReferences as SourceReference[];
    seenSources.push(...sources);
    try {
      switch (fact.key) {
        case "space": {
          spaces.push(readBusinessKnowledge({
            spaces: [{ ...value, confidence, sourceReferences: sources }],
            policies: [],
            scopedExceptions: [],
            priceBook: { currency: "USD", lines: [], costs: [], floorCents: null, minMarginBps: null, depositBps: null, sourceReferences: [] },
            services: [],
            sourceReferences: [],
          }).spaces[0] as BusinessKnowledge["spaces"][number]);
          break;
        }
        case "policy": {
          policies.push(readBusinessKnowledge({
            spaces: [],
            policies: [{ ...value, confidence, sourceReferences: sources }],
            scopedExceptions: [],
            priceBook: { currency: "USD", lines: [], costs: [], floorCents: null, minMarginBps: null, depositBps: null, sourceReferences: [] },
            services: [],
            sourceReferences: [],
          }).policies[0] as BusinessKnowledge["policies"][number]);
          break;
        }
        case "scoped_exception": {
          scopedExceptions.push(readBusinessKnowledge({
            spaces: [],
            policies: [],
            scopedExceptions: [{ ...value, confidence: undefined, sourceReferences: sources }],
            priceBook: { currency: "USD", lines: [], costs: [], floorCents: null, minMarginBps: null, depositBps: null, sourceReferences: [] },
            services: [],
            sourceReferences: [],
          }).scopedExceptions[0] as BusinessKnowledge["scopedExceptions"][number]);
          void confidence;
          break;
        }
        case "price_line": {
          lines.push(readBusinessKnowledge({
            spaces: [],
            policies: [],
            scopedExceptions: [],
            priceBook: { currency: "USD", lines: [{ ...value, sourceReferences: sources }], costs: [], floorCents: null, minMarginBps: null, depositBps: null, sourceReferences: [] },
            services: [],
            sourceReferences: [],
          }).priceBook.lines[0] as BusinessKnowledge["priceBook"]["lines"][number]);
          priceBookSources.push(...sources);
          break;
        }
        case "cost": {
          costs.push(readBusinessKnowledge({
            spaces: [],
            policies: [],
            scopedExceptions: [],
            priceBook: { currency: "USD", lines: [], costs: [{ ...value, sourceReferences: sources }], floorCents: null, minMarginBps: null, depositBps: null, sourceReferences: [] },
            services: [],
            sourceReferences: [],
          }).priceBook.costs[0] as BusinessKnowledge["priceBook"]["costs"][number]);
          priceBookSources.push(...sources);
          break;
        }
        case "pricing_bounds": {
          if (typeof value.currency === "string" && value.currency.trim().length > 0) currency = value.currency;
          if (value.floorCents === null || value.floorCents === undefined) {
            if (value.floorCents === null) floorCents = null;
          } else if (typeof value.floorCents === "number" && Number.isInteger(value.floorCents) && value.floorCents >= 0) {
            floorCents = value.floorCents;
          } else {
            throw new Error("pricing_bounds.floorCents must be a non-negative integer or null");
          }
          if (value.minMarginBps === null || value.minMarginBps === undefined) {
            if (value.minMarginBps === null) minMarginBps = null;
          } else if (typeof value.minMarginBps === "number" && Number.isInteger(value.minMarginBps) && value.minMarginBps >= 0) {
            minMarginBps = value.minMarginBps;
          } else {
            throw new Error("pricing_bounds.minMarginBps must be a non-negative integer or null");
          }
          if (value.depositBps === null || value.depositBps === undefined) {
            if (value.depositBps === null) depositBps = null;
          } else if (typeof value.depositBps === "number" && Number.isInteger(value.depositBps) && value.depositBps >= 0) {
            depositBps = value.depositBps;
          } else {
            throw new Error("pricing_bounds.depositBps must be a non-negative integer or null");
          }
          priceBookSources.push(...sources);
          break;
        }
        case "service": {
          services.push(readBusinessKnowledge({
            spaces: [],
            policies: [],
            scopedExceptions: [],
            priceBook: { currency: "USD", lines: [], costs: [], floorCents: null, minMarginBps: null, depositBps: null, sourceReferences: [] },
            services: [{ ...value, sourceReferences: sources }],
            sourceReferences: [],
          }).services[0] as BusinessKnowledge["services"][number]);
          break;
        }
        default: {
          unparseable.push({ factId: fact.id, key: fact.key, reason: `Unknown fact key "${fact.key}"; add an explicit adapter mapping before it can affect offers` });
        }
      }
    } catch (error) {
      unparseable.push({ factId: fact.id, key: fact.key, reason: describeFailure(error) });
    }
  }

  return {
    knowledge: {
      spaces,
      policies,
      scopedExceptions,
      priceBook: { currency, lines, costs, floorCents, minMarginBps, depositBps, sourceReferences: priceBookSources },
      services,
      sourceReferences: seenSources,
    },
    unparseable,
  };
}

export interface AvailabilityBuildInput {
  calendarId: string;
  observedAt: string;
  asOf: string;
  maxFreshnessMs?: number;
  slots: { startAt: string; endAt: string; available: boolean; reason?: string; sourceReferences: SourceReference[] }[];
  sourceReferences: SourceReference[];
}

/**
 * Validate and normalize fresh availability observations (for example from a
 * CalendarAvailabilityReader result) into evidence the offer module accepts.
 * Staleness itself is reported by prepareOffer as missing information; this
 * step only enforces shape, never freshness.
 */
export function buildAvailabilityEvidence(input: unknown): AvailabilityEvidence {
  if (!isRecord(input)) throw new Error("availability input must be an object");
  const withDefault = {
    ...(input as Record<string, unknown>),
    maxFreshnessMs: (input as Record<string, unknown>).maxFreshnessMs ?? DEFAULT_FRESHNESS_MS,
  };
  return readAvailabilityEvidence(withDefault);
}
