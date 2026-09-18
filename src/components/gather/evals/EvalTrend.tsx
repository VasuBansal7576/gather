import type { ReactNode } from "react";
import type { ComparedRuns } from "../../../evals/runner.ts";

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

export interface EvalTrendProps {
  comparison: ComparedRuns;
}

/**
 * ADR-005 evaluation trend (exported for ADR-006 composition). Renders the
 * before/after comparison on the same versioned case set with numerator and
 * denominator shown, added cases listed as denominator changes, and the
 * no-causal-claim disclaimer. An unchanged or worse score renders honestly.
 */
export function EvalTrend(props: EvalTrendProps): ReactNode {
  const { comparison } = props;
  return (
    <section aria-label="Evaluation trend" style={panel}>
      <h2 style={heading}>Evaluation trend</h2>
      <p style={muted}>
        Case set <strong>{comparison.caseSetVersion}</strong> · verdict:{" "}
        <strong>{comparison.verdict}</strong>
      </p>
      <table style={{ borderCollapse: "collapse", width: "100%", maxWidth: "100%" }}>
        <caption style={{ textAlign: "left", ...muted }}>
          Same versioned case set before and after; numerators with denominators.
        </caption>
        <thead>
          <tr>
            <th scope="col" style={{ textAlign: "left", borderBottom: "1px solid #d8d2c7" }}>Run</th>
            <th scope="col" style={{ textAlign: "left", borderBottom: "1px solid #d8d2c7" }}>Score</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row" style={{ textAlign: "left" }}>Before</th>
            <td>
              {comparison.before.passed}/{comparison.before.denominator}
            </td>
          </tr>
          <tr>
            <th scope="row" style={{ textAlign: "left" }}>After</th>
            <td>
              {comparison.after.passed}/{comparison.after.denominator}
            </td>
          </tr>
          <tr>
            <th scope="row" style={{ textAlign: "left" }}>Shared cases</th>
            <td>
              {comparison.sharedAfterPassed}/{comparison.sharedCaseIds.length} (before{" "}
              {comparison.sharedBeforePassed}/{comparison.sharedCaseIds.length})
            </td>
          </tr>
        </tbody>
      </table>
      <p style={muted}>{comparison.denominatorNote}</p>
      {comparison.addedCaseIds.length > 0 ? (
        <p style={muted}>Added cases (denominator change, not improvement): {comparison.addedCaseIds.join(", ")}</p>
      ) : null}
      {comparison.removedCaseIds.length > 0 ? (
        <p style={muted}>Removed cases: {comparison.removedCaseIds.join(", ")}</p>
      ) : null}
      <p style={muted}>{comparison.disclaimer}</p>
    </section>
  );
}
