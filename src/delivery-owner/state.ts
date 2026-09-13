import type { ConditionResult, HandoffState } from "./contracts.ts";

/**
 * Explicit deep link to one booking's delivery view. This is the nav hook
 * for later integration: host navigation can point at this route without
 * touching the shared workspace nav.
 */
export function deliveryRouteForBooking(bookingId: string): string {
  return `/bookings/${encodeURIComponent(bookingId)}/delivery`;
}

export type BookingPhase = "provisional" | "confirmed" | "other";

/** Owner-readable booking phase from raw status. */
export function bookingPhase(status: string): BookingPhase {
  if (status === "provisional_hold") return "provisional";
  if (status === "confirmed") return "confirmed";
  return "other";
}

export function phaseLabel(phase: BookingPhase, status: string): string {
  switch (phase) {
    case "provisional":
      return "Provisional — a hold is not a confirmed booking.";
    case "confirmed":
      return "Confirmed — every condition verified with real receipts.";
    default:
      return `Status: ${status}`;
  }
}

export function handoffStateLabel(state: HandoffState): string {
  switch (state) {
    case "ready":
      return "Ready for operations";
    case "preliminary":
      return "Preliminary — approved but not fully confirmed";
    case "blocked":
      return "Blocked — needs attention before handoff";
  }
}

const KIND_LABELS: Record<string, string> = {
  customer_acceptance: "Customer acceptance",
  deposit: "Deposit",
  availability: "Availability",
  resource_commitment: "Resources",
};

export function conditionLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

export function conditionTone(condition: ConditionResult): "ok" | "attention" | "muted" {
  if (!condition.required) return "muted";
  return condition.status === "verified" ? "ok" : "attention";
}

/** True when the owner may attempt confirmation (backend still decides). */
export function canAttemptConfirm(ready: boolean, liveReady: boolean): boolean {
  return ready && liveReady;
}

export function formatCents(amountCents: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amountCents / 100);
  } catch {
    return `${(amountCents / 100).toFixed(2)} ${currency}`;
  }
}

export function formatWhen(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  try {
    return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(ms));
  } catch {
    return iso;
  }
}

/**
 * Stale-request guard: each load carries a monotonically increasing epoch
 * and only the latest epoch may commit its result.
 */
export class RequestEpoch {
  private current = 0;
  next(): number {
    this.current += 1;
    return this.current;
  }
  isCurrent(epoch: number): boolean {
    return epoch === this.current;
  }
}
