/**
 * ADR-004 incident types (C06/C08/C09/C10).
 *
 * A supervisor outside the booking agent turns intent failures, health
 * failures and dead-letters into scoped incidents. Each incident records
 * symptom, diagnosis, selected action, verification and resumption — the
 * owner-visible repair thread. Technical restoration and useful booking
 * continuation are declared separately (C09).
 */

/** Bounded C09 repair catalog action ids. Anything else is rejected. */
export const CATALOG_ACTION_IDS = [
  "restart_runtime",
  "resume_sync_from_cursor",
  "reconcile_execution_by_external_id",
  "refresh_access",
  "request_reconnect",
  "rollback_config_known_good",
  "rerun_resumable_intent",
  "mark_blocked",
] as const;

export type CatalogActionId = (typeof CATALOG_ACTION_IDS)[number];

export function isCatalogActionId(value: unknown): value is CatalogActionId {
  return typeof value === "string" && (CATALOG_ACTION_IDS as readonly string[]).includes(value);
}

/** Where the incident came from. Never a live provider write path. */
export type IncidentSource = "intent_failure" | "health" | "deadletter" | "fault_injection";

export type IncidentStatus = "open" | "recovering" | "recovered" | "blocked";

/** Diagnosis tier: deterministic, budgeted read-only, or code-patch proposal. */
export type DiagnosisTier = "tier1_deterministic" | "tier2_budgeted" | "tier3_patch_proposal";

export interface IncidentSymptom {
  /** Stable signature, e.g. "hold_succeeded_email_failed". */
  signature: string;
  /** Affected operation key / resource scope (booking, account, run). */
  resource: string;
  operation?: string;
  detail: string;
  /** Evidence label: prepared | scripted-runtime | real-runtime | live-provider. */
  evidence: "prepared" | "scripted-runtime" | "real-runtime" | "live-provider";
}

export interface IncidentDiagnosis {
  tier: DiagnosisTier;
  summary: string;
  selectedAction: CatalogActionId;
  /** Tier-2 only: bounded model spend accounted against the run budget. */
  budgetSpent?: { toolCalls: number; tokens: number };
}

export interface AttemptVerification {
  ok: boolean;
  detail: string;
  /** Technical restoration (e.g. runtime restarted) vs useful continuation. */
  technicalRestored?: boolean;
  /** Useful booking continuation (e.g. email receipt now succeeded). */
  bookingContinued?: boolean;
}

export interface IncidentAttempt {
  id: string;
  incidentId: string;
  n: number;
  action: CatalogActionId;
  preconditionOk: boolean;
  verification: AttemptVerification;
  createdAt: string;
}

export interface Incident {
  id: string;
  source: IncidentSource;
  symptom: IncidentSymptom;
  /** Dedup key: affected resource/operation + signature (C09). */
  dedupeKey: string;
  status: IncidentStatus;
  diagnosis?: IncidentDiagnosis;
  attempts: IncidentAttempt[];
  blockedReason?: string;
  resumedIntentId?: string;
  remainingImpact?: string;
  createdAt: string;
  updatedAt: string;
}

/** Maximum repair attempts per incident (C09). */
export const MAX_INCIDENT_ATTEMPTS = 3;

export function dedupeKeyFor(resource: string, operation: string | undefined, signature: string): string {
  return [resource, operation ?? "-", signature].join("|");
}
