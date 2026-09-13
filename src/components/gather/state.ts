import type { ActionReceipt, BookingSummary, Proposal } from './types';

/**
 * Recover the selected booking when the bookings list changes.
 * Keeps the current selection while its id still exists (preserving context
 * across refreshes), falls back to the first booking when it disappears, and
 * returns undefined when the list is empty.
 */
export function resolveSelectedBookingId(
  bookings: readonly Pick<BookingSummary, 'id'>[],
  currentId: string | undefined,
): string | undefined {
  if (currentId !== undefined && bookings.some((booking) => booking.id === currentId)) {
    return currentId;
  }
  return bookings[0]?.id;
}

/**
 * An approval is in flight when the host reports the proposal fingerprint as
 * pending, or when any receipt for this booking is still pending. Either way
 * the approve control must stay disabled so the same version cannot be
 * approved twice.
 */
export function isApprovalInFlight(
  proposal: Pick<Proposal, 'fingerprint'>,
  pendingFingerprints: readonly string[] | undefined,
  receipts: readonly ActionReceipt[] | undefined,
): boolean {
  if (pendingFingerprints?.includes(proposal.fingerprint)) return true;
  return receipts?.some((receipt) => receipt.status === 'pending') ?? false;
}

/**
 * Whether the exact displayed proposal version has fully executed. Completion
 * requires a succeeded receipt for EVERY required executable step the host
 * contract declares (`proposal.requiredSteps`), each scoped to this action id
 * + version — a proposal whose email step never ran must not read as approved
 * just because the hold receipt succeeded. Receipts must carry the exact
 * proposal version: a versionless receipt cannot complete any version. A
 * proposal with no declared required steps can never prove completeness, so
 * it never shows a completed state. Pending, failed, partial, or uncertain
 * receipts keep their recovery paths instead of reading as "approved", and a
 * newer proposal (new action id or version) has no scoped receipts and stays
 * approvable.
 */
export function proposalApprovalComplete(
  proposal: Pick<Proposal, 'id' | 'version' | 'requiredSteps'>,
  receipts: readonly ActionReceipt[] | undefined,
): boolean {
  const required = proposal.requiredSteps;
  if (required === undefined || required.length === 0) return false;
  const scoped = (receipts ?? []).filter(
    (receipt) =>
      receipt.actionId === proposal.id &&
      receipt.proposalVersion === proposal.version,
  );
  if (scoped.length === 0 || !scoped.every((receipt) => receipt.status === 'succeeded')) {
    return false;
  }
  return required.every((step) => scoped.some((receipt) => receipt.step === step));
}

/**
 * Recovery routing for a receipt. `uncertain` always reconciles first — an
 * explicit `recovery: 'retry'` declaration cannot skip verifying whether the
 * execution already applied. For other statuses an explicit declaration wins;
 * defaults are `failed` retries the action while `partial` reconciles first —
 * an aggregate partial never lets the UI infer a definitive failed step.
 * Succeeded and pending receipts expose no recovery.
 */
export function receiptRecoveryKind(
  receipt: Pick<ActionReceipt, 'status' | 'recoveryLabel' | 'recovery' | 'executionId'>,
): 'retry' | 'reconcile' | undefined {
  if (!receipt.recoveryLabel) return undefined;
  // Uncertain always reconciles first — even a mistaken 'retry' declaration
  // cannot skip verifying whether the execution already applied.
  if (receipt.status === 'uncertain') {
    return receipt.executionId ? 'reconcile' : undefined;
  }
  if (receipt.recovery === 'retry') return 'retry';
  if (receipt.recovery === 'reconcile') return receipt.executionId ? 'reconcile' : undefined;
  if (receipt.status === 'partial') return receipt.executionId ? 'reconcile' : undefined;
  if (receipt.status === 'failed') return 'retry';
  return undefined;
}
