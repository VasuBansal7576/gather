import { emailOperationKey, holdOperationKey, reconcileExecution, ServiceError } from "../booking-service.ts";
import type { WaitingItem, WaitingKind } from "../../coordination/contracts.ts";
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
  kind: WaitingKind;
  claimToken?: string;
  claimedAt?: string;
  detail: Record<string, unknown>;
}

/**
 * Claim phase with scope-before-limit: due work is listed per booking of
 * this runtime's business (a supported ledger query), so a full global
 * page of foreign-business items can never starve this business — foreign
 * rows are never even read. Pages merge oldest-first and cap at `limit`,
 * so every sweep makes progress on the oldest open work.
 */
export function claimDueItems(
  deps: OperatorRuntimeDeps,
  input: { limit?: number; claimedBy?: string } = {},
): { claimed: ClaimedWorkItem[]; skipped: string[] } {
  const now = nowIso(deps);
  const total = input.limit ?? 50;
  // Store failures must surface as a drain error — never as a healthy
  // zero-work report. drainDueWork catches this into report.error.
  const bookings = deps.store.listBookings(deps.businessId);
  const due: WaitingItem[] = [];
  for (const booking of bookings) {
    const items = deps.ledger.listDueWork({ nowIso: now, limit: total, bookingId: booking.id });
    due.push(...items);
  }
  due.sort((left, right) => left.dueAt.localeCompare(right.dueAt));
  const scoped = due.slice(0, total);
  if (scoped.length === 0) return { claimed: [], skipped: [] };
  const result = deps.ledger.claimDueWork({
    ids: scoped.map((item) => item.id),
    claimedBy: input.claimedBy ?? "operator-sweep",
    nowIso: now,
  });
  return {
    claimed: result.claimed.map((item) => ({
      id: item.id,
      bookingId: item.bookingId,
      kind: item.kind,
      claimToken: item.claimToken,
      claimedAt: item.claimedAt,
      detail: item.detail as Record<string, unknown>,
    })),
    skipped: [...result.skippedIds],
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
 * ADR-010 dispatch revalidation: stale/failed intake sync blocks follow-up
 * progress. A sync that failed (or never succeeded) may have missed a
 * customer reply or opt-out, so resolving follow-up work as done on stale
 * evidence is refused: the item stays open for the owner instead.
 * Reads the durable intake batches/failures for this runtime's account.
 */
export function intakeSyncHealth(deps: OperatorRuntimeDeps): { healthy: boolean; reason: string } {
  const intake = new OperatorIntakeStore(deps.store.db);
  const failures = intake.listFailures(deps.accountId, 1);
  const latest = intake.latestBatch(deps.accountId);
  if (!latest) {
    return failures.length > 0
      ? { healthy: false, reason: `intake sync never succeeded and recorded failures: ${failures[0]?.message ?? "unknown"}` }
      : { healthy: true, reason: "no intake batches yet; nothing observed to go stale" };
  }
  if (latest.status === "failed") {
    return { healthy: false, reason: `latest intake batch ${latest.id} failed; sync is stale until a batch drains` };
  }
  const latestFailure = failures[0];
  if (latestFailure && latestFailure.at > latest.updatedAt) {
    return { healthy: false, reason: `intake failure after the last drained batch: ${latestFailure.message}` };
  }
  return { healthy: true, reason: `intake batch ${latest.id} ${latest.status}` };
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
  // 1. Still ours? Re-read the row: status, owner, fencing token, and a
  // live lease — an expired lease is never executed under, even with a
  // matching token.
  const current = readWaiting(deps, item.id);
  if (!current || current.status !== "claimed" || current.claimedBy !== claimedBy) {
    return "skipped";
  }
  if (current.claimToken === undefined || item.claimToken === undefined || current.claimToken !== item.claimToken) {
    return "skipped";
  }
  if (current.claimExpiresAt !== undefined) {
    const expiresMs = Date.parse(current.claimExpiresAt);
    const nowMs = Date.parse(nowIso(deps));
    if (!Number.isFinite(expiresMs) || !Number.isFinite(nowMs) || expiresMs <= nowMs) {
      return "skipped";
    }
  }
  // 2. Booking still runnable? Pause (or cancel) after the claim stops dispatch.
  if (controlState(deps, item.bookingId) !== null) {
    return "skipped";
  }
  // 2b. Durable opt-out suppresses followups: a customer who asked for no
  // further follow-ups never gets one from dispatch, even when due.
  if (current.kind === "followup" && deps.ledger.isOptedOut(item.bookingId)) {
    deps.ledger.resolveWaiting({ id: item.id, resolution: "suppressed", note: "operator dispatch: booking opted out of follow-ups", claimToken: item.claimToken });
    return "skipped";
  }
  // 3. Reply since claim? A customer reply between claim and dispatch
  // suppresses a FOLLOWUP instead of executing — and only a followup.
  // A reply does not answer a change review, deposit check, or resource
  // check: those kinds are never resolved away by inbound mail.
  if (current.kind === "followup" && replySince(deps, item.bookingId, current.claimedAt ?? current.updatedAt)) {
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
  // 5. Durable completion only: EVERY exact required executable step for
  // the current proposal version (hold AND email receipts under the stable
  // per-step keys) must be succeeded. Anything missing, pending, failed,
  // or still uncertain afterwards stays open — never resolved done.
  // Failed or never-run steps (which would send customer email on retry)
  // stay with the owner; only read-only reconciliation runs here.
  if (action.kind !== "create_provisional_hold") {
    return "awaitingOwner";
  }
  const holdKey = holdOperationKey(actionId, action.proposalVersion);
  const mailKey = emailOperationKey(actionId, action.proposalVersion);
  let progressed = false;
  for (const key of [holdKey, mailKey]) {
    const step = deps.store.getExecutionByIdempotencyKey(key);
    if (step && (step.status === "uncertain" || step.status === "partial")) {
      await reconcileExecution(deps.booking, step.id);
      progressed = true;
    }
  }
  const holdOk = deps.store.getExecutionByIdempotencyKey(holdKey)?.status === "succeeded";
  const mailOk = deps.store.getExecutionByIdempotencyKey(mailKey)?.status === "succeeded";
  if (holdOk && mailOk) {
    // 6. Stale sync blocks follow-up completion: intake may have missed a
    // reply or opt-out, so a followup is never resolved done on stale
    // evidence — it stays open for the owner instead.
    if (item.kind === "followup") {
      const sync = intakeSyncHealth(deps);
      if (!sync.healthy) return "awaitingOwner";
    }
    await resolveDone(deps, item);
    return "reconciled";
  }
  if (progressed) {
    return "reconciled";
  }
  return "awaitingOwner";
}

async function resolveDone(deps: OperatorRuntimeDeps, item: ClaimedWorkItem): Promise<void> {
  deps.ledger.resolveWaiting({ id: item.id, resolution: "done", note: "operator drain reconciled owner-approved work", claimToken: item.claimToken });
}

function readWaiting(deps: OperatorRuntimeDeps, id: string): {
  status: string;
  kind: string;
  claimedBy?: string;
  claimToken?: string;
  claimedAt?: string;
  claimExpiresAt?: string;
  updatedAt: string;
} | undefined {
  const found = deps.store.db.prepare("SELECT status, kind, claimed_by, claim_token, claimed_at, claim_expires_at, updated_at FROM coord_waiting WHERE id = $id").get({ $id: id });
  const value = rowOf(found);
  if (!value) return undefined;
  return {
    status: String(value.status),
    kind: String(value.kind),
    claimedBy: value.claimed_by ? String(value.claimed_by) : undefined,
    claimToken: value.claim_token ? String(value.claim_token) : undefined,
    claimedAt: value.claimed_at ? String(value.claimed_at) : undefined,
    claimExpiresAt: value.claim_expires_at ? String(value.claim_expires_at) : undefined,
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
  // Authoritative ledger receipt ordering: any non-stale reply received at
  // or after the claim fence suppresses. The >= fence is deliberate — a
  // reply sharing the claim's clock tick is still evidence the customer
  // answered, and suppressing is always the safe direction. Replies already
  // visible at claim time were handled by the ledger's claim-time recheck.
  const sinceMs = Date.parse(sinceIso);
  if (!Number.isFinite(sinceMs)) return false;
  const rows = deps.store.db.prepare(
    "SELECT received_at FROM coord_events WHERE booking_id = $booking AND kind = 'reply' AND stale = 0",
  ).all({ $booking: bookingId }) as unknown[];
  for (const entry of rows) {
    const received = rowOf(entry)?.received_at;
    if (typeof received === "string") {
      const ms = Date.parse(received);
      if (Number.isFinite(ms) && ms >= sinceMs) return true;
    }
  }
  return false;
}

/**
 * Host handoff: bind a waiting item to the exact proposal it refers to.
 * This is the ONLY supported producer of `detail.proposedActionId` — the
 * field the dispatch phase reads. The binding is validated here: the
 * waiting item must be open (pending or claimed), the action must exist,
 * belong to the SAME booking, and sit inside this runtime's business.
 * Existing detail fields are preserved; nothing else about the row
 * (status, claim, fencing) changes.
 */
export function bindWaitingToProposal(
  deps: OperatorRuntimeDeps,
  input: { waitingId: string; proposedActionId: string },
): { waitingId: string; proposedActionId: string } {
  const found = deps.store.db
    .prepare("SELECT id, booking_id, kind, status, detail_json FROM coord_waiting WHERE id = $id")
    .get({ $id: input.waitingId });
  const item = rowOf(found);
  if (!item) {
    throw new ServiceError("NOT_FOUND", `Waiting item not found: ${input.waitingId}`, false);
  }
  const status = String(item.status);
  if (status !== "pending" && status !== "claimed") {
    throw new ServiceError("INVALID_REQUEST", `Waiting ${input.waitingId} is ${status}; only open work can be bound to a proposal`, false);
  }
  let action;
  try {
    action = deps.store.getProposedAction(input.proposedActionId);
  } catch {
    throw new ServiceError("NOT_FOUND", `Proposed action not found: ${input.proposedActionId}`, false);
  }
  const bookingId = String(item.booking_id);
  if (action.bookingId !== bookingId) {
    throw new ServiceError("INVALID_REQUEST", `Action ${input.proposedActionId} belongs to booking ${action.bookingId}, not ${bookingId}`, false);
  }
  if (bookingBusiness(deps, bookingId) !== deps.businessId) {
    throw new ServiceError("INVALID_REQUEST", `Waiting ${input.waitingId} is outside business ${deps.businessId}`, false);
  }
  const prior = item.detail_json;
  const detail: Record<string, unknown> =
    typeof prior === "string" && prior.length > 0 ? (JSON.parse(prior) as Record<string, unknown>) : {};
  detail.proposedActionId = input.proposedActionId;
  deps.store.db
    .prepare("UPDATE coord_waiting SET detail_json = $detail, updated_at = $at WHERE id = $id")
    .run({ $detail: JSON.stringify(detail), $at: nowIso(deps), $id: input.waitingId });
  return { waitingId: input.waitingId, proposedActionId: input.proposedActionId };
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

export interface ResumeReconciliation {
  resumedWaitingIds: string[];
  reconciledExecutionIds: string[];
  stillUncertainExecutionIds: string[];
  /** Always false: resuming never refreshes a stale approval into a live one. */
  approvalsRefreshed: false;
  liveApprovalPresent: boolean;
  note: string;
}

/**
 * ADR-010 pause/takeover/resume with reconciliation (C07).
 *
 * Resume reopens paused waiting work through the attested owner control,
 * then reconciles external reality BEFORE new effects: every uncertain or
 * partial step on the booking's current proposal is reconciled against
 * provider truth (read-only; never a new write). Previously recorded
 * approvals are re-read, never refreshed — a stale approval stays stale and
 * the owner must re-approve the displayed proposal. Takeover (another owner
 * resuming) follows the same path: attestedBy names the resuming owner.
 */
export async function resumeAndReconcile(
  deps: OperatorRuntimeDeps,
  input: { bookingId: string; attestedBy: string; dedupeKey: string },
): Promise<ResumeReconciliation> {
  const control = deps.ledger.applyOwnerControl({
    dedupeKey: input.dedupeKey,
    kind: "resume",
    bookingId: input.bookingId,
    attestedBy: input.attestedBy,
  });
  const reconciledExecutionIds: string[] = [];
  const stillUncertainExecutionIds: string[] = [];
  try {
    const current = deps.store.getCurrentProposalAction(input.bookingId);
    if (current) {
      for (const execution of deps.store.listActionExecutions(current.id)) {
        if (execution.status !== "uncertain" && execution.status !== "partial") continue;
        try {
          await reconcileExecution(deps.booking, execution.id);
          reconciledExecutionIds.push(execution.id);
        } catch {
          stillUncertainExecutionIds.push(execution.id);
        }
      }
    }
  } catch {
    // No current proposal: nothing to reconcile; resume still stands.
  }
  let liveApprovalPresent = false;
  try {
    const current = deps.store.getCurrentProposalAction(input.bookingId);
    if (current) {
      liveApprovalPresent = deps.store.listApprovals(current.id).some(
        (approval) =>
          approval.status === "approved" &&
          approval.proposalVersion === current.proposalVersion &&
          approval.proposalFingerprint === current.proposalFingerprint,
      );
    }
  } catch {
    liveApprovalPresent = false;
  }
  return {
    resumedWaitingIds: control.resumedWaitingIds,
    reconciledExecutionIds,
    stillUncertainExecutionIds,
    approvalsRefreshed: false,
    liveApprovalPresent,
    note: "Resume reconciled provider effects before new work; stale approvals were not refreshed — re-approve the displayed proposal.",
  };
}
