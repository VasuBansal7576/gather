import type { SourceReference } from "../domain/contracts.ts";
import {
  canonicalizeValue,
  readAvailabilityEvidence,
  readCostLine,
  readCurrency,
  readPolicyRule,
  readPriceLine,
  readServiceCapability,
  readSpaceKnowledge,
  readScopedExceptionValue,
  readSourceReferenceList,
  readTimezone,
} from "./prepare.ts";
import type {
  AvailabilityEvidence,
  BusinessKnowledge,
  CostLine,
  FactConfidence,
  PolicyRule,
  PriceLine,
  ServiceCapability,
  SpaceKnowledge,
  ScopedException,
} from "./types.ts";

/**
 * Adapter contract: convert shared durable records into the offer module's
 * inputs WITHOUT mutating shared domain or connector types.
 *
 * TRUST MODEL (callers must heed this): the host owns fetching and may only
 * feed this adapter persisted, owner-confirmed facts. Unknown inputs, model
 * output, or customer text can never mint authority here:
 * - pricing bounds and scoped exceptions require verified, attributed facts;
 *   anything weaker is reported unparseable, never applied. An uncertain
 *   exception is never treated as approved.
 * - cost-completeness attestation requires its own verified, attributed
 *   pricing_bounds fact — `costsComplete: true` next to unrelated price-line
 *   sources does not count.
 * - facts are business-scoped: mixed business IDs are rejected outright.
 * - each bounds record is validated complete before anything is applied, so
 *   a malformed record cannot partially mutate the book; conflicting
 *   duplicates are exposed, never last-write-wins.
 *
 * The host/runtime additionally owns authentication, persistence, fresh
 * availability fetching, approval, and the owner experience.
 */

/** Structural subset of the domain BusinessFact: any record with these fields adapts. */
export interface AdaptableFact {
  id: string;
  key: string;
  value: unknown;
  confidence: FactConfidence;
  sourceReferences: SourceReference[];
  businessId?: string;
}

export interface AdaptedKnowledge {
  knowledge: BusinessKnowledge;
  /** Facts that could not be interpreted; never silently dropped or applied. */
  unparseable: { factId: string; key: string; reason: string }[];
}

export interface AdaptScope {
  businessId?: string;
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

interface BoundsRecord {
  currency: string;
  floorCents: number | null;
  minMarginBps: number | null;
  depositBps: number | null;
  costsComplete: boolean;
}

/** Validate one complete bounds record before the caller applies anything. */
function readBoundsRecord(value: unknown, path: string): BoundsRecord {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  const readBound = (field: string): number | null => {
    const entry = value[field];
    if (entry === null || entry === undefined) return null;
    if (typeof entry !== "number" || !Number.isInteger(entry) || entry < 0) {
      throw new Error(`${path}.${field} must be a non-negative integer or null`);
    }
    return entry;
  };
  let costsComplete = false;
  if (value.costsComplete !== undefined) {
    if (typeof value.costsComplete !== "boolean") {
      throw new Error(`${path}.costsComplete must be a boolean when present`);
    }
    costsComplete = value.costsComplete;
  }
  return {
    currency: readCurrency(value.currency, `${path}.currency`),
    floorCents: readBound("floorCents"),
    minMarginBps: readBound("minMarginBps"),
    depositBps: readBound("depositBps"),
    costsComplete,
  };
}

function readBusinessValue(value: unknown, path: string): { businessId?: string; timezone?: string } {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  const out: { businessId?: string; timezone?: string } = {};
  if (value.businessId !== undefined) {
    if (!isNonEmptyString(value.businessId)) throw new Error(`${path}.businessId must be a non-empty string when present`);
    out.businessId = value.businessId;
  }
  if (value.timezone !== undefined) {
    out.timezone = readTimezone(value.timezone, `${path}.timezone`);
  }
  return out;
}

/**
 * Build offer-ready business knowledge from attributable, business-scoped facts.
 * See the trust model above for what is accepted, reported, or rejected.
 */
export function adaptBusinessFacts(input: unknown, scope?: unknown): AdaptedKnowledge {
  if (!Array.isArray(input)) throw new Error("adaptBusinessFacts input must be an array of facts");
  let scopeBusinessId: string | undefined;
  if (scope !== undefined) {
    if (!isRecord(scope)) throw new Error("adaptBusinessFacts scope must be an object when present");
    if (scope.businessId !== undefined) {
      if (!isNonEmptyString(scope.businessId)) throw new Error("adaptBusinessFacts scope.businessId must be a non-empty string when present");
      scopeBusinessId = scope.businessId;
    }
  }

  const spaces: { item: SpaceKnowledge; factId: string }[] = [];
  const policies: { item: PolicyRule; factId: string }[] = [];
  const scopedExceptions: { item: ScopedException; factId: string }[] = [];
  const lines: { item: PriceLine; factId: string }[] = [];
  const costs: { item: CostLine; factId: string }[] = [];
  const services: { item: ServiceCapability; factId: string }[] = [];
  const unparseable: AdaptedKnowledge["unparseable"] = [];
  const seenSources: SourceReference[] = [];
  let bounds: { record: BoundsRecord; factId: string; sources: SourceReference[] } | undefined;
  let businessTimezone: { timezone: string; factId: string } | undefined;
  const businessIds = new Set<string>();

  for (const [index, entry] of input.entries()) {
    if (!isRecord(entry)) {
      unparseable.push({ factId: `#${index}`, key: "unknown", reason: "Fact must be an object" });
      continue;
    }
    const fact = entry as Partial<AdaptableFact> & { id?: unknown; key?: unknown; businessId?: unknown };
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
    if (fact.businessId !== undefined && !isNonEmptyString(fact.businessId)) {
      unparseable.push({ factId: fact.id, key: fact.key, reason: "businessId must be a non-empty string when present" });
      continue;
    }
    if (scopeBusinessId !== undefined && fact.businessId !== undefined && fact.businessId !== scopeBusinessId) {
      unparseable.push({
        factId: fact.id,
        key: fact.key,
        reason: `Fact belongs to business ${fact.businessId}, outside the requested scope ${scopeBusinessId}; cross-business facts are never applied`,
      });
      continue;
    }
    if (fact.businessId !== undefined) businessIds.add(fact.businessId);
    const value = fact.value as Record<string, unknown>;
    /* Source arrays are validated as real source objects: a malformed
       element cannot mint verified authority through an `as` assertion. */
    let sources: SourceReference[];
    try {
      sources = readSourceReferenceList(fact.sourceReferences, `fact.sourceReferences:${fact.id}`);
    } catch (error) {
      unparseable.push({ factId: fact.id, key: fact.key, reason: describeFailure(error) });
      continue;
    }
    seenSources.push(...sources);
    const path = `${fact.key}:${fact.id}`;
    try {
      switch (fact.key) {
        case "business": {
          const parsed = readBusinessValue(value, path);
          if (parsed.businessId !== undefined) businessIds.add(parsed.businessId);
          if (parsed.timezone !== undefined) {
            if (businessTimezone !== undefined && businessTimezone.timezone !== parsed.timezone) {
              unparseable.push({ factId: fact.id, key: fact.key, reason: `Conflicting business timezone ${parsed.timezone} vs ${businessTimezone.timezone} from ${businessTimezone.factId}` });
            } else if (businessTimezone === undefined) {
              businessTimezone = { timezone: parsed.timezone, factId: fact.id };
            }
          }
          break;
        }
        case "space": {
          spaces.push({ item: readSpaceKnowledge({ ...value, confidence, sourceReferences: sources }, path), factId: fact.id });
          break;
        }
        case "policy": {
          policies.push({ item: readPolicyRule({ ...value, confidence, sourceReferences: sources }, path), factId: fact.id });
          break;
        }
        case "scoped_exception": {
          /* Approval-grade fact: only verified, attributed exceptions can
             relax a policy. Anything weaker is exposed, never approved. */
          if (confidence !== "verified" || sources.length === 0) {
            unparseable.push({
              factId: fact.id,
              key: fact.key,
              reason: "Scoped exceptions need verified confidence and their own source references; an uncertain or unattributed exception is never treated as approved",
            });
            break;
          }
          scopedExceptions.push({
            item: readScopedExceptionValue({ ...value, sourceReferences: sources }, path),
            factId: fact.id,
          });
          break;
        }
        case "price_line": {
          lines.push({ item: readPriceLine({ ...value, confidence, sourceReferences: sources }, path), factId: fact.id });
          break;
        }
        case "cost": {
          costs.push({ item: readCostLine({ ...value, confidence, sourceReferences: sources }, path), factId: fact.id });
          break;
        }
        case "pricing_bounds": {
          /* Approval-grade, atomic fact: verified and attributed only, and
             the whole record validates before anything is applied. */
          if (confidence !== "verified" || sources.length === 0) {
            unparseable.push({
              factId: fact.id,
              key: fact.key,
              reason: "Pricing bounds need verified confidence and their own source references; uncertain or unattributed bounds are never applied",
            });
            break;
          }
          const record = readBoundsRecord(value, path);
          if (bounds !== undefined && JSON.stringify(bounds.record) !== JSON.stringify(record)) {
            unparseable.push({
              factId: fact.id,
              key: fact.key,
              reason: `Conflicting pricing bounds vs ${bounds.factId}; refusing last-write-wins, keeping the first complete record`,
            });
            break;
          }
          if (bounds === undefined) bounds = { record, factId: fact.id, sources: sources.map((source) => ({ ...source })) };
          break;
        }
        case "service": {
          services.push({ item: readServiceCapability({ ...value, sourceReferences: sources }, path), factId: fact.id });
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

  /* Business scope: mixed business IDs are rejected outright. */
  if (businessIds.size > 1) {
    throw new Error(`Facts span multiple businesses (${[...businessIds].sort().join(", ")}); refusing to build cross-business knowledge`);
  }
  const resolvedBusinessId = businessIds.size === 1 ? [...businessIds][0] as string : scopeBusinessId;
  if (resolvedBusinessId === undefined) {
    throw new Error("No business scope could be resolved: facts carry no businessId and no scope was given");
  }
  if (scopeBusinessId !== undefined && resolvedBusinessId !== scopeBusinessId) {
    throw new Error(`Resolved business ${resolvedBusinessId} is outside the requested scope ${scopeBusinessId}`);
  }
  if (businessTimezone === undefined) {
    throw new Error(`No business timezone fact for ${resolvedBusinessId}; local-time suitability cannot be proven without it`);
  }
  if (bounds === undefined && (lines.length > 0 || costs.length > 0)) {
    throw new Error("Priced lines/costs without an authoritative pricing_bounds fact: the currency would be invented; add a verified pricing_bounds fact");
  }

  /* Conflicting duplicates are exposed, never silently overwritten. */
  const dedupe = <T>(entries: { item: T; factId: string }[], idOf: (item: T) => string, label: string): T[] => {
    const seen = new Map<string, string>();
    const out: T[] = [];
    for (const entry of entries) {
      const id = idOf(entry.item);
      const canonical = JSON.stringify(canonicalizeValue(entry.item));
      const prior = seen.get(id);
      if (prior === undefined) {
        seen.set(id, canonical);
        out.push(entry.item);
      } else if (prior !== canonical) {
        unparseable.push({
          factId: entry.factId,
          key: label,
          reason: `Conflicting duplicate ${label} "${id}"; keeping the first version, refusing last-write-wins`,
        });
      }
    }
    return out;
  };

  return {
    knowledge: {
      businessId: resolvedBusinessId,
      timezone: businessTimezone.timezone,
      spaces: dedupe(spaces, (item) => item.spaceId, "space"),
      policies: dedupe(policies, (item) => item.policyId, "policy"),
      scopedExceptions: dedupe(scopedExceptions, (item) => item.exceptionId, "scoped_exception"),
      priceBook: {
        currency: bounds?.record.currency ?? "USD",
        lines: dedupe(lines, (item) => item.lineId, "price_line"),
        costs: dedupe(costs, (item) => item.costId, "cost"),
        costsComplete: bounds?.record.costsComplete ?? false,
        floorCents: bounds?.record.floorCents ?? null,
        minMarginBps: bounds?.record.minMarginBps ?? null,
        depositBps: bounds?.record.depositBps ?? null,
        sourceReferences: bounds !== undefined ? bounds.sources : [],
      },
      services: dedupe(services, (item) => item.serviceId, "service"),
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
  slots: {
    startAt: string;
    endAt: string;
    available: boolean;
    reason?: string;
    venueWide?: boolean;
    spaceIds?: string[];
    sourceReferences: SourceReference[];
  }[];
  sourceReferences: SourceReference[];
}

/**
 * Validate and normalize fresh availability observations (for example from a
 * CalendarAvailabilityReader result) into evidence the offer module accepts.
 * Scope must be explicit per slot (`venueWide: true` or `spaceIds`).
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
