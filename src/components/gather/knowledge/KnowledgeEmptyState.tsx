import type { ReactNode } from "react";

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

export type KnowledgeEmptyVariant = "no-facts" | "unavailable" | "stale" | "error";

const COPY: Record<KnowledgeEmptyVariant, { title: string; body: string }> = {
  "no-facts": {
    title: "No business information yet",
    body: "No business information found yet for this scope. Add a source document or type an owner rule to begin — this is an empty result, not a failure.",
  },
  unavailable: {
    title: "Knowledge unavailable",
    body: "Knowledge is unavailable right now, not empty. Pending work that needs it stays blocked until the index is reachable again — nothing here authorizes an offer.",
  },
  stale: {
    title: "Knowledge needs reconfirmation",
    body: "A source changed since the owner confirmed these facts. Affected facts are withheld from offers until reconfirmed; accepted snapshots stay unchanged.",
  },
  error: {
    title: "Something went wrong",
    body: "The knowledge read failed. No facts were served and nothing was confirmed. Retry, and if it persists, reconnect the source before authorizing work.",
  },
};

export interface KnowledgeEmptyStateProps {
  variant: KnowledgeEmptyVariant;
  detail?: string;
  reasons?: readonly string[];
  onRetry?: () => void;
}

/**
 * ADR-005 honest empty/error states (exported for ADR-006 composition).
 * no-facts, unavailable, stale and error render distinct copy so an outage
 * or a stale index can never read as "no information".
 */
export function KnowledgeEmptyState(props: KnowledgeEmptyStateProps): ReactNode {
  const copy = COPY[props.variant];
  return (
    <section aria-label={copy.title} style={panel}>
      <h2 style={heading}>{copy.title}</h2>
      <p style={muted}>{copy.body}</p>
      {props.detail ? <p style={muted}>{props.detail}</p> : null}
      {props.reasons && props.reasons.length > 0 ? (
        <ul>
          {props.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      ) : null}
      {props.onRetry ? (
        <button type="button" onClick={props.onRetry} aria-label="Retry knowledge read">
          Retry
        </button>
      ) : null}
    </section>
  );
}
