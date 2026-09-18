"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createSetupApi, SetupApiError, type CreateBusinessResultDTO, type PreparedScenarioIdDTO, type SetupBusinessDTO, type SetupFetch, type SetupModeDTO } from "../../src/setup/api.ts";
import type {
  ConnectedAccountDTO,
  ConnectionsSummaryDTO,
  ProviderConnectionDTO,
} from "../../src/setup/contracts.ts";
import {
  hasConnectedAccount,
  parseCallbackNotice,
  RequestEpoch,
  statusBlurb,
  type CallbackNotice,
  type LoadState,
  type SetupStep,
} from "../../src/setup/state.ts";
import "./setup.css";

type BusinessState =
  | { kind: "idle" | "loading" }
  | { kind: "ready"; businesses: SetupBusinessDTO[] }
  | { kind: "error"; code: string; message: string; retryable: boolean };

type ConnectionsState =
  | { kind: "idle" | "loading" }
  | { kind: "ready"; summary: ConnectionsSummaryDTO }
  | { kind: "error"; code: string; message: string; retryable: boolean };

function timezones(): string[] {
  try {
    const values = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
    if (typeof values === "function") return values("timeZone");
  } catch {
    // Fall through to the short list below.
  }
  return ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "Europe/London", "Europe/Paris", "UTC"];
}

function StepIndicator({ step }: { step: SetupStep }): React.JSX.Element {
  const steps: Array<{ id: SetupStep; label: string }> = [
    { id: "business", label: "Your venue" },
    { id: "apps", label: "Your apps" },
    { id: "ready", label: "Ready" },
  ];
  const order: SetupStep[] = ["business", "apps", "ready"];
  const current = order.indexOf(step);
  return (
    <ol className="setup-steps" aria-label="Setup progress">
      {steps.map((item, index) => (
        <li
          key={item.id}
          className={index < current ? "setup-step is-done" : index === current ? "setup-step is-current" : "setup-step"}
          {...(index === current ? { "aria-current": "step" } : {})}
        >
          <span className="setup-step-number" aria-hidden="true">{index + 1}</span>
          <span>{item.label}</span>
        </li>
      ))}
    </ol>
  );
}

function InlineError({ state, onRetry, retryLabel }: { state: { code: string; message: string; retryable: boolean }; onRetry: () => void; retryLabel: string }): React.JSX.Element {
  return (
    <div className="setup-notice is-error" role="alert">
      <div>
        <strong>Gather could not finish that step ({state.code}).</strong>
        <p>{state.message}</p>
      </div>
      {state.retryable ? (
        <button type="button" className="setup-button is-secondary" onClick={onRetry}>{retryLabel}</button>
      ) : null}
    </div>
  );
}

function AccountRow({
  account,
  onDisconnect,
  disconnecting,
}: {
  account: ConnectedAccountDTO;
  onDisconnect: (account: ConnectedAccountDTO) => void;
  disconnecting: boolean;
}): React.JSX.Element {
  const attention = account.status !== "connected";
  return (
    <li className="setup-account">
      <div>
        <strong>{account.displayName}</strong>
        <span className={attention ? "setup-pill is-attention" : "setup-pill is-ok"}>
          {account.status === "connected" ? "Connected" : account.status === "revoked" ? "Access removed" : account.status === "expired" ? "Session expired" : "Needs attention"}
        </span>
      </div>
      {account.status === "expired" ? (
        <p className="setup-muted">The Google session expired. Reconnect Google to restore availability checks.</p>
      ) : null}
      {attention && account.status !== "expired" ? (
        <p className="setup-muted">Gather cannot read from this account right now. Reconnect Google to restore it.</p>
      ) : null}
      <button
        type="button"
        className="setup-text-button is-danger"
        disabled={disconnecting}
        onClick={() => onDisconnect(account)}
      >
        {disconnecting ? "Removing…" : "Disconnect"}
      </button>
    </li>
  );
}

function ProviderCard({
  provider,
  action,
  actionBusy,
  onConnect,
  onDisconnect,
  disconnectingAccountId,
}: {
  provider: ProviderConnectionDTO;
  action: LoadState;
  actionBusy: boolean;
  onConnect: () => void;
  onDisconnect: (account: ConnectedAccountDTO) => void;
  disconnectingAccountId: string | undefined;
}): React.JSX.Element {
  const unavailable = provider.status === "unavailable";
  return (
    <article className="setup-card" aria-label="Google connection">
      <div className="setup-card-top">
        <h3>Google</h3>
        <span className={provider.status === "connected" ? "setup-pill is-ok" : provider.status === "not_connected" ? "setup-pill" : "setup-pill is-attention"}>
          {provider.status === "connected"
            ? "Connected"
            : provider.status === "not_connected"
              ? "Not connected"
              : provider.status === "authorization_pending"
                ? "Waiting on Google"
              : provider.status === "revoked"
                ? "Access removed"
                : provider.status === "expired"
                  ? "Session expired"
                  : provider.status === "error"
                    ? "Needs attention"
                    : "Unavailable"}
        </span>
      </div>
      <p className="setup-muted">{statusBlurb(provider.status, provider.unavailableReason)}</p>
      <p className="setup-muted">Covers your inbox and calendar — Gather reads inquiries and checks dates, and only ever prepares work for your review.</p>
      {provider.accounts.length > 0 ? (
        <ul className="setup-accounts">
          {provider.accounts.map((account) => (
            <AccountRow
              key={account.id}
              account={account}
              onDisconnect={onDisconnect}
              disconnecting={disconnectingAccountId === account.id}
            />
          ))}
        </ul>
      ) : null}
      {action.kind === "error" ? <InlineError state={action} onRetry={onConnect} retryLabel="Try again" /> : null}
      {!unavailable ? (
        <button type="button" className="setup-button is-primary" disabled={actionBusy} onClick={onConnect}>
          {actionBusy ? "Opening Google…" : provider.status === "connected" ? "Connect another account" : "Connect Google"}
        </button>
      ) : null}
    </article>
  );
}

export default function SetupPage(): React.JSX.Element {
  const fetchImpl: SetupFetch = useMemo(() => (input, init) => fetch(input, init), []);
  const api = useMemo(() => createSetupApi(fetchImpl), [fetchImpl]);
  // Separate epochs per loader: businesses and connections refresh
  // independently (choosing a venue must not invalidate the venue list).
  const epochBiz = useRef(new RequestEpoch());
  const epochConn = useRef(new RequestEpoch());
  const epochAct = useRef(new RequestEpoch());

  const [step, setStep] = useState<SetupStep>("business");
  const [businesses, setBusinesses] = useState<BusinessState>({ kind: "idle" });
  const [businessId, setBusinessId] = useState<string | undefined>(undefined);
  const [createState, setCreateState] = useState<LoadState>({ kind: "idle" });
  const [name, setName] = useState("");
  const [timezone, setTimezone] = useState("");
  const [connections, setConnections] = useState<ConnectionsState>({ kind: "idle" });
  const [actionState, setActionState] = useState<LoadState>({ kind: "idle" });
  const [callback, setCallback] = useState<CallbackNotice | undefined>(undefined);
  const [confirmDisconnect, setConfirmDisconnect] = useState<ConnectedAccountDTO | undefined>(undefined);
  const [disconnectingId, setDisconnectingId] = useState<string | undefined>(undefined);
  const [demoState, setDemoState] = useState<LoadState>({ kind: "idle" });
  const [status, setStatus] = useState("");
  const [mode, setMode] = useState<SetupModeDTO | undefined>(undefined);
  const [liveGate, setLiveGate] = useState<{ liveReady: boolean; blockedBy: string[] } | undefined>(undefined);
  const [scenario, setScenario] = useState<PreparedScenarioIdDTO>("glasshouse");
  const zones = useMemo(timezones, []);

  const loadBusinesses = useCallback(async () => {
    const run = epochBiz.current.next();
    setBusinesses({ kind: "loading" });
    try {
      const list = await api.getBusinesses();
      if (!epochBiz.current.isCurrent(run)) return;
      setBusinesses({ kind: "ready", businesses: list });
      setStatus(list.length === 0 ? "No venues yet. Create yours below." : "");
    } catch (error) {
      if (!epochBiz.current.isCurrent(run)) return;
      const apiError = error instanceof SetupApiError ? error.apiError : { code: "UNKNOWN", message: "Gather could not load your venues.", retryable: true };
      setBusinesses({ kind: "error", ...apiError });
    }
  }, [api]);

  const loadConnections = useCallback(async (id: string) => {
    const run = epochConn.current.next();
    setConnections({ kind: "loading" });
    try {
      const summary = await api.getConnections(id);
      if (!epochConn.current.isCurrent(run)) return;
      setConnections({ kind: "ready", summary });
    } catch (error) {
      if (!epochConn.current.isCurrent(run)) return;
      const apiError = error instanceof SetupApiError ? error.apiError : { code: "UNKNOWN", message: "Gather could not load connection state.", retryable: true };
      setConnections({ kind: "error", ...apiError });
    }
  }, [api]);

  useEffect(() => {
    void loadBusinesses();
    try {
      const notice = parseCallbackNotice(window.location.search);
      if (notice) {
        setCallback(notice);
        // Business context from the redirect selects the venue; connection
        // proof still comes only from the refetched server state below.
        if (notice.businessId) {
          setBusinessId(notice.businessId);
          setStep("apps");
        }
        setStatus(notice.kind === "connected" ? "Google finished — checking the connection now." : "Google did not complete. You can retry below.");
        window.history.replaceState(null, "", window.location.pathname);
      }
    } catch {
      // A malformed query string never blocks setup.
    }
  }, [loadBusinesses]);

  useEffect(() => {
    let cancelled = false;
    api.getMode()
      .then((info) => {
        if (!cancelled) setMode(info);
      })
      .catch(() => undefined);
    // ADR-006 live gate: owner-visible capability report. A failed read
    // leaves the card in its disabled state — never an enabled guess.
    fetch("/api/live-model/status?profile=base", { headers: { accept: "application/json" } })
      .then(async (response) => {
        if (cancelled || !response.ok) return;
        const body = (await response.json().catch(() => undefined)) as
          | { gate?: { liveReady?: boolean; blockedBy?: string[] } }
          | undefined;
        if (body?.gate) {
          setLiveGate({
            liveReady: body.gate.liveReady === true,
            blockedBy: Array.isArray(body.gate.blockedBy) ? body.gate.blockedBy.map(String) : [],
          });
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => {
    if (businessId) void loadConnections(businessId);
  }, [businessId, loadConnections, callback]);

  const chooseBusiness = (id: string): void => {
    setBusinessId(id);
    setStep("apps");
    setStatus("");
  };

  const createBusiness = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!name.trim() || !timezone.trim()) {
      setCreateState({ kind: "error", code: "MISSING_DETAILS", message: "Give your venue a name and a timezone so dates read correctly.", retryable: false });
      return;
    }
    const run = epochAct.current.next();
    setCreateState({ kind: "loading" });
    try {
      const result: CreateBusinessResultDTO = await api.createBusiness(name.trim(), timezone.trim());
      if (!epochAct.current.isCurrent(run)) return;
      setCreateState({ kind: "ready" });
      setName("");
      setTimezone("");
      setStatus(result.created ? "" : "That venue already existed — continuing with it.");
      await loadBusinesses();
      chooseBusiness(result.business.id);
    } catch (error) {
      if (!epochAct.current.isCurrent(run)) return;
      const apiError = error instanceof SetupApiError ? error.apiError : { code: "UNKNOWN", message: "Gather could not create the venue.", retryable: true };
      setCreateState({ kind: "error", ...apiError });
    }
  };

  const connectGoogle = async (): Promise<void> => {
    if (!businessId) return;
    const run = epochAct.current.next();
    setActionState({ kind: "loading" });
    try {
      const started = await api.startGoogleAuthorization(businessId);
      if (!epochAct.current.isCurrent(run)) return;
      setActionState({ kind: "ready" });
      // The ONLY navigation target: the validated https URL the server returned.
      window.location.assign(started.authorizationUrl);
    } catch (error) {
      if (!epochAct.current.isCurrent(run)) return;
      const apiError = error instanceof SetupApiError ? error.apiError : { code: "UNKNOWN", message: "Gather could not start the Google connection.", retryable: true };
      setActionState({ kind: "error", ...apiError });
      setStatus(apiError.code === "UNAVAILABLE" ? "Google connection is not available in this setup yet." : "");
    }
  };

  const confirmDisconnectAccount = async (): Promise<void> => {
    if (!confirmDisconnect || !businessId) return;
    const account = confirmDisconnect;
    const run = epochAct.current.next();
    setDisconnectingId(account.id);
    try {
      await api.disconnectGoogleAccount(account.id, account.businessId);
      if (!epochAct.current.isCurrent(run)) return;
      setConfirmDisconnect(undefined);
      setStatus(`${account.displayName} is disconnected. Availability checks will pause until you reconnect.`);
      await loadConnections(businessId);
    } catch (error) {
      if (!epochAct.current.isCurrent(run)) return;
      const apiError = error instanceof SetupApiError ? error.apiError : { code: "UNKNOWN", message: "Gather could not remove the account.", retryable: true };
      setActionState({ kind: "error", ...apiError });
    } finally {
      if (epochAct.current.isCurrent(run)) setDisconnectingId(undefined);
    }
  };

  const startDemo = async (): Promise<void> => {
    const run = epochAct.current.next();
    setDemoState({ kind: "loading" });
    try {
      const demo = await api.startDemo(mode?.managed === true ? scenario : undefined);
      if (!epochAct.current.isCurrent(run)) return;
      setDemoState({ kind: "ready" });
      setBusinessId(demo.businessId);
      setStep("ready");
      setStatus("Demo venue ready — nothing here is real, and your real setup is untouched.");
      await loadBusinesses();
      try {
        setMode(await api.getMode());
      } catch {
        // A stale mode read never blocks the completed seed.
      }
    } catch (error) {
      if (!epochAct.current.isCurrent(run)) return;
      const apiError = error instanceof SetupApiError ? error.apiError : { code: "UNKNOWN", message: "Gather could not start the demo.", retryable: true };
      setDemoState({ kind: "error", ...apiError });
    }
  };

  const summary = connections.kind === "ready" ? connections.summary : undefined;
  const connected = summary ? hasConnectedAccount(summary) : false;
  const chosen = businesses.kind === "ready" ? businesses.businesses.find((item) => item.id === businessId) : undefined;

  return (
    <div className="setup-shell">
      <header className="setup-header">
        <div className="setup-brand">Gather</div>
        <h1>Set up Gather</h1>
        <p className="setup-muted">Choose your venue and your apps. Gather handles the rest — no workflows, no wiring, nothing technical.</p>
        <StepIndicator step={step} />
      </header>
      <div className="setup-status" aria-live="polite">{status}</div>
      <main className="setup-main">
        <section className="setup-panel" aria-label="Choose how to start">
          <h2>Choose how to start</h2>
          <div className="setup-choice-grid">
            <article className="setup-mode-card">
              <h3>Prepared workspace</h3>
              <p className="setup-muted">
                Explore Gather with clearly marked fictional data — no Google sign-in, no real
                messages, nothing leaves this Mac. Every record is labelled simulated.
              </p>
              {mode?.managed === true ? (
                <label className="setup-field">
                  <span>Prepared scenario</span>
                  <select
                    value={scenario}
                    onChange={(event) => setScenario(event.target.value as PreparedScenarioIdDTO)}
                    aria-label="Prepared scenario"
                  >
                    {mode.scenarios.map((item) => (
                      <option key={item.id} value={item.id}>{item.label}</option>
                    ))}
                  </select>
                </label>
              ) : null}
              {mode?.managed === true && mode.prepared ? (
                <p className="setup-muted" role="status">
                  Seeded: {mode.scenarios.find((item) => item.id === mode.prepared?.scenario)?.label ?? mode.prepared.scenario} — {mode.prepared.inboxCount} inbox
                  message{mode.prepared.inboxCount === 1 ? "" : "s"}, {mode.prepared.busyBlockCount} busy
                  block{mode.prepared.busyBlockCount === 1 ? "" : "s"}, {mode.prepared.offerCount} offers.{" "}
                  {mode.prepared.coverageDetail}
                </p>
              ) : null}
              {mode?.managed === true ? (
                <p className="setup-muted">
                  To reset the prepared data: stop Gather, then run{" "}
                  <code>gather reset --confirm-reset</code> from the install directory. The next start
                  verifies the fresh seed.
                </p>
              ) : null}
              {demoState.kind === "error" ? <InlineError state={demoState} onRetry={() => void startDemo()} retryLabel="Try again" /> : null}
              <button
                type="button"
                className="setup-button is-primary"
                disabled={demoState.kind === "loading" || mode?.mode === "live"}
                onClick={() => void startDemo()}
              >
                {demoState.kind === "loading" ? "Preparing…" : "Start prepared workspace"}
              </button>
            </article>
            <article className="setup-mode-card is-disabled" aria-disabled="true">
              <h3>Live workspace</h3>
              <p className="setup-muted">
                Connect your real Google inbox and calendar.{" "}
                {mode?.live.reason ?? "Live onboarding is not available in this build."}
              </p>
              {liveGate && !liveGate.liveReady && liveGate.blockedBy.length > 0 ? (
                <div role="status">
                  <p className="setup-muted"><strong>Live verification is blocked — missing:</strong></p>
                  <ul className="setup-muted">
                    {liveGate.blockedBy.map((missing) => <li key={missing}>{missing}</li>)}
                  </ul>
                  <p className="setup-muted">Prepared mode above stays fully usable. No fixture evidence counts as live proof.</p>
                </div>
              ) : null}
              {liveGate?.liveReady ? (
                <p className="setup-muted" role="status">Capability gates pass. Continue below to connect Google on your own explicitly authorized accounts — live sends stay restricted to your configured test recipient.</p>
              ) : null}
              <button type="button" className="setup-button is-secondary" disabled>
                Not available yet
              </button>
            </article>
          </div>
        </section>
        {mode?.managed !== true && step === "business" ? (
          <section className="setup-panel" aria-label="Choose your venue">
            <h2>Which venue is this for?</h2>
            {businesses.kind === "loading" || businesses.kind === "idle" ? <p className="setup-muted">Loading your venues…</p> : null}
            {businesses.kind === "error" ? <InlineError state={businesses} onRetry={() => void loadBusinesses()} retryLabel="Reload venues" /> : null}
            {businesses.kind === "ready" && businesses.businesses.length > 0 ? (
              <ul className="setup-choices">
                {businesses.businesses.map((item) => (
                  <li key={item.id}>
                    <button type="button" className="setup-choice" onClick={() => chooseBusiness(item.id)}>
                      <strong>{item.name}</strong>
                      <span className="setup-muted">{item.timezone}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            {businesses.kind === "ready" && businesses.businesses.length === 0 ? (
              <p className="setup-muted">No venues yet — create yours below to begin.</p>
            ) : null}
            <form className="setup-form" onSubmit={(event) => void createBusiness(event)}>
              <h3>Or create a new venue</h3>
              <label className="setup-field">
                <span>Venue name</span>
                <input type="text" value={name} onChange={(event) => setName(event.target.value)} placeholder="Cedar Hall" autoComplete="organization" />
              </label>
              <label className="setup-field">
                <span>Timezone</span>
                <input type="text" value={timezone} onChange={(event) => setTimezone(event.target.value)} placeholder="America/New_York" list="setup-timezones" autoComplete="off" />
                <datalist id="setup-timezones">
                  {zones.map((zone) => <option key={zone} value={zone} />)}
                </datalist>
              </label>
              {createState.kind === "error" ? <InlineError state={createState} onRetry={() => setCreateState({ kind: "idle" })} retryLabel="Dismiss" /> : null}
              <button type="submit" className="setup-button is-primary" disabled={createState.kind === "loading"}>
                {createState.kind === "loading" ? "Creating…" : "Create venue and continue"}
              </button>
            </form>
          </section>
        ) : null}
        {mode?.managed !== true && step === "apps" ? (
          <section className="setup-panel" aria-label="Connect your apps">
            <h2>Connect your apps{chosen ? ` for ${chosen.name}` : ""}</h2>
            <button type="button" className="setup-text-button" onClick={() => setStep("business")}>← Change venue</button>
            {callback?.kind === "connected" ? (
              <div className="setup-notice is-ok" role="status">Google finished — refreshing the connection below.</div>
            ) : null}
            {callback?.kind === "error" ? (
              <div className="setup-notice is-error" role="alert">
                <div><strong>Google did not complete ({callback.code}).</strong><p>No access was granted. You can retry whenever you are ready.</p></div>
              </div>
            ) : null}
            {connections.kind === "loading" || connections.kind === "idle" ? <p className="setup-muted">Checking Google…</p> : null}
            {connections.kind === "error" ? <InlineError state={connections} onRetry={() => businessId && void loadConnections(businessId)} retryLabel="Check again" /> : null}
            {summary && summary.providers.length === 0 ? (
              <div className="setup-notice" role="status">No apps are available to connect in this setup yet. Try the demo below to explore.</div>
            ) : null}
            {summary?.providers.map((provider) => (
              <ProviderCard
                key={provider.provider}
                provider={provider}
                action={actionState}
                actionBusy={actionState.kind === "loading"}
                onConnect={() => void connectGoogle()}
                onDisconnect={(account) => setConfirmDisconnect(account)}
                disconnectingAccountId={disconnectingId}
              />
            ))}
            <div className="setup-actions">
              <button type="button" className="setup-button is-secondary" disabled={!connected} onClick={() => setStep("ready")}>
                Continue{connected ? "" : " (connect Google first)"}
              </button>
            </div>
          </section>
        ) : null}
        {step === "ready" ? (
          <section className="setup-panel" aria-label="Ready">
            <h2>You are ready{chosen ? `, ${chosen.name}` : ""}</h2>
            {mode?.managed === true ? (
              <p className="setup-muted">The prepared workspace is seeded — every record is fictional and nothing contacts real services.</p>
            ) : connected ? (
              <p>Gather can read your inbox and calendar. Every proposal still waits for your review.</p>
            ) : (
              <p className="setup-muted">You are exploring with demo data — nothing here is real.</p>
            )}
            <div className="setup-actions">
              <a className="setup-button is-primary" href="/">Enter workspace</a>
              {step === "ready" && !connected && mode?.managed !== true ? (
                <button type="button" className="setup-button is-secondary" onClick={() => setStep("business")}>Set up for real</button>
              ) : null}
            </div>
          </section>
        ) : null}
        {mode?.managed !== true ? (
          <aside className="setup-panel is-demo" aria-label="Try the demo">
            <h2>Just looking?</h2>
            <p className="setup-muted">Try Gather with clearly marked fictional data. Your real setup stays untouched, and nothing here contacts Google.</p>
            {demoState.kind === "error" ? <InlineError state={demoState} onRetry={() => void startDemo()} retryLabel="Try demo again" /> : null}
            <button type="button" className="setup-button is-secondary" disabled={demoState.kind === "loading"} onClick={() => void startDemo()}>
              {demoState.kind === "loading" ? "Starting demo…" : "Try demo"}
            </button>
          </aside>
        ) : null}
      </main>
      {confirmDisconnect ? (
        <div className="setup-dialog-backdrop">
          <div className="setup-dialog" role="alertdialog" aria-modal="true" aria-labelledby="setup-disconnect-title" aria-describedby="setup-disconnect-desc">
            <h2 id="setup-disconnect-title">Disconnect {confirmDisconnect.displayName}?</h2>
            <p id="setup-disconnect-desc">Gather will stop reading this account. Availability checks pause until you reconnect — existing bookings and history stay put.</p>
            <div className="setup-actions">
              <button type="button" className="setup-button is-danger" disabled={disconnectingId !== undefined} onClick={() => void confirmDisconnectAccount()}>
                {disconnectingId !== undefined ? "Removing…" : "Yes, disconnect"}
              </button>
              <button type="button" className="setup-button is-secondary" disabled={disconnectingId !== undefined} onClick={() => setConfirmDisconnect(undefined)}>
                Keep connected
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
