import type { SourceReference } from "../../domain/contracts.ts";

/**
 * Live-model journey contracts. The journey binds ONE business and ONE
 * verified account for a single run: designated Gmail thread (inquiry),
 * designated Drive file (venue policy), and one owner-chosen calendar.
 * Every tool result carries explicit provenance with scoped ids; runtime
 * or core monitors alone never qualify as sources.
 *
 * Authority boundary (structural, not prompted):
 * - The model can READ via the four tools below and propose exact terms.
 * - The model cannot approve (no approve tool exists), cannot override
 *   venue policy (violations reject before any row is written), and cannot
 *   claim receipts (payloads carry evidence only; receipts are minted by
 *   provider dispatch after owner approval through the existing UI).
 * - Nothing is sent and no live data is read until the live gate passes:
 *   designated account + controlled recipient (Chief, pending) + explicit
 *   opt-in. Scripted verification runs with `mode: "scripted"` and is
 *   labeled simulated end to end.
 */

export type LiveToolName = "readInquiry" | "readVenuePolicy" | "checkAvailability" | "prepareProposal";

export interface LiveRunInput {
  businessId: string;
  /** Designated Gmail thread id (the inquiry). Never a search, never "recent". */
  threadId: string;
  /** Designated Drive file id (the venue policy). Never a listing. */
  fileId: string;
  /** Owner-chosen calendar id (must already be bound via setup). */
  calendarId: string;
  /**
   * Execution mode. "scripted" serves injected fictional ports for
   * verification; "live" requires the live gate (designated connected
   * account + Chief-assigned controlled recipient + explicit opt-in).
   */
  mode: "scripted" | "live";
  /** Explicit live opt-in; ignored unless mode is "live". */
  allowLive?: boolean;
  /** Stable caller key for run idempotency. */
  idempotencyKey?: string;
}

export interface ToolProvenance {
  tool: LiveToolName;
  runId: string;
  businessId: string;
  accountId: string;
  source: SourceReference;
  at: string;
}

export interface InquiryTerms {
  threadId: string;
  subject: string;
  body: string;
  provenance: ToolProvenance;
}

export interface VenuePolicy {
  fileId: string;
  text: string;
  /** Normalized by the tool from the policy text it actually read. */
  perPersonGbp: number;
  capacitySeated: number;
  currency: string;
  provenance: ToolProvenance;
}

export interface AvailabilityAttestation {
  calendarId: string;
  startAt: string;
  endAt: string;
  free: boolean;
  provenance: ToolProvenance;
}

export interface ProposalTerms {
  startAt: string;
  endAt: string;
  guestCount: number;
  perPersonGbp: number;
  totalGbp: number;
  notes: string;
}

export interface PreparedProposal {
  bookingId: string;
  proposedActionId: string;
  terms: ProposalTerms;
  evidence: SourceReference[];
  provenance: ToolProvenance;
}

export type LiveRunStatus = "ok" | "error" | "continuing" | "running";

export interface LiveRunStep {
  tool: LiveToolName;
  ok: boolean;
  at: string;
  error?: string;
  provenance?: ToolProvenance;
}

export interface LiveRunRecord {
  runId: string;
  businessId: string;
  accountId: string;
  /** The submitted remote run identity, when one exists — preserved so a
   * continuing live run is never re-submitted as a duplicate. */
  gatewayRunId?: string;
  /** Designated inputs this run was claimed for; resubmits must match exactly. */
  designation: { threadId: string; fileId: string; calendarId: string };
  mode: "scripted" | "live";
  simulated: boolean;
  status: LiveRunStatus;
  steps: LiveRunStep[];
  proposal?: PreparedProposal;
  error?: string;
  startedAt: string;
  finishedAt: string;
}

export class LiveModelError extends Error {
  readonly code:
    | "MODEL_UNCONFIGURED"
    | "LIVE_NOT_AUTHORIZED"
    | "INVALID_REQUEST"
    | "TOOL_FAILURE"
    | "POLICY_VIOLATION";
  readonly retryable = false;
  constructor(
    code: LiveModelError["code"],
    message: string,
  ) {
    super(message);
    this.code = code;
  }
}
