"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ConfirmPanel,
  ConditionList,
  HandoffView,
  PhaseBanner,
  ReceiptList,
} from "../../../../src/components/delivery/DeliveryView.tsx";
import {
  createDeliveryApi,
  DeliveryApiError,
  type ConfirmResponse,
  type DeliveryFetch,
  type HandoffResponse,
  type ProposalIdentity,
  type ReadinessResponse,
  type StepReceipt,
} from "../../../../src/delivery-owner/api.ts";
import { canAttemptConfirm, RequestEpoch } from "../../../../src/delivery-owner/state.ts";

type LoadState =
  | { kind: "idle" | "loading" }
  | { kind: "ready" }
  | { kind: "error"; code: string; message: string; retryable: boolean };

function toLoadState(error: unknown, fallback: string): LoadState {
  const apiError = error instanceof DeliveryApiError
    ? error.apiError
    : { code: "UNKNOWN", message: fallback, retryable: true };
  return { kind: "error", ...apiError };
}

export default function DeliveryPage({ params }: { params: Promise<{ bookingId: string }> }): React.JSX.Element {
  const { bookingId } = React.use(params);
  const fetchImpl: DeliveryFetch = useMemo(() => (input, init) => fetch(input, init), []);
  const api = useMemo(() => createDeliveryApi(fetchImpl), [fetchImpl]);
  const epoch = useRef(new RequestEpoch());

  const [state, setState] = useState<LoadState>({ kind: "idle" });
  const [readiness, setReadiness] = useState<ReadinessResponse | null>(null);
  const [readinessError, setReadinessError] = useState<LoadState>({ kind: "idle" });
  const [handoff, setHandoff] = useState<HandoffResponse | null>(null);
  const [handoffError, setHandoffError] = useState<LoadState>({ kind: "idle" });
  const [identity, setIdentity] = useState<ProposalIdentity | undefined>(undefined);
  const [receipts, setReceipts] = useState<StepReceipt[]>([]);
  const [eventName, setEventName] = useState(bookingId);
  const [bookingStatus, setBookingStatus] = useState("unknown");
  const [isDemo, setIsDemo] = useState(false);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmResult, setConfirmResult] = useState<ConfirmResponse | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [recordBusy, setRecordBusy] = useState(false);
  const [status, setStatus] = useState("");

  const load = useCallback(async () => {
    const run = epoch.current.next();
    setState({ kind: "loading" });
    setConfirmResult(null);
    setConfirmError(null);
    // Each part loads independently: a readiness failure must not blank
    // the handoff preview, receipts, or confirm panel (and vice versa).
    const [readinessSettled, handoffSettled, contextSettled] = await Promise.allSettled([
      api.getReadiness(bookingId),
      api.getHandoff(bookingId),
      api.getBookingContext(bookingId),
    ]);
    if (!epoch.current.isCurrent(run)) return;
    if (readinessSettled.status === "fulfilled") {
      setReadiness(readinessSettled.value);
      setReadinessError({ kind: "ready" });
    } else {
      setReadiness(null);
      setReadinessError(toLoadState(readinessSettled.reason, "Gather could not load readiness."));
    }
    if (handoffSettled.status === "fulfilled") {
      setHandoff(handoffSettled.value);
      setHandoffError({ kind: "ready" });
    } else {
      setHandoff(null);
      setHandoffError(toLoadState(handoffSettled.reason, "Gather could not load the handoff."));
    }
    if (contextSettled.status === "fulfilled") {
      const context = contextSettled.value;
      setIdentity(context.identity);
      setReceipts(context.receipts);
      setEventName(context.eventName);
      setBookingStatus(context.status);
      setIsDemo(context.demo);
      setState({ kind: "ready" });
    } else {
      setState(toLoadState(contextSettled.reason, "Gather could not load the delivery view."));
    }
  }, [api, bookingId]);

  useEffect(() => {
    void load();
  }, [load]);

  const confirmKey = useMemo(() => {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
    return `confirm-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  }, [identity?.proposedActionId, identity?.proposalVersion, identity?.proposalFingerprint]);

  const permitted = readiness !== null && canAttemptConfirm(readiness.decision.ready, readiness.decision.liveReady);
  const whyBlocked = readiness === null
    ? "Readiness has not loaded yet."
    : !readiness.decision.ready
      ? `Not ready: ${readiness.decision.blockedBy.join("; ") || "conditions unmet"}.`
      : !readiness.decision.liveReady
        ? "Ready on demo evidence only — live provenance is required before confirmation."
        : "";

  const onConfirm = async (): Promise<void> => {
    if (!identity || !permitted) return;
    const run = epoch.current.next();
    setConfirmBusy(true);
    setConfirmError(null);
    try {
      const result = await api.confirmBooking(bookingId, identity, confirmKey);
      if (!epoch.current.isCurrent(run)) return;
      setConfirmResult(result);
      setStatus(result.confirmedBooking ? "Booking confirmed." : "Confirmation refused — review the decision.");
      await load();
    } catch (error) {
      if (!epoch.current.isCurrent(run)) return;
      const apiError = error instanceof DeliveryApiError ? error.apiError : { code: "UNKNOWN", message: "Confirmation did not complete.", retryable: true };
      setConfirmError(`${apiError.code}: ${apiError.message}`);
    } finally {
      if (epoch.current.isCurrent(run)) setConfirmBusy(false);
    }
  };

  const onRecordHandoff = async (): Promise<void> => {
    const run = epoch.current.next();
    setRecordBusy(true);
    try {
      const response = await api.recordHandoff(bookingId);
      if (!epoch.current.isCurrent(run)) return;
      setHandoff(response);
      setStatus(response.revision === null ? "Handoff evaluated but not recorded." : `Handoff recorded as revision ${response.revision}.`);
      await load();
    } catch (error) {
      if (!epoch.current.isCurrent(run)) return;
      const apiError = error instanceof DeliveryApiError ? error.apiError : { code: "UNKNOWN", message: "Handoff could not be recorded.", retryable: true };
      setStatus(`${apiError.code}: ${apiError.message}`);
    } finally {
      if (epoch.current.isCurrent(run)) setRecordBusy(false);
    }
  };

  return (
    <div className="delivery-shell">
      <header>
        <div className="delivery-brand">Gather</div>
        <h1>Delivery readiness</h1>
        <p className="delivery-muted">
          Booking <strong>{bookingId}</strong> · every condition below is verified against real receipts before anything confirms.
          {isDemo ? " DEMO ONLY — fixture evidence, not live proof." : ""}
        </p>
      </header>
      <div className="delivery-status" aria-live="polite">{status}</div>
      <main className="delivery-main">
        {state.kind === "loading" || state.kind === "idle" ? <p className="delivery-muted">Loading delivery state…</p> : null}
        {state.kind === "error" ? (
          <div className="delivery-notice is-error" role="alert">
            <div>
              <strong>Gather could not load this view ({state.code}).</strong>
              <p>{state.message}</p>
            </div>
            {state.retryable ? (
              <div className="delivery-actions">
                <button type="button" className="delivery-button is-secondary" onClick={() => void load()}>Reload and review current state</button>
              </div>
            ) : null}
          </div>
        ) : null}
        {state.kind === "ready" ? (
          <>
            <PhaseBanner status={bookingStatus} eventName={eventName} />
            {readiness !== null ? <ConditionList decision={readiness.decision} /> : null}
            {readinessError.kind === "error" ? (
              <div className="delivery-notice is-error" role="alert">
                <div>
                  <strong>Readiness is unavailable ({readinessError.code}).</strong>
                  <p>{readinessError.message}</p>
                </div>
                {readinessError.retryable ? (
                  <div className="delivery-actions">
                    <button type="button" className="delivery-button is-secondary" onClick={() => void load()}>Reload and review current state</button>
                  </div>
                ) : null}
              </div>
            ) : null}
            <ReceiptList receipts={receipts} />
            <ConfirmPanel
              identity={identity}
              permitted={permitted}
              whyBlocked={whyBlocked}
              busy={confirmBusy}
              result={confirmResult}
              error={confirmError}
              onConfirm={() => void onConfirm()}
            />
            {handoff !== null ? <HandoffView response={handoff} /> : null}
            {handoffError.kind === "error" ? (
              <div className="delivery-notice is-error" role="alert">
                <div>
                  <strong>Handoff preview is unavailable ({handoffError.code}).</strong>
                  <p>{handoffError.message}</p>
                </div>
                {handoffError.retryable ? (
                  <div className="delivery-actions">
                    <button type="button" className="delivery-button is-secondary" onClick={() => void load()}>Reload and review current state</button>
                  </div>
                ) : null}
              </div>
            ) : null}
            <div className="delivery-actions">
              <button type="button" className="delivery-button is-secondary" disabled={recordBusy} onClick={() => void onRecordHandoff()}>
                {recordBusy ? "Recording…" : "Record handoff revision"}
              </button>
              <button type="button" className="delivery-button is-secondary" onClick={() => void load()}>
                Reload and review current state
              </button>
            </div>
          </>
        ) : null}
      </main>
    </div>
  );
}
