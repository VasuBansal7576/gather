import { catalogAction, type CatalogPorts } from "./catalog.ts";
import { diagnoseTier1, diagnoseTier2, type Tier2Budget, type Tier2Evidence, type Tier2Model } from "./diagnose.ts";
import { IncidentStore } from "./store.ts";
import { MAX_INCIDENT_ATTEMPTS, type CatalogActionId, type Incident, type IncidentSymptom } from "./types.ts";

/**
 * ADR-004 supervisor loop (C06/C08/C09/C10).
 *
 * The supervisor sits outside the booking agent: it never depends on the
 * broken agent answering, never issues arbitrary shell/provider/authority
 * operations, and never repeats an unchanged action without new evidence.
 * Bounded to MAX_INCIDENT_ATTEMPTS attempts; exhaustion, permanent denial,
 * or invalid diagnosis all end honestly blocked.
 */

export interface SupervisorPorts extends CatalogPorts {
  tier2?: { budget: Tier2Budget; model: Tier2Model };
  /**
   * Whether fresh evidence arrived since the last failed attempt (e.g. a
   * new provider observation). Defaults to false: an unchanged repeat is
   * never retried. Tests drive transient-then-exhausted scenarios through
   * this hook explicitly.
   */
  newEvidenceAvailable?: () => boolean;
  /** Resumption hook: re-drive the affected intent after recovery. */
  resumeIntent?: (incident: Incident) => Promise<{ resumedIntentId: string } | { blocked: string }>;
}

export interface SupervisorResult {
  incident: Incident;
  /** True when useful booking continuation was verified (not just technical restore). */
  bookingContinued: boolean;
}

/** request_reconnect and mark_blocked succeed by recording the owner step; the incident then waits blocked. */
const OWNER_BLOCKED_ACTIONS: CatalogActionId[] = ["request_reconnect", "mark_blocked"];

export async function superviseIncident(
  store: IncidentStore,
  incidentId: string,
  ports: SupervisorPorts,
): Promise<SupervisorResult> {
  let incident = store.get(incidentId);
  const symptom: IncidentSymptom = incident.symptom;

  // Diagnose once: Tier-1 deterministic, else budgeted Tier-2, else blocked.
  if (!incident.diagnosis) {
    const tier1 = diagnoseTier1(symptom);
    if (tier1) {
      incident = store.setDiagnosis(incidentId, { tier: tier1.tier, summary: tier1.summary, selectedAction: tier1.selectedAction });
    } else if (ports.tier2) {
      const evidence: Tier2Evidence = { summary: symptom.detail, signature: symptom.signature, resource: symptom.resource };
      const { result, blocked } = await diagnoseTier2(evidence, ports.tier2.budget, ports.tier2.model);
      if (blocked || !result) {
        return { incident: store.markBlocked(incidentId, blocked ?? "unknown diagnosis unavailable", symptom.detail), bookingContinued: false };
      }
      incident = store.setDiagnosis(incidentId, { tier: result.tier, summary: result.summary, selectedAction: result.selectedAction, budgetSpent: result.budgetSpent });
    } else {
      return {
        incident: store.markBlocked(incidentId, `unknown signature ${JSON.stringify(symptom.signature)} with no Tier-2 budget; refusing arbitrary action`, symptom.detail),
        bookingContinued: false,
      };
    }
  }

  const selected = incident.diagnosis!.selectedAction;
  const input = { resource: symptom.resource, operationKey: symptom.operation, reason: symptom.detail };

  while (incident.attempts.length < MAX_INCIDENT_ATTEMPTS) {
    const action = catalogAction(selected);
    const check = action.check(input, ports);
    if (!check.ok) {
      // A denial on the first attempt (wrong resource, revoked consent,
      // permanently denied action) stops immediately — no attempt is burned
      // pretending. A later precondition failure also blocks honestly.
      return { incident: store.markBlocked(incidentId, check.reason, symptom.detail), bookingContinued: false };
    }
    const verification = await action.run(input, ports);
    incident = store.recordAttempt(incidentId, { action: selected, preconditionOk: true, verification });
    if (verification.ok) {
      if (OWNER_BLOCKED_ACTIONS.includes(selected)) {
        return { incident: store.markBlocked(incidentId, verification.detail, symptom.detail), bookingContinued: false };
      }
      if (ports.resumeIntent) {
        try {
          const resumed = await ports.resumeIntent(incident);
          if ("resumedIntentId" in resumed) incident = store.markResumed(incidentId, resumed.resumedIntentId);
        } catch {
          // Resumption failure never rewrites the verified recovery.
        }
      }
      return { incident, bookingContinued: verification.bookingContinued === true };
    }
    // Failed attempt: retry only with genuinely new evidence and remaining
    // budget; an unchanged repeat is forbidden.
    const fresh = ports.newEvidenceAvailable?.() === true;
    if (!fresh || incident.attempts.length >= MAX_INCIDENT_ATTEMPTS) break;
  }

  const last = incident.attempts[incident.attempts.length - 1];
  return {
    incident: store.markBlocked(
      incidentId,
      `exhausted ${incident.attempts.length} bounded attempt(s) of ${MAX_INCIDENT_ATTEMPTS} for ${selected}; last: ${last?.verification.detail ?? "no attempt recorded"}`,
      symptom.detail,
    ),
    bookingContinued: false,
  };
}
