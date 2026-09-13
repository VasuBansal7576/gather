'use client';

import { useState } from "react";
import type { BusinessConflict, ConflictRevision } from "../../knowledge-owner/conflicts.ts";
import { formatConflictValue } from "../../knowledge-owner/conflicts.ts";
import { formatValue, newCommandId, sourceKindLabel } from "../../knowledge-owner/state.ts";
import type { KnowledgeSourceReference } from "../../knowledge-owner/types.ts";
import "./conflict.css";

export interface ConflictResolutionInput {
  winningRevisionId: string;
  consideredRevisionIds: string[];
  commandId: string;
}

function revisionSources(revision: ConflictRevision, factSources: Map<string, KnowledgeSourceReference[]>): KnowledgeSourceReference[] {
  return factSources.get(revision.factId) ?? [];
}

/**
 * One business-wide cross-account conflict. Visually distinct from pending
 * candidate cards: this is about already-confirmed values disagreeing
 * across account lines, and resolution pins an exact winning revision —
 * never a value match, never an approve-everything action.
 */
export function ConflictCard({
  conflict,
  factSources,
  busy,
  mutationError,
  onResolve,
}: {
  conflict: BusinessConflict;
  factSources: Map<string, KnowledgeSourceReference[]>;
  busy: boolean;
  mutationError?: string;
  onResolve: (input: ConflictResolutionInput) => void;
}): React.JSX.Element {
  const [winner, setWinner] = useState<string | undefined>(undefined);
  const considered = conflict.revisions.map((revision) => revision.revisionId).sort();
  const resolved = conflict.status === "resolved";

  return (
    <article
      className={`knowledge-card is-account-conflict${resolved ? " is-resolved" : ""}`}
      aria-labelledby={`conflict-${conflict.key}-${conflict.subjectId}-title`}
    >
      <div className="knowledge-card-head">
        <h3 id={`conflict-${conflict.key}-${conflict.subjectId}-title`}>
          Account conflict · {conflict.key} · {conflict.subjectId || "business-wide"}
        </h3>
      </div>
      <div className="knowledge-card-sub">
        {conflict.revisions.length} confirmed values disagree across account lines
        {resolved && conflict.winningRevisionId ? ` · resolved in favor of revision ${conflict.winningRevisionId.slice(0, 8)}…` : ""}
      </div>
      <div className="knowledge-withheld" role="note">
        {resolved ? (
          <>Resolved — the winning revision feeds offers; other revisions stay out of offer preparation. Nothing merged.</>
        ) : (
          <><strong>On hold for offers:</strong> these values stay out of offer preparation until you pick exactly one revision below. Nothing merges.</>
        )}
      </div>
      <fieldset className="conflict-options">
        <legend>Which confirmed value should govern {conflict.subjectId || conflict.key} across accounts?</legend>
        {conflict.revisions.map((revision) => {
          const sources = revisionSources(revision, factSources);
          return (
            <label key={revision.revisionId} className="conflict-option">
              <input
                type="radio"
                name={`conflict-${conflict.key}-${conflict.subjectId}`}
                value={revision.revisionId}
                checked={winner === revision.revisionId}
                disabled={resolved || busy}
                onChange={() => setWinner(revision.revisionId)}
              />
              <span className="conflict-option-body">
                <strong>{formatConflictValue(revision.value)}</strong>
                <span className="knowledge-card-sub">
                  Account {revision.accountId} · revision {revision.revision} · approved {revision.approvedAt.slice(0, 10)}
                  {revision.reviewState !== "none" ? " · under review (stale source)" : ""}
                </span>
                {sources.length > 0 ? (
                  <span className="knowledge-card-sub">
                    {sources.map((source, index) => (
                      <span key={`${source.locator}-${index}`}>
                        {sourceKindLabel(source.kind)}: {source.label ?? source.locator}
                        {source.fictional ? " (Fixture)" : ""}
                        {index < sources.length - 1 ? " · " : ""}
                      </span>
                    ))}
                  </span>
                ) : null}
              </span>
            </label>
          );
        })}
      </fieldset>
      {mutationError ? (
        <div className="knowledge-notice" role="alert">
          <strong>Resolution did not apply. </strong>{mutationError}
        </div>
      ) : null}
      {!resolved ? (
        <div className="knowledge-actions">
          <button
            type="button"
            className="knowledge-approve-button"
            disabled={busy || winner === undefined}
            onClick={() => {
              if (winner !== undefined) onResolve({ winningRevisionId: winner, consideredRevisionIds: considered, commandId: newCommandId() });
            }}
          >
            {busy ? "Resolving…" : winner === undefined ? "Choose a revision above" : "Resolve to the chosen revision"}
          </button>
        </div>
      ) : (
        <p className="knowledge-fact-meta">
          Reviewed revisions: {considered.map((id) => id.slice(0, 8)).join(", ")} — a new revision reopens this conflict.
        </p>
      )}
    </article>
  );
}

/** Fallback value text for pending-candidate conflict mentions (bounded, never profit). */
export function conflictMention(value: Record<string, unknown>): string {
  return formatValue(value, 80);
}
