import type { ConnectionsSummaryDTO, ConnectionStatus } from "./contracts.ts";

/** Owner-facing setup journey: business first, then apps, then workspace. */
export type SetupStep = "business" | "apps" | "ready";

export type LoadState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "error"; code: string; message: string; retryable: boolean };

export interface CallbackNotice {
  kind: "connected" | "error";
  provider: string;
  code?: string;
  /** Controlled business context from the redirect; selects the venue, never proves connection. */
  businessId?: string;
}

/**
 * Parse the provider-callback redirect query
 * (/setup?businessId=<id>&connected=google or &connectionError=CODE). Only
 * the controlled status hint and business context are read — the UI
 * re-fetches authoritative connection state from the local service and
 * never trusts query content as proof of connection.
 */
export function parseCallbackNotice(search: string): CallbackNotice | undefined {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search.startsWith("?") ? search : `?${search}`);
  } catch {
    return undefined;
  }
  const rawBusiness = params.get("businessId");
  const businessId = rawBusiness !== null && rawBusiness.trim().length > 0 ? rawBusiness : undefined;
  const connected = params.get("connected");
  if (connected) return { kind: "connected", provider: connected, ...(businessId === undefined ? {} : { businessId }) };
  const failure = params.get("connectionError");
  if (failure) {
    const provider = params.get("provider") ?? "google";
    return { kind: "error", provider, code: failure, ...(businessId === undefined ? {} : { businessId }) };
  }
  return undefined;
}

/**
 * Stale-request guard: each load carries a monotonically increasing epoch
 * and only the latest epoch may commit its result. Late responses from a
 * superseded business selection or a retried fetch are dropped, never
 * rendered.
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

/** Preferred next step from loaded state: apps need a business first. */
export function nextStep(businessId: string | undefined): SetupStep {
  return businessId ? "apps" : "business";
}

const READY_STATUSES: readonly ConnectionStatus[] = ["connected"];

/** True when at least one provider account is connected (enter-workspace gate). */
export function hasConnectedAccount(summary: ConnectionsSummaryDTO): boolean {
  return summary.providers.some(
    (provider) =>
      READY_STATUSES.includes(provider.status) ||
      provider.accounts.some((account) => account.status === "connected"),
  );
}

/** Owner-readable one-liner per provider status (no technical mapping language). */
export function statusBlurb(status: ConnectionStatus | "available", unavailableReason?: string): string {
  switch (status) {
    case "available":
      return "Available — connect it when you are ready.";
    case "connected":
      return "Connected — Gather can read what it needs for your review.";
    case "authorization_pending":
      return "Waiting on Google — finish signing in, then come back here.";
    case "not_connected":
      return "Not connected yet — connect it when you are ready.";
    case "revoked":
      return "Access was removed — reconnect to restore availability checks.";
    case "expired":
      return "The session expired — reconnect Google to restore availability checks.";
    case "error":
      return "Something needs attention — check the account, then retry.";
    case "unavailable":
      return unavailableReason ?? "Google connection is not available in this setup yet.";
  }
}
