import type { GmailInboxPoller } from "../../connectors/google/incremental.ts";
import type { BookingServiceDeps } from "../booking-service.ts";
import type { CoordinationLedger } from "../../coordination/ledger.ts";
import type { GatherStore } from "../sqlite-store.ts";

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

/** Injected Gmail history poller, pre-bound to one stable accountId. */
export type InboxPort = Pick<GmailInboxPoller, "pollInbox">;

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
   * Host-declared wiring mode: true while the inbox poller/transport is a
   * stand-in (scripted/demo), false only for approved live assets. Echoed
   * on every sweep and health report — simulated runs never claim live.
   */
  simulation: boolean;
}

export type IntakeItemStatus =
  | "received"
  | "linked"
  | "needs_decision"
  | "ingested"
  | "failed";

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
  error?: string;
}

export interface DueWorkReport {
  simulation: boolean;
  claimed: string[];
  skipped: string[];
  retried: string[];
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
}

export interface OperatorHealth {
  simulation: boolean;
  generatedAt: string;
  accounts: OperatorAccountHealth[];
  waitingByStatus: Record<string, number>;
  pausedBookings: string[];
  failures: Array<{ scope: string; message: string; at: string }>;
  lastSweep?: SweepReport;
  lastDueWork?: DueWorkReport;
}
