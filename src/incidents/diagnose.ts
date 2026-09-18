import type { CatalogActionId, IncidentSymptom } from "./types.ts";

/**
 * ADR-004 diagnosis tiers (C08/C09).
 *
 * Tier-1 is deterministic: known signatures map to a catalog action with
 * no model call, no shell, no provider access. Tier-2 is a separately
 * budgeted read-only diagnosis over redacted evidence with catalog choices
 * only — invalid or unavailable output blocks honestly. Tier-3 handles
 * code defects with isolated reproduction + proposed patch + regression
 * artifacts under .runtime/repairs/<incident>/, never applied.
 */

/** Known-signature table: Tier-1 deterministic selection. */
const KNOWN_SIGNATURES: Record<string, { action: CatalogActionId; summary: string }> = {
  hold_succeeded_email_failed: {
    action: "rerun_resumable_intent",
    summary: "Hold receipt succeeded while email is still incomplete: only the incomplete email step may advance; the completed hold receipt is reused, never duplicated.",
  },
  sync_cursor_stalled: {
    action: "resume_sync_from_cursor",
    summary: "Source scan stalled at a durable checkpoint: resume from the committed cursor with stable-key dedupe.",
  },
  execution_uncertain: {
    action: "reconcile_execution_by_external_id",
    summary: "Step outcome unknown after dispatch: re-read provider state with the persisted operation identity (read-only); unknown stays blocked.",
  },
  access_expired: {
    action: "refresh_access",
    summary: "Stored credential expired with a refresh credential available and consent intact: refresh, then prove a harmless authorized read.",
  },
  access_revoked: {
    action: "request_reconnect",
    summary: "Access revoked or expired beyond existing authority: surface a visible reconnect action and stay blocked until consent + read succeed.",
  },
  runtime_unhealthy: {
    action: "restart_runtime",
    summary: "Owned isolated process unhealthy: fence affected runs, observe old exit, reboot, prove a useful bounded read, then reconcile pending effects.",
  },
  config_incompatible: {
    action: "rollback_config_known_good",
    summary: "Configuration incompatible with the pinned runtime: restore the validated compatible backup (runs fenced), then a useful read plus external reconciliation.",
  },
};

export interface Tier1Result {
  tier: "tier1_deterministic";
  summary: string;
  selectedAction: CatalogActionId;
}

/** Tier-1: known signatures only. Unknown signatures return undefined — never guessed. */
export function diagnoseTier1(symptom: IncidentSymptom): Tier1Result | undefined {
  const known = KNOWN_SIGNATURES[symptom.signature];
  if (!known) return undefined;
  return { tier: "tier1_deterministic", summary: known.summary, selectedAction: known.action };
}

export interface Tier2Budget {
  maxToolCalls: number;
  maxTokens: number;
  usedToolCalls: number;
  usedTokens: number;
}

export interface Tier2Evidence {
  /** Redacted, read-only evidence — never credentials or provider bodies. */
  summary: string;
  signature: string;
  resource: string;
}

/** The only shape an unknown-diagnosis model call may return. */
export interface Tier2ModelOutput {
  selectedAction: CatalogActionId;
  rationale: string;
}

export type Tier2Model = (evidence: Tier2Evidence) => Promise<Tier2ModelOutput | undefined>;

export interface Tier2Result {
  tier: "tier2_budgeted";
  summary: string;
  selectedAction: CatalogActionId;
  budgetSpent: { toolCalls: number; tokens: number };
}

/**
 * Tier-2: separately budgeted, read-only, catalog choices only.
 * - Budget is reserved before the call; exhaustion blocks without calling.
 * - The output must name a bounded catalog action; anything else
 *   (arbitrary tool, shell, authority change) is rejected and blocks.
 * - Invalid or unavailable model output blocks honestly — it never claims
 *   recovery and never falls through to an arbitrary action.
 */
export async function diagnoseTier2(
  evidence: Tier2Evidence,
  budget: Tier2Budget,
  model: Tier2Model,
): Promise<{ result?: Tier2Result; blocked?: string }> {
  if (budget.usedToolCalls + 1 > budget.maxToolCalls || budget.usedTokens + 500 > budget.maxTokens) {
    return { blocked: `Tier-2 diagnosis budget exhausted (${budget.usedToolCalls}/${budget.maxToolCalls} calls, ${budget.usedTokens}/${budget.maxTokens} tokens); incident stays blocked` };
  }
  budget.usedToolCalls += 1;
  let output: Tier2ModelOutput | undefined;
  try {
    output = await model(evidence);
  } catch (error) {
    return { blocked: `Tier-2 diagnosis unavailable: ${error instanceof Error ? error.message : String(error)}; incident stays blocked` };
  }
  budget.usedTokens += 500;
  if (!output || typeof output.selectedAction !== "string" || typeof output.rationale !== "string" || output.rationale.length === 0) {
    return { blocked: "Tier-2 diagnosis returned invalid output (action + rationale required); incident stays blocked" };
  }
  if (!(["restart_runtime", "resume_sync_from_cursor", "reconcile_execution_by_external_id", "refresh_access", "request_reconnect", "rollback_config_known_good", "rerun_resumable_intent", "mark_blocked"] as const).includes(output.selectedAction as CatalogActionId)) {
    return { blocked: `Tier-2 diagnosis selected an unknown action ${JSON.stringify(output.selectedAction)}; arbitrary tools are forbidden, incident stays blocked` };
  }
  return {
    result: {
      tier: "tier2_budgeted",
      summary: `Budgeted read-only diagnosis: ${output.rationale}`,
      selectedAction: output.selectedAction,
      budgetSpent: { toolCalls: 1, tokens: 500 },
    },
  };
}
