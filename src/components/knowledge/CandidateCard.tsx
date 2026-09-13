'use client';

import { useState } from "react";
import type { KnowledgeCandidate } from "../../knowledge-owner/types.ts";
import {
  describeConfirmEffect,
  describeRejectEffect,
  formatValue,
  isFixtureOnly,
  keyLabel,
  sourceKindLabel,
  subjectLabel,
} from "../../knowledge-owner/state.ts";

export interface CandidateDecision {
  candidateId: string;
  commandId: string;
  reason?: string;
}

interface CandidateCardProps {
  candidate: KnowledgeCandidate;
  conflicts: KnowledgeCandidate[];
  busy: boolean;
  mutationError?: string;
  onConfirm: (decision: CandidateDecision) => void;
  onReject: (decision: CandidateDecision) => void;
  newCommandId: () => string;
}

function StatusPills({ candidate }: { candidate: KnowledgeCandidate }): React.JSX.Element {
  const conflicted = candidate.conflictsWith.length > 0 && candidate.status === "pending";
  return (
    <div className="knowledge-pill-row" aria-label="Candidate status">
      <span className={`knowledge-pill is-${candidate.status}`}>
        <span className="knowledge-dot" aria-hidden="true" />
        {candidate.status === "pending"
          ? "Needs review"
          : candidate.status === "stale"
            ? "Stale — replaced"
            : candidate.status === "confirmed"
              ? "Confirmed"
              : "Rejected"}
      </span>
      {conflicted ? (
        <span className="knowledge-pill is-conflict">
          <span className="knowledge-dot" aria-hidden="true" />
          Conflict — {candidate.conflictsWith.length} differing observation{candidate.conflictsWith.length === 1 ? "" : "s"}
        </span>
      ) : null}
      <span className="knowledge-pill is-uncertain" title="Extraction label as stored — not a calibrated probability">
        Observed: {candidate.confidence}
      </span>
      {isFixtureOnly(candidate.sourceReferences) ? <span className="knowledge-pill is-fixture">Fixture</span> : null}
    </div>
  );
}

function Sources({ candidate }: { candidate: KnowledgeCandidate }): React.JSX.Element {
  return (
    <div className="knowledge-sources" aria-label="Attributable sources">
      {candidate.sourceReferences.map((source) => (
        <div className="knowledge-source" key={`${source.kind}:${source.locator}`}>
          <span className="knowledge-source-kind">{sourceKindLabel(source.kind)}</span>
          <span>{source.label ?? source.locator}</span>
          {source.label ? <code>{source.locator}</code> : null}
          {source.fictional ? <span className="knowledge-pill is-fixture">Fixture</span> : null}
        </div>
      ))}
      {candidate.sourceRevision ? (
        <div className="knowledge-source">
          <span className="knowledge-source-kind">Source version</span>
          <code>{candidate.sourceRevision}</code>
        </div>
      ) : null}
    </div>
  );
}

/**
 * One reviewable observation. Confirming is always optional per item:
 * skipping leaves the candidate pending and changes nothing.
 */
export function CandidateCard({
  candidate,
  conflicts,
  busy,
  mutationError,
  onConfirm,
  onReject,
  newCommandId,
}: CandidateCardProps): React.JSX.Element {
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason, setReason] = useState("");
  const conflicted = candidate.conflictsWith.length > 0 && candidate.status === "pending";
  const actionable = candidate.status === "pending";
  const confirmEffect = describeConfirmEffect(candidate);
  const rejectEffect = describeRejectEffect(candidate);

  return (
    <article
      className={`knowledge-card${conflicted ? " is-conflict" : ""}${candidate.status === "stale" ? " is-stale" : ""}`}
      aria-labelledby={`candidate-${candidate.id}-title`}
    >
      <div className="knowledge-card-head">
        <h3 id={`candidate-${candidate.id}-title`}>
          {keyLabel(candidate.key)} · {subjectLabel(candidate)}
        </h3>
      </div>
      <div className="knowledge-card-sub">
        Observed {new Date(candidate.observedAt).toLocaleString()} · {candidate.sourceReferences.length} source{candidate.sourceReferences.length === 1 ? "" : "s"}
      </div>
      <StatusPills candidate={candidate} />
      <div className="knowledge-value">{formatValue(candidate.value, 240)}</div>
      {conflicted ? (
        <div className="knowledge-withheld" role="note">
          <strong>Before you confirm:</strong> {conflicts.length > 0
            ? conflicts.map((other) => `${formatValue(other.value, 80)} (${other.id.slice(0, 8)}…)`).join(" vs ")
            : "another pending observation carries a different value."} Confirming picks this value business-wide.
        </div>
      ) : null}
      {candidate.status === "stale" ? (
        <p className="knowledge-fact-meta">
          A newer observation from the same source replaced this one. No action is needed — it will never become a fact.
        </p>
      ) : null}
      <Sources candidate={candidate} />
      {actionable ? (
        <>
          <div className="knowledge-effect">
            <strong>{confirmEffect.headline}</strong>
            {confirmEffect.detail}
          </div>
          <div className="knowledge-actions">
            <button
              type="button"
              className="knowledge-approve-button"
              disabled={busy}
              onClick={() => onConfirm({ candidateId: candidate.id, commandId: newCommandId() })}
            >
              {busy ? "Confirming…" : "Confirm as fact"}
            </button>
            <button
              type="button"
              className="knowledge-secondary-button"
              disabled={busy}
              aria-expanded={rejectOpen}
              onClick={() => setRejectOpen((open) => !open)}
            >
              {rejectOpen ? "Close dismiss" : "Dismiss…"}
            </button>
          </div>
          {rejectOpen ? (
            <form
              className="knowledge-inline-form"
              aria-label={`Dismiss observation ${candidate.id}`}
              onSubmit={(event) => {
                event.preventDefault();
                onReject({ candidateId: candidate.id, commandId: newCommandId(), reason: reason.trim() || undefined });
              }}
            >
              <strong>Dismiss this observation</strong>
              <p className="knowledge-field-hint">{rejectEffect.detail}</p>
              <label className="knowledge-field">
                <span>Reason (optional, kept with the decision record)</span>
                <input
                  type="text"
                  className="knowledge-input"
                  value={reason}
                  disabled={busy}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="e.g. superseded by the signed events pack"
                  maxLength={280}
                />
              </label>
              <div className="knowledge-actions">
                <button type="submit" className="knowledge-danger-button" disabled={busy}>
                  {busy ? "Dismissing…" : "Dismiss observation"}
                </button>
              </div>
            </form>
          ) : null}
        </>
      ) : null}
      {mutationError ? (
        <div className="knowledge-notice" role="alert" style={{ marginTop: 10, marginBottom: 0 }}>
          <strong>That decision did not apply. </strong>{mutationError}
        </div>
      ) : null}
    </article>
  );
}
