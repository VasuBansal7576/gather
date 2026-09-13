import type { ProposalIdentity } from "./contracts.ts";

/**
 * Delivery page lifecycle guard.
 *
 * The page has three independent lifecycles that must never share one
 * generation counter:
 *
 * - load generation: explicit reloads / booking navigation / mount refresh.
 * - confirm operation lifecycle: one confirm attempt from click to settle.
 * - record-handoff operation lifecycle: one record attempt to settle.
 *
 * Booking identity is a separate guard: work captured for booking A must
 * never commit success/error/busy changes to booking B, even if its
 * generation number happens to match.
 *
 * The bug this replaces: onConfirm/onRecordHandoff shared a single
 * RequestEpoch with load(). Success awaited load() (which bumped the same
 * epoch), so the operation's own finally check `isCurrent(originalRun)`
 * always failed and busy stayed true forever; load() also cleared the
 * just-set confirm result.
 */
export class DeliveryPageLifecycle {
  private loadGen = 0;
  private confirmGen = 0;
  private recordGen = 0;
  private activeBooking: string | null = null;
  private mounted = true;

  /** Mark the component mounted (StrictMode remount support). */
  mount(): void {
    this.mounted = true;
  }

  /** Mark unmounted: every pending commit becomes stale. */
  unmount(): void {
    this.mounted = false;
  }

  isMounted(): boolean {
    return this.mounted;
  }

  /** Latest booking this instance has bound to (null before first bind). */
  currentBooking(): string | null {
    return this.activeBooking;
  }

  private bind(bookingId: string): void {
    this.activeBooking = bookingId;
  }

  /** Start a load for bookingId. Returns its generation. */
  beginLoad(bookingId: string): number {
    this.bind(bookingId);
    this.loadGen += 1;
    return this.loadGen;
  }

  /** True when a load commit may still touch state. */
  isLoadCurrent(bookingId: string, gen: number): boolean {
    return this.mounted && this.activeBooking === bookingId && gen === this.loadGen;
  }

  /** Start a confirm operation for bookingId. Returns its generation. */
  beginConfirm(bookingId: string): number {
    this.bind(bookingId);
    this.confirmGen += 1;
    return this.confirmGen;
  }

  /** True when a confirm commit (success/error/finally) may still run. */
  isConfirmCurrent(bookingId: string, gen: number): boolean {
    return this.mounted && this.activeBooking === bookingId && gen === this.confirmGen;
  }

  /** Start a record-handoff operation for bookingId. */
  beginRecord(bookingId: string): number {
    this.bind(bookingId);
    this.recordGen += 1;
    return this.recordGen;
  }

  /** True when a record-handoff commit may still run. */
  isRecordCurrent(bookingId: string, gen: number): boolean {
    return this.mounted && this.activeBooking === bookingId && gen === this.recordGen;
  }

  /**
   * Rebind when the route booking changes. Stale generations for the
   * previous booking fail their booking check even without a bump, but
   * bumping as well makes reuse of a bare counter impossible.
   * Returns true when the booking actually changed.
   */
  rebindBooking(bookingId: string): boolean {
    if (this.activeBooking === bookingId) return false;
    const firstBind = this.activeBooking === null;
    this.activeBooking = bookingId;
    if (!firstBind) {
      this.loadGen += 1;
      this.confirmGen += 1;
      this.recordGen += 1;
    }
    return true;
  }
}

/** Stable key for the exact proposal the confirm panel addresses. */
export function proposalKey(identity: ProposalIdentity | undefined): string {
  if (!identity) return "";
  return `${identity.proposedActionId}@v${identity.proposalVersion}#${identity.proposalFingerprint}`;
}

/**
 * True when a stored command result still addresses the current proposal.
 * A result is only useful after refresh while the booking is the same AND
 * the exact proposal identity is unchanged; a new proposal version,
 * fingerprint, or action means the next confirm needs fresh exact checks.
 */
export function confirmResultStillCurrent(
  currentBookingId: string,
  resultBookingId: string,
  currentIdentityKey: string,
  resultIdentityKey: string,
): boolean {
  if (currentBookingId !== resultBookingId) return false;
  if (currentIdentityKey.length === 0 || resultIdentityKey.length === 0) return false;
  return currentIdentityKey === resultIdentityKey;
}
