import { reconcileExecution, retryFailedSteps } from "../booking-service.ts";
import type { DueWorkReport, OperatorRuntimeDeps } from "./types.ts";
import { OperatorIntakeStore } from "./store.ts";

function nowIso(deps: OperatorRuntimeDeps): string {
  return deps.now ? deps.now() : new Date().toISOString();
}

/**
 * Idempotent waiting drain. For each claimed item that references an
 * approved proposal, verify the live exact-version approval read-only and
 * then only retry or reconcile — NEVER approveAndExecute, which would mint
 * an owner approval from the operator path. Items without live approval
 * are left for the owner (reported as awaitingOwner); claimed leases
 * fence them until expiry.
 *
 * Convention: WaitingItem.detail.proposedActionId (string) links due work
 * to the guarded booking pipeline. Items without it are skipped, never
 * force-executed.
 */
export async function drainDueWork(
  deps: OperatorRuntimeDeps,
  input: { limit?: number; claimedBy?: string } = {},
): Promise<DueWorkReport> {
  const report: DueWorkReport = {
    simulation: deps.simulation,
    claimed: [],
    skipped: [],
    retried: [],
    reconciled: [],
    awaitingOwner: [],
  };
  const now = nowIso(deps);
  let due;
  try {
    due = deps.ledger.listDueWork({ nowIso: now, limit: input.limit ?? 50 });
  } catch (error) {
    return { ...report, error: error instanceof Error ? error.message : String(error) };
  }
  if (due.length === 0) return report;
  const claimedBy = input.claimedBy ?? "operator-sweep";
  let claimedItems: Array<{ id: string; claimToken?: string; detail: Record<string, unknown> }>;
  try {
    const result = deps.ledger.claimDueWork({ ids: due.map((item) => item.id), claimedBy, nowIso: now });
    claimedItems = result.claimed.map((item) => ({ id: item.id, claimToken: item.claimToken, detail: item.detail as Record<string, unknown> }));
    report.skipped.push(...result.skippedIds);
  } catch (error) {
    return { ...report, error: error instanceof Error ? error.message : String(error) };
  }
  const intake = new OperatorIntakeStore(deps.store.db);
  for (const item of claimedItems) {
    report.claimed.push(item.id);
    const actionId = (item.detail as Record<string, unknown>).proposedActionId;
    if (typeof actionId !== "string" || actionId.length === 0) {
      report.skipped.push(item.id);
      continue;
    }
    try {
      if (!hasLiveApproval(deps, actionId)) {
        report.awaitingOwner.push(item.id);
        continue;
      }
      const executions = deps.store.listActionExecutions(actionId);
      const uncertain = executions.find((entry) => entry.status === "uncertain" || entry.status === "partial");
      if (uncertain !== undefined) {
        await reconcileExecution(deps.booking, uncertain.id);
        report.reconciled.push(item.id);
      } else {
        await retryFailedSteps(deps.booking, actionId);
        report.retried.push(item.id);
      }
      deps.ledger.resolveWaiting({ id: item.id, resolution: "done", note: "operator drain executed owner-approved work", claimToken: item.claimToken });
    } catch (error) {
      intake.recordFailure(deps.accountId, "due-work", `${item.id}: ${error instanceof Error ? error.message : String(error)}`);
      // Leave claimed for lease expiry; never resolve as done on failure.
    }
  }
  return report;
}

/** Read-only live exact-version approval check; creates nothing. */
function hasLiveApproval(deps: OperatorRuntimeDeps, actionId: string): boolean {
  let action;
  try {
    action = deps.store.getProposedAction(actionId);
  } catch {
    return false;
  }
  return deps.store.listApprovals(actionId).some(
    (approval) =>
      approval.status === "approved" &&
      approval.proposalVersion === action.proposalVersion &&
      approval.proposalFingerprint === action.proposalFingerprint,
  );
}
