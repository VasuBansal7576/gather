import type { IncidentSource, IncidentSymptom } from "./types.ts";

/**
 * ADR-004 prepared fault-injection panel (C09/C10 6.5).
 *
 * Faults are explicitly labelled injected fixtures for prepared-mode
 * recovery drills — never evidence of real runtime behaviour. Real process
 * stop/restart proof is a separately opted-in path (the recovery tests
 * gate it behind GATHER_TEST_REAL_RESTART); everything else is scripted.
 */

export interface FaultDefinition {
  id: string;
  label: string;
  symptom: Omit<IncidentSymptom, "evidence">;
  /** Real-restart proof requires explicit opt-in; all other faults are scripted. */
  kind: "scripted" | "real-restart-opt-in";
  description: string;
}

export const FAULT_CATALOG: FaultDefinition[] = [
  {
    id: "fault_hold_ok_email_failed",
    label: "Partial completion: hold succeeded, email failed",
    symptom: {
      signature: "hold_succeeded_email_failed",
      resource: "booking:fixture-partial-001",
      operation: "create_provisional_hold",
      detail: "Injected partial completion (prepared fixture): hold receipt hold:op-1 succeeded; email step email:op-1 still pending.",
    },
    kind: "scripted",
    description: "Drives the one-hold recovery path: deterministic Tier-1 reruns only the incomplete email step.",
  },
  {
    id: "fault_sync_stalled",
    label: "Source scan stalled at cursor",
    symptom: {
      signature: "sync_cursor_stalled",
      resource: "account:fixture-mailbox",
      operation: "source_scan",
      detail: "Injected stall (prepared fixture): durable checkpoint cursor-42 committed, no progress for 2 windows.",
    },
    kind: "scripted",
    description: "Drives resume_sync_from_cursor from the committed checkpoint.",
  },
  {
    id: "fault_execution_uncertain",
    label: "Uncertain step outcome",
    symptom: {
      signature: "execution_uncertain",
      resource: "booking:fixture-uncertain-001",
      operation: "exec:op-uncertain-1",
      detail: "Injected uncertainty (prepared fixture): dispatch returned no receipt; provider truth unknown.",
    },
    kind: "scripted",
    description: "Drives reconcile_execution_by_external_id; unknown provider truth stays blocked.",
  },
  {
    id: "fault_access_revoked",
    label: "Access revoked (consent withdrawn)",
    symptom: {
      signature: "access_revoked",
      resource: "account:fixture-mailbox",
      operation: "provider_read",
      detail: "Injected revocation (prepared fixture): consent withdrawn; refresh is not authorized.",
    },
    kind: "scripted",
    description: "Drives request_reconnect: the reconnect action is surfaced and the incident honestly stays blocked.",
  },
  {
    id: "fault_runtime_unhealthy",
    label: "Isolated runtime process unhealthy",
    symptom: {
      signature: "runtime_unhealthy",
      resource: "runtime:fixture-owned-process",
      operation: "runtime_health",
      detail: "Injected unhealth (prepared fixture): owned isolated process missed 3 heartbeats.",
    },
    kind: "scripted",
    description: "Scripted restart drill through the same catalog port; labelled scripted-runtime, never real-restart proof.",
  },
  {
    id: "fault_real_restart",
    label: "Real isolated process stop/restart (opt-in only)",
    symptom: {
      signature: "runtime_unhealthy",
      resource: "runtime:opt-in-child",
      operation: "runtime_health",
      detail: "Real restart proof: a test-owned loopback child process is stopped, its exit observed, a new one started, and a useful bounded read verified. Requires GATHER_TEST_REAL_RESTART=1.",
    },
    kind: "real-restart-opt-in",
    description: "The ONLY fault that touches a real OS process, and only a test-owned loopback child — never the developer installation. Skipped unless explicitly opted in.",
  },
  {
    id: "fault_unknown_signature",
    label: "Unknown failure signature",
    symptom: {
      signature: "unknown_mystery_zzz",
      resource: "booking:fixture-mystery-001",
      operation: "unknown_op",
      detail: "Injected unknown (prepared fixture): no Tier-1 entry; budgeted Tier-2 diagnosis decides or blocks.",
    },
    kind: "scripted",
    description: "Drives Tier-2: invalid/unavailable model output blocks honestly without arbitrary tools.",
  },
];

export function faultById(id: string): FaultDefinition {
  const fault = FAULT_CATALOG.find((entry) => entry.id === id);
  if (!fault) throw new Error(`Unknown fault ${JSON.stringify(id)}; prepared faults are bounded to ${FAULT_CATALOG.map((entry) => entry.id).join(", ")}`);
  return fault;
}

export interface InjectedFault {
  faultId: string;
  source: IncidentSource;
  symptom: IncidentSymptom;
}

/** Inject a prepared fault: always labelled, never live evidence. */
export function injectFault(id: string): InjectedFault {
  const fault = faultById(id);
  if (fault.kind === "real-restart-opt-in" && process.env.GATHER_TEST_REAL_RESTART !== "1") {
    throw new Error("Real-restart proof requires explicit opt-in (GATHER_TEST_REAL_RESTART=1); refusing to touch a real process in default checks");
  }
  return {
    faultId: fault.id,
    source: "fault_injection",
    symptom: { ...fault.symptom, evidence: fault.kind === "real-restart-opt-in" ? "real-runtime" : "prepared" },
  };
}
