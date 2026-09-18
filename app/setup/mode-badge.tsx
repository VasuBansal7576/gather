"use client";

import { useEffect, useState } from "react";

/**
 * Persistent simulation badge (ADR-001 / C01). Rendered on every page via the
 * root layout; its label comes only from the server's own mode report — never
 * from local guesses. Prepared/managed installs and unmanaged dev runs are
 * always simulated; a managed live mode would read LIVE instead.
 */
export function ModeBadge(): React.JSX.Element | null {
  const [label, setLabel] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/setup/mode", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : undefined))
      .then((body: unknown) => {
        if (cancelled || typeof body !== "object" || body === null) return;
        const mode = (body as { mode?: unknown }).mode;
        const simulated = (body as { simulated?: unknown }).simulated;
        if (mode === "live") setLabel("LIVE MODE");
        else if (simulated === true) setLabel("SIMULATED DATA — nothing here is real");
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  if (label === undefined) return null;
  return (
    <div className="gather-mode-badge" role="status">
      {label}
    </div>
  );
}
