import type { Incident } from "../../../incidents/types.ts";

export interface IncidentThreadProps {
  incident: Incident;
  onSupervise?: (id: string) => void;
  supervising?: boolean;
}

const EVIDENCE_LABEL: Record<Incident["symptom"]["evidence"], string> = {
  prepared: "prepared fixture",
  "scripted-runtime": "scripted runtime",
  "real-runtime": "real runtime",
  "live-provider": "live provider",
};

/**
 * ADR-004 owner-visible repair thread (C10 Recoveries view).
 * Renders only persisted states: symptom, diagnosis, attempts with
 * precondition/verification detail, resumption, and remaining impact.
 * Evidence is always labelled; no internal API jargon.
 */
export function IncidentThread({ incident, onSupervise, supervising }: IncidentThreadProps) {
  const open = incident.status === "open" || incident.status === "recovering";
  return (
    <article data-testid={`incident-${incident.id}`} style={{ border: "1px solid #ccc", borderRadius: 8, padding: 12, marginBottom: 12 }}>
      <header style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
        <strong>Repair thread</strong>
        <span data-testid="incident-status">{incident.status}</span>
        <span data-testid="incident-evidence" title="Where this evidence came from">
          {EVIDENCE_LABEL[incident.symptom.evidence]}
        </span>
      </header>
      <section>
        <h4>What happened</h4>
        <p data-testid="incident-symptom">{incident.symptom.detail}</p>
        <p>
          <small>
            Scope: {incident.symptom.resource}
            {incident.symptom.operation ? ` / ${incident.symptom.operation}` : ""} · Seen {incident.attempts.length} of 3 repair attempts
          </small>
        </p>
      </section>
      {incident.diagnosis && (
        <section>
          <h4>Diagnosis ({incident.diagnosis.tier === "tier1_deterministic" ? "known problem" : "budgeted review"})</h4>
          <p data-testid="incident-diagnosis">{incident.diagnosis.summary}</p>
          <p>
            <small>Planned repair: {incident.diagnosis.selectedAction}</small>
          </p>
        </section>
      )}
      {incident.attempts.length > 0 && (
        <section>
          <h4>Repair attempts</h4>
          <ol data-testid="incident-attempts">
            {incident.attempts.map((attempt) => (
              <li key={attempt.id}>
                {attempt.action}: {attempt.preconditionOk ? "checks passed" : "checks failed"} —{" "}
                {attempt.verification.ok ? "verified" : "not verified"} ({attempt.verification.detail})
              </li>
            ))}
          </ol>
        </section>
      )}
      {incident.status === "blocked" && incident.blockedReason && (
        <section>
          <h4>Blocked — needs you</h4>
          <p data-testid="incident-blocked">{incident.blockedReason}</p>
          {incident.remainingImpact && <p><small>Still affected: {incident.remainingImpact}</small></p>}
        </section>
      )}
      {incident.status === "recovered" && (
        <section>
          <h4>Recovered</h4>
          <p data-testid="incident-recovered">
            Repair verified{incident.resumedIntentId ? `; work resumed (${incident.resumedIntentId})` : "; resume the affected work from the booking view"}.
          </p>
        </section>
      )}
      {open && onSupervise && (
        <button type="button" onClick={() => onSupervise(incident.id)} disabled={supervising === true}>
          {supervising === true ? "Repairing…" : "Run repair"}
        </button>
      )}
    </article>
  );
}
