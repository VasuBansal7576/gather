import type {
  ClassifierVerdict,
  DomainClassifier,
  DomainGateDecision,
  DomainGateInput,
} from "./gate.ts";

/**
 * ADR-003 scripted domain classifier for prepared mode. Deterministic
 * keyword heuristics over subject+body — every decision is labelled
 * simulated and carries displayable reasons. This classifier is a demo
 * stand-in, not a model: it never grants authority, and anything it cannot
 * positively place lands in needs_review rather than being guessed.
 *
 * Ordering is deliberate: strong non-event categories are evaluated first,
 * but only win when there is no positive event-inquiry evidence — a
 * newsletter that merely mentions "weddings" stays unrelated, while a real
 * inquiry that happens to quote an invoice still reviews instead of being
 * dropped.
 */

interface CategoryRule {
  id: string;
  label: string;
  patterns: RegExp[];
}

const NON_EVENT_CATEGORIES: CategoryRule[] = [
  {
    id: "invoice",
    label: "invoice or billing mail",
    patterns: [
      /\binvoice\b/i,
      /\bremittance\b/i,
      /\bamount due\b/i,
      /\bpayment (is )?(due|requested|required)\b/i,
      /\bpast due\b/i,
      /\bbalance due\b/i,
      /\bstatement of account\b/i,
      /\bbill(ing)? (for|period|statement)\b/i,
    ],
  },
  {
    id: "newsletter",
    label: "newsletter or marketing mail",
    patterns: [
      /\bunsubscribe\b/i,
      /\bnewsletter\b/i,
      /\b(weekly|monthly|daily) (digest|roundup|update|news)\b/i,
      /\bthis week\s*[:!]/i,
      /\bview (this |in )(browser|online)\b/i,
      /\bemail preferences\b/i,
      /\bsubscribe(d|rs)?\b/i,
    ],
  },
  {
    id: "vendor_pitch",
    label: "vendor or sales pitch",
    patterns: [
      /\bpartner(ship|ing)? (with|opportunit|offer)\b/i,
      /\bpreferred (vendor|supplier|partner)\b/i,
      /\brevenue share\b/i,
      /\bwe (supply|provide|offer|sell|manufacture)\b/i,
      /\bour (products?|services?|portfolio|platform|team) (would|could|can|helps?)\b/i,
      /\bwholesale\b/i,
      /\bintroduc(e|ing) (our|my|us)\b/i,
      /\bphoto ?booth vendor\b/i,
      /\bpreferred photo booth\b/i,
    ],
  },
  {
    id: "transactional",
    label: "automated or transactional mail",
    patterns: [
      /\bpassword reset\b/i,
      /\bverify your (email|account|identity)\b/i,
      /\bsecurity (code|alert)\b/i,
      /\byour (order|receipt|statement|subscription)\b/i,
      /\bconfirmation number\b/i,
      /\bsign(ed)?-?in (attempt|from)\b/i,
      /\bdelivery (status|update)\b/i,
      /\btwo-?factor\b/i,
    ],
  },
  {
    id: "career_or_other",
    label: "job application or other non-event mail",
    patterns: [
      /\bcover letter\b/i,
      /\br[ée]sum[ée]\b/i,
      /\bjob (application|opening|position|posting)\b/i,
      /\bapplying for\b/i,
      /\bopen (role|position)\b/i,
    ],
  },
];

const AUTOMATED_SENDER = /^(no-?reply|donotreply|do-?not-?reply|notifications?|alerts?|newsletter|billing|mailer-daemon|postmaster)@/i;

const INJECTION_PATTERNS: RegExp[] = [
  /\bignore (all |any |the )?(previous|prior|above|earlier) (instructions?|prompts?|rules?)\b/i,
  /\bdisregard (all |any |the )?(previous|prior|above)\b/i,
  /\bsystem prompt\b/i,
  /\byou are (now |actually )?(a|an|the)\b/i,
  /\bact as\b/i,
  /\bnew instructions?\b/i,
  /\bdo not follow\b/i,
  /\boverride (your|the|all)\b/i,
  /\bjailbreak\b/i,
  /\breveal (your|the) (prompt|instructions|system)\b/i,
];

const EVENT_NOUNS = /\b(wedding|reception|ceremony|birthday|anniversar(y|ies)|gala|offsite|retreat|fundraiser|banquet|reunion|graduation|(baby|bridal) shower|engagement|bar mitzvah|quincea[ñn]era|christmas (party|dinner)|holiday (party|reception|dinner)|corporate (event|party|reception|dinner)|private (dinner|dining|event|party|hire)|dinner party|launch (party|event)|conference|workshop|celebration|company (reception|party|offsite)|product launch|networking (event|night)|screening|performance|recital|exhibition|pop-?up|wedding shower)\b/i;

const VENUE_WORDS = /\b(venue|the [a-z]+ room|event space|function (room|space)|hall|the glasshouse|private dining)\b/i;

const REQUEST_INTENT = new RegExp(
  [
    "we('| a)re (planning|looking|interested|hoping|organizing|considering)",
    "we'?d like to",
    "we would like to",
    "(looking|hoping|planning) to (book|host|hire|hold|reserve|rent|organize)",
    "would like to (book|host|hold|reserve|hire|rent)",
    "want(s|ed)? to (book|host|hold|reserve|hire|rent)",
    "interested in (booking|hosting|holding|reserving|renting|hiring)",
    "is (the |your |this )?[^.\\n]{1,50}\\bavailable\\b",
    "are you (available|free|open|able)",
    "do you (host|have availability|offer|cater|accommodate)",
    "can (we|you) (host|hold|book|accommodate|fit|seat)",
    "what (would it|does it|will it|do you) (cost|charge)",
    "how much (would|does|will|to)",
    "availability (for|on|around)",
    "(send|share|provide)( us| me)?( a| the)? (quote|pricing|rates|proposal|estimate|packages)",
    "a quote (for|on)",
    "inquirie?s? about (booking|hosting|holding|reserving|your)",
    "enquirie?s? about (booking|hosting|holding|reserving|your)",
    "request(ing|s)? a (booking|reservation|quote|proposal|tour|viewing)",
    "book(ing)? (the|your|a)? ?(venue|space|room|hall|restaurant)",
    "(hire|rent) (the|your) (venue|space|room|hall)",
    "options\\??\\s*$",
    "hold (the|our|a|my) (date|space|venue|room|slot)",
  ].join("|"),
  "i",
);

const MONTH = "(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";
const DATE_PATTERNS: RegExp[] = [
  new RegExp(`\\b\\d{4}-\\d{2}-\\d{2}\\b`, "g"),
  new RegExp(`\\b${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?\\b`, "gi"),
  new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}\\b`, "gi"),
  /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g,
  new RegExp(`\\b(next|this) (spring|summer|autumn|fall|winter|week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\\b`, "gi"),
  /\bthis weekend\b/gi,
];

const GUEST_COUNT = /\b(\d{1,4})\s*(guests?|people|attendees|pax|persons?|seats?|plates?|covers?|heads?)\b/i;
const PARTY_OF = /\bparty of (\d{1,4})\b/i;

const MONTH_CANONICAL: Record<string, string> = {
  jan: "january", january: "january",
  feb: "february", february: "february",
  mar: "march", march: "march",
  apr: "april", april: "april",
  may: "may",
  jun: "june", june: "june",
  jul: "july", july: "july",
  aug: "august", august: "august",
  sep: "september", sept: "september", september: "september",
  oct: "october", october: "october",
  nov: "november", november: "november",
  dec: "december", december: "december",
};

function normalizeDateHint(hint: string): string {
  const match = new RegExp(`(${MONTH})`, "i").exec(hint);
  if (!match) return hint.toLowerCase().replace(/\s+/g, " ").trim();
  const monthKey = match[1]!.toLowerCase().replace(/\.$/, "");
  const canonical = MONTH_CANONICAL[monthKey] ?? monthKey;
  const day = /\d{1,2}/.exec(hint)?.[0];
  return day === undefined ? canonical : `${canonical} ${day}`;
}

function extractDateHints(text: string): string[] {
  const found = new Set<string>();
  for (const pattern of DATE_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      found.add(normalizeDateHint(match[0]));
    }
  }
  return [...found].sort();
}

function extractGuestCount(text: string): number | undefined {
  const direct = GUEST_COUNT.exec(text) ?? PARTY_OF.exec(text);
  if (!direct) return undefined;
  const count = Number.parseInt(direct[1]!, 10);
  return Number.isFinite(count) && count > 0 ? count : undefined;
}

function eventTypeOf(text: string): string | undefined {
  const match = EVENT_NOUNS.exec(text);
  return match ? match[0]!.toLowerCase() : undefined;
}

function nonEventHits(text: string, sender: string | undefined): CategoryRule[] {
  const hits = NON_EVENT_CATEGORIES.filter((category) => category.patterns.some((pattern) => pattern.test(text)));
  if (sender !== undefined && AUTOMATED_SENDER.test(sender)) {
    hits.push({ id: "automated_sender", label: "automated sender address", patterns: [] });
  }
  return hits;
}

/**
 * The scripted classifier used by prepared mode (and by the compose intake
 * API). Returns `classified` always — determinism means it cannot go
 * unavailable; genuinely thin or contradictory input maps to needs_review
 * instead of a guess.
 */
export function createScriptedDomainClassifier(): DomainClassifier {
  return {
    id: "scripted-prepared-domain-gate",
    simulated: true,
    classify(input: DomainGateInput): Promise<ClassifierVerdict> {
      const subject = (input.subject ?? "").trim();
      const body = (input.body ?? "").trim();
      const text = `${subject}\n${body}`;
      const sender = input.from?.toLowerCase();

      const categories = nonEventHits(text, sender);
      const injected = INJECTION_PATTERNS.some((pattern) => pattern.test(text));
      const eventType = eventTypeOf(text);
      const hasEventNoun = eventType !== undefined;
      const hasVenue = VENUE_WORDS.test(text);
      const hasIntent = REQUEST_INTENT.test(text);
      const dateHints = extractDateHints(text);
      const guestCount = extractGuestCount(text);
      const concreteField = dateHints.length > 0 || guestCount !== undefined;

      const extracted = {
        ...(hasEventNoun ? { eventType } : {}),
        dateHints,
        ...(guestCount === undefined ? {} : { guestCount }),
      };

      // Positive event-inquiry evidence: a request intent tied to an event
      // or venue, or recognizably an event (noun) carrying at least one
      // concrete field. An event noun alone ("Dinner" as a subject) is not
      // enough — it stays ambiguous.
      const eventEvidence =
        (hasIntent && (hasEventNoun || hasVenue)) ||
        (hasEventNoun && concreteField);

      let decision: DomainGateDecision;
      if (eventEvidence && categories.length === 0) {
        const missingFields: string[] = [];
        const reasons: string[] = [];
        if (dateHints.length === 0) missingFields.push("event_date");
        if (dateHints.length > 1) {
          missingFields.push("event_date");
          reasons.push(`Multiple candidate dates appear (${dateHints.join(" / ")}); qualification must resolve one before any proposal.`);
        }
        if (guestCount === undefined) missingFields.push("guest_count");
        if (!hasEventNoun) missingFields.push("event_type");
        if (injected) {
          reasons.push("Message also contains instruction-like text; it is classified on its event request only and carries no authority.");
        }
        decision = { outcome: "eligible", reasons, missingFields, extracted };
      } else if (eventEvidence && categories.length > 0) {
        decision = {
          outcome: "needs_review",
          reasons: [
            `Event-inquiry signals mixed with ${categories.map((hit) => hit.label).join(", ")}; an owner should confirm the domain before intake.`,
          ],
          missingFields: [],
          extracted,
        };
      } else if (categories.length > 0) {
        decision = {
          outcome: "unrelated",
          reasons: [`Not an event inquiry: ${categories.map((hit) => hit.label).join(", ")}.`],
          missingFields: [],
          extracted,
        };
      } else if (injected && !hasEventNoun && !hasIntent) {
        decision = {
          outcome: "unrelated",
          reasons: ["Not an event inquiry: the message carries instructions unrelated to an event booking; they grant no authority and trigger no business action."],
          missingFields: [],
          extracted,
        };
      } else if (hasEventNoun || hasIntent || hasVenue) {
        decision = {
          outcome: "needs_review",
          reasons: ["Possible event inquiry, but the evidence is too thin to classify; parked for owner review."],
          missingFields: [],
          extracted,
        };
      } else {
        decision = {
          outcome: "needs_review",
          reasons: ["No event-domain evidence found; the message is parked for owner review rather than assumed unrelated."],
          missingFields: [],
          extracted,
        };
      }
      return Promise.resolve({ status: "classified", decision });
    },
  };
}
