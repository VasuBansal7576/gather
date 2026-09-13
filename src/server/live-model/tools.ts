import type { CalendarConnector, DocumentRetriever, InquiryThreadReader } from "../../connectors/contracts.ts";
import type { GatherStore } from "../sqlite-store.ts";
import type {
  AvailabilityAttestation,
  InquiryTerms,
  PreparedProposal,
  ProposalTerms,
  ToolProvenance,
  VenuePolicy,
} from "./types.ts";
import { LiveModelError } from "./types.ts";

/**
 * The four narrowly bound live tools. Each tool reads exactly one
 * designated source through already-resolved provider ports and stamps
 * every result with run-scoped provenance. There is deliberately no
 * approve/send/claim tool: the model plans reads and exact terms, the
 * owner approves actual writes through the existing UI, and receipts
 * come only from provider dispatch afterwards.
 */

export interface LiveToolPorts {
  store: GatherStore;
  businessId: string;
  accountId: string;
  runId: string;
  threads: InquiryThreadReader;
  documents: DocumentRetriever;
  calendar: CalendarConnector;
  calendarId: string;
  /** Server-side controlled recipient (never a model argument). */
  recipient: string;
  now?: () => string;
}

function stamp(ports: LiveToolPorts, tool: ToolProvenance["tool"], source: ToolProvenance["source"]): ToolProvenance {
  return {
    tool,
    runId: ports.runId,
    businessId: ports.businessId,
    accountId: ports.accountId,
    source,
    at: ports.now ? ports.now() : new Date().toISOString(),
  };
}

function fail(tool: string, message: string): never {
  throw new LiveModelError("TOOL_FAILURE", `${tool} failed: ${message}`);
}

/**
 * Reviewable hold window: a GATHER TEST offer holds the slot for at most 24
 * hours and offer validity ends no later than one hour before the event
 * starts; no automatic provider release is implied.
 */
const HOLD_VALIDITY_MS = 24 * 60 * 60 * 1000;
const HOLD_RELEASE_BUFFER_MS = 60 * 60 * 1000;

/** Human-readable local time in the business timezone (never raw UTC ISO). */
function formatLocal(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: timezone,
  }).format(new Date(iso));
}

/**
 * The exact body the approval pipeline sends on owner approval: a real
 * offer, not a placeholder: the exact window rendered in the business
 * timezone, guest count, exact GBP terms, the offer validity, and explicit
 * provisional terms. It promises no automatic slot release (none is wired)
 * and never implies venue approval alone confirms a booking.
 */
function renderOfferBody(terms: ProposalTerms, policy: { perPersonGbp: number; currency: string }, timezone: string, expiresAt: string): string {
  return [
    "GATHER TEST: provisional event offer",
    "",
    `Event window: ${formatLocal(terms.startAt, timezone)} to ${formatLocal(terms.endAt, timezone)} (${timezone})`,
    `Guests: ${terms.guestCount}`,
    `Total: ${policy.currency} ${terms.totalGbp} (${policy.currency} ${policy.perPersonGbp} per person)`,
    `Offer validity: this provisional offer is valid until ${formatLocal(expiresAt, timezone)} (${timezone}).`,
    `Notes: ${terms.notes}`,
    "",
    "This is a provisional offer only. It becomes a confirmed booking only after all of the following: the customer accepts the exact date, time, guest count and price above; the venue approves; and the reservation is verified in the provider system of record. Venue approval alone does not confirm a booking.",
  ].join("\n");
}

export interface LiveTools {
  readInquiry(input: { threadId: string }): Promise<InquiryTerms>;
  readVenuePolicy(input: { fileId: string }): Promise<VenuePolicy>;
  checkAvailability(input: { startAt: string; endAt: string }): Promise<AvailabilityAttestation>;
  prepareProposal(input: {
    inquiry: InquiryTerms;
    policy: VenuePolicy;
    availability: AvailabilityAttestation;
    terms: ProposalTerms;
  }): Promise<PreparedProposal>;
}

export function createLiveTools(ports: LiveToolPorts): LiveTools {
  if (!ports.recipient || !ports.recipient.trim()) {
    throw new LiveModelError("INVALID_REQUEST", "live tools require a server-side controlled recipient");
  }
  const opKey = (tool: string): string => `live-model:${ports.runId}:${tool}`;
  const sameRun = (provenance: ToolProvenance, tool: string): void => {
    if (provenance.runId !== ports.runId || provenance.businessId !== ports.businessId || provenance.accountId !== ports.accountId) {
      throw new LiveModelError("POLICY_VIOLATION", `${tool} rejected evidence from another run/scope; re-read within this run`);
    }
  };

  return {
    async readInquiry(input: { threadId: string }): Promise<InquiryTerms> {
      if (!input.threadId || !input.threadId.trim()) throw new LiveModelError("INVALID_REQUEST", "readInquiry requires a designated threadId");
      const result = await ports.threads.readInquiryThread({ operationKey: opKey("readInquiry"), threadId: input.threadId.trim() });
      if (result.status !== "succeeded") fail("readInquiry", result.error.message);
      const thread = result.data.thread;
      const body = thread.messages.map((message) => message.body).join("\n---\n");
      return {
        threadId: thread.threadId,
        subject: thread.subject,
        body,
        provenance: stamp(ports, "readInquiry", {
          kind: "email",
          locator: `gmail://thread/${thread.threadId}`,
          label: `Gmail thread ${thread.threadId} (account ${ports.accountId})`,
        }),
      };
    },

    async readVenuePolicy(input: { fileId: string }): Promise<VenuePolicy> {
      if (!input.fileId || !input.fileId.trim()) throw new LiveModelError("INVALID_REQUEST", "readVenuePolicy requires a designated fileId");
      const result = await ports.documents.retrieveDocument({ operationKey: opKey("readVenuePolicy"), documentId: input.fileId.trim() });
      if (result.status !== "succeeded") fail("readVenuePolicy", result.error.message);
      const text = result.data.document.text;
      const policy = { ...parseVenuePolicy(text, input.fileId.trim()) };
      return {
        fileId: result.data.document.documentId,
        text,
        ...policy,
        provenance: stamp(ports, "readVenuePolicy", {
          kind: "document",
          locator: `drive://file/${result.data.document.documentId}`,
          label: `Drive file ${result.data.document.title} (account ${ports.accountId})`,
        }),
      };
    },

    async checkAvailability(input: { startAt: string; endAt: string }): Promise<AvailabilityAttestation> {
      if (!input.startAt || !input.endAt) throw new LiveModelError("INVALID_REQUEST", "checkAvailability requires startAt and endAt");
      const result = await ports.calendar.checkAvailability({
        operationKey: opKey("checkAvailability"),
        calendarId: ports.calendarId,
        startAt: input.startAt,
        endAt: input.endAt,
      });
      if (result.status !== "succeeded") fail("checkAvailability", result.error.message);
      const busy = result.data.slots.some((slot) => slot.available === false && slot.startAt < input.endAt && input.startAt < slot.endAt);
      return {
        calendarId: ports.calendarId,
        startAt: input.startAt,
        endAt: input.endAt,
        free: !busy,
        provenance: stamp(ports, "checkAvailability", {
          kind: "calendar",
          locator: `calendar://${ports.calendarId}`,
          label: `Availability ${input.startAt}/${input.endAt} on calendar ${ports.calendarId}`,
        }),
      };
    },

    async prepareProposal(input: {
      inquiry: InquiryTerms;
      policy: VenuePolicy;
      availability: AvailabilityAttestation;
      terms: ProposalTerms;
    }): Promise<PreparedProposal> {
      sameRun(input.inquiry.provenance, "prepareProposal");
      sameRun(input.policy.provenance, "prepareProposal");
      sameRun(input.availability.provenance, "prepareProposal");
      const { terms } = input;
      // Policy is law, not suggestion: exact arithmetic, capacity, and a
      // free slot attested in THIS run — anything else rejects before any
      // row is written. No discounts, no overrides, no approximations.
      if (!Number.isInteger(terms.guestCount) || terms.guestCount <= 0) {
        throw new LiveModelError("POLICY_VIOLATION", "guest count must be a positive integer");
      }
      if (terms.guestCount > input.policy.capacitySeated) {
        throw new LiveModelError("POLICY_VIOLATION", `guest count ${terms.guestCount} exceeds venue capacity ${input.policy.capacitySeated}`);
      }
      const exactTotal = terms.guestCount * input.policy.perPersonGbp;
      if (terms.totalGbp !== exactTotal || terms.perPersonGbp !== input.policy.perPersonGbp) {
        throw new LiveModelError(
          "POLICY_VIOLATION",
          `price must be exactly ${terms.guestCount} x GBP ${input.policy.perPersonGbp} = GBP ${exactTotal}; got GBP ${terms.totalGbp} at GBP ${terms.perPersonGbp}`,
        );
      }
      if (terms.startAt !== input.availability.startAt || terms.endAt !== input.availability.endAt) {
        throw new LiveModelError("POLICY_VIOLATION", "proposal slot must equal the attested availability slot");
      }
      if (!input.availability.free) {
        throw new LiveModelError("POLICY_VIOLATION", "attested slot is not free; no proposal prepared");
      }
      if (input.availability.calendarId !== ports.calendarId) {
        throw new LiveModelError("POLICY_VIOLATION", "availability attestation names a different calendar");
      }
      const evidence = [input.inquiry.provenance.source, input.policy.provenance.source, input.availability.provenance.source];
      // Hold validity is server-computed, never a model term: the provisional
      // hold expires at the earlier of 24h from now or one hour before the
      // event starts — always in the future, always before the event, and
      // explicit in the fingerprinted payload so the owner reviews it.
      const nowMs = Date.parse(ports.now ? ports.now() : new Date().toISOString());
      const expiresMs = Math.min(nowMs + HOLD_VALIDITY_MS, Date.parse(terms.startAt) - HOLD_RELEASE_BUFFER_MS);
      if (!Number.isFinite(expiresMs) || expiresMs <= nowMs) {
        throw new LiveModelError("POLICY_VIOLATION", "the attested slot starts too soon to hold provisionally; no proposal prepared");
      }
      const expiresAt = new Date(expiresMs).toISOString();
      const business = ports.store.getBusiness(ports.businessId);
      const emailBody = renderOfferBody(terms, input.policy, business.timezone, expiresAt);
      const booking = ports.store.createBooking({
        businessId: ports.businessId,
        eventName: `GATHER TEST proposal: ${terms.guestCount} guests ${terms.startAt}`,
        status: "inquiry",
        startAt: terms.startAt,
        endAt: terms.endAt,
        guestCount: terms.guestCount,
        notes: `GATHER TEST. ${terms.notes}`,
        sourceReferences: evidence,
      });
      // The approval pipeline executes exactly one plan: provisional hold +
      // offer email (kind "create_provisional_hold"). Every executable field
      // is explicit in the fingerprinted payload — no derived defaults.
      const action = ports.store.createProposedAction({
        bookingId: booking.id,
        kind: "create_provisional_hold",
        payload: {
          startAt: terms.startAt,
          endAt: terms.endAt,
          expiresAt,
          calendarId: ports.calendarId,
          guestCount: terms.guestCount,
          perPersonGbp: terms.perPersonGbp,
          totalGbp: terms.totalGbp,
          currency: input.policy.currency,
          emailTo: [ports.recipient],
          emailSubject: `GATHER TEST provisional offer: ${terms.guestCount} guests ${terms.startAt}`,
          emailBody,
          controlledRecipient: ports.recipient,
          evidence: evidence.map((source) => ({ kind: source.kind, locator: source.locator, label: source.label })),
        },
        sourceReferences: evidence,
      });
      return {
        bookingId: booking.id,
        proposedActionId: action.id,
        terms,
        evidence,
        provenance: stamp(ports, "prepareProposal", {
          kind: "manual",
          locator: `gather:proposal/${action.id}`,
          label: `Source-linked proposal ${action.id} (pending owner approval; no receipt claimed)`,
        }),
      };
    },
  };
}

/**
 * Narrow policy normalization over the EXACT text just read from Drive.
 * Only the labeled GATHER TEST venue shape is understood; anything else
 * rejects rather than guessing prices the model could then "match".
 */
function parseVenuePolicy(text: string, fileId: string): { perPersonGbp: number; capacitySeated: number; currency: string } {
  const perPerson = /GBP\s+(\d+)\s+per\s+person/i.exec(text);
  const capacity = /capacity:\s*(\d+)\s+seated/i.exec(text);
  const currency = /Currency:\s*([A-Z]{3})/i.exec(text);
  if (!perPerson || !capacity || !currency) {
    throw new LiveModelError("POLICY_VIOLATION", `venue file ${fileId} is not a readable GATHER TEST price policy; refusing to price without one`);
  }
  return { perPersonGbp: Number(perPerson[1]), capacitySeated: Number(capacity[1]), currency: currency[1]! };
}
