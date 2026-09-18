import type { ReactNode } from "react";
import type { SourceInspection } from "../../../knowledge/review.ts";

const panel: React.CSSProperties = {
  border: "1px solid #d8d2c7",
  borderRadius: 12,
  padding: 16,
  marginBottom: 16,
  maxWidth: "100%",
  background: "#fffdf8",
};

const heading: React.CSSProperties = { margin: "0 0 8px", fontSize: 18 };
const muted: React.CSSProperties = { color: "#5b564a", fontSize: 14 };
const row: React.CSSProperties = {
  display: "flex",
  gap: 12,
  alignItems: "flex-start",
  padding: "10px 0",
  borderTop: "1px solid #ece7db",
  flexWrap: "wrap",
};

export interface EvidenceReviewProps {
  inspection: SourceInspection;
  selectedIds: readonly string[];
  onToggleCandidate: (candidateId: string) => void;
  onBatchConfirm: () => void;
  confirming?: boolean;
}

/**
 * ADR-005 evidence review (exported for ADR-006 composition).
 * Owner-inspectable candidate list with sources, uncertainty, current
 * counterparts, conflicts and missing information, plus batch confirmation
 * of exactly the inspected claims. All controls are native and keyboard
 * operable; layout is fluid for 390px mobile and 1440px desktop.
 */
export function EvidenceReview(props: EvidenceReviewProps): ReactNode {
  const { inspection, selectedIds, onToggleCandidate, onBatchConfirm, confirming } = props;
  return (
    <section aria-label="Evidence review" style={panel}>
      <h2 style={heading}>Review document claims</h2>
      <p style={muted}>
        Source <strong>{inspection.sourceLocator}</strong> · {inspection.candidates.length} pending{" "}
        {inspection.candidates.length === 1 ? "claim" : "claims"} · provenance {inspection.provenance}
      </p>
      {inspection.candidates.length === 0 ? (
        <p>No pending claims from this source. Nothing to confirm.</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {inspection.candidates.map((candidate) => (
            <li key={candidate.id} style={row}>
              <input
                type="checkbox"
                id={`candidate-${candidate.id}`}
                checked={selectedIds.includes(candidate.id)}
                onChange={() => onToggleCandidate(candidate.id)}
                aria-describedby={`candidate-${candidate.id}-detail`}
              />
              <div style={{ flex: "1 1 240px", minWidth: 0 }}>
                <label htmlFor={`candidate-${candidate.id}`}>
                  <strong>
                    {candidate.key}/{candidate.subjectId || "(global)"}
                  </strong>{" "}
                  · {candidate.confidence}
                </label>
                <p id={`candidate-${candidate.id}-detail`} style={{ ...muted, margin: "4px 0" }}>
                  From {candidate.sourceLabel}
                  {candidate.sourceRevision ? ` (revision ${candidate.sourceRevision})` : ""}; observed{" "}
                  {candidate.observedAt}.
                </p>
                <p style={{ ...muted, margin: "4px 0" }}>
                  {candidate.currentFact
                    ? `Current: confirmed revision ${candidate.currentFact.revision}. Confirming supersedes it.`
                    : "No confirmed fact yet — confirming creates the first version."}
                </p>
                {candidate.conflictsWith.length > 0 ? (
                  <p style={{ margin: "4px 0", fontSize: 14 }}>
                    <strong>Conflicts with:</strong> {candidate.conflictsWith.join(", ")}
                  </p>
                ) : null}
                <pre
                  style={{
                    fontSize: 12,
                    background: "#f4f0e6",
                    padding: 8,
                    borderRadius: 8,
                    overflowX: "auto",
                    maxWidth: "100%",
                  }}
                >
                  {JSON.stringify(candidate.value, null, 2)}
                </pre>
              </div>
            </li>
          ))}
        </ul>
      )}
      {inspection.missingKeys.length > 0 ? (
        <p style={muted}>
          Missing information: no confirmed fact yet for{" "}
          <strong>{inspection.missingKeys.join(", ")}</strong>.
        </p>
      ) : null}
      <button
        type="button"
        onClick={onBatchConfirm}
        disabled={selectedIds.length === 0 || confirming === true}
        aria-label={`Confirm ${selectedIds.length} selected claims`}
      >
        {confirming === true ? "Confirming…" : `Confirm ${selectedIds.length} selected`}
      </button>
    </section>
  );
}
