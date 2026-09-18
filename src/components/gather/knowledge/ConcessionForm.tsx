import { useState, type ReactNode } from "react";
import {
  CONCESSION_APPROVAL_NOTICE,
  type ConcessionFormInput,
} from "../../../knowledge/concessions.ts";

const panel: React.CSSProperties = {
  border: "1px solid #d8d2c7",
  borderRadius: 12,
  padding: 16,
  marginBottom: 16,
  maxWidth: "100%",
  background: "#fffdf8",
};

const heading: React.CSSProperties = { margin: "0 0 8px", fontSize: 18 };
const muted: React.CSSProperties = { color: "#5b564a", fontSize: 14 };
const field: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4, marginBottom: 12 };

export interface ConcessionFormProps {
  onSubmit: (form: ConcessionFormInput) => void;
  submitting?: boolean;
  serverError?: string | null;
}

/**
 * ADR-005 scoped concession form (exported for ADR-006 composition). The
 * scope control only offers booking or customer — never business-wide and
 * never standing send authority. Every field is a labelled native control
 * so the form works with keyboard and mobile alike.
 */
export function ConcessionForm(props: ConcessionFormProps): ReactNode {
  const { onSubmit, submitting, serverError } = props;
  const [scopeType, setScopeType] = useState("booking");
  const [scopeId, setScopeId] = useState("");
  const [percent, setPercent] = useState("");
  const [capMinor, setCapMinor] = useState("");
  const [floorMinor, setFloorMinor] = useState("");
  const [dateBounds, setDateBounds] = useState("");
  const [packageBounds, setPackageBounds] = useState("");

  function submit(): void {
    const parsedPercent = percent.trim() === "" ? undefined : Number(percent);
    const parsedCap = capMinor.trim() === "" ? undefined : Math.round(Number(capMinor) * 100);
    const parsedFloor = floorMinor.trim() === "" ? undefined : Math.round(Number(floorMinor) * 100);
    onSubmit({
      scopeType,
      scopeId: scopeId.trim(),
      maxReduction: {
        ...(parsedPercent === undefined || !Number.isFinite(parsedPercent) ? {} : { percent: parsedPercent }),
        ...(parsedCap === undefined || !Number.isInteger(parsedCap) ? {} : { minor: parsedCap, currency: "USD" }),
      },
      ...(parsedFloor === undefined || !Number.isInteger(parsedFloor)
        ? {}
        : { floor: { minor: parsedFloor, currency: "USD" } }),
      ...(dateBounds.trim() === "" ? {} : { dateBounds: dateBounds.trim() }),
      ...(packageBounds.trim() === "" ? {} : { packageBounds: packageBounds.trim() }),
    });
  }

  return (
    <section aria-label="Scoped concession form" style={panel}>
      <h2 style={heading}>Scoped concession</h2>
      <p style={muted}>{CONCESSION_APPROVAL_NOTICE}</p>
      <div style={field}>
        <label htmlFor="concession-scope-type">Scope</label>
        <select
          id="concession-scope-type"
          value={scopeType}
          onChange={(event) => setScopeType(event.target.value)}
        >
          <option value="booking">One booking</option>
          <option value="customer">One customer</option>
        </select>
      </div>
      <div style={field}>
        <label htmlFor="concession-scope-id">Booking or customer id</label>
        <input
          id="concession-scope-id"
          type="text"
          value={scopeId}
          onChange={(event) => setScopeId(event.target.value)}
          placeholder="e.g. booking-7"
          autoComplete="off"
        />
      </div>
      <div style={field}>
        <label htmlFor="concession-percent">Maximum percent off (0–100)</label>
        <input
          id="concession-percent"
          type="number"
          min={0}
          max={100}
          value={percent}
          onChange={(event) => setPercent(event.target.value)}
          inputMode="decimal"
        />
      </div>
      <div style={field}>
        <label htmlFor="concession-cap">Capped total in USD (optional)</label>
        <input
          id="concession-cap"
          type="number"
          min={0}
          value={capMinor}
          onChange={(event) => setCapMinor(event.target.value)}
          inputMode="decimal"
        />
      </div>
      <div style={field}>
        <label htmlFor="concession-floor">Floor total in USD (optional)</label>
        <input
          id="concession-floor"
          type="number"
          min={0}
          value={floorMinor}
          onChange={(event) => setFloorMinor(event.target.value)}
          inputMode="decimal"
        />
      </div>
      <div style={field}>
        <label htmlFor="concession-dates">Date bounds (optional)</label>
        <input
          id="concession-dates"
          type="text"
          value={dateBounds}
          onChange={(event) => setDateBounds(event.target.value)}
          placeholder="e.g. weekday evenings in November"
          autoComplete="off"
        />
      </div>
      <div style={field}>
        <label htmlFor="concession-packages">Package bounds (optional)</label>
        <input
          id="concession-packages"
          type="text"
          value={packageBounds}
          onChange={(event) => setPackageBounds(event.target.value)}
          placeholder="e.g. dinner package only"
          autoComplete="off"
        />
      </div>
      {serverError ? (
        <p role="alert" style={{ color: "#8a1f1f" }}>
          {serverError}
        </p>
      ) : null}
      <button type="button" onClick={submit} disabled={submitting === true} aria-label="Validate concession">
        {submitting === true ? "Checking…" : "Review concession"}
      </button>
    </section>
  );
}
