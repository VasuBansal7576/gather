import type { GatherTool } from "../runtime/mcp.ts";

/**
 * ADR-003 booking-scoped tool allowlist and capability inventory.
 *
 * The boundary is structural: the registered Gather tools are the ONLY
 * model-reachable surface, and every one of them binds business, account,
 * source, and recipient server-side. A tool is outside the allowlist when
 * it takes caller-supplied identity or recipient arguments, opens an
 * unrestricted read surface (arbitrary mailbox search, drive listing), or
 * performs a consequential write the approval pipeline does not own.
 *
 * The inventory is derived from the actual registered tool set — it is PR
 * evidence, not a paraphrase: each entry reports the tool's declared
 * execution mode and its real input fields, plus the boundary verdicts.
 */

/** Registered names that satisfy the booking-scoped boundary, with their allowed input fields. */
export const BOOKING_SCOPED_TOOL_ALLOWLIST: Readonly<Record<string, readonly string[]>> = {
  "gather.read_inquiry": [],
  "gather.read_venue_policy": [],
  "gather.check_availability": ["startAt", "endAt"],
  "gather.prepare_proposal": ["startAt", "endAt", "guestCount", "notes"],
  "operator.health": [],
  "operator.waiting": ["limit"],
  "operator.intake.status": [],
};

/**
 * Input fields that would hand a model authority it must never get:
 * recipient selection, identity/source selection (business, account,
 * thread, file, calendar, booking, run, source key), or an unrestricted
 * read surface (search queries, mailbox/drive listing handles).
 */
const FORBIDDEN_FIELD = /^(to|recipient|recipients|cc|bcc|from|emailto|address|addresses|account(id)?|business(id)?|thread(id)?|file(id)?|document(id)?|calendar(id)?|booking(id)?|run(id)?|source(key|s)?|query|search|q|filter|mailbox|folder|drive(id)?|label(s)?)$/i;

/** Names that imply a consequential write or an unrestricted provider surface. */
const FORBIDDEN_NAME = /(send|approve|reject|confirm|execute|hold|write|delete|update|create|mail|email|gmail|drive|calendar|search|list|compose)/i;

export interface ToolCapabilityEntry {
  name: string;
  description: string;
  execution: "live" | "simulated";
  /** Declared input fields (top-level inputSchema keys). */
  inputFields: string[];
  /** True when the tool is inside the booking-scoped allowlist. */
  allowed: boolean;
  /** Displayable reasons when not allowed. */
  violations: string[];
}

export interface CapabilityInventory {
  ok: boolean;
  tools: ToolCapabilityEntry[];
  /** Tool names present in the registration but absent from the allowlist. */
  unregistered: string[];
  /** Registered input fields the allowlist does not name. */
  extraFields: Array<{ name: string; fields: string[] }>;
}

function forbiddenFields(fields: string[]): string[] {
  return fields.filter((field) => FORBIDDEN_FIELD.test(field));
}

function isForbiddenName(name: string): boolean {
  const tail = name.includes(".") ? name.split(".").pop()! : name;
  return FORBIDDEN_NAME.test(tail);
}

/** Inventory one registered tool set against the allowlist. */
export function capabilityInventory(tools: readonly GatherTool[]): CapabilityInventory {
  const seen = new Set<string>();
  const entries: ToolCapabilityEntry[] = [];
  const unregistered: string[] = [];
  const extraFields: Array<{ name: string; fields: string[] }> = [];
  for (const tool of tools) {
    const fields = Object.keys(tool.inputSchema ?? {}).sort();
    const violations: string[] = [];
    const allowedSpec = BOOKING_SCOPED_TOOL_ALLOWLIST[tool.name];
    if (allowedSpec === undefined) {
      violations.push("tool is not in the booking-scoped allowlist");
      unregistered.push(tool.name);
    }
    if (seen.has(tool.name)) {
      violations.push("duplicate tool registration");
    }
    seen.add(tool.name);
    const bad = forbiddenFields(fields);
    if (bad.length > 0) {
      violations.push(`caller-supplied identity/recipient/source arguments are forbidden: ${bad.join(", ")}`);
    }
    if (allowedSpec !== undefined) {
      const extra = fields.filter((field) => !allowedSpec.includes(field));
      if (extra.length > 0) {
        violations.push(`input fields outside the registered allowlist: ${extra.join(", ")}`);
        extraFields.push({ name: tool.name, fields: extra });
      }
    } else if (isForbiddenName(tool.name)) {
      violations.push("tool name implies a write or unrestricted provider surface");
    }
    entries.push({
      name: tool.name,
      description: tool.description,
      execution: tool.execution,
      inputFields: fields,
      allowed: violations.length === 0,
      violations,
    });
  }
  return { ok: entries.every((entry) => entry.allowed), tools: entries, unregistered, extraFields };
}

/** Throw-on-violation variant used where the boundary must fail closed. */
export function assertToolAllowlist(tools: readonly GatherTool[]): CapabilityInventory {
  const inventory = capabilityInventory(tools);
  if (!inventory.ok) {
    const detail = inventory.tools
      .filter((entry) => !entry.allowed)
      .map((entry) => `${entry.name}: ${entry.violations.join("; ")}`)
      .join(" | ");
    throw new Error(`Tool surface violates the booking-scoped allowlist: ${detail}`);
  }
  return inventory;
}
