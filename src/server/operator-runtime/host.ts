import type { IntakeDeps } from "./intake.ts";

/**
 * Host wiring for the operator API routes. The host (application bootstrap)
 * provides fully-built operator deps — including the injected inbox poller
 * with approved tokens. Until wired, routes report intake-not-configured
 * instead of fabricating a poller or reading credentials themselves.
 */
let current: IntakeDeps | null = null;

export function setOperatorDeps(deps: IntakeDeps): void {
  current = deps;
}

export function getOperatorDeps(): IntakeDeps | null {
  return current;
}

/** Test-only reset. */
export function resetOperatorDeps(): void {
  current = null;
}
