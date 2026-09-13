import { assertValidHandoffInput } from "./contracts.ts";
import type {
  BuildHandoffInput,
  ConditionResult,
  OperationalHandoff,
} from "./contracts.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isIso(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));
}

/**
 * Operational handoff tied to the accepted proposal version. Every entry
 * comes from the booking snapshot, the accepted payload, or evaluated
 * evidence — nothing is invented. Missing staff, services, prices, or
 * responsibilities appear under `outstanding` and force `ready: false`.
 * Pure: no store, no status writes.
 */
export function buildHandoff(raw: unknown): OperationalHandoff {
  assertValidHandoffInput(raw);
  const input = raw as BuildHandoffInput;
  const { decision, booking, proposal } = input;

  if (
    decision.binding.businessId !== booking.businessId ||
    decision.binding.businessId !== proposal.businessId ||
    decision.binding.bookingId !== booking.id ||
    decision.binding.bookingId !== proposal.bookingId ||
    decision.binding.proposalVersion !== proposal.proposalVersion ||
    decision.binding.proposalFingerprint !== proposal.proposalFingerprint
  ) {
    throw new Error("Handoff binding mismatch: decision, booking, and proposal must share the accepted version identity");
  }

  const outstanding: string[] = [];
  for (const condition of decision.conditions as ConditionResult[]) {
    if (condition.required && condition.status !== "verified") {
      outstanding.push(`Unresolved ${condition.kind} (${condition.status}): ${condition.detail}`);
    }
  }

  const payloadStart: unknown = proposal.payload.startAt;
  const payloadEnd: unknown = proposal.payload.endAt;
  const startAt = isIso(booking.startAt) ? booking.startAt : isIso(payloadStart) ? (payloadStart as string) : undefined;
  const endAt = isIso(booking.endAt) ? booking.endAt : isIso(payloadEnd) ? (payloadEnd as string) : undefined;
  if (!startAt || !endAt) outstanding.push("Event window is not specified in the booking or accepted proposal");

  const services: OperationalHandoff["services"] = [];
  const rawServices: unknown = proposal.payload.services;
  if (Array.isArray(rawServices) && rawServices.length > 0 && rawServices.every((entry) => isRecord(entry) && isNonEmptyString(entry.name))) {
    for (const entry of rawServices as Record<string, unknown>[]) {
      services.push({
        name: entry.name as string,
        detail: typeof entry.detail === "string" ? entry.detail : undefined,
        source: proposal.sourceReferences,
      });
    }
  } else {
    outstanding.push("Services are not itemized in the accepted proposal; no service list was invented");
  }

  const responsibilities: OperationalHandoff["responsibilities"] = [];
  const rawResponsibilities: unknown = proposal.payload.responsibilities;
  if (
    Array.isArray(rawResponsibilities) &&
    rawResponsibilities.length > 0 &&
    rawResponsibilities.every((entry) => isRecord(entry) && isNonEmptyString(entry.party) && isNonEmptyString(entry.task))
  ) {
    for (const entry of rawResponsibilities as Record<string, unknown>[]) {
      responsibilities.push({ party: entry.party as string, task: entry.task as string, source: proposal.sourceReferences });
    }
  } else {
    outstanding.push("Responsibilities are not assigned in the accepted proposal; no owners were invented");
  }

  const resources: OperationalHandoff["resources"] = [];
  const resourceCondition = (decision.conditions as ConditionResult[]).find((condition) => condition.kind === "resource_commitment");
  if (resourceCondition?.resources) {
    for (const item of resourceCondition.resources) {
      resources.push({
        resourceId: item.resourceId,
        status: item.status,
        responsible: item.responsible,
        source: resourceCondition.evidence,
      });
    }
  } else {
    outstanding.push("Resource commitments were not evaluated under the confirmation policy");
  }

  return {
    binding: decision.binding,
    provenance: decision.provenance,
    event: {
      name: booking.eventName,
      ...(startAt ? { startAt } : {}),
      ...(endAt ? { endAt } : {}),
      ...(typeof booking.guestCount === "number" ? { guestCount: booking.guestCount } : {}),
    },
    services,
    responsibilities,
    resources,
    outstanding,
    ready: decision.ready && outstanding.length === 0,
  };
}
