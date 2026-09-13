import type {
  ConditionResult,
  ConfirmResponse,
  HandoffResponse,
  OperationalHandoff,
  ProposalIdentity,
  ReadinessDecision,
  SourceRef,
  StepReceipt,
} from "../../../src/delivery-owner/contracts.ts";
import {
  bookingPhase,
  conditionLabel,
  conditionTone,
  formatWhen,
  handoffStateLabel,
  phaseLabel,
} from "../../../src/delivery-owner/state.ts";
import "./delivery.css";

export function StatusPill({ tone, children }: { tone: "ok" | "attention" | "muted" | "info"; children: React.ReactNode }): React.JSX.Element {
  return <span className={`delivery-pill is-${tone}`}>{children}</span>;
}

export function SourceAttribution({ source }: { source: SourceRef[] }): React.JSX.Element | null {
  if (source.length === 0) return null;
  return (
    <ul className="delivery-sources">
      {source.map((ref, index) => (
        <li key={`${ref.kind}-${ref.locator}-${index}`}>
          <span className="delivery-source-kind">{ref.kind}</span>{" "}
          <span title={ref.locator}>{ref.label ?? ref.locator}</span>
          {ref.fictional ? <span className="delivery-pill is-muted">DEMO ONLY</span> : null}
        </li>
      ))}
    </ul>
  );
}

export function ConditionList({ decision }: { decision: ReadinessDecision }): React.JSX.Element {
  return (
    <section className="delivery-panel" aria-label="Readiness conditions">
      <h2>Readiness</h2>
      <p className="delivery-muted">Evaluated {formatWhen(decision.evaluatedAt)} · {decision.provenance === "live" ? "live evidence" : "demo evidence — not live proof"}</p>
      <ul className="delivery-conditions">
        {decision.conditions.map((condition: ConditionResult) => (
          <li key={condition.kind} className="delivery-condition">
            <div className="delivery-condition-top">
              <strong>{conditionLabel(condition.kind)}</strong>
              <StatusPill tone={conditionTone(condition)}>
                {condition.waived ? "Waived by owner" : condition.status === "verified" ? "Verified" : condition.required ? "Missing" : "Optional"}
              </StatusPill>
            </div>
            <p className="delivery-muted">{condition.detail}</p>
            <SourceAttribution source={condition.evidence} />
          </li>
        ))}
      </ul>
      {decision.blockedBy.length > 0 ? (
        <div className="delivery-notice is-error" role="alert">
          <strong>Blocked: {decision.blockedBy.join("; ")}</strong>
        </div>
      ) : null}
      {decision.rejectedEvidence.length > 0 ? (
        <p className="delivery-muted">Rejected evidence: {decision.rejectedEvidence.join("; ")}</p>
      ) : null}
    </section>
  );
}

function provenanceLabel(provenance: StepReceipt["provenance"]): string {
  switch (provenance) {
    case "live":
      return "Live receipt";
    case "simulated":
      return "Simulated receipt";
    default:
      return "Provider receipt unverified";
  }
}

function stepLabel(receipt: StepReceipt): string {
  if (receipt.step === "hold") return "Provisional hold";
  if (receipt.step === "email") return "Offer email";
  return "Unsupported step";
}

export function ReceiptList({ receipts }: { receipts: StepReceipt[] }): React.JSX.Element {
  // Only rows scoped to the exact current proposal with a known step count
  // as proof. Everything else renders in a clearly labeled history section
  // (superseded proposals) or as an unsupported step — never as proof.
  const proof = receipts.filter((receipt) => receipt.current && receipt.step !== "unknown");
  const history = receipts.filter((receipt) => !(receipt.current && receipt.step !== "unknown"));
  if (receipts.length === 0) {
    return (
      <section className="delivery-panel" aria-label="Action receipts">
        <h2>Action receipts</h2>
        <p className="delivery-muted">No hold or email steps have completed for the current proposal yet.</p>
      </section>
    );
  }
  return (
    <section className="delivery-panel" aria-label="Action receipts">
      <h2>Action receipts</h2>
      {proof.length === 0 ? (
        <p className="delivery-muted">No hold or email steps have completed for the current proposal yet.</p>
      ) : (
        <ul className="delivery-conditions">
          {proof.map((receipt) => (
            <li key={receipt.id} className="delivery-condition">
              <div className="delivery-condition-top">
                <strong>{stepLabel(receipt)}</strong>
                <StatusPill tone={receipt.status === "succeeded" ? "ok" : receipt.status === "failed" ? "attention" : "muted"}>
                  {receipt.status}
                </StatusPill>
              </div>
              <p className="delivery-muted">
                Started {formatWhen(receipt.startedAt)}
                {receipt.completedAt ? ` · finished ${formatWhen(receipt.completedAt)}` : ""}
                {` · ${provenanceLabel(receipt.provenance)}`}
              </p>
              {receipt.error ? <p className="delivery-error-text">{receipt.error}</p> : null}
            </li>
          ))}
        </ul>
      )}
      {history.length > 0 ? (
        <>
          <h3>Earlier or unrecognized records — not current proof</h3>
          <ul className="delivery-conditions">
            {history.map((receipt) => (
              <li key={receipt.id} className="delivery-condition">
                <div className="delivery-condition-top">
                  <strong>{stepLabel(receipt)}</strong>
                  <StatusPill tone="muted">
                    {receipt.step === "unknown" ? "Unsupported" : "Earlier proposal"}
                  </StatusPill>
                </div>
                <p className="delivery-muted">
                  {receipt.step === "unknown"
                    ? "This record names no known hold or email step, so it cannot count as proof."
                    : "This record belongs to a superseded proposal, so it cannot count as current proof."}{" "}
                  {provenanceLabel(receipt.provenance)} · {receipt.status}.
                </p>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

export function HandoffView({ response }: { response: HandoffResponse }): React.JSX.Element {
  const handoff: OperationalHandoff | null = response.handoff;
  return (
    <section className="delivery-panel" aria-label="Operational handoff">
      <div className="delivery-card-top">
        <h2>Operations handoff</h2>
        <StatusPill tone={response.state === "ready" ? "ok" : response.state === "preliminary" ? "info" : "attention"}>
          {handoffStateLabel(response.state)}
        </StatusPill>
      </div>
      {response.revision === null ? (
        <div className="delivery-notice" role="status">
          <strong>Unpersisted preview.</strong> This view has not been recorded — revisions are created only by an explicit owner action below.
        </div>
      ) : (
        <p className="delivery-muted">Recorded revision {response.revision} · tied to the accepted proposal version.</p>
      )}
      {response.reason ? <p className="delivery-muted">{response.reason}</p> : null}
      {handoff === null ? <p className="delivery-muted">No handoff content is available for the current state.</p> : (
        <>
          <h3>Event</h3>
          <p>
            <strong>{handoff.event.name}</strong>
            {handoff.event.startAt ? ` · ${formatWhen(handoff.event.startAt)}` : ""}
            {typeof handoff.event.guestCount === "number" ? ` · ${handoff.event.guestCount} guests` : ""}
          </p>
          <h3>Services</h3>
          {handoff.services.length === 0 ? <p className="delivery-muted">No services listed.</p> : (
            <ul className="delivery-conditions">
              {handoff.services.map((service, index) => (
                <li key={`${service.name}-${index}`} className="delivery-condition">
                  <strong>{service.name}</strong>
                  {service.detail ? <p className="delivery-muted">{service.detail}</p> : null}
                  <SourceAttribution source={service.source} />
                </li>
              ))}
            </ul>
          )}
          <h3>Responsibilities</h3>
          {handoff.responsibilities.length === 0 ? <p className="delivery-muted">No responsibilities listed.</p> : (
            <ul className="delivery-conditions">
              {handoff.responsibilities.map((item, index) => (
                <li key={`${item.party}-${item.task}-${index}`} className="delivery-condition">
                  <strong>{item.party}</strong> — {item.task}
                  <SourceAttribution source={item.source} />
                </li>
              ))}
            </ul>
          )}
          <h3>Resources</h3>
          {handoff.resources.length === 0 ? <p className="delivery-muted">No resources listed.</p> : (
            <ul className="delivery-conditions">
              {handoff.resources.map((resource) => (
                <li key={resource.resourceId} className="delivery-condition">
                  <div className="delivery-condition-top">
                    <strong>{resource.resourceId}</strong>
                    <StatusPill tone={resource.status === "verified" ? "ok" : "attention"}>{resource.status}</StatusPill>
                  </div>
                  {resource.responsible ? <p className="delivery-muted">Responsible: {resource.responsible}</p> : null}
                  <SourceAttribution source={resource.source} />
                </li>
              ))}
            </ul>
          )}
          {handoff.outstanding.length > 0 ? (
            <>
              <h3>Outstanding</h3>
              <ul className="delivery-outstanding">
                {handoff.outstanding.map((item) => <li key={item}>{item}</li>)}
              </ul>
            </>
          ) : null}
        </>
      )}
    </section>
  );
}

export function ConfirmPanel({
  identity,
  permitted,
  whyBlocked,
  busy,
  result,
  error,
  onConfirm,
}: {
  identity: ProposalIdentity | undefined;
  permitted: boolean;
  whyBlocked: string;
  busy: boolean;
  result: ConfirmResponse | null;
  error: string | null;
  onConfirm: () => void;
}): React.JSX.Element {
  return (
    <section className="delivery-panel" aria-label="Confirm booking">
      <h2>Confirm booking</h2>
      {identity === undefined ? (
        <p className="delivery-muted">No current proposal to confirm for this booking.</p>
      ) : (
        <p className="delivery-muted">
          Confirms exactly proposal v{identity.proposalVersion} ({identity.proposalFingerprint.slice(0, 12)}…).
          Only the backend can confirm — this button requests it, and stale or changed proposals are refused.
        </p>
      )}
      {!permitted && identity !== undefined ? <p className="delivery-muted">{whyBlocked}</p> : null}
      {error !== null ? (
        <div className="delivery-notice is-error" role="alert">
          <strong>Confirmation did not complete.</strong>
          <p>{error}</p>
          <p className="delivery-muted">If the proposal or evidence changed, reload and review the current state, then try again.</p>
        </div>
      ) : null}
      {result !== null ? (
        <div className={result.confirmedBooking ? "delivery-notice is-ok" : "delivery-notice is-error"} role="status">
          <strong>{result.confirmedBooking ? "Booking confirmed." : `Not confirmed (${result.command.status}).`}</strong>
          <p>{result.note}</p>
        </div>
      ) : null}
      <button type="button" className="delivery-button is-primary" disabled={!permitted || busy} onClick={onConfirm}>
        {busy ? "Confirming…" : "Confirm booking"}
      </button>
    </section>
  );
}

export function PhaseBanner({ status, eventName }: { status: string; eventName: string }): React.JSX.Element {
  const phase = bookingPhase(status);
  return (
    <div className="delivery-banner" role="status">
      <div>
        <strong>{eventName}</strong>
        <p className="delivery-muted">{phaseLabel(phase, status)}</p>
      </div>
      <StatusPill tone={phase === "confirmed" ? "ok" : phase === "provisional" ? "info" : "muted"}>
        {phase === "provisional" ? "Provisional" : phase === "confirmed" ? "Confirmed" : status}
      </StatusPill>
    </div>
  );
}
