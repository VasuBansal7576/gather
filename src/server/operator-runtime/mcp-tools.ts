import { z } from "zod";
import { defineGatherTool, type GatherTool } from "../../runtime/mcp.ts";
import { operatorHealth } from "./health.ts";
import { OperatorIntakeStore } from "./store.ts";
import type { OperatorRuntimeDeps } from "./types.ts";

/**
 * Supported runtime MCP tools for operator monitoring. READ-ONLY by
 * construction: every tool is registered with execution "live" (real local
 * backend state) but none mutates anything — there is deliberately no
 * model-invokable approve/control/retry tool, so an untrusted model cannot
 * mint owner approval, control state, or verified payment through this
 * boundary. Results carry `authority: "advisory"` via the boundary wrapper.
 */
export function operatorMcpTools(deps: OperatorRuntimeDeps): GatherTool[] {
  const health = defineGatherTool({
    name: "operator.health",
    description: "Read operator-runtime monitoring health: sweep/cursor state, waiting counts, paused bookings, recent failures. Read-only.",
    inputSchema: {},
    execution: "live",
    handler: async () => {
      const report = operatorHealth(deps);
      return {
        content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
        structuredContent: { health: report as unknown as Record<string, unknown> },
      };
    },
  });

  const waiting = defineGatherTool({
    name: "operator.waiting",
    description: "List due coordination waiting items with their recommended next actions. Read-only; acting requires owner-approved paths outside this boundary.",
    inputSchema: {
      limit: z.number().int().min(1).max(100).optional().describe("Maximum items to return"),
    },
    execution: "live",
    handler: async (args: { limit?: number }) => {
      const now = deps.now ? deps.now() : new Date().toISOString();
      const items = deps.ledger.listDueWork({ nowIso: now, limit: args.limit ?? 25 });
      return {
        content: [{ type: "text", text: JSON.stringify(items, null, 2) }],
        structuredContent: { waiting: items as unknown as Record<string, unknown> },
      };
    },
  });

  const intakeStatus = defineGatherTool({
    name: "operator.intake.status",
    description: "Read intake batch and cursor checkpoint state for the bound account. Read-only.",
    inputSchema: {},
    execution: "live",
    handler: async () => {
      const intake = new OperatorIntakeStore(deps.store.db);
      const latest = intake.latestBatch(deps.accountId) ?? null;
      const cursor = intake.getCursor(deps.accountId) ?? null;
      const report = { latest, cursor, simulation: deps.simulation };
      return {
        content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
        structuredContent: { intake: report as unknown as Record<string, unknown> },
      };
    },
  });

  return [health, waiting, intakeStatus];
}
