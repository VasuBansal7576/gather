import type { IntakeDeps } from "./intake.ts";

/**
 * Host wiring for the operator API routes. The host (application bootstrap)
 * registers fully-built operator deps — including the injected inbox poller
 * with approved tokens — per stable accountId. Until wired, routes report
 * intake-not-configured instead of fabricating a poller or reading
 * credentials themselves.
 *
 * Multi-business composition: the registry is bounded (one binding per
 * accountId, at most MAX_OPERATOR_BINDINGS accounts) — bounded so an
 * accidentally unbounded host loop cannot grow memory without limit.
 * `getOperatorDeps()` returns the binding only when exactly one is
 * registered; with several bindings a caller MUST name the account via
 * `getOperatorDepsFor(accountId)` — the shared routes never guess a
 * business for an ambiguous request.
 */

export const MAX_OPERATOR_BINDINGS = 32;

const bindings = new Map<string, IntakeDeps>();

/** Register (or replace) the operator deps for one stable accountId. */
export function setOperatorDeps(deps: IntakeDeps): void {
  if (!bindings.has(deps.accountId) && bindings.size >= MAX_OPERATOR_BINDINGS) {
    throw new Error(`Operator binding registry is full (${MAX_OPERATOR_BINDINGS} accounts); remove a binding before adding another`);
  }
  bindings.set(deps.accountId, deps);
}

export function removeOperatorDeps(accountId: string): boolean {
  return bindings.delete(accountId);
}

/**
 * The operator deps when exactly one account is wired. Returns null when
 * nothing is registered OR when several accounts are registered — callers
 * must then address a specific account via getOperatorDepsFor.
 */
export function getOperatorDeps(): IntakeDeps | null {
  if (bindings.size !== 1) return null;
  const [first] = bindings.values();
  return first ?? null;
}

/** The operator deps for one stable accountId, if registered. */
export function getOperatorDepsFor(accountId: string): IntakeDeps | null {
  return bindings.get(accountId) ?? null;
}

/** All registered account ids (bounded by MAX_OPERATOR_BINDINGS). */
export function listOperatorAccounts(): string[] {
  return [...bindings.keys()].sort();
}

/** Test-only reset. */
export function resetOperatorDeps(): void {
  bindings.clear();
}
