import type { ReactNode } from "react";
import type { ParseOwnerRuleResult } from "../../../knowledge/rules.ts";

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

export interface RuleConfirmationProps {
  result: ParseOwnerRuleResult;
  onConfirm: () => void;
  onBack: () => void;
  confirming?: boolean;
}

/**
 * ADR-005 rule confirmation (exported for ADR-006 composition). Shows the
 * parsed scope visibly before anything becomes policy, or the clarification
 * questions when the text is ambiguous. Confirming here still routes through
 * the owner-only versioned decisions — this screen grants no authority and
 * no send permission by itself.
 */
export function RuleConfirmation(props: RuleConfirmationProps): ReactNode {
  const { result, onConfirm, onBack, confirming } = props;
  return (
    <section aria-label="Rule confirmation" style={panel}>
      <h2 style={heading}>Confirm owner rule</h2>
      <p style={muted}>
        You typed: <q>{result.echo}</q>
      </p>
      {result.status === "needs_clarification" ? (
        <div>
          <p>This needs clarification before it can become policy. Nothing was saved.</p>
          <ul>
            {result.questions.map((question) => (
              <li key={question}>{question}</li>
            ))}
          </ul>
          <button type="button" onClick={onBack}>
            Revise rule text
          </button>
        </div>
      ) : (
        <div>
          <dl>
            <dt>Kind</dt>
            <dd>{result.draft.kind}</dd>
            <dt>Fact key</dt>
            <dd>
              {result.draft.key}/{result.draft.subjectId || "(global)"}
            </dd>
            <dt>Visible scope</dt>
            <dd>
              <strong>{result.draft.scope.label}</strong>
            </dd>
            <dt>Limits</dt>
            <dd>{result.draft.limits.join("; ") || "none stated"}</dd>
            <dt>Send authority</dt>
            <dd>
              <strong>none</strong> — confirming permits the policy only; every outbound action
              still needs its own exact approval.
            </dd>
          </dl>
          {result.draft.warnings.length > 0 ? (
            <ul>
              {result.draft.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          ) : null}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={onConfirm}
              disabled={confirming === true}
              aria-label="Confirm rule as owner policy"
            >
              {confirming === true ? "Confirming…" : "Confirm as owner policy"}
            </button>
            <button type="button" onClick={onBack}>
              Revise
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
