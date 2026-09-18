'use client';

/**
 * ADR-006 owner-journey composition panels (C10).
 *
 * Thin composition over the existing subsystem routes — knowledge review,
 * evaluation trend, prepared inbox composer, intake/identity sweep, owner
 * takeover via durable intents, and acceptance/handoff states. Every panel
 * renders only persisted server state with honest loading, empty, partial,
 * error, and reconnect states; no panel invents data, and controls without
 * a wired backend stay disabled with the reason shown.
 */

import { useCallback, useEffect, useState } from 'react';
import type { BookingSummary } from './types';

type FetchState<T> =
  | { kind: 'idle' | 'loading' }
  | { kind: 'ready'; data: T }
  | { kind: 'error'; message: string };

function PanelError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="gather-blocked-notice" role="alert">
      <div><strong>Could not load this panel</strong><p>{message}</p></div>
      {onRetry ? (
        <div className="gather-blocked-actions">
          <button type="button" className="gather-secondary-button gather-small-button" onClick={onRetry}>Try again</button>
        </div>
      ) : null}
    </div>
  );
}

function PanelLoading({ label }: { label: string }) {
  return <div className="gather-loading-state" role="status" aria-label={label}><span className="gather-skeleton gather-skeleton-medium" /><span className="gather-skeleton gather-skeleton-list" /></div>;
}

async function postJson(path: string, payload: unknown): Promise<unknown> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof body === 'object' && body !== null && 'message' in body ? String((body as { message: unknown }).message) : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return body;
}

async function getJson(path: string): Promise<unknown> {
  const response = await fetch(path, { headers: { accept: 'application/json' } });
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof body === 'object' && body !== null && 'message' in body ? String((body as { message: unknown }).message) : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return body;
}

/* ---------------- Business understanding ---------------- */

interface KnowledgeCandidate {
  id: string;
  claim?: unknown;
  status?: string;
  sourceLocator?: string;
}

export function UnderstandingPanel({ businessId }: { businessId?: string }) {
  const [facts, setFacts] = useState<FetchState<{ snapshot: unknown; mode: unknown }>>({ kind: 'idle' });
  const [candidates, setCandidates] = useState<FetchState<{ candidates: KnowledgeCandidate[] }>>({ kind: 'idle' });
  const [ruleText, setRuleText] = useState('');
  const [ruleDraft, setRuleDraft] = useState<unknown>(undefined);
  const [ruleBusy, setRuleBusy] = useState(false);
  const [ruleNote, setRuleNote] = useState<string | undefined>(undefined);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmNote, setConfirmNote] = useState<string | undefined>(undefined);

  const refresh = useCallback(async () => {
    if (!businessId) return;
    setFacts({ kind: 'loading' });
    setCandidates({ kind: 'loading' });
    try {
      const snapshot = (await getJson(`/api/knowledge/snapshot?businessId=${encodeURIComponent(businessId)}`)) as { snapshot: unknown; mode: unknown };
      setFacts({ kind: 'ready', data: snapshot });
    } catch (error) {
      setFacts({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
    }
    try {
      const listed = (await getJson(`/api/knowledge/candidates?businessId=${encodeURIComponent(businessId)}&status=pending`)) as { candidates: KnowledgeCandidate[] };
      setCandidates({ kind: 'ready', data: listed });
    } catch (error) {
      setCandidates({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }, [businessId]);

  useEffect(() => { void refresh(); }, [refresh]);

  if (!businessId) {
    return <p className="gather-muted-label" role="status">No venue is loaded yet — business understanding appears once the workspace has a venue.</p>;
  }

  const parseRule = async () => {
    setRuleBusy(true);
    setRuleNote(undefined);
    setRuleDraft(undefined);
    try {
      const result = (await postJson('/api/knowledge/rules', { action: 'parse', text: ruleText })) as { result: unknown };
      setRuleDraft((result as { result: { draft?: unknown } }).result && 'draft' in (result as { result: object }).result ? (result as { result: { draft: unknown } }).result.draft : result.result);
      setRuleNote('Parsed — review the scope below, then confirm to write it as an owner rule. Parsing alone changed nothing.');
    } catch (error) {
      setRuleNote(error instanceof Error ? error.message : String(error));
    } finally {
      setRuleBusy(false);
    }
  };

  const confirmRule = async () => {
    if (ruleDraft === undefined || ruleDraft === null) return;
    setRuleBusy(true);
    try {
      await postJson('/api/knowledge/rules', { action: 'confirm', businessId, draft: ruleDraft });
      setRuleNote('Owner rule confirmed. The next affected inquiry cites it; the trend view measures the effect.');
      setRuleText('');
      setRuleDraft(undefined);
      void refresh();
    } catch (error) {
      setRuleNote(error instanceof Error ? error.message : String(error));
    } finally {
      setRuleBusy(false);
    }
  };

  const confirmAll = async (ids: string[]) => {
    setConfirmBusy(true);
    setConfirmNote(undefined);
    try {
      await postJson('/api/knowledge/review', { businessId, candidateIds: ids });
      setConfirmNote(`${ids.length} candidate${ids.length === 1 ? '' : 's'} confirmed as owner-reviewed facts.`);
      void refresh();
    } catch (error) {
      setConfirmNote(error instanceof Error ? error.message : String(error));
    } finally {
      setConfirmBusy(false);
    }
  };

  const pending = candidates.kind === 'ready' ? (candidates.data.candidates ?? []) : [];

  return (
    <div>
      <section className="gather-review-block" aria-labelledby="understanding-facts">
        <div className="gather-block-heading gather-block-heading-tight"><div><span className="gather-eyebrow">Confirmed facts</span><h2 id="understanding-facts">What Gather understands</h2></div></div>
        {facts.kind === 'loading' || facts.kind === 'idle' ? <PanelLoading label="Loading business facts" /> : null}
        {facts.kind === 'error' ? <PanelError message={facts.message} onRetry={() => void refresh()} /> : null}
        {facts.kind === 'ready' ? (
          <p className="gather-meta-sub">{JSON.stringify(facts.data.snapshot).length > 2 ? 'Confirmed facts are cited on every offer that uses them.' : 'No business information found yet.'}</p>
        ) : null}
      </section>
      <section className="gather-review-block" aria-labelledby="understanding-candidates">
        <div className="gather-block-heading gather-block-heading-tight"><div><span className="gather-eyebrow">Needs your review</span><h2 id="understanding-candidates">Candidate facts</h2></div></div>
        {candidates.kind === 'loading' || candidates.kind === 'idle' ? <PanelLoading label="Loading candidate facts" /> : null}
        {candidates.kind === 'error' ? <PanelError message={candidates.message} onRetry={() => void refresh()} /> : null}
        {candidates.kind === 'ready' && pending.length === 0 ? <p className="gather-meta-sub" role="status">Nothing awaiting review — imported claims appear here as candidates before they can authorize anything.</p> : null}
        {candidates.kind === 'ready' && pending.length > 0 ? (
          <div>
            <ul className="gather-offer-terms">
              {pending.map((candidate) => <li key={candidate.id}>{candidate.id}{candidate.sourceLocator ? ` — ${candidate.sourceLocator}` : ''}</li>)}
            </ul>
            <button type="button" className="gather-secondary-button gather-small-button" disabled={confirmBusy} onClick={() => void confirmAll(pending.map((c) => c.id))}>
              {confirmBusy ? 'Confirming…' : `Confirm ${pending.length} inspected candidate${pending.length === 1 ? '' : 's'}`}
            </button>
            {confirmNote ? <p className="gather-action-note" role="status">{confirmNote}</p> : null}
          </div>
        ) : null}
      </section>
      <section className="gather-review-block" aria-labelledby="understanding-rule">
        <div className="gather-block-heading gather-block-heading-tight"><div><span className="gather-eyebrow">Owner rule</span><h2 id="understanding-rule">Tell Gather a new rule</h2></div></div>
        <p className="gather-meta-sub">Type a policy in plain language. Gather parses the scope for your review — nothing is written until you confirm.</p>
        <div className="gather-meta-group">
          <label className="gather-meta-label" htmlFor="owner-rule-text">Rule</label>
          <input id="owner-rule-text" type="text" value={ruleText} onChange={(event) => setRuleText(event.target.value)} placeholder="Weekday evenings in November: up to 10% off" style={{ width: '100%' }} />
        </div>
        <div className="gather-review-actions">
          <button type="button" className="gather-secondary-button gather-small-button" disabled={ruleBusy || ruleText.trim().length === 0} onClick={() => void parseRule()}>
            {ruleBusy ? 'Parsing…' : 'Parse rule'}
          </button>
          {ruleDraft !== undefined ? (
            <button type="button" className="gather-approve-button gather-small-button" disabled={ruleBusy} onClick={() => void confirmRule()}>Confirm as owner rule</button>
          ) : null}
        </div>
        {ruleNote ? <p className="gather-action-note" role="status">{ruleNote}</p> : null}
      </section>
    </div>
  );
}

/* ---------------- Evaluation trend ---------------- */

interface EvalRunShape {
  caseSetVersion: string;
  passed?: number;
  denominator?: number;
}

export function TrendPanel({ businessId }: { businessId?: string }) {
  const [runs, setRuns] = useState<EvalRunShape[]>([]);
  const [comparison, setComparison] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  if (!businessId) {
    return <p className="gather-muted-label" role="status">No venue is loaded yet — the evaluation trend appears once the workspace has a venue.</p>;
  }

  const run = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const body = (await postJson('/api/evals/run', { action: 'run', businessId })) as { run: EvalRunShape };
      const next = [...runs, body.run].slice(-2);
      setRuns(next);
      if (next.length === 2) {
        const compared = (await postJson('/api/evals/run', { action: 'compare', before: next[0], after: next[1] })) as { comparison: unknown };
        setComparison(compared.comparison);
      } else {
        setComparison(undefined);
      }
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : String(runError));
    } finally {
      setBusy(false);
    }
  };

  const latest = runs[runs.length - 1];

  return (
    <section className="gather-review-block" aria-labelledby="trend-heading">
      <div className="gather-block-heading gather-block-heading-tight"><div><span className="gather-eyebrow">Self-improvement, measured</span><h2 id="trend-heading">Evaluation trend</h2></div></div>
      <p className="gather-meta-sub">Before/after on the same versioned case set, with numerator and denominator. An unchanged or worse score is reported honestly — never forced to rise.</p>
      <button type="button" className="gather-secondary-button gather-small-button" disabled={busy} onClick={() => void run()}>
        {busy ? 'Running…' : runs.length === 0 ? 'Run evaluation' : 'Run again (before/after)'}
      </button>
      {error ? <PanelError message={error} onRetry={() => void run()} /> : null}
      {latest ? (
        <p className="gather-meta-sub" role="status">Latest: case set <strong>{latest.caseSetVersion}</strong>{latest.passed !== undefined && latest.denominator !== undefined ? <> — <strong>{latest.passed}/{latest.denominator}</strong></> : null}. {runs.length < 2 ? 'Run again after a correction to compare.' : ''}</p>
      ) : (
        <p className="gather-meta-sub" role="status">No runs yet. Run the versioned case set to establish a baseline.</p>
      )}
      {comparison ? (
        <details className="gather-technical-details"><summary>Comparison detail</summary><p>{JSON.stringify(comparison)}</p></details>
      ) : null}
    </section>
  );
}

/* ---------------- Prepared inbox composer ---------------- */

interface ComposeClassification {
  outcome: string;
  reasons: string[];
  missingFields?: string[];
}

export function ComposerPanel({ enabled, disabledReason }: { enabled: boolean; disabledReason?: string }) {
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ classification: ComposeClassification; notice: string } | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  const send = async () => {
    setBusy(true);
    setError(undefined);
    setResult(undefined);
    try {
      const response = (await postJson('/api/inbox/compose', { subject, body })) as { classification: ComposeClassification; notice: string };
      setResult({ classification: response.classification, notice: response.notice });
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : String(sendError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="gather-review-block" aria-labelledby="composer-heading">
      <div className="gather-block-heading gather-block-heading-tight"><div><span className="gather-eyebrow">Judge-testable demo</span><h2 id="composer-heading">Try an inquiry</h2></div></div>
      <p className="gather-meta-sub">Type any email — an invoice, a newsletter, an injection attempt, or a real inquiry — and watch the domain gate classify it. Nothing is sent, linked, or booked.</p>
      {!enabled ? <p className="gather-action-note is-error" role="status">{disabledReason ?? 'The composer is prepared-mode only.'}</p> : null}
      <div className="gather-meta-group">
        <label className="gather-meta-label" htmlFor="composer-subject">Subject</label>
        <input id="composer-subject" type="text" value={subject} disabled={!enabled} onChange={(event) => setSubject(event.target.value)} placeholder="Re: December wedding for 80" style={{ width: '100%' }} />
      </div>
      <div className="gather-meta-group">
        <label className="gather-meta-label" htmlFor="composer-body">Message</label>
        <textarea id="composer-body" value={body} disabled={!enabled} onChange={(event) => setBody(event.target.value)} placeholder="We love the Glasshouse…" rows={4} style={{ width: '100%' }} />
      </div>
      <button type="button" className="gather-secondary-button gather-small-button" disabled={!enabled || busy || subject.trim().length === 0 || body.trim().length === 0} onClick={() => void send()}>
        {busy ? 'Classifying…' : 'Classify message'}
      </button>
      {error ? <PanelError message={error} /> : null}
      {result ? (
        <div role="status">
          <p><strong>Outcome: {result.classification.outcome}</strong></p>
          {result.classification.reasons.length > 0 ? (
            <ul className="gather-offer-terms">{result.classification.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
          ) : null}
          {result.classification.missingFields && result.classification.missingFields.length > 0 ? (
            <p className="gather-meta-sub">Missing: {result.classification.missingFields.join(', ')} — the inquiry stays eligible; qualification asks for these.</p>
          ) : null}
          <p className="gather-meta-sub">{result.notice}</p>
        </div>
      ) : null}
    </section>
  );
}

/* ---------------- Intake, identity decisions, due work ---------------- */

export function IdentityPanel() {
  const [status, setStatus] = useState<FetchState<{ latest: unknown; cursor: unknown; simulation: unknown }>>({ kind: 'idle' });
  const [due, setDue] = useState<FetchState<unknown[]>>({ kind: 'idle' });
  const [sweep, setSweep] = useState<FetchState<{ needsDecision?: Array<{ messageId?: string; reason?: string }> }>>({ kind: 'idle' });
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setStatus({ kind: 'loading' });
    setDue({ kind: 'loading' });
    try {
      const data = (await getJson('/api/operator/intake/status')) as { latest: unknown; cursor: unknown; simulation: unknown };
      setStatus({ kind: 'ready', data });
    } catch (error) {
      setStatus({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
    }
    try {
      const data = (await getJson('/api/operator/waiting?limit=25')) as unknown;
      const items = Array.isArray(data) ? data : (data as { items?: unknown[] }).items ?? [];
      setDue({ kind: 'ready', data: items });
    } catch (error) {
      setDue({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const runSweep = async () => {
    setBusy(true);
    try {
      const report = (await postJson('/api/operator/sweep', {})) as { needsDecision?: Array<{ messageId?: string; reason?: string }> };
      setSweep({ kind: 'ready', data: report });
      void refresh();
    } catch (error) {
      setSweep({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  const needsDecision = sweep.kind === 'ready' ? (sweep.data.needsDecision ?? []) : [];
  const dueItems = due.kind === 'ready' ? due.data : [];

  return (
    <div>
      <section className="gather-review-block" aria-labelledby="identity-intake">
        <div className="gather-block-heading gather-block-heading-tight"><div><span className="gather-eyebrow">Coverage</span><h2 id="identity-intake">Inbox intake</h2></div></div>
        {status.kind === 'loading' || status.kind === 'idle' ? <PanelLoading label="Loading intake status" /> : null}
        {status.kind === 'error' ? <PanelError message={status.message} onRetry={() => void refresh()} /> : null}
        {status.kind === 'ready' ? (
          <p className="gather-meta-sub" role="status">
            {status.data.latest ? 'Intake is wired and polling.' : 'Intake is not wired yet — no durable capture is running.'}
            {' '}Ambiguous matches park here as needs-decision; exact verified links deduplicate silently.
          </p>
        ) : null}
        <button type="button" className="gather-secondary-button gather-small-button" disabled={busy} onClick={() => void runSweep()}>
          {busy ? 'Sweeping…' : 'Check for new mail now'}
        </button>
        {sweep.kind === 'error' ? <PanelError message={sweep.message} /> : null}
        {sweep.kind === 'ready' && needsDecision.length === 0 ? <p className="gather-meta-sub" role="status">Sweep complete — nothing needs an identity decision.</p> : null}
        {needsDecision.length > 0 ? (
          <div role="status">
            <p><strong>{needsDecision.length} message{needsDecision.length === 1 ? '' : 's'} need{needsDecision.length === 1 ? 's' : ''} your identity decision</strong> — resolve them on their bookings. Similarity is a hint only; booking writes stay blocked until you resolve.</p>
            <ul className="gather-offer-terms">{needsDecision.map((item, index) => <li key={item.messageId ?? index}>{item.messageId ?? `item ${index + 1}`}{item.reason ? ` — ${item.reason}` : ''}</li>)}</ul>
          </div>
        ) : null}
      </section>
      <section className="gather-review-block" aria-labelledby="identity-due">
        <div className="gather-block-heading gather-block-heading-tight"><div><span className="gather-eyebrow">Follow-ups</span><h2 id="identity-due">Due work</h2></div></div>
        {due.kind === 'loading' || due.kind === 'idle' ? <PanelLoading label="Loading due work" /> : null}
        {due.kind === 'error' ? <PanelError message={due.message} onRetry={() => void refresh()} /> : null}
        {due.kind === 'ready' && dueItems.length === 0 ? <p className="gather-meta-sub" role="status">Nothing due — follow-up drafts appear here 24 hours after an unanswered reply, never sent automatically.</p> : null}
        {due.kind === 'ready' && dueItems.length > 0 ? (
          <ul className="gather-offer-terms">{dueItems.map((item, index) => <li key={index}>{JSON.stringify(item)}</li>)}</ul>
        ) : null}
      </section>
    </div>
  );
}

/* ---------------- Owner takeover via durable intents ---------------- */

interface IntentShape {
  id: string;
  state: string;
  steps?: Array<{ name: string; status: string; error?: string }>;
  lastError?: string;
}

export function TakeoverPanel({ bookings }: { bookings: BookingSummary[] }) {
  const [bookingId, setBookingId] = useState<string>(bookings[0]?.id ?? '');
  const [intent, setIntent] = useState<IntentShape | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!bookingId && bookings[0]?.id) setBookingId(bookings[0].id);
  }, [bookings, bookingId]);

  const control = async (kind: 'pause' | 'resume' | 'cancel') => {
    if (!bookingId) return;
    setBusy(true);
    setError(undefined);
    try {
      const submitted = (await postJson('/api/intents', {
        command: { kind: 'owner_control', bookingId, control, dedupeKey: `${kind}:${bookingId}:${Date.now()}` },
      })) as { intentId: string };
      const data = (await getJson(`/api/intents/${encodeURIComponent(submitted.intentId)}`)) as { intent: IntentShape };
      setIntent(data.intent);
    } catch (controlError) {
      setError(controlError instanceof Error ? controlError.message : String(controlError));
    } finally {
      setBusy(false);
    }
  };

  const refreshIntent = async () => {
    if (!intent) return;
    try {
      const data = (await getJson(`/api/intents/${encodeURIComponent(intent.id)}`)) as { intent: IntentShape };
      setIntent(data.intent);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
    }
  };

  return (
    <section className="gather-review-block" aria-labelledby="takeover-heading">
      <div className="gather-block-heading gather-block-heading-tight"><div><span className="gather-eyebrow">Pause · resume · cancel</span><h2 id="takeover-heading">Take over a booking</h2></div></div>
      <p className="gather-meta-sub">Takeover stops new effects but keeps ingesting evidence. Resume reconciles replies, provider effects, and hold state first — a previous approval never becomes fresh by resuming.</p>
      {bookings.length === 0 ? <p className="gather-meta-sub" role="status">No bookings to take over yet.</p> : (
        <div className="gather-meta-group">
          <label className="gather-meta-label" htmlFor="takeover-booking">Booking</label>
          <select id="takeover-booking" value={bookingId} onChange={(event) => setBookingId(event.target.value)} style={{ width: '100%' }}>
            {bookings.map((booking) => <option key={booking.id} value={booking.id}>{booking.clientName} — {booking.statusLabel}</option>)}
          </select>
        </div>
      )}
      <div className="gather-review-actions">
        <button type="button" className="gather-secondary-button gather-small-button" disabled={busy || !bookingId} onClick={() => void control('pause')}>Pause work</button>
        <button type="button" className="gather-secondary-button gather-small-button" disabled={busy || !bookingId} onClick={() => void control('resume')}>Resume</button>
        <button type="button" className="gather-secondary-button gather-small-button" disabled={busy || !bookingId} onClick={() => void control('cancel')}>Cancel booking work</button>
      </div>
      {error ? <PanelError message={error} /> : null}
      {intent ? (
        <div role="status" aria-live="polite">
          <p><strong>Control intent {intent.id}</strong> — state: <strong>{intent.state}</strong> <button type="button" className="gather-text-button" onClick={() => void refreshIntent()}>Refresh progress</button></p>
          {intent.steps && intent.steps.length > 0 ? (
            <ul className="gather-offer-terms">{intent.steps.map((step) => <li key={step.name}>{step.name}: {step.status}{step.error ? ` — ${step.error}` : ''}</li>)}</ul>
          ) : null}
          {intent.lastError ? <p className="gather-action-note is-error">{intent.lastError}</p> : null}
        </div>
      ) : null}
    </section>
  );
}

/* ---------------- Acceptance and handoff ---------------- */

export function AcceptanceHandoffPanel({ bookingId }: { bookingId?: string }) {
  const [handoff, setHandoff] = useState<FetchState<unknown>>({ kind: 'idle' });
  const [customerEmail, setCustomerEmail] = useState('');
  const [mailbox, setMailbox] = useState('');
  const [link, setLink] = useState<{ mailto: string; explanation: string } | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const refresh = useCallback(async () => {
    if (!bookingId) return;
    setHandoff({ kind: 'loading' });
    try {
      setHandoff({ kind: 'ready', data: await getJson(`/api/bookings/${encodeURIComponent(bookingId)}/handoff`) });
    } catch (refreshError) {
      setHandoff({ kind: 'error', message: refreshError instanceof Error ? refreshError.message : String(refreshError) });
    }
  }, [bookingId]);

  useEffect(() => { void refresh(); }, [refresh]);

  if (!bookingId) {
    return <p className="gather-meta-sub" role="status">Select a booking to see its acceptance and handoff state.</p>;
  }

  const compose = async () => {
    setBusy(true);
    setError(undefined);
    setLink(undefined);
    try {
      const now = new Date();
      const issuedAt = now.toISOString();
      const expiresAt = new Date(now.getTime() + 48 * 3600 * 1000).toISOString();
      const response = (await postJson(`/api/bookings/${encodeURIComponent(bookingId)}/acceptance`, {
        customerEmail, mailbox, issuedAt, expiresAt,
      })) as { mailto?: string; explanation?: string; error?: string };
      if (response.error) throw new Error(response.error);
      if (!response.mailto) throw new Error('The server did not return an acceptance link');
      setLink({ mailto: response.mailto, explanation: response.explanation ?? '' });
    } catch (composeError) {
      setError(composeError instanceof Error ? composeError.message : String(composeError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <section className="gather-review-block" aria-labelledby="acceptance-heading">
        <div className="gather-block-heading gather-block-heading-tight"><div><span className="gather-eyebrow">Customer decision</span><h2 id="acceptance-heading">Acceptance</h2></div></div>
        <p className="gather-meta-sub">The customer needs no Gather account: the offer carries an <strong>Accept by email</strong> link. Opening it is not acceptance — the customer must send the reply, and the signed token binds the exact offer version and authorized sender.</p>
        <div className="gather-meta-group">
          <label className="gather-meta-label" htmlFor="acceptance-customer">Customer email (authorized sender)</label>
          <input id="acceptance-customer" type="email" value={customerEmail} onChange={(event) => setCustomerEmail(event.target.value)} placeholder="guest@example.com" style={{ width: '100%' }} />
        </div>
        <div className="gather-meta-group">
          <label className="gather-meta-label" htmlFor="acceptance-mailbox">Business mailbox (reply-to)</label>
          <input id="acceptance-mailbox" type="email" value={mailbox} onChange={(event) => setMailbox(event.target.value)} placeholder="events@venue.com" style={{ width: '100%' }} />
        </div>
        <button type="button" className="gather-secondary-button gather-small-button" disabled={busy || customerEmail.trim().length === 0 || mailbox.trim().length === 0} onClick={() => void compose()}>
          {busy ? 'Composing…' : 'Compose acceptance link'}
        </button>
        {error ? <PanelError message={error} /> : null}
        {link ? (
          <div role="status">
            <p><a href={link.mailto}>Accept by email</a></p>
            <p className="gather-meta-sub">{link.explanation}</p>
          </div>
        ) : null}
      </section>
      <section className="gather-review-block" aria-labelledby="handoff-heading">
        <div className="gather-block-heading gather-block-heading-tight"><div><span className="gather-eyebrow">What remains</span><h2 id="handoff-heading">Handoff</h2></div></div>
        {handoff.kind === 'loading' || handoff.kind === 'idle' ? <PanelLoading label="Loading handoff" /> : null}
        {handoff.kind === 'error' ? <PanelError message={handoff.message} onRetry={() => void refresh()} /> : null}
        {handoff.kind === 'ready' ? (
          <div role="status">
            <p className="gather-meta-sub">Accepted is not confirmed: the handoff below shows event details, terms, responsibilities, and outstanding conditions for the accepted version.</p>
            <details className="gather-technical-details"><summary>Handoff detail</summary><p>{JSON.stringify(handoff.data)}</p></details>
            <button type="button" className="gather-text-button" onClick={() => void refresh()}>Refresh handoff</button>
          </div>
        ) : null}
      </section>
    </div>
  );
}
