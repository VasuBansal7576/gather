import type { FaultDefinition } from "../../../incidents/faults.ts";

export interface FaultPanelProps {
  faults: FaultDefinition[];
  onInject?: (faultId: string) => void;
  injecting?: boolean;
}

/**
 * ADR-004 prepared fault-injection panel. Every fault is labelled as a
 * prepared drill (or real-restart opt-in); nothing injected here counts as
 * real runtime evidence.
 */
export function FaultPanel({ faults, onInject, injecting }: FaultPanelProps) {
  return (
    <section data-testid="fault-panel" style={{ border: "1px dashed #999", borderRadius: 8, padding: 12, marginBottom: 12 }}>
      <h3>Recovery drills (prepared fixtures)</h3>
      <p>
        <small>
          These inject labelled practice failures so you can watch the repair loop work. They never touch real
          connections, real bookings, or the live runtime. Real restart proof needs a separate explicit opt-in.
        </small>
      </p>
      <ul>
        {faults.map((fault) => (
          <li key={fault.id} style={{ marginBottom: 8 }}>
            <strong>{fault.label}</strong>{" "}
            <small data-testid={`fault-kind-${fault.id}`}>
              {fault.kind === "real-restart-opt-in" ? "real restart — opt-in only" : "scripted drill"}
            </small>
            <br />
            <small>{fault.description}</small>
            <br />
            {onInject && (
              <button type="button" onClick={() => onInject(fault.id)} disabled={injecting === true}>
                Inject this drill
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
