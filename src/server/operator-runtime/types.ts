import type { GmailInboxPoller } from "../../connectors/google/incremental.ts";
import type { BookingServiceDeps } from "../booking-service.ts";
import type { CoordinationLedger } from "../../coordination/ledger.ts";
import type { GatherStore } from "../sqlite-store.ts";
import type { BoundSourcePort } from "../sources/types.ts";

/**
 * Operator-runtime boundary types.
 *
 * Gather owns business-specific durable intake (raw batches, per-item
 * evidence, per-account cursor checkpoints) on the SAME SQLite database —
 * no second database. The runtime owns scheduling and merely calls
 * `runOperatorSweep`; it never interprets intake. Ledger and identity own
 * their own BEGIN transactions, so this layer never nests them: it
 * persists a raw batch atomically, drains items through ledger/identity/
 * guarded booking calls (each own-transactional and idempotent), and only
 * then commits the cursor checkpoint.
 */

/**
 * Injected Gmail history poller, pre-bound to one stable accountId.
 * Provenance is bound to the wiring (not a per-request caller boolean):
 * scripted/demo stand-ins declare simulated:true here, live wiring declares
 * the approved provider source. Sweeps additionally cross-check the poll
 * result metadata mode and report simulated when either side says so.
 */
export interface InboxPort extends Pick<GmailInboxPoller, "pollInbox"> {
  readonly provenance: { simulated: boolean; label: string };
}

export interface ConnectionDirectoryPort {
  /** Resolve a stable accountId to its connection record, if the connections lane knows it. */
  getConnection(accountId: string): { provider: string; status: string; businessId: string } | undefined;
}

export interface OperatorRuntimeDeps {
  store: GatherStore;
  ledger: CoordinationLedger;
  inbox: InboxPort;
  booking: BookingServiceDeps;
  /** Stable account identity polled by this runtime (never a userId alias). */
  accountId: string;
  businessId: string;
  now?: () => string;
  connections?: ConnectionDirectoryPort;
  /**
   * ADR-007 progressive source pipeline, pre-bound to this account's
   * server-derived scope (like the inbox poller). Absent → source
   * scan/coverage routes report not-configured rather than fabricating one.
   */
  sources?: BoundSourcePort;
}

export type IntakeItemStatus =
  | "received"
  | "linked"
  | "needs_decision"
  | "ingested"
  | "failed"
  | "skipped";

export interface IntakeBatchRecord {
  id: string;
  accountId: string;
  providerHistoryId?: string;
  nextCursor?: string;
  itemCount: number;
  status: "received" | "drained" | "failed";
  simulation: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface IntakeItemRecord {
  id: string;
  batchId: string;
  messageId: string;
  threadId?: string;
  observedAt: string;
  status: IntakeItemStatus;
  bookingId?: string;
  sourceKey?: string;
  ledgerEventId?: string;
  error?: string;
  /** Processing attempts so far (drives the bounded retry budget). */
  attempts: number;
  /** Dead-lettered: terminally failed, never auto-retried, visible to the owner. */
  dead: boolean;
}

export interface CursorCheckpoint {
  accountId: string;
  cursor: string;
  providerHistoryId?: string;
  updatedAt: string;
}

export interface SweepReport {
  simulation: boolean;
  accountId: string;
  batchId?: string;
  polled: number;
  persisted: number;
  drained: number;
  duplicates: number;
  needsDecision: string[];
  cursorCommitted: boolean;
  resetRequired: boolean;
  /**
   * Re-driven parked work this sweep (crash-stranded, owner-resolved, or
   * retried failures). Parked outcomes never gate the cursor: the cursor
   * is the durable capture watermark, not the processing outcome.
   */
  resumedDrained: number;
  resumedFailed: number;
  /** Items moved to the dead-letter state this sweep (terminal, owner-visible). */
  deadLettered: string[];
  error?: string;
}

export interface DueWorkReport {
  simulation: boolean;
  claimed: string[];
  skipped: string[];
  reconciled: string[];
  awaitingOwner: string[];
  error?: string;
}

export interface OperatorAccountHealth {
  accountId: string;
  cursorCommitted: boolean;
  lastSweepAt?: string;
  lastError?: string;
  connectionStatus?: string;
  /** Terminal intake failures awaiting owner attention (never auto-retried). */
  deadLettered: number;
}

export interface OperatorHealth {
  simulation: boolean;
  generatedAt: string;
  accounts: OperatorAccountHealth[];
  waitingByStatus: Record<string, number>;
  pausedBookings: string[];
  failures: Array<{ scope: string; message: string; at: string }>;
  /** Scheduler registration is explicit: no fake scheduled/watching label. */
  scheduler: { registered: boolean; status: string };
  lastSweep?: SweepReport;
  lastDueWork?: DueWorkReport;
}
