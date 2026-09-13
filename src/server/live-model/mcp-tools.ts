import { z } from "zod";
import type { CalendarConnector, DocumentRetriever, InquiryThreadReader } from "../../connectors/contracts.ts";
import type { GatherStore } from "../sqlite-store.ts";
import { defineGatherTool, type GatherTool, type GatherToolExecution, type GatherToolResult } from "../../runtime/mcp.ts";
import { createLiveTools } from "./tools.ts";
import type { AvailabilityAttestation, InquiryTerms, VenuePolicy } from "./types.ts";
import { LiveModelError } from "./types.ts";

/**
 * The four bound Gather MCP tools. Identity (business, account, thread,
 * file, calendar, recipient) comes ONLY from the server-side run scope —
 * tool arguments carry non-identity content alone, so a model can neither
 * forge provenance nor redirect sources or recipients. Every invocation
 * appends to the scope audit (the durable tool-call audit); source
 * objects stay server-side in same-run state, and prepareProposal
 * consumes that state rather than any model-supplied evidence.
 */

export interface LiveMcpAuditEntry {
  tool: string;
  at: string;
  ok: boolean;
  error?: string;
}

export interface LiveMcpScope {
  store: GatherStore;
  businessId: string;
  accountId: string;
  runId: string;
  threadId: string;
  fileId: string;
  calendarId: string;
  recipient: string;
  threads: InquiryThreadReader;
  documents: DocumentRetriever;
  calendar: CalendarConnector;
  execution: GatherToolExecution;
  now?: () => string;
  audit: (entry: LiveMcpAuditEntry) => void;
  state: {
    inquiry?: InquiryTerms;
    policy?: VenuePolicy;
    availability?: AvailabilityAttestation;
  };
}

function at(scope: LiveMcpScope): string {
  return scope.now ? scope.now() : new Date().toISOString();
}

function ok(text: string, structured: Record<string, unknown>): GatherToolResult {
  return { content: [{ type: "text", text }], structuredContent: { ...structured, "gather:authority": "advisory" } };
}

function toolError(tool: string, message: string): GatherToolResult {
  return { content: [{ type: "text", text: `${tool} refused: ${message}` }], isError: true };
}

export function createLiveMcpTools(scope: LiveMcpScope): GatherTool[] {
  const tools = createLiveTools({
    store: scope.store,
    businessId: scope.businessId,
    accountId: scope.accountId,
    runId: scope.runId,
    threads: scope.threads,
    documents: scope.documents,
    calendar: scope.calendar,
    calendarId: scope.calendarId,
    recipient: scope.recipient,
    ...(scope.now === undefined ? {} : { now: scope.now }),
  });
  const record = (tool: string, ok: boolean, error?: string): void => {
    scope.audit({ tool, at: at(scope), ok, ...(error === undefined ? {} : { error }) });
  };

  return [
    defineGatherTool({
      name: "gather.read_inquiry",
      description: "Read the run-designated Gmail inquiry thread. Takes no source arguments; identity is server-bound.",
      inputSchema: {},
      execution: scope.execution,
      handler: async () => {
        try {
          const inquiry = await tools.readInquiry({ threadId: scope.threadId });
          scope.state.inquiry = inquiry;
          record("gather.read_inquiry", true);
          return ok(`Inquiry ${inquiry.threadId}: ${inquiry.subject}`, {
            threadId: inquiry.threadId,
            subject: inquiry.subject,
            body: inquiry.body,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          record("gather.read_inquiry", false, message);
          return toolError("gather.read_inquiry", message);
        }
      },
    }),
    defineGatherTool({
      name: "gather.read_venue_policy",
      description: "Read the run-designated Drive venue-policy file. Takes no source arguments; identity is server-bound.",
      inputSchema: {},
      execution: scope.execution,
      handler: async () => {
        try {
          const policy = await tools.readVenuePolicy({ fileId: scope.fileId });
          scope.state.policy = policy;
          record("gather.read_venue_policy", true);
          return ok(`Venue policy ${policy.fileId}: GBP ${policy.perPersonGbp}/person, ${policy.capacitySeated} seated`, {
            fileId: policy.fileId,
            text: policy.text,
            perPersonGbp: policy.perPersonGbp,
            capacitySeated: policy.capacitySeated,
            currency: policy.currency,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          record("gather.read_venue_policy", false, message);
          return toolError("gather.read_venue_policy", message);
        }
      },
    }),
    defineGatherTool({
      name: "gather.check_availability",
      description: "Check the run-designated calendar for a slot. The calendar is server-bound; only the slot is argued.",
      inputSchema: { startAt: z.string(), endAt: z.string() },
      execution: scope.execution,
      handler: async (args: { startAt: string; endAt: string }) => {
        try {
          const availability = await tools.checkAvailability({ startAt: args.startAt, endAt: args.endAt });
          scope.state.availability = availability;
          record("gather.check_availability", true);
          return ok(`Slot ${availability.startAt}/${availability.endAt} free: ${availability.free}`, {
            calendarId: availability.calendarId,
            startAt: availability.startAt,
            endAt: availability.endAt,
            free: availability.free,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          record("gather.check_availability", false, message);
          return toolError("gather.check_availability", message);
        }
      },
    }),
    defineGatherTool({
      name: "gather.prepare_proposal",
      description: "Prepare a source-linked booking proposal from same-run evidence. Price is server-computed from policy; recipient is server-bound. Never approves, sends, or receipts.",
      inputSchema: { startAt: z.string(), endAt: z.string(), guestCount: z.number().int(), notes: z.string() },
      execution: scope.execution,
      handler: async (args: { startAt: string; endAt: string; guestCount: number; notes: string }) => {
        try {
          const { inquiry, policy, availability } = scope.state;
          if (!inquiry || !policy || !availability) {
            throw new LiveModelError("POLICY_VIOLATION", "prepare requires same-run inquiry, policy, and availability reads first; model-supplied evidence is never accepted");
          }
          const proposal = await tools.prepareProposal({
            inquiry,
            policy,
            availability,
            terms: {
              startAt: args.startAt,
              endAt: args.endAt,
              guestCount: args.guestCount,
              perPersonGbp: policy.perPersonGbp,
              totalGbp: args.guestCount * policy.perPersonGbp,
              notes: args.notes,
            },
          });
          record("gather.prepare_proposal", true);
          return ok(`Proposal ${proposal.proposedActionId}: GBP ${proposal.terms.totalGbp} (pending owner approval; no receipt)`, {
            bookingId: proposal.bookingId,
            proposedActionId: proposal.proposedActionId,
            terms: proposal.terms,
            evidence: proposal.evidence,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          record("gather.prepare_proposal", false, message);
          return toolError("gather.prepare_proposal", message);
        }
      },
    }),
  ];
}
