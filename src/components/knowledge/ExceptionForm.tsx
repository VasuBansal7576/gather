'use client';

import { useState } from "react";
import type { KnowledgeFact, WorkspaceBooking } from "../../knowledge-owner/types.ts";
import { describeExceptionEffect, scopeTargetLabel } from "../../knowledge-owner/state.ts";
import type { ExceptionInput } from "../../knowledge-owner/api.ts";

export type ScopeBookingsState =
  | { kind: "idle" | "loading" }
  | { kind: "ready"; bookings: WorkspaceBooking[] }
  | { kind: "error"; message: string };

interface ExceptionFormProps {
  policies: KnowledgeFact[];
  bookingsState: ScopeBookingsState;
  onReloadBookings: () => void;
  busy: boolean;
  error?: string;
  onException: (input: ExceptionInput) => void;
  newCommandId: () => string;
}

function policyIdOf(fact: KnowledgeFact): string | undefined {
  const value = fact.value.policyId;
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

type BookingsState =
  | { kind: "idle" | "loading" }
  | { kind: "ready"; bookings: WorkspaceBooking[] }
  | { kind: "error"; message: string };

/**
 * Scoped exception composer. The booking is chosen from the owned
 * business's workspace identities — never typed as a raw DB id — and
 * customer selection stays disabled with an explanation because Gather
 * keeps no customer directory to choose from. The exception detail is one
 * focused question, shaped to the scoped-exception value contract.
 */
export function ExceptionForm({
  policies,
  bookingsState,
  onReloadBookings,
  busy,
  error,
  onException,
  newCommandId,
}: ExceptionFormProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [policyId, setPolicyId] = useState("");
  const [effect, setEffect] = useState<"allow" | "require_owner_decision">("allow");
  const [bookingId, setBookingId] = useState("");
  const [note, setNote] = useState("");
  const [localError, setLocalError] = useState<string | undefined>();

  const bookings = bookingsState.kind === "ready" ? bookingsState.bookings : [];
  const chosen = bookings.find((booking) => booking.id === bookingId);
  const preview = describeExceptionEffect("booking", chosen ? scopeTargetLabel("booking", chosen.id, bookings) : "…");

  if (!open) {
    return (
      <div className="knowledge-actions">
        <button type="button" className="knowledge-secondary-button" onClick={() => setOpen(true)}>
          Add a scoped exception…
        </button>
      </div>
    );
  }

  const canSubmit = !busy && policies.length > 0 && policyId !== "" && bookingId !== "" && note.trim().length > 0;

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
        if (!bookingId) {
          setLocalError("Choose the booking this exception is for — exceptions can never apply business-wide, and customer choice is unavailable.");
          return;
        }
        if (!note.trim()) {
          setLocalError("Say what Gather should allow here, in plain words.");
          return;
        }
        setLocalError(undefined);
        onException({
          policyId,
          effect,
          scope: "booking",
          scopeId: bookingId,
          subjectId: bookingId,
          value: { note: note.trim() },
          commandId: newCommandId(),
        });
      }}
    >
      <strong>Add a scoped exception</strong>
      <p className="knowledge-field-hint">For one booking that needs different treatment than the confirmed policy.</p>
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
        {bookingsState.kind === "loading" || bookingsState.kind === "idle" ? (
          <p className="knowledge-field-hint">Loading the bookings for this venue…</p>
        ) : bookingsState.kind === "error" ? (
          <div className="knowledge-notice" role="alert" style={{ margin: "4px 0" }}>
            <strong>Bookings did not load. </strong>{bookingsState.message}{" "}
            <button type="button" className="knowledge-secondary-button" onClick={() => onReloadBookings()}>Try again</button>
          </div>
        ) : bookings.length === 0 ? (
          <p className="knowledge-field-hint">No bookings for this venue yet — a scoped exception needs an existing booking to attach to.</p>
        ) : (
          <label className="knowledge-field">
            <span>Booking</span>
            <select className="knowledge-select" value={bookingId} disabled={busy} onChange={(event) => setBookingId(event.target.value)}>
              <option value="">Choose a booking…</option>
              {bookings.map((booking) => (
                <option key={booking.id} value={booking.id}>
                  {booking.eventName} · {booking.status} · {booking.id}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="knowledge-radio-row" role="radiogroup" aria-label="Exception scope">
          <label><input type="radio" name="exception-scope" checked disabled={busy} onChange={() => undefined} /> One booking</label>
          <label style={{ opacity: 0.6 }}>
            <input type="radio" name="exception-scope" disabled onChange={() => undefined} /> One customer (unavailable)
          </label>
        </div>
        <p className="knowledge-field-hint">
          Customer choice stays unavailable: Gather keeps no customer directory to choose from, so no customer
          can be named — and none is invented. Pick a booking above.
        </p>
      </fieldset>
      <label className="knowledge-field">
        <span>What should Gather allow here?</span>
        <textarea
          className="knowledge-textarea"
          value={note}
          disabled={busy}
          onChange={(event) => setNote(event.target.value)}
          placeholder="e.g. Let this booking run 30 minutes past midnight without asking again."
          rows={3}
          maxLength={500}
        />
      </label>
      <div className="knowledge-effect">
        <strong>{preview.headline}</strong>
        {preview.detail}
      </div>
      {localError ? <div className="knowledge-notice" role="alert"><strong>Check the form. </strong>{localError}</div> : null}
      {error ? <div className="knowledge-notice" role="alert"><strong>That exception did not apply. </strong>{error}</div> : null}
      <div className="knowledge-actions">
        <button type="submit" className="knowledge-approve-button" disabled={!canSubmit}>
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
