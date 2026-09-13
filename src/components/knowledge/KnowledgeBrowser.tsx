'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createKnowledgeOwnerApi,
  KnowledgeApiError,
  type ExceptionInput,
} from "../../knowledge-owner/api.ts";
import {
  conflictingCandidates,
  countNeedsReview,
  groupOf,
  LoadGeneration,
  newCommandId,
  sortCandidatesForReview,
} from "../../knowledge-owner/state.ts";
import type {
  KnowledgeBusiness,
  KnowledgeCandidate,
  KnowledgeConfirmedFact,
  KnowledgeSnapshot,
  WithheldFact,
} from "../../knowledge-owner/types.ts";
import { CandidateCard, type CandidateDecision } from "./CandidateCard.tsx";
import { ConfirmedFacts, type CorrectSubmission } from "./ConfirmedFacts.tsx";

type LoadState =
  | { kind: "idle" | "loading" }
  | { kind: "ready" }
  | { kind: "error"; message: string; retryable: boolean };

interface MutationStatus {
  ok?: string;
  errors: Record<string, string>;
}

const BUSINESS_KEY = "gather-knowledge-business";

function errorMessage(error: unknown, fallback: string): { message: string; retryable: boolean } {
  if (error instanceof KnowledgeApiError) {
    return { message: `${error.apiError.code}: ${error.apiError.message}`, retryable: error.apiError.retryable };
  }
  return { message: error instanceof Error ? error.message : fallback, retryable: true };
}

/**
 * Owner business-knowledge review. Reads the real candidates / snapshot /
 * facts APIs for the owner-chosen venue and routes focused consequential
 * decisions (confirm, correct, reject, scoped exception) through the real
 * decisions API. Reviewing is optional per item — unreviewed observations
 * stay pending and confirmed facts stay in force.
 */
export function KnowledgeBrowser(): React.JSX.Element {
  const api = useMemo(() => createKnowledgeOwnerApi((input, init) => fetch(input, init)), []);
  const inFlight = useRef(new Set<string>());
  // Independent generations for the venue list and the venue data: a late
  // response from a superseded selection is dropped before it can commit
  // success, error, or cleanup over the current business view.
  const businessesGen = useRef(new LoadGeneration());
  const dataGen = useRef(new LoadGeneration());

  const [businesses, setBusinesses] = useState<KnowledgeBusiness[]>([]);
  const [businessesState, setBusinessesState] = useState<LoadState>({ kind: "idle" });
  const [businessId, setBusinessId] = useState<string | undefined>(() => {
    try {
      return window.localStorage.getItem(BUSINESS_KEY) ?? undefined;
    } catch {
      return undefined;
    }
  });
  const [dataState, setDataState] = useState<LoadState>({ kind: "idle" });
  const [candidates, setCandidates] = useState<KnowledgeCandidate[]>([]);
  const [facts, setFacts] = useState<KnowledgeConfirmedFact[]>([]);
  const [snapshot, setSnapshot] = useState<KnowledgeSnapshot | undefined>();
  const [withheld, setWithheld] = useState<WithheldFact[]>([]);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [mutation, setMutation] = useState<MutationStatus>({ errors: {} });
  const businessRef = useRef(businessId);
  businessRef.current = businessId;

  const loadBusinesses = useCallback(async () => {
    const generation = businessesGen.current.next();
    setBusinessesState({ kind: "loading" });
    try {
      const list = await api.getBusinesses();
      if (!businessesGen.current.isCurrent(generation)) return;
      setBusinesses(list);
      setBusinessesState({ kind: "ready" });
      if (list.length > 0 && !list.some((business) => business.id === businessId)) {
        const stored = (() => {
          try {
            return window.localStorage.getItem(BUSINESS_KEY);
          } catch {
            return null;
          }
        })();
        const next = list.some((business) => business.id === stored) ? stored! : list[0]!.id;
        setBusinessId(next);
      }
    } catch (error) {
      if (!businessesGen.current.isCurrent(generation)) return;
      const { message, retryable } = errorMessage(error, "Gather could not load your venues.");
      setBusinessesState({ kind: "error", message, retryable });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  const loadData = useCallback(async (id: string) => {
    const generation = dataGen.current.next();
    setDataState({ kind: "loading" });
    setMutation({ errors: {} });
    try {
      const [candidateRes, snapshotRes, factsRes] = await Promise.all([
        api.listCandidates(id),
        api.getSnapshot(id),
        api.listFacts(id),
      ]);
      if (!dataGen.current.isCurrent(generation)) return;
      setCandidates(candidateRes.candidates);
      setSnapshot(snapshotRes.snapshot);
      setWithheld(snapshotRes.snapshot.withheld);
      setFacts(factsRes.facts);
      setDataState({ kind: "ready" });
    } catch (error) {
      if (!dataGen.current.isCurrent(generation)) return;
      const { message, retryable } = errorMessage(error, "Gather could not load business understanding.");
      setDataState({ kind: "error", message, retryable });
    }
  }, [api]);

  useEffect(() => {
    void loadBusinesses();
  }, [loadBusinesses]);

  useEffect(() => {
    if (!businessId) return;
    // Clear the previous venue's data before loading: stale candidates,
    // facts, and messages must never present as the newly selected venue.
    setCandidates([]);
    setFacts([]);
    setSnapshot(undefined);
    setWithheld([]);
    setMutation({ errors: {} });
    setBusyKey(null);
    void loadData(businessId);
  }, [businessId, loadData]);

  const chooseBusiness = useCallback((id: string) => {
    setBusinessId(id);
    try {
      window.localStorage.setItem(BUSINESS_KEY, id);
    } catch {
      // Private browsing or disabled storage never blocks review.
    }
  }, []);

  const refresh = useCallback(async () => {
    if (businessId) await loadData(businessId);
  }, [businessId, loadData]);

  const runDecision = useCallback(async (
    key: string,
    label: string,
    apply: () => Promise<unknown>,
  ): Promise<void> => {
    if (!businessId || inFlight.current.has(key)) return;
    const startedFor = businessId;
    inFlight.current.add(key);
    setBusyKey(key);
    setMutation((current) => ({ ok: undefined, errors: { ...current.errors, [key]: undefined as unknown as string } }));
    let failure: string | undefined;
    try {
      await apply();
    } catch (error) {
      failure = errorMessage(error, `${label} failed`).message;
    }
    // The venue may have switched mid-decision: only touch the current
    // view when it is still the venue this decision started for. A switch
    // already triggers its own load; stale success, error, busy, and
    // refresh writes for the old venue are dropped here.
    if (businessRef.current !== startedFor) {
      inFlight.current.delete(key);
      setBusyKey((current) => (current === key ? null : current));
      return;
    }
    try {
      await refresh();
    } catch {
      // A refresh failure keeps the decision result visible below; the data
      // may be stale, so say so rather than silently showing old state.
      failure = failure ?? "The decision applied, but the latest data did not reload — retry before acting on it.";
    } finally {
      inFlight.current.delete(key);
    }
    if (businessRef.current !== startedFor) {
      setBusyKey((current) => (current === key ? null : current));
      return;
    }
    setBusyKey((current) => (current === key ? null : current));
    if (failure) {
      setMutation((current) => ({ ok: undefined, errors: { ...current.errors, [key]: failure as string } }));
    } else {
      setMutation({ ok: `${label} applied.`, errors: {} });
    }
  }, [businessId, refresh]);

  const handleConfirm = useCallback((decision: CandidateDecision) => {
    if (!businessId) return;
    void runDecision(`confirm:${decision.candidateId}`, "Confirmation", () =>
      api.confirmCandidate(businessId, decision.candidateId, decision.commandId));
  }, [api, businessId, runDecision]);

  const handleReject = useCallback((decision: CandidateDecision) => {
    if (!businessId) return;
    void runDecision(`confirm:${decision.candidateId}`, "Dismissal", () =>
      api.rejectCandidate(businessId, decision.candidateId, decision.reason ?? "dismissed by owner", decision.commandId));
  }, [api, businessId, runDecision]);

  const handleCorrect = useCallback((input: CorrectSubmission) => {
    if (!businessId) return;
    const target = facts.find((fact) => fact.key === input.key && fact.subjectId === input.subjectId);
    const key = `correct:${target?.id ?? `${input.key}:${input.subjectId}`}`;
    void runDecision(key, "Correction", () =>
      api.correctFact(businessId, {
        key: input.key,
        subjectId: input.subjectId,
        expectedRevision: input.expectedRevision,
        value: input.value,
        commandId: input.commandId,
      }));
  }, [api, businessId, facts, runDecision]);

  const handleException = useCallback((input: ExceptionInput) => {
    if (!businessId) return;
    void runDecision("exception:new", "Scoped exception", () => api.addException(businessId, input));
  }, [api, businessId, runDecision]);

  const ordered = useMemo(() => sortCandidatesForReview(candidates), [candidates]);
  const needsReview = useMemo(() => ordered.filter((candidate) => groupOf(candidate) === "needs-review"), [ordered]);
  const stale = useMemo(() => ordered.filter((candidate) => groupOf(candidate) === "stale"), [ordered]);
  const decided = useMemo(() => ordered.filter((candidate) => groupOf(candidate) === "decided"), [ordered]);
  const needsCount = countNeedsReview(candidates);
  // Fixture scope is derived from the loaded records themselves (not the
  // mode envelope, which also covers the synthesized owner-maintained
  // business record): only claim "fictional demo data" when every
  // attributable source says so. Never claim connected sources exist.
  const loadedSources = useMemo(
    () => [...candidates.flatMap((item) => item.sourceReferences), ...facts.flatMap((fact) => fact.sourceReferences)],
    [candidates, facts],
  );
  const fixtureOnly = loadedSources.length > 0 && loadedSources.every((source) => source.fictional === true);
  const chosen = businesses.find((business) => business.id === businessId);

  return (
    <div className="knowledge-shell">
      <div className="knowledge-inner">
        <nav className="knowledge-topbar" aria-label="Breadcrumb">
          <span className="knowledge-brand"><a href="/">Gather</a></span>
          <span className="knowledge-crumb" aria-hidden="true">/</span>
          <span aria-current="page">Knowledge</span>
        </nav>

        <header className="knowledge-hero">
          <span className="knowledge-eyebrow">Business understanding</span>
          <h1>What Gather knows about your business</h1>
          <p>
            Review what matters — prices, policies, spaces — and confirm, correct, or dismiss it.
            Everything you skip stays exactly as it is: unreviewed observations remain pending and
            confirmed facts stay in force. Nothing here configures workflows or infrastructure.
          </p>
        </header>

        <div className="knowledge-mode-banner" role="note">
          <span className="knowledge-demo-label">DEMO ONLY</span>
          <span>
            {fixtureOnly
              ? "You are reviewing fictional demo data — nothing here is a real customer, price, or connected source."
              : "Fixture records are always badged Fixture; only confirmed facts feed offers."} Decisions are recorded
            against {chosen ? <strong>{chosen.name}</strong> : "the selected venue"} only.
          </span>
        </div>

        {mutation.ok ? <div className="knowledge-status-ok" role="status">{mutation.ok}</div> : null}

        <div className="knowledge-business-row">
          <label htmlFor="knowledge-business">Venue</label>
          {businessesState.kind === "loading" || businessesState.kind === "idle" ? (
            <span className="knowledge-card-sub">Loading your venues…</span>
          ) : businessesState.kind === "error" ? (
            <span className="knowledge-notice" role="alert" style={{ margin: 0 }}>
              <strong>Venues did not load. </strong>{businessesState.message}{" "}
              <button type="button" className="knowledge-secondary-button" onClick={() => void loadBusinesses()}>
                Reload venues
              </button>
            </span>
          ) : businesses.length === 0 ? (
            <span className="knowledge-card-sub">
              No venues yet — <a href="/setup" style={{ color: "var(--k-lavender)" }}>set up your venue first</a>.
            </span>
          ) : (
            <select
              id="knowledge-business"
              className="knowledge-select"
              value={businessId ?? ""}
              onChange={(event) => chooseBusiness(event.target.value)}
            >
              {businesses.map((business) => (
                <option key={business.id} value={business.id}>
                  {business.name} · {business.timezone}
                </option>
              ))}
            </select>
          )}
        </div>

        {dataState.kind === "loading" || dataState.kind === "idle" ? (
          <div className="knowledge-state" role="status" aria-label="Loading business understanding">
            <h2>Loading business understanding…</h2>
            <p>Reading observations and confirmed facts for {chosen?.name ?? "the selected venue"}.</p>
          </div>
        ) : dataState.kind === "error" ? (
          <div className="knowledge-state" role="alert">
            <h2>Business understanding did not load</h2>
            <p>{dataState.message}</p>
            <div className="knowledge-actions">
              <button type="button" className="knowledge-secondary-button" onClick={() => void refresh()}>
                Try again
              </button>
            </div>
          </div>
        ) : (
          <div className="knowledge-grid">
            <section className="knowledge-section" aria-labelledby="knowledge-review-heading">
              <div className="knowledge-section-heading">
                <h2 id="knowledge-review-heading">Review queue<span className="knowledge-count">{needsCount}</span></h2>
                <p>
                  Consequential observations first — prices, bounds, costs, policies — with conflicts
                  at the top. Confirm only what you have checked; skip the rest.
                </p>
              </div>
              {needsReview.length === 0 ? (
                <div className="knowledge-state">
                  <h2>Nothing needs review</h2>
                  <p>Every observation has been confirmed, dismissed, or replaced. New evidence will appear here.</p>
                </div>
              ) : needsReview.map((candidate) => (
                <CandidateCard
                  key={candidate.id}
                  candidate={candidate}
                  conflicts={conflictingCandidates(candidates, candidate)}
                  busy={busyKey === `confirm:${candidate.id}`}
                  mutationError={mutation.errors[`confirm:${candidate.id}`]}
                  onConfirm={handleConfirm}
                  onReject={handleReject}
                  newCommandId={newCommandId}
                />
              ))}
              {stale.length > 0 ? (
                <>
                  <div className="knowledge-section-heading" style={{ marginTop: 18 }}>
                    <h2>Replaced observations<span className="knowledge-count">{stale.length}</span></h2>
                    <p>Newer evidence from the same source replaced these. They can never become facts.</p>
                  </div>
                  {stale.map((candidate) => (
                    <CandidateCard
                      key={candidate.id}
                      candidate={candidate}
                      conflicts={[]}
                      busy={false}
                      onConfirm={handleConfirm}
                      onReject={handleReject}
                      newCommandId={newCommandId}
                    />
                  ))}
                </>
              ) : null}
              {decided.length > 0 ? (
                <details className="knowledge-card">
                  <summary>Decided observations ({decided.length}) — confirmed or dismissed</summary>
                  <div style={{ marginTop: 10 }}>
                    {decided.map((candidate) => (
                      <CandidateCard
                        key={candidate.id}
                        candidate={candidate}
                        conflicts={[]}
                        busy={false}
                        onConfirm={handleConfirm}
                        onReject={handleReject}
                        newCommandId={newCommandId}
                      />
                    ))}
                  </div>
                </details>
              ) : null}
            </section>

            <section className="knowledge-section" aria-labelledby="knowledge-facts-heading">
              <div id="knowledge-facts-heading">
                <ConfirmedFacts
                  facts={facts}
                  withheld={withheld}
                  scopedCount={snapshot?.scopedFactCount ?? 0}
                  busyKey={busyKey}
                  errors={mutation.errors}
                  onCorrect={handleCorrect}
                  onException={handleException}
                  newCommandId={newCommandId}
                />
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
