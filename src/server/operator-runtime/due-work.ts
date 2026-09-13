import { reconcileExecution } from "../booking-service.ts";
import type { DueWorkReport, OperatorRuntimeDeps } from "./types.ts";
import { OperatorIntakeStore } from "./store.ts";

function nowIso(deps: OperatorRuntimeDeps): string {
  return deps.now ? deps.now() : new Date().toISOString();
}

type SqlRow = Record<string, unknown>;

function rowOf(value: unknown): SqlRow | undefined {
  if (!value || typeof value !== "object") return undefined;
  return value as SqlRow;
}

export interface ClaimedWorkItem {
  id: string;
  bookingId: string;
  claimToken?: string;
  claimedAt?: string;
  detail: Record<string, unknown>;
}

/**
 * Claim phase: list due work scoped to this runtime's business, then claim
 * with fencing. Selection itself is scoped — waiting items whose booking
 * belongs to another business are never claimed here.
 */
export function claimDueItems(
  deps: OperatorRuntimeDeps,
  input: { limit?: number; claimedBy?: string } = {},
): { claimed: ClaimedWorkItem[]; skipped: string[] } {
  const now = nowIso(deps);
  const due = deps.ledger.listDueWork({ nowIso: now, limit: input.limit ?? 50 });
  const scoped = due.filter((item) => bookingBusiness(deps, item.bookingId) === deps.businessId);
  if (scoped.length === 0) return { claimed: [], skipped: due.map((item) => item.id) };
  const result = deps.ledger.claimDueWork({
    ids: scoped.map((item) => item.id),
    claimedBy: input.claimedBy ?? "operator-sweep",
    nowIso: now,
  });
  return {
    claimed: result.claimed.map((item) => ({
      id: item.id,
      bookingId: item.bookingId,
      claimToken: item.claimToken,
      claimedAt: item.claimedAt,
      detail: item.detail as Record<string, unknown>,
    })),
    skipped: [...due.filter((entry) => !scoped.some((item) => item.id === entry.id)).map((entry) => entry.id), ...result.skippedIds],
  };
}

function bookingBusiness(deps: OperatorRuntimeDeps, bookingId: string): string | undefined {
  try {
    return deps.store.getBooking(bookingId).businessId;
  } catch {
    return undefined;
  }
}

/**
 * Dispatch phase: revalidate EVERYTHING immediately before any effect —
 * the row must still be claimed by us with a matching token, the booking
 * must not be paused, no reply may have arrived since the claim, and the
 * referenced proposal must still carry a live exact-version approval for
 * the same booking. Only then may an uncertain step reconcile (read-only
 * provider truth, never a new write). Failed or not-yet-run steps report
 * awaitingOwner: retrying an old approved offer is not automatically
 * authorized follow-up messaging, and resending customer email as an
 * automatic consequence of intake timing is never permitted here.
 * NEVER approveAndExecute: the operator path cannot mint owner approval.
 */
export async function dispatchClaimedItems(
  deps: OperatorRuntimeDeps,
  items: ClaimedWorkItem[],
  claimedBy = "operator-sweep",
): Promise<Pick<DueWorkReport, "reconciled" | "awaitingOwner" | "skipped">> {
  const reconciled: string[] = [];
  const awaitingOwner: string[] = [];
  const skipped: string[] = [];
  const intake = new OperatorIntakeStore(deps.store.db);
  for (const item of items) {
    try {
      const verdict = await dispatchOne(deps, item, claimedBy);
      if (verdict === "reconciled") reconciled.push(item.id);
      else if (verdict === "awaitingOwner") awaitingOwner.push(item.id);
      else skipped.push(item.id);
    } catch (error) {
      intake.recordFailure(deps.accountId, "due-work", `${item.id}: ${error instanceof Error ? error.message : String(error)}`);
      skipped.push(item.id);
    }
  }
  return { reconciled, awaitingOwner, skipped };
}

async function dispatchOne(deps: OperatorRuntimeDeps, item: ClaimedWorkItem, claimedBy: string): Promise<"reconciled" | "awaitingOwner" | "skipped"> {
  // 1. Still ours? Re-read the row: status, owner, and fencing token.
  const current = readWaiting(deps, item.id);
  if (!current || current.status !== "claimed" || current.claimedBy !== claimedBy) {
    return "skipped";
  }
  if (current.claimToken === undefined || item.claimToken === undefined || current.claimToken !== item.claimToken) {
    return "skipped";
  }
  // 2. Booking still runnable? Pause (or cancel) after the claim stops dispatch.
  if (controlState(deps, item.bookingId) !== null) {
    return "skipped";
  }
  // 3. Reply since claim? A customer reply between claim and dispatch
  // suppresses instead of executing.
  if (replySince(deps, item.bookingId, current.claimedAt ?? current.updatedAt)) {
    deps.ledger.resolveWaiting({ id: item.id, resolution: "suppressed", note: "operator dispatch: reply arrived after claim", claimToken: item.claimToken });
    return "skipped";
  }
  // 4. Linked proposal, same booking, same business, live approval?
  const actionId = item.detail.proposedActionId;
  if (typeof actionId !== "string" || actionId.length === 0) {
    return "skipped";
  }
  let action;
  try {
    action = deps.store.getProposedAction(actionId);
  } catch {
    return "awaitingOwner";
  }
  if (action.bookingId !== item.bookingId) {
    return "skipped";
  }
  if (bookingBusiness(deps, action.bookingId) !== deps.businessId) {
    return "skipped";
  }
  const live = deps.store.listApprovals(actionId).some(
    (approval) =>
      approval.status === "approved" &&
      approval.proposalVersion === action.proposalVersion &&
      approval.proposalFingerprint === action.proposalFingerprint,
  );
  if (!live) {
    return "awaitingOwner";
  }
  // 5. Reconcile uncertain steps only. Failed or never-run steps (which
  // would send customer email on retry) stay with the owner.
  const executions = deps.store.listActionExecutions(actionId);
  const uncertain = executions.filter((entry) => entry.status === "uncertain" || entry.status === "partial");
  if (uncertain.length === 0) {
    const failed = executions.some((entry) => entry.status === "failed");
    if (failed || executions.length === 0) return "awaitingOwner";
    await resolveDone(deps, item);
    return "reconciled";
  }
  for (const execution of uncertain) {
    await reconcileExecution(deps.booking, execution.id);
  }
  const after = deps.store.listActionExecutions(actionId);
  if (after.every((entry) => entry.status === "succeeded")) {
    await resolveDone(deps, item);
  }
  return "reconciled";
}

async function resolveDone(deps: OperatorRuntimeDeps, item: ClaimedWorkItem): Promise<void> {
  deps.ledger.resolveWaiting({ id: item.id, resolution: "done", note: "operator drain reconciled owner-approved work", claimToken: item.claimToken });
}

function readWaiting(deps: OperatorRuntimeDeps, id: string): {
  status: string;
  claimedBy?: string;
  claimToken?: string;
  claimedAt?: string;
  updatedAt: string;
} | undefined {
  const found = deps.store.db.prepare("SELECT status, claimed_by, claim_token, claimed_at, updated_at FROM coord_waiting WHERE id = $id").get({ $id: id });
  const value = rowOf(found);
  if (!value) return undefined;
  return {
    status: String(value.status),
    claimedBy: value.claimed_by ? String(value.claimed_by) : undefined,
    claimToken: value.claim_token ? String(value.claim_token) : undefined,
    claimedAt: value.claimed_at ? String(value.claimed_at) : undefined,
    updatedAt: String(value.updated_at),
  };
}

function controlState(deps: OperatorRuntimeDeps, bookingId: string): string | null {
  const found = deps.store.db.prepare("SELECT state FROM coord_control WHERE booking_id = $booking").get({ $booking: bookingId });
  const value = rowOf(found);
  if (!value) return null;
  const state = String(value.state);
  return state === "paused" || state === "cancelled" ? state : null;
}

function replySince(deps: OperatorRuntimeDeps, bookingId: string, sinceIso: string): boolean {
  const sinceMs = Date.parse(sinceIso);
  if (!Number.isFinite(sinceMs)) return false;
  const rows = deps.store.db.prepare(
    "SELECT received_at FROM coord_events WHERE booking_id = $booking AND kind = 'reply' AND stale = 0",
  ).all({ $booking: bookingId }) as unknown[];
  for (const entry of rows) {
    const received = rowOf(entry)?.received_at;
    if (typeof received === "string") {
      const ms = Date.parse(received);
      if (Number.isFinite(ms) && ms > sinceMs) return true;
    }
  }
  return false;
}

/** Full drain: claim scoped items, then dispatch each with revalidation. */
export async function drainDueWork(
  deps: OperatorRuntimeDeps,
  input: { limit?: number; claimedBy?: string } = {},
): Promise<DueWorkReport> {
  const report: DueWorkReport = {
    simulation: deriveSimulation(deps),
    claimed: [],
    skipped: [],
    reconciled: [],
    awaitingOwner: [],
  };
  let claimed: ClaimedWorkItem[];
  try {
    const result = claimDueItems(deps, input);
    claimed = result.claimed;
    report.skipped.push(...result.skipped);
  } catch (error) {
    return { ...report, error: error instanceof Error ? error.message : String(error) };
  }
  report.claimed.push(...claimed.map((item) => item.id));
  const dispatched = await dispatchClaimedItems(deps, claimed, input.claimedBy ?? "operator-sweep");
  report.reconciled.push(...dispatched.reconciled);
  report.awaitingOwner.push(...dispatched.awaitingOwner);
  report.skipped.push(...dispatched.skipped);
  return report;
}

function deriveSimulation(deps: OperatorRuntimeDeps): boolean {
  return deps.inbox.provenance.simulated;
}
