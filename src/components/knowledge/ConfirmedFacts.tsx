'use client';

import { useState } from "react";
import type { ExceptionInput } from "../../knowledge-owner/api.ts";
import type {
  KnowledgeConfirmedFact,
  KnowledgeFact,
  KnowledgeSourceReference,
  WithheldFact,
} from "../../knowledge-owner/types.ts";
import {
  describeCorrectEffect,
  describeExceptionEffect,
  formatValue,
  isFixtureOnly,
  keyLabel,
  parseValueJson,
  policyFacts,
  sourceKindLabel,
  subjectLabel,
} from "../../knowledge-owner/state.ts";

export interface CorrectSubmission {
  key: string;
  subjectId: string;
  expectedRevision: number;
  value: Record<string, unknown>;
  commandId: string;
}

interface FactsProps {
  facts: KnowledgeConfirmedFact[];
  withheld: WithheldFact[];
  scopedCount: number;
  busyKey: string | null;
  errors: Record<string, string>;
  onCorrect: (input: CorrectSubmission) => void;
  onException: (input: ExceptionInput) => void;
  newCommandId: () => string;
}

function FactSources({ sources }: { sources: KnowledgeSourceReference[] }): React.JSX.Element {
  return (
    <div className="knowledge-sources" aria-label="Attributable sources">
      {sources.map((source) => (
        <div className="knowledge-source" key={`${source.kind}:${source.locator}`}>
          <span className="knowledge-source-kind">{sourceKindLabel(source.kind)}</span>
          <span>{source.label ?? source.locator}</span>
          {source.label ? <code>{source.locator}</code> : null}
          {source.fictional ? <span className="knowledge-pill is-fixture">Fixture</span> : null}
        </div>
      ))}
    </div>
  );
}

function policyIdOf(fact: KnowledgeFact): string | undefined {
  const value = fact.value.policyId;
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function CorrectForm({
  fact,
  busy,
  error,
  onCorrect,
  newCommandId,
}: {
  fact: KnowledgeConfirmedFact;
  busy: boolean;
  error?: string;
  onCorrect: (input: CorrectSubmission) => void;
  newCommandId: () => string;
}): React.JSX.Element {
  const [text, setText] = useState(() => JSON.stringify(fact.value, null, 2));
  const [localError, setLocalError] = useState<string | undefined>();
  const effect = describeCorrectEffect(fact.key, fact.subjectId, fact.revision);
  return (
    <form
      className="knowledge-inline-form"
      aria-label={`Correct ${fact.key} ${fact.subjectId}`}
      onSubmit={(event) => {
        event.preventDefault();
        const parsed = parseValueJson(text);
        if (!parsed.ok) {
          setLocalError(parsed.error);
          return;
        }
        setLocalError(undefined);
        onCorrect({ key: fact.key, subjectId: fact.subjectId, expectedRevision: fact.revision, value: parsed.value, commandId: newCommandId() });
      }}
    >
      <strong>Correct this fact</strong>
      <div className="knowledge-effect" style={{ marginTop: 8 }}>
        <strong>{effect.headline}</strong>
        {effect.detail} If someone else changed it first, your correction is refused and you can review the newer revision — nothing is overwritten blindly.
      </div>
      <label className="knowledge-field">
        <span>Corrected value (JSON object)</span>
        <textarea
          className="knowledge-textarea"
          value={text}
          disabled={busy}
          onChange={(event) => setText(event.target.value)}
          rows={6}
          spellCheck={false}
        />
      </label>
      {localError ? <div className="knowledge-notice" role="alert"><strong>Check the value. </strong>{localError}</div> : null}
      {error ? <div className="knowledge-notice" role="alert"><strong>That correction did not apply. </strong>{error}</div> : null}
      <div className="knowledge-actions">
        <button type="submit" className="knowledge-approve-button" disabled={busy}>
          {busy ? "Correcting…" : `Save as revision ${fact.revision + 1}`}
        </button>
      </div>
    </form>
  );
}

function ExceptionComposer({
  policies,
  busy,
  error,
  onException,
  newCommandId,
}: {
  policies: KnowledgeFact[];
  busy: boolean;
  error?: string;
  onException: (input: ExceptionInput) => void;
  newCommandId: () => string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [policyId, setPolicyId] = useState("");
  const [effect, setEffect] = useState<"allow" | "require_owner_decision">("allow");
  const [scope, setScope] = useState<"booking" | "customer">("booking");
  const [scopeId, setScopeId] = useState("");
  const [detail, setDetail] = useState("{}");
  const [localError, setLocalError] = useState<string | undefined>();
  const preview = describeExceptionEffect(scope, scopeId.trim() || "…");

  if (!open) {
    return (
      <div className="knowledge-actions">
        <button type="button" className="knowledge-secondary-button" onClick={() => setOpen(true)}>
          Add a scoped exception…
        </button>
      </div>
    );
  }
  return (
    <form
      className="knowledge-inline-form"
      aria-label="Add a scoped exception"
      onSubmit={(event) => {
        event.preventDefault();
        if (!policyId) {
          setLocalError("Choose the policy this exception relaxes.");
          return;
        }
        if (!scopeId.trim()) {
          setLocalError("Name the booking or customer this exception is for — exceptions can never apply business-wide.");
          return;
        }
        const parsed = parseValueJson(detail);
        if (!parsed.ok) {
          setLocalError(parsed.error);
          return;
        }
        setLocalError(undefined);
        onException({
          policyId,
          effect,
          scope,
          scopeId: scopeId.trim(),
          subjectId: scopeId.trim(),
          value: parsed.value,
          commandId: newCommandId(),
        });
      }}
    >
      <strong>Add a scoped exception</strong>
      <p className="knowledge-field-hint">For one customer or booking that needs different treatment than the confirmed policy.</p>
      <label className="knowledge-field">
        <span>Policy to relax</span>
        <select className="knowledge-select" value={policyId} disabled={busy} onChange={(event) => setPolicyId(event.target.value)}>
          <option value="">Choose a confirmed policy…</option>
          {policies.map((policy) => {
            const id = policyIdOf(policy);
            if (!id) return null;
            const statement = typeof policy.value.statement === "string" ? policy.value.statement : id;
            return <option key={policy.id} value={id}>{statement} ({id})</option>;
          })}
        </select>
      </label>
      <fieldset className="knowledge-field" style={{ border: "none", padding: 0 }}>
        <legend className="knowledge-field-hint">Effect</legend>
        <div className="knowledge-radio-row" role="radiogroup" aria-label="Exception effect">
          <label><input type="radio" name="exception-effect" checked={effect === "allow"} disabled={busy} onChange={() => setEffect("allow")} /> Allow — proceed under this exception</label>
          <label><input type="radio" name="exception-effect" checked={effect === "require_owner_decision"} disabled={busy} onChange={() => setEffect("require_owner_decision")} /> Still ask me each time</label>
        </div>
      </fieldset>
      <fieldset className="knowledge-field" style={{ border: "none", padding: 0 }}>
        <legend className="knowledge-field-hint">Applies to</legend>
        <div className="knowledge-radio-row" role="radiogroup" aria-label="Exception scope">
          <label><input type="radio" name="exception-scope" checked={scope === "booking"} disabled={busy} onChange={() => setScope("booking")} /> One booking</label>
          <label><input type="radio" name="exception-scope" checked={scope === "customer"} disabled={busy} onChange={() => setScope("customer")} /> One customer</label>
        </div>
      </fieldset>
      <label className="knowledge-field">
        <span>{scope === "booking" ? "Booking reference" : "Customer reference"}</span>
        <input
          type="text"
          className="knowledge-input"
          value={scopeId}
          disabled={busy}
          onChange={(event) => setScopeId(event.target.value)}
          placeholder={scope === "booking" ? "e.g. EVT-024" : "e.g. Acme Co."}
          maxLength={200}
        />
      </label>
      <label className="knowledge-field">
        <span>Exception detail (JSON object, e.g. what is permitted)</span>
        <textarea className="knowledge-textarea" value={detail} disabled={busy} onChange={(event) => setDetail(event.target.value)} rows={3} spellCheck={false} />
      </label>
      <div className="knowledge-effect">
        <strong>{preview.headline}</strong>
        {preview.detail}
      </div>
      {localError ? <div className="knowledge-notice" role="alert"><strong>Check the form. </strong>{localError}</div> : null}
      {error ? <div className="knowledge-notice" role="alert"><strong>That exception did not apply. </strong>{error}</div> : null}
      <div className="knowledge-actions">
        <button type="submit" className="knowledge-approve-button" disabled={busy || policies.length === 0}>
          {busy ? "Adding…" : "Add scoped exception"}
        </button>
        <button type="button" className="knowledge-secondary-button" disabled={busy} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      {policies.length === 0 ? (
        <p className="knowledge-field-hint">No confirmed policies yet — confirm a policy observation first, then scope exceptions to it.</p>
      ) : null}
    </form>
  );
}

/**
 * Confirmed business understanding: global facts (correctable), facts
 * withheld from offers pending reconfirmation, and scoped exceptions.
 */
export function ConfirmedFacts({
  facts,
  withheld,
  scopedCount,
  busyKey,
  errors,
  onCorrect,
  onException,
  newCommandId,
}: FactsProps): React.JSX.Element {
  const [correctingId, setCorrectingId] = useState<string | undefined>();
  const policies = policyFacts(facts);
  const scoped = facts.filter((fact) => fact.key === "scoped_exception");
  const global = facts.filter((fact) => fact.key !== "scoped_exception");

  return (
    <div>
      <div className="knowledge-section-heading">
        <h2>Confirmed facts<span className="knowledge-count">{facts.length}</span></h2>
        <p>
          What Gather treats as settled and feeds into offers. Correcting a fact replaces it with a new
          revision — the history is kept. {scopedCount > 0 ? `${scopedCount} scoped exception${scopedCount === 1 ? "" : "s"} included.` : ""}
        </p>
      </div>
      {withheld.length > 0 ? (
        <div aria-label="Facts withheld from offers">
          {withheld.map((entry) => (
            <div className="knowledge-withheld" key={entry.factId} role="note">
              <strong>Withheld from offers — {keyLabel(entry.key)} · {entry.subjectId || "general"}.</strong> {entry.reason}
            </div>
          ))}
        </div>
      ) : null}
      {global.length === 0 && scoped.length === 0 ? (
        <div className="knowledge-state">
          <h2>No confirmed facts yet</h2>
          <p>Confirm an observation from the review queue and it will appear here as settled business understanding.</p>
        </div>
      ) : null}
      {global.map((fact) => (
        <article className="knowledge-card" key={fact.id} aria-labelledby={`fact-${fact.id}-title`}>
          <div className="knowledge-card-head">
            <h3 id={`fact-${fact.id}-title`}>{keyLabel(fact.key)} · {fact.subjectId || "general"}</h3>
          </div>
          <div className="knowledge-pill-row">
            <span className="knowledge-pill is-confirmed"><span className="knowledge-dot" aria-hidden="true" />Confirmed · revision {fact.revision}</span>
            {fact.reviewState === "review" ? <span className="knowledge-pill is-review">Source changed — reconfirm</span> : null}
            {isFixtureOnly(fact.sourceReferences) ? <span className="knowledge-pill is-fixture">Fixture</span> : null}
          </div>
          <div className="knowledge-value">{formatValue(fact.value, 240)}</div>
          <FactSources sources={fact.sourceReferences} />
          <div className="knowledge-actions">
            <button
              type="button"
              className="knowledge-secondary-button"
              aria-expanded={correctingId === fact.id}
              onClick={() => setCorrectingId((current) => (current === fact.id ? undefined : fact.id))}
            >
              {correctingId === fact.id ? "Close correction" : "Correct…"}
            </button>
          </div>
          {correctingId === fact.id ? (
            <CorrectForm
              fact={fact}
              busy={busyKey === `correct:${fact.id}`}
              error={errors[`correct:${fact.id}`]}
              onCorrect={onCorrect}
              newCommandId={newCommandId}
            />
          ) : null}
          {errors[`correct:${fact.id}`] && correctingId !== fact.id ? (
            <div className="knowledge-notice" role="alert" style={{ marginTop: 10, marginBottom: 0 }}>
              <strong>That correction did not apply. </strong>{errors[`correct:${fact.id}`]}
            </div>
          ) : null}
        </article>
      ))}
      <div className="knowledge-section-heading" style={{ marginTop: 18 }}>
        <h2>Scoped exceptions<span className="knowledge-count">{scoped.length}</span></h2>
        <p>One-customer or one-booking differences. The global policy is never changed by an exception.</p>
      </div>
      {scoped.map((fact) => (
        <article className="knowledge-card" key={fact.id} aria-label={`Scoped exception ${fact.id}`}>
          <div className="knowledge-card-head">
            <h3>{subjectLabel({ subjectId: fact.subjectId, key: fact.key })}</h3>
          </div>
          <div className="knowledge-pill-row">
            <span className="knowledge-pill is-ok"><span className="knowledge-dot" aria-hidden="true" />Scoped · {fact.scope}{fact.scopeId ? ` ${fact.scopeId}` : ""}</span>
            {isFixtureOnly(fact.sourceReferences) ? <span className="knowledge-pill is-fixture">Fixture</span> : null}
          </div>
          <div className="knowledge-value">{formatValue(fact.value, 240)}</div>
          <FactSources sources={fact.sourceReferences} />
        </article>
      ))}
      <ExceptionComposer
        policies={policies}
        busy={busyKey === "exception:new"}
        error={errors["exception:new"]}
        onException={onException}
        newCommandId={newCommandId}
      />
    </div>
  );
}
