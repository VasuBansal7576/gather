import { assertValidEvaluateInput } from "./contracts.ts";
import type { SourceReference } from "../domain/contracts.ts";
import type {
  AcceptanceRecord,
  AvailabilityAttestation,
  ConditionConfig,
  ConditionResult,
  DepositReceipt,
  EvaluateReadinessInput,
  OwnerWaiver,
  Provenance,
  ReadinessBinding,
  ReadinessDecision,
  ResourceCommitment,
  ResourceResult,
} from "./contracts.ts";

const DEFAULT_AVAILABILITY_MAX_AGE_MS = 300_000;
const DEFAULT_RESOURCE_MAX_AGE_MS = 3_600_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isIso(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));
}

function isRefArray(value: unknown): value is SourceReference[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.locator === "string" &&
        entry.locator.length > 0 &&
        typeof entry.kind === "string",
    )
  );
}

interface Classified {
  acceptance: AcceptanceRecord[];
  deposits: DepositReceipt[];
  availability: AvailabilityAttestation[];
  resources: ResourceCommitment[];
}

function classifyAcceptance(item: Record<string, unknown>): AcceptanceRecord | string {
  if (!isNonEmptyString(item.bookingId)) return "acceptance_record without bookingId";
  if (typeof item.proposalVersion !== "number" || !Number.isInteger(item.proposalVersion)) {
    return "acceptance_record without integer proposalVersion";
  }
  if (!isNonEmptyString(item.proposalFingerprint)) return "acceptance_record without proposalFingerprint";
  if (!isIso(item.acceptedAt)) return "acceptance_record without acceptedAt timestamp";
  if (!isRefArray(item.sourceRefs)) return "acceptance_record without source references";
  if (item.acceptedBy !== undefined && typeof item.acceptedBy !== "string") return "acceptance_record with invalid acceptedBy";
  if (item.revoked !== undefined && typeof item.revoked !== "boolean") return "acceptance_record with invalid revoked flag";
  return {
    resolver: "acceptance_record",
    bookingId: item.bookingId,
    proposalVersion: item.proposalVersion,
    proposalFingerprint: item.proposalFingerprint,
    acceptedAt: item.acceptedAt,
    acceptedBy: typeof item.acceptedBy === "string" ? item.acceptedBy : undefined,
    revoked: item.revoked === true,
    sourceRefs: item.sourceRefs,
  };
}

function classifyDeposit(item: Record<string, unknown>): DepositReceipt | string {
  if (!isNonEmptyString(item.bookingId)) return "deposit_ledger output without bookingId";
  if (!isNonEmptyString(item.receiptId)) return "deposit_ledger output without receiptId";
  if (typeof item.amountCents !== "number" || !Number.isInteger(item.amountCents) || item.amountCents < 0) {
    return "deposit_ledger output without non-negative integer amountCents";
  }
  if (!isNonEmptyString(item.currency)) return "deposit_ledger output without currency";
  const statuses = ["settled", "pending", "rejected", "refunded", "revoked"] as const;
  if (typeof item.status !== "string" || !(statuses as readonly string[]).includes(item.status)) {
    return "deposit_ledger output without a known receipt status";
  }
  if (!isIso(item.observedAt)) return "deposit_ledger output without observedAt timestamp";
  if (!isRefArray(item.sourceRefs)) return "deposit_ledger output without source references";
  return {
    resolver: "deposit_ledger",
    bookingId: item.bookingId,
    receiptId: item.receiptId,
    amountCents: item.amountCents,
    currency: item.currency,
    status: item.status as DepositReceipt["status"],
    observedAt: item.observedAt,
    sourceRefs: item.sourceRefs,
  };
}

function classifyAvailability(item: Record<string, unknown>): AvailabilityAttestation | string {
  if (!isNonEmptyString(item.calendarId)) return "calendar_provider output without calendarId";
  if (!isIso(item.startAt) || !isIso(item.endAt)) return "calendar_provider output without valid window";
  if (typeof item.available !== "boolean") return "calendar_provider output without boolean available";
  if (item.holdId !== undefined && !isNonEmptyString(item.holdId)) return "calendar_provider output with invalid holdId";
  if (item.holdValidUntil !== undefined && !isIso(item.holdValidUntil)) {
    return "calendar_provider output with invalid holdValidUntil";
  }
  if (!isIso(item.observedAt)) return "calendar_provider output without observedAt timestamp";
  if (!isRefArray(item.sourceRefs)) return "calendar_provider output without source references";
  return {
    resolver: "calendar_provider",
    calendarId: item.calendarId,
    startAt: item.startAt,
    endAt: item.endAt,
    available: item.available,
    holdId: isNonEmptyString(item.holdId) ? item.holdId : undefined,
    holdValidUntil: isIso(item.holdValidUntil) ? (item.holdValidUntil as string) : undefined,
    observedAt: item.observedAt,
    sourceRefs: item.sourceRefs,
  };
}

function classifyResource(item: Record<string, unknown>): ResourceCommitment | string {
  if (!isNonEmptyString(item.bookingId)) return "resource_registry output without bookingId";
  if (!isNonEmptyString(item.resourceId)) return "resource_registry output without resourceId";
  const statuses = ["committed", "requested", "rejected", "revoked", "expired"] as const;
  if (typeof item.status !== "string" || !(statuses as readonly string[]).includes(item.status)) {
    return "resource_registry output without a known commitment status";
  }
  if (item.validUntil !== undefined && !isIso(item.validUntil)) return "resource_registry output with invalid validUntil";
  if (item.responsible !== undefined && typeof item.responsible !== "string") {
    return "resource_registry output with invalid responsible";
  }
  if (!isIso(item.observedAt)) return "resource_registry output without observedAt timestamp";
  if (!isRefArray(item.sourceRefs)) return "resource_registry output without source references";
  return {
    resolver: "resource_registry",
    bookingId: item.bookingId,
    resourceId: item.resourceId,
    status: item.status as ResourceCommitment["status"],
    validUntil: isIso(item.validUntil) ? (item.validUntil as string) : undefined,
    responsible: typeof item.responsible === "string" && item.responsible.length > 0 ? item.responsible : undefined,
    observedAt: item.observedAt,
    sourceRefs: item.sourceRefs,
  };
}

function classifyWaiver(item: unknown): OwnerWaiver | string {
  if (!isRecord(item)) return "waiver must be an object";
  if (item.resolver !== "owner_authority") return `waiver from untrusted resolver ${String(item.resolver)}`;
  if (!isNonEmptyString(item.businessId)) return "waiver without businessId";
  if (!isNonEmptyString(item.bookingId)) return "waiver without bookingId";
  const kinds = ["customer_acceptance", "deposit", "availability", "resource_commitment"] as const;
  if (typeof item.condition !== "string" || !(kinds as readonly string[]).includes(item.condition)) {
    return "waiver without a known condition";
  }
  if (typeof item.proposalVersion !== "number" || !Number.isInteger(item.proposalVersion)) {
    return "waiver without integer proposalVersion";
  }
  if (!isNonEmptyString(item.waivedBy)) return "waiver without owner identity (waivedBy)";
  if (!isIso(item.waivedAt)) return "waiver without waivedAt timestamp";
  if (!isNonEmptyString(item.reason)) return "waiver without reason";
  if (!isRefArray(item.sourceRefs)) return "waiver without source references";
  return {
    resolver: "owner_authority",
    businessId: item.businessId,
    bookingId: item.bookingId,
    condition: item.condition as OwnerWaiver["condition"],
    proposalVersion: item.proposalVersion,
    waivedBy: item.waivedBy,
    waivedAt: item.waivedAt,
    reason: item.reason,
    sourceRefs: item.sourceRefs,
  };
}

function fresh(observedAt: string, nowMs: number, maxAgeMs: number | undefined): boolean {
  if (maxAgeMs === undefined) return true;
  return Date.parse(observedAt) >= nowMs - maxAgeMs;
}

interface EvalContext {
  input: EvaluateReadinessInput;
  nowMs: number;
  classified: Classified;
  rejectedEvidence: string[];
  citedFictional: boolean[];
}

function matchWaiver(ctx: EvalContext, kind: ConditionConfig["kind"]): OwnerWaiver | null {
  if (!ctx.input.waivers) return null;
  for (const raw of ctx.input.waivers) {
    const waiver = classifyWaiver(raw);
    if (typeof waiver === "string") {
      ctx.rejectedEvidence.push(`rejected waiver: ${waiver}`);
      continue;
    }
    if (
      waiver.businessId === ctx.input.businessId &&
      waiver.bookingId === ctx.input.booking.id &&
      waiver.condition === kind &&
      waiver.proposalVersion === ctx.input.proposal.proposalVersion
    ) {
      return waiver;
    }
  }
  return null;
}

function waivedResult(kind: ConditionConfig["kind"], required: boolean, waiver: OwnerWaiver): ConditionResult {
  return {
    kind,
    required,
    status: "verified",
    detail: `Waived by ${waiver.waivedBy} for proposal v${waiver.proposalVersion}: ${waiver.reason}`,
    evidence: waiver.sourceRefs,
    waived: true,
  };
}

function evaluateAcceptance(ctx: EvalContext, cfg: ConditionConfig): ConditionResult {
  const base = { kind: cfg.kind, required: cfg.required, evidence: [] as SourceReference[], waived: false as const };
  const waiver = matchWaiver(ctx, cfg.kind);
  if (waiver) return waivedResult(cfg.kind, cfg.required, waiver);
  const records = ctx.classified.acceptance;
  if (records.length === 0) {
    return { ...base, status: "missing", detail: `No customer acceptance record for proposal v${ctx.input.proposal.proposalVersion}` };
  }
  const exact = records.filter(
    (record) =>
      record.proposalVersion === ctx.input.proposal.proposalVersion &&
      record.proposalFingerprint === ctx.input.proposal.proposalFingerprint,
  );
  const revoked = exact.filter((record) => record.revoked);
  if (revoked.length > 0) {
    return { ...base, status: "conflicting", detail: "Customer acceptance was revoked; re-acceptance of the current version is required", evidence: revoked.flatMap((record) => record.sourceRefs) };
  }
  const freshExact = exact.filter((record) => fresh(record.acceptedAt, ctx.nowMs, cfg.maxAgeMs));
  if (freshExact.length > 0) {
    return { ...base, status: "verified", detail: `Customer accepted proposal v${ctx.input.proposal.proposalVersion}`, evidence: freshExact.flatMap((record) => record.sourceRefs) };
  }
  if (exact.length > 0) {
    return { ...base, status: "stale", detail: "Acceptance evidence is older than the allowed evidence age; re-verify acceptance", evidence: exact.flatMap((record) => record.sourceRefs) };
  }
  const seen = [...new Set(records.map((record) => `v${record.proposalVersion}`))].join(", ");
  return { ...base, status: "conflicting", detail: `Acceptance targets ${seen}, not the accepted proposal v${ctx.input.proposal.proposalVersion}; exact-version acceptance is required`, evidence: records.flatMap((record) => record.sourceRefs) };
}

function evaluateDeposit(ctx: EvalContext, cfg: ConditionConfig): ConditionResult {
  const base = { kind: cfg.kind, required: cfg.required, evidence: [] as SourceReference[], waived: false as const };
  const waiver = matchWaiver(ctx, cfg.kind);
  if (waiver) return waivedResult(cfg.kind, cfg.required, waiver);
  const requirement = cfg.deposit;
  if (!requirement) {
    return { ...base, status: "missing", detail: "Deposit condition is configured without a required amount and currency" };
  }
  const receipts = ctx.classified.deposits;
  if (receipts.length === 0) {
    return { ...base, status: "missing", detail: `No deposit receipts: required ${requirement.requiredAmountCents} ${requirement.currency}` };
  }
  const freshReceipts = receipts.filter((receipt) => fresh(receipt.observedAt, ctx.nowMs, cfg.maxAgeMs));
  if (freshReceipts.length === 0) {
    return { ...base, status: "stale", detail: "Deposit evidence is older than the allowed evidence age; re-verify the deposit", evidence: receipts.flatMap((receipt) => receipt.sourceRefs) };
  }
  const inCurrency = freshReceipts.filter((receipt) => receipt.currency === requirement.currency);
  if (inCurrency.length === 0) {
    const seen = [...new Set(freshReceipts.map((receipt) => receipt.currency))].join(", ");
    return { ...base, status: "conflicting", detail: `Deposit currency mismatch: required ${requirement.currency}, receipts show ${seen}`, evidence: freshReceipts.flatMap((receipt) => receipt.sourceRefs) };
  }
  const disregarded = inCurrency.filter((receipt) => receipt.status !== "settled");
  const settled = inCurrency.filter((receipt) => receipt.status === "settled");
  const paid = settled.reduce((sum, receipt) => sum + receipt.amountCents, 0);
  if (paid >= requirement.requiredAmountCents) {
    return { ...base, status: "verified", detail: `Settled ${paid} of required ${requirement.requiredAmountCents} ${requirement.currency} across ${settled.length} receipt(s)`, evidence: settled.flatMap((receipt) => receipt.sourceRefs) };
  }
  const pendingNote = disregarded.length > 0 ? `; ${disregarded.length} receipt(s) not settled (${[...new Set(disregarded.map((receipt) => receipt.status))].join(", ")})` : "";
  const evidence = [...settled, ...disregarded].flatMap((receipt) => receipt.sourceRefs);
  return { ...base, status: "missing", detail: `Partial deposit: settled ${paid} of required ${requirement.requiredAmountCents} ${requirement.currency}${pendingNote}`, evidence };
}

function proposalWindow(payload: Record<string, unknown>): { startAt: string; endAt: string; calendarId: string } | null {
  const startAt = payload.startAt;
  const endAt = payload.endAt;
  const calendarId = payload.calendarId;
  if (!isIso(startAt) || !isIso(endAt) || Date.parse(startAt) >= Date.parse(endAt)) return null;
  if (!isNonEmptyString(calendarId)) return null;
  return { startAt, endAt, calendarId };
}

function evaluateAvailability(ctx: EvalContext, cfg: ConditionConfig): ConditionResult {
  const base = { kind: cfg.kind, required: cfg.required, evidence: [] as SourceReference[], waived: false as const };
  const waiver = matchWaiver(ctx, cfg.kind);
  if (waiver) return waivedResult(cfg.kind, cfg.required, waiver);
  const window = proposalWindow(ctx.input.proposal.payload);
  if (!window) {
    return { ...base, status: "missing", detail: "Accepted proposal lacks an explicit event window and calendar binding; availability cannot be verified" };
  }
  const maxAge = cfg.maxAgeMs ?? DEFAULT_AVAILABILITY_MAX_AGE_MS;
  const covering = ctx.classified.availability.filter(
    (att) =>
      att.calendarId === window.calendarId &&
      Date.parse(att.startAt) <= Date.parse(window.startAt) &&
      Date.parse(att.endAt) >= Date.parse(window.endAt),
  );
  if (covering.length === 0) {
    return { ...base, status: "missing", detail: `No current availability attestation covering ${window.startAt}..${window.endAt} on ${window.calendarId}` };
  }
  const current = covering.filter((att) => fresh(att.observedAt, ctx.nowMs, maxAge));
  if (current.length === 0) {
    return { ...base, status: "stale", detail: "Availability evidence is older than the allowed evidence age; recheck availability fresh", evidence: covering.flatMap((att) => att.sourceRefs) };
  }
  const unavailable = current.filter((att) => !att.available);
  if (unavailable.length > 0) {
    return { ...base, status: "conflicting", detail: "Calendar provider reports the requested window unavailable", evidence: unavailable.flatMap((att) => att.sourceRefs) };
  }
  const expiredHold = current.filter(
    (att) => att.holdId && att.holdValidUntil && Date.parse(att.holdValidUntil) <= ctx.nowMs,
  );
  if (expiredHold.length > 0 && current.every((att) => att.holdId)) {
    return { ...base, status: "stale", detail: "Provisional hold expired; availability must be rechecked and the hold renewed", evidence: expiredHold.flatMap((att) => att.sourceRefs) };
  }
  const usable = current.filter((att) => att.available && (!att.holdId || !att.holdValidUntil || Date.parse(att.holdValidUntil) > ctx.nowMs));
  if (usable.length === 0) {
    return { ...base, status: "stale", detail: "No usable current availability: holds expired", evidence: current.flatMap((att) => att.sourceRefs) };
  }
  const holdNote = usable.some((att) => att.holdId) ? " with a valid provisional hold" : " (availability only, no hold claimed)";
  return { ...base, status: "verified", detail: `Current availability covers the accepted window${holdNote}`, evidence: usable.flatMap((att) => att.sourceRefs) };
}

function evaluateResources(ctx: EvalContext, cfg: ConditionConfig): ConditionResult {
  const base = { kind: cfg.kind, required: cfg.required, evidence: [] as SourceReference[], waived: false as const };
  const waiver = matchWaiver(ctx, cfg.kind);
  if (waiver) return waivedResult(cfg.kind, cfg.required, waiver);
  const requiredIds = cfg.resources?.requiredResourceIds ?? [];
  const maxAge = cfg.maxAgeMs ?? DEFAULT_RESOURCE_MAX_AGE_MS;
  const breakdown: ResourceResult[] = requiredIds.map((resourceId) => {
    const commits = ctx.classified.resources.filter((commit) => commit.resourceId === resourceId);
    if (commits.length === 0) return { resourceId, status: "missing" as const, detail: "No commitment evidence" };
    const current = commits.filter((commit) => fresh(commit.observedAt, ctx.nowMs, maxAge));
    if (current.length === 0) {
      return { resourceId, status: "stale" as const, detail: "Commitment evidence is older than the allowed evidence age; re-verify" };
    }
    const committed = current.filter((commit) => commit.status === "committed" && (!commit.validUntil || Date.parse(commit.validUntil) > ctx.nowMs));
    const bad = current.filter((commit) => commit.status === "rejected" || commit.status === "revoked");
    if (committed.length > 0 && bad.length > 0) {
      return { resourceId, status: "conflicting" as const, detail: "Conflicting commitment and rejection/revocation evidence" };
    }
    if (committed.length > 0) {
      const responsible = committed.find((commit) => commit.responsible)?.responsible;
      return { resourceId, status: "verified" as const, detail: "Explicit commitment recorded", responsible };
    }
    if (bad.length > 0) {
      return { resourceId, status: "conflicting" as const, detail: `Resource ${bad[0]?.status}; commitment required` };
    }
    if (current.some((commit) => commit.status === "expired" || (commit.validUntil && Date.parse(commit.validUntil) <= ctx.nowMs))) {
      return { resourceId, status: "stale" as const, detail: "Commitment expired; re-verify" };
    }
    return { resourceId, status: "missing" as const, detail: "Requested but not committed; explicit commitment required" };
  });
  const evidence = breakdown.flatMap((item) =>
    ctx.classified.resources.filter((commit) => commit.resourceId === item.resourceId).flatMap((commit) => commit.sourceRefs),
  );
  if (breakdown.some((item) => item.status === "conflicting")) {
    return { ...base, status: "conflicting", detail: "Conflicting resource evidence; see per-resource breakdown", evidence, resources: breakdown };
  }
  if (breakdown.some((item) => item.status === "stale")) {
    return { ...base, status: "stale", detail: "Resource evidence is stale or expired; re-verify commitments", evidence, resources: breakdown };
  }
  if (breakdown.some((item) => item.status === "missing")) {
    return { ...base, status: "missing", detail: "Missing required resource commitments; see per-resource breakdown", evidence, resources: breakdown };
  }
  return { ...base, status: "verified", detail: `All ${breakdown.length} required resources explicitly committed`, evidence, resources: breakdown };
}

/**
 * Smallest maintainable booking-specific readiness evaluator. Pure: no
 * store, no status writes, no sends. Never confirms from a hold alone, a
 * payment link, an email claim, an unverified request, or unknown
 * availability — those inputs are either unclassifiable raw signals or
 * rejected evidence.
 */
export function evaluateReadiness(raw: unknown): ReadinessDecision {
  assertValidEvaluateInput(raw);
  const input: EvaluateReadinessInput = raw;
  const nowMs = Date.parse(input.nowIso);

  if (input.booking.businessId !== input.businessId || input.proposal.businessId !== input.businessId) {
    throw new Error("Binding mismatch: booking and proposal must belong to the evaluated business");
  }
  if (input.proposal.bookingId !== input.booking.id) {
    throw new Error("Binding mismatch: proposal does not belong to the evaluated booking");
  }
  if (input.policy.businessId !== input.businessId) {
    throw new Error("Binding mismatch: confirmation policy belongs to a different business");
  }

  const ctx: EvalContext = {
    input,
    nowMs,
    classified: { acceptance: [], deposits: [], availability: [], resources: [] },
    rejectedEvidence: [],
    citedFictional: [],
  };

  for (const item of input.evidence) {
    const record = item as unknown as Record<string, unknown>;
    const resolver: unknown = record.resolver;
    if (resolver === "acceptance_record" || resolver === "deposit_ledger" || resolver === "calendar_provider" || resolver === "resource_registry") {
      const classified =
        resolver === "acceptance_record"
          ? classifyAcceptance(record)
          : resolver === "deposit_ledger"
            ? classifyDeposit(record)
            : resolver === "calendar_provider"
              ? classifyAvailability(record)
              : classifyResource(record);
      if (typeof classified === "string") {
        ctx.rejectedEvidence.push(`rejected malformed ${String(resolver)} output: ${classified}`);
        continue;
      }
      if ("bookingId" in classified && classified.bookingId !== input.booking.id) {
        ctx.rejectedEvidence.push(`rejected ${String(resolver)} output for a different booking (${classified.bookingId})`);
        continue;
      }
      if (resolver === "acceptance_record") ctx.classified.acceptance.push(classified as AcceptanceRecord);
      else if (resolver === "deposit_ledger") ctx.classified.deposits.push(classified as DepositReceipt);
      else if (resolver === "calendar_provider") ctx.classified.availability.push(classified as AvailabilityAttestation);
      else ctx.classified.resources.push(classified as ResourceCommitment);
    } else {
      ctx.rejectedEvidence.push(
        `rejected evidence from outside the trusted resolver boundary (resolver: ${typeof resolver === "string" ? resolver : "missing"}); arbitrary verified flags never verify`,
      );
    }
  }

  const conditions: ConditionResult[] = input.policy.conditions.map((cfg) => {
    switch (cfg.kind) {
      case "customer_acceptance":
        return evaluateAcceptance(ctx, cfg);
      case "deposit":
        return evaluateDeposit(ctx, cfg);
      case "availability":
        return evaluateAvailability(ctx, cfg);
      case "resource_commitment":
        return evaluateResources(ctx, cfg);
    }
  });

  for (const condition of conditions) {
    for (const ref of condition.evidence) ctx.citedFictional.push(ref.fictional === true);
  }

  const fictionalSet = new Set(ctx.citedFictional);
  const provenance: Provenance =
    ctx.citedFictional.length === 0 ? "none" : fictionalSet.size === 1 ? (fictionalSet.has(true) ? "demo" : "live") : "mixed";

  const blockedBy: string[] = [];
  for (const condition of conditions) {
    if (condition.required && condition.status !== "verified") {
      blockedBy.push(`${condition.kind}:${condition.status} — ${condition.detail}`);
    }
  }
  if (provenance === "mixed") blockedBy.push("mixed_provenance_blocks_confirmation — fixture and live evidence are mixed; live confirmation is blocked");

  const binding: ReadinessBinding = {
    businessId: input.businessId,
    bookingId: input.booking.id,
    proposalVersion: input.proposal.proposalVersion,
    proposalFingerprint: input.proposal.proposalFingerprint,
  };
  const ready = blockedBy.length === 0 && conditions.some((condition) => condition.required);
  return {
    binding,
    evaluatedAt: input.nowIso,
    conditions,
    ready,
    liveReady: ready && provenance === "live",
    provenance,
    blockedBy,
    ignoredRawSignals: input.rawSignals?.length ?? 0,
    rejectedEvidence: ctx.rejectedEvidence,
  };
}
