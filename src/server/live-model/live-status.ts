/**
 * ADR-006 live gate evidence collection (composition only).
 *
 * Reads presence-level evidence through existing ports — connection
 * readiness, connected accounts, env-supplied configuration — and evaluates
 * it with the pure `evaluateLiveGate` contract. This module performs no
 * provider calls, boots no runtime, discovers no personal installation, and
 * contacts no model: collecting evidence never authorizes live effects.
 *
 * Without operator-supplied accounts/credentials the report stays
 * explicitly BLOCKED with named missing evidence. No fixture injection
 * into the empty-account path: an empty connected-account list is evidence
 * of absence, never a reason to simulate.
 */

import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  evaluateLiveGate,
  type IntegrationProfileId,
  type LiveGateEvidence,
  type LiveGateReport,
} from "../../integrations/contracts.ts";
import { getProfile } from "../../integrations/registry.ts";
import { configuredAcceptanceKeyring } from "../acceptance/index.ts";
import type { GatherStore } from "../sqlite-store.ts";

function envPresent(name: string): boolean {
  return (process.env[name] ?? "").trim().length > 0;
}

export interface LiveStatusDeps {
  store: GatherStore;
  /** Existing provider-readiness port (no network; reads local config). */
  providerReadiness: () => Array<{ provider: string; status: string }>;
}

export function collectLiveGateEvidence(deps: LiveStatusDeps): LiveGateEvidence {
  // Pinned test harness binary explicitly supplied by the operator. Presence
  // only — never executed, booted, or discovered implicitly here.
  const harness = (process.env.GATHER_TEST_OPENCLAW_BIN ?? "").trim();
  const runtimeProvisioned = harness.length > 0 && isAbsolute(harness) && existsSync(harness);

  // ADR-008 native cutover has no recorded activation in this build: the
  // prepared port is authoritative and the native gate stays live-BLOCKED.
  // (Commit 47caf47.) A future verified cutover records its activation and
  // flips this read; nothing here invents it.
  const knowledgeNative = false;

  let googleConfigured = false;
  try {
    googleConfigured = deps.providerReadiness().some(
      (entry) => entry.provider === "google" && entry.status === "available",
    );
  } catch {
    googleConfigured = false;
  }

  let googleAccountConnected = false;
  try {
    googleAccountConnected = deps.store
      .listConnectedAccounts()
      .some((account) => account.status === "connected");
  } catch {
    googleAccountConnected = false;
  }

  // Supported model access: an explicit profile id is the operator's claim
  // of an authorized path; consent is separately required per live run.
  const modelAuthorized = envPresent("GATHER_MODEL_PROFILE_ID") || envPresent("GATHER_LIVE_CONSENT");

  // The default recipient is undeliverable by design — only an explicit
  // operator value counts as an authorized test recipient. Read at call
  // time so operator configuration applied after boot is honored.
  const recipient = (process.env.GATHER_TEST_RECIPIENT ?? "").trim();
  const testRecipientConfigured = recipient.length > 0 && !recipient.endsWith("@example.invalid");

  let acceptanceKeyConfigured = false;
  try {
    acceptanceKeyConfigured = configuredAcceptanceKeyring() !== undefined;
  } catch {
    acceptanceKeyConfigured = false;
  }

  return {
    runtimeProvisioned,
    knowledgeNative,
    googleConfigured,
    googleAccountConnected,
    modelAuthorized,
    testRecipientConfigured,
    acceptanceKeyConfigured,
  };
}

export function liveGateReport(
  deps: LiveStatusDeps,
  profile: IntegrationProfileId = "base",
): LiveGateReport {
  return evaluateLiveGate(getProfile(profile), collectLiveGateEvidence(deps));
}
