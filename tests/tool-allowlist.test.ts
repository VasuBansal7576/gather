/**
 * ADR-003 booking-scoped tool allowlist and capability inventory tests.
 * All local fixtures only; tools are inventoried, never invoked against
 * providers. Covers: the registered live-model and operator tool sets sit
 * entirely inside the allowlist, the inventory is derived from the actual
 * registration, and fabricated tools carrying recipient/identity/
 * unrestricted-source arguments or write surfaces are refused.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import type { CalendarConnector, DocumentRetriever, InquiryThreadReader } from "../src/connectors/contracts.ts";
import { createDemoConnectors } from "../src/connectors/demo.ts";
import { CoordinationLedger } from "../src/coordination/ledger.ts";
import {
  BOOKING_SCOPED_TOOL_ALLOWLIST,
  assertToolAllowlist,
  capabilityInventory,
} from "../src/intake/tool-inventory.ts";
import { defineGatherTool } from "../src/runtime/mcp.ts";
import { createLiveMcpTools } from "../src/server/live-model/mcp-tools.ts";
import { operatorMcpTools } from "../src/server/operator-runtime/mcp-tools.ts";
import { GatherStore } from "../src/server/sqlite-store.ts";

const NOW = "2030-06-01T00:00:00.000Z";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "gather-tools-"));
  const store = new GatherStore(join(dir, "gather.sqlite"));
  const ledger = new CoordinationLedger(store.db, { clock: () => NOW });
  const business = store.createBusiness({ name: "Fictional Tools Venue", timezone: "UTC" });
  return {
    store, ledger, businessId: business.id,
    cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test("every registered Gather tool is inside the booking-scoped allowlist", () => {
  const fx = fixture();
  try {
    const demo = createDemoConnectors({});
    const operatorTools = operatorMcpTools({
      store: fx.store,
      ledger: fx.ledger,
      inbox: { pollInbox: async () => { throw new Error("unused"); }, provenance: { simulated: true, label: "test" } },
      booking: { store: fx.store, calendar: demo.calendar, email: demo.email },
      accountId: "acct-tools",
      businessId: fx.businessId,
      now: () => NOW,
    });
    const liveTools = createLiveMcpTools({
      store: fx.store,
      businessId: fx.businessId,
      accountId: "acct-tools",
      runId: "run-tools",
      threadId: "t-tools",
      fileId: "f-tools",
      calendarId: "cal-tools",
      recipient: "gather-test-recipient@example.invalid",
      threads: undefined as unknown as InquiryThreadReader,
      documents: undefined as unknown as DocumentRetriever,
      calendar: demo.calendar as unknown as CalendarConnector,
      execution: "simulated",
      audit: () => {},
      state: {},
    });
    const inventory = capabilityInventory([...operatorTools, ...liveTools]);
    assert.equal(inventory.ok, true);
    assert.deepEqual(inventory.unregistered, []);
    assert.deepEqual(inventory.extraFields, []);
    // The inventory is derived from the real registration — assert the full
    // declared surface, field by field.
    assert.deepEqual(
      inventory.tools.map((entry) => [entry.name, entry.inputFields, entry.allowed]),
      [
        ["operator.health", [], true],
        ["operator.waiting", ["limit"], true],
        ["operator.intake.status", [], true],
        ["gather.read_inquiry", [], true],
        ["gather.read_venue_policy", [], true],
        ["gather.check_availability", ["endAt", "startAt"], true],
        ["gather.prepare_proposal", ["endAt", "guestCount", "notes", "startAt"], true],
      ],
    );
    // No model-facing tool takes a recipient, identity, or source argument.
    for (const entry of inventory.tools) {
      assert.equal(
        entry.inputFields.some((field) => /^(to|recipient|cc|bcc|account(id)?|business(id)?|thread(id)?|file(id)?|calendar(id)?|query|search)$/i.test(field)),
        false,
        `${entry.name} must not accept identity or recipient arguments`,
      );
    }
    // The allowlist names exactly the registered set.
    assert.deepEqual(
      Object.keys(BOOKING_SCOPED_TOOL_ALLOWLIST).sort(),
      [...operatorTools.map((tool) => tool.name), ...liveTools.map((tool) => tool.name)].sort(),
    );
  } finally {
    fx.cleanup();
  }
});

test("fabricated tools with recipient, identity, or unrestricted-source surfaces are refused", () => {
  const mailSend = defineGatherTool({
    name: "gmail.send",
    description: "Send any email anywhere",
    inputSchema: { to: z.string(), subject: z.string(), body: z.string() },
    execution: "live",
    handler: async () => ({ content: [{ type: "text", text: "sent" }] }),
  });
  const driveList = defineGatherTool({
    name: "drive.list_files",
    description: "List arbitrary Drive files",
    inputSchema: { query: z.string() },
    execution: "live",
    handler: async () => ({ content: [{ type: "text", text: "files" }] }),
  });
  const foreignIdentity = defineGatherTool({
    name: "gather.read_other",
    description: "Read a caller-chosen thread",
    inputSchema: { accountId: z.string(), threadId: z.string() },
    execution: "live",
    handler: async () => ({ content: [{ type: "text", text: "x" }] }),
  });
  const approve = defineGatherTool({
    name: "gather.approve_proposal",
    description: "Approve a proposal",
    inputSchema: {},
    execution: "live",
    handler: async () => ({ content: [{ type: "text", text: "approved" }] }),
  });
  const inventory = capabilityInventory([mailSend, driveList, foreignIdentity, approve]);
  assert.equal(inventory.ok, false);
  const byName = new Map(inventory.tools.map((entry) => [entry.name, entry]));
  assert.equal(byName.get("gmail.send")?.allowed, false);
  assert.ok(byName.get("gmail.send")!.violations.some((violation) => /allowlist|recipient|identity/i.test(violation)));
  assert.equal(byName.get("drive.list_files")?.allowed, false);
  assert.equal(byName.get("gather.read_other")?.allowed, false);
  assert.equal(byName.get("gather.approve_proposal")?.allowed, false);
  assert.throws(() => assertToolAllowlist([mailSend, driveList, foreignIdentity, approve]), /booking-scoped allowlist/);
});
