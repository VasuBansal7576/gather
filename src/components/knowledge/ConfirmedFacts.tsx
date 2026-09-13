'use client';

import { useCallback, useEffect, useMemo, useState } from "react";
import { createKnowledgeOwnerApi } from "../../knowledge-owner/api.ts";
import type { ExceptionInput } from "../../knowledge-owner/api.ts";
import type {
  KnowledgeConfirmedFact,
  KnowledgeSourceReference,
  WithheldFact,
  WorkspaceBooking,
} from "../../knowledge-owner/types.ts";
import {
  bookingsForBusiness,
  formatValue,
  isFixtureOnly,
  keyLabel,
  policyFacts,
  scopeTargetLabel,
  sourceKindLabel,
} from "../../knowledge-owner/state.ts";
import { FactCorrectForm } from "./FactCorrectForm.tsx";
import { ExceptionForm, type ScopeBookingsState } from "./ExceptionForm.tsx";

export interface CorrectSubmission {
  key: string;
  subjectId: string;
  expectedRevision: number;
  value: Record<string, unknown>;
  commandId: string;
}

// Input bindings preserved for the conflict integration: corrections carry
// key + subjectId + expectedRevision + value + commandId, exceptions carry
// policy/effect/scope/scopeId/subjectId/value + commandId. Account fact IDs
// will arrive with the new account-aware service; nothing here mints or
// renames revision identity.

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

function boundsCurrency(facts: KnowledgeConfirmedFact[]): string | undefined {
  const bounds = facts.find((fact) => fact.key === "pricing_bounds");
  const currency = bounds?.value.currency;
  return typeof currency === "string" && currency.trim().length > 0 ? currency.trim() : undefined;
}

/**
 * Confirmed business understanding: global facts (correctable through
 * guided business-labelled inputs), facts withheld from offers pending
 * reconfirmation, and scoped exceptions with meaningful scope labels.
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
  const api = useMemo(() => createKnowledgeOwnerApi((input, init) => fetch(input, init)), []);
  const [correctingId, setCorrectingId] = useState<string | undefined>();
  const [bookingsState, setBookingsState] = useState<ScopeBookingsState>({ kind: "idle" });
  const policies = policyFacts(facts);
  const scoped = facts.filter((fact) => fact.key === "scoped_exception");
  const global = facts.filter((fact) => fact.key !== "scoped_exception");
  const businessId = facts.length > 0 ? facts[0]!.businessId : undefined;
  const currencyHint = boundsCurrency(facts);

  const loadBookings = useCallback(async () => {
    if (!businessId) return;
    setBookingsState({ kind: "loading" });
    try {
      const all = await api.listWorkspaceBookings();
      setBookingsState({ kind: "ready", bookings: bookingsForBusiness(all, businessId) });
    } catch (err) {
      setBookingsState({
        kind: "error",
        message: err instanceof Error ? err.message : "Gather could not load the bookings for this venue.",
      });
    }
  }, [api, businessId]);

  useEffect(() => {
    void loadBookings();
  }, [loadBookings]);

  const bookings: WorkspaceBooking[] = bookingsState.kind === "ready" ? bookingsState.bookings : [];

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
            <FactCorrectForm
              fact={fact}
              currencyHint={currencyHint}
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
            <h3>{scopeTargetLabel(fact.scope, fact.scopeId ?? fact.subjectId, bookings)}</h3>
          </div>
          <div className="knowledge-pill-row">
            <span className="knowledge-pill is-ok"><span className="knowledge-dot" aria-hidden="true" />Scoped · {fact.scope}{fact.scopeId ? ` ${fact.scopeId}` : ""}</span>
            {isFixtureOnly(fact.sourceReferences) ? <span className="knowledge-pill is-fixture">Fixture</span> : null}
          </div>
          <div className="knowledge-value">{formatValue(fact.value, 240)}</div>
          <FactSources sources={fact.sourceReferences} />
        </article>
      ))}
      <ExceptionForm
        policies={policies}
        bookingsState={bookingsState}
        onReloadBookings={() => void loadBookings()}
        busy={busyKey === "exception:new"}
        error={errors["exception:new"]}
        onException={onException}
        newCommandId={newCommandId}
      />
    </div>
  );
}
