'use client';

import { useState } from "react";
import type { KnowledgeConfirmedFact } from "../../knowledge-owner/types.ts";
import { describeCorrectEffect } from "../../knowledge-owner/state.ts";
import {
  assembleFieldValues,
  correctFieldsFor,
  correctQuestionFor,
  extractFieldValues,
  moneyPreview,
  preservedUnknownKeys,
  type FieldValues,
} from "./factSchemas.ts";
import type { CorrectSubmission } from "./ConfirmedFacts.tsx";

interface CorrectFormProps {
  fact: KnowledgeConfirmedFact;
  /** Bounds currency for honest money previews; undefined renders minor-unit labels. */
  currencyHint?: string;
  busy: boolean;
  error?: string;
  onCorrect: (input: CorrectSubmission) => void;
  newCommandId: () => string;
}

function MoneyHint({ inputs, name, currencyHint }: { inputs: FieldValues; name: string; currencyHint?: string }): React.JSX.Element | null {
  const raw = inputs[name];
  if (typeof raw !== "string" || raw.trim().length === 0 || !/^\d+$/.test(raw.trim())) return null;
  return <p className="knowledge-field-hint">Reads as {moneyPreview(Number(raw.trim()), currencyHint)}.</p>;
}

/**
 * Guided correction with business-labelled inputs. Identity fields are
 * display-only, unknown value fields are preserved untouched, and formats
 * without guided inputs fail closed instead of offering a JSON editor.
 */
export function FactCorrectForm({
  fact,
  currencyHint,
  busy,
  error,
  onCorrect,
  newCommandId,
}: CorrectFormProps): React.JSX.Element {
  const fields = correctFieldsFor(fact.key);
  const [inputs, setInputs] = useState<FieldValues>(() => extractFieldValues(fact.key, fact.value));
  const [localError, setLocalError] = useState<string | undefined>();
  const effect = describeCorrectEffect(fact.key, fact.subjectId, fact.revision);
  const preserved = preservedUnknownKeys(fact.key, fact.value);

  if (!fields) {
    return (
      <div className="knowledge-inline-form" role="note" aria-label={`Correction unavailable for ${fact.key}`}>
        <strong>Guided correction is unavailable for this format.</strong>
        <p className="knowledge-field-hint">
          Gather does not offer inputs for “{fact.key}” yet, so this fact is left exactly as confirmed
          rather than edited through an unvalidated format. Confirm a newer observation of it instead.
        </p>
      </div>
    );
  }

  const set = (name: string, value: string | boolean): void => {
    setInputs((current) => ({ ...current, [name]: value }));
  };

  return (
    <form
      className="knowledge-inline-form"
      aria-label={`Correct ${fact.key} ${fact.subjectId}`}
      onSubmit={(event) => {
        event.preventDefault();
        const assembled = assembleFieldValues(fact.key, fact.value, inputs);
        if (!assembled.ok) {
          setLocalError(assembled.error);
          return;
        }
        setLocalError(undefined);
        onCorrect({ key: fact.key, subjectId: fact.subjectId, expectedRevision: fact.revision, value: assembled.value, commandId: newCommandId() });
      }}
    >
      <strong>{correctQuestionFor(fact.key, fact.subjectId || "general")}</strong>
      <div className="knowledge-effect" style={{ marginTop: 8 }}>
        <strong>{effect.headline}</strong>
        {effect.detail} If someone else changed it first, your correction is refused and you can review the newer revision — nothing is overwritten blindly.
      </div>
      {fields.map((field) => {
        const value = inputs[field.name];
        const disabled = busy;
        switch (field.type) {
          case "readonly":
            return (
              <div className="knowledge-field" key={field.name}>
                <span>{field.label}</span>
                <p className="knowledge-field-hint">{typeof value === "string" && value ? value : "—"}{field.hint ? ` · ${field.hint}` : ""}</p>
              </div>
            );
          case "textarea":
            return (
              <label className="knowledge-field" key={field.name}>
                <span>{field.label}</span>
                <textarea
                  className="knowledge-textarea"
                  value={typeof value === "string" ? value : ""}
                  disabled={disabled}
                  onChange={(event) => set(field.name, event.target.value)}
                  rows={3}
                  style={{ minHeight: 64 }}
                />
                {field.hint ? <span className="knowledge-field-hint">{field.hint}</span> : null}
              </label>
            );
          case "select":
            return (
              <label className="knowledge-field" key={field.name}>
                <span>{field.label}</span>
                <select
                  className="knowledge-select"
                  value={typeof value === "string" ? value : ""}
                  disabled={disabled}
                  onChange={(event) => set(field.name, event.target.value)}
                >
                  {(field.options ?? []).map((option) => <option key={option} value={option}>{option.replaceAll("_", " ")}</option>)}
                </select>
                {field.hint ? <span className="knowledge-field-hint">{field.hint}</span> : null}
              </label>
            );
          case "checkbox":
            return (
              <label className="knowledge-field" key={field.name} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                <input
                  type="checkbox"
                  checked={value === true}
                  disabled={disabled}
                  onChange={(event) => set(field.name, event.target.checked)}
                  style={{ marginTop: 3 }}
                />
                <span>{field.label}{field.hint ? <span className="knowledge-field-hint"> {field.hint}</span> : null}</span>
              </label>
            );
          default:
            return (
              <label className="knowledge-field" key={field.name}>
                <span>{field.label}</span>
                <input
                  type="text"
                  className="knowledge-input"
                  value={typeof value === "string" ? value : ""}
                  disabled={disabled}
                  onChange={(event) => set(field.name, event.target.value)}
                  inputMode={field.type === "text" || field.type === "csv" ? "text" : "numeric"}
                  maxLength={field.type === "currency" ? 3 : 280}
                  style={field.type === "currency" ? { textTransform: "uppercase" } : undefined}
                />
                {field.hint ? <span className="knowledge-field-hint">{field.hint}</span> : null}
                {field.type === "moneyOrNull" ? <MoneyHint inputs={inputs} name={field.name} currencyHint={currencyHint} /> : null}
              </label>
            );
        }
      })}
      {preserved.length > 0 ? (
        <p className="knowledge-field-hint">Kept unchanged: {preserved.join(", ")}.</p>
      ) : null}
      {localError ? <div className="knowledge-notice" role="alert"><strong>Check the form. </strong>{localError}</div> : null}
      {error ? <div className="knowledge-notice" role="alert"><strong>That correction did not apply. </strong>{error}</div> : null}
      <div className="knowledge-actions">
        <button type="submit" className="knowledge-approve-button" disabled={busy}>
          {busy ? "Correcting…" : `Save as revision ${fact.revision + 1}`}
        </button>
      </div>
    </form>
  );
}
