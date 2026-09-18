'use client';

import { useCallback, useEffect, useState } from "react";
import type { FaultDefinition } from "../../../incidents/faults.ts";
import type { Incident } from "../../../incidents/types.ts";
import { FaultPanel } from "./FaultPanel.tsx";
import { IncidentThread } from "./IncidentThread.tsx";

/**
 * ADR-004 Recoveries view (C10): prepared fault-injection panel plus the
 * owner-visible repair threads. Shows only persisted incident states;
 * evidence is always labelled.
 */
export function RecoveriesPanel() {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [faults, setFaults] = useState<FaultDefinition[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const refresh = useCallback(async () => {
    const [incidentsResponse, faultsResponse] = await Promise.all([
      fetch("/api/incidents", { headers: { accept: "application/json" } }),
      fetch("/api/faults", { headers: { accept: "application/json" } }),
    ]);
    if (!incidentsResponse.ok) throw new Error(`incidents request failed (${incidentsResponse.status})`);
    if (!faultsResponse.ok) throw new Error(`faults request failed (${faultsResponse.status})`);
    const incidentsBody = (await incidentsResponse.json()) as { incidents: Incident[] };
    const faultsBody = (await faultsResponse.json()) as { faults: FaultDefinition[] };
    setIncidents(incidentsBody.incidents);
    setFaults(faultsBody.faults);
  }, []);

  useEffect(() => {
    refresh().catch((refreshError: unknown) => {
      setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
    });
  }, [refresh]);

  async function inject(faultId: string): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch("/api/faults", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ faultId }),
      });
      if (!response.ok) throw new Error(`inject failed (${response.status}): ${JSON.stringify(await response.json())}`);
      await refresh();
    } catch (injectError: unknown) {
      setError(injectError instanceof Error ? injectError.message : String(injectError));
    } finally {
      setBusy(false);
    }
  }

  async function supervise(id: string): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/incidents/${encodeURIComponent(id)}/supervise`, { method: "POST" });
      if (!response.ok) throw new Error(`repair failed (${response.status}): ${JSON.stringify(await response.json())}`);
      await refresh();
    } catch (superviseError: unknown) {
      setError(superviseError instanceof Error ? superviseError.message : String(superviseError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section data-testid="recoveries-panel">
      <h2>Recoveries</h2>
      {error && (
        <p role="alert" data-testid="recoveries-error">
          {error}
        </p>
      )}
      <FaultPanel faults={faults} onInject={inject} injecting={busy} />
      {incidents.length === 0 ? (
        <p data-testid="recoveries-empty">No repair threads yet. Inject a drill above to watch the repair loop work.</p>
      ) : (
        incidents.map((incident) => (
          <IncidentThread key={incident.id} incident={incident} onSupervise={supervise} supervising={busy} />
        ))
      )}
    </section>
  );
}
