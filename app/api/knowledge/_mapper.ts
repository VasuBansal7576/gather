import { NextResponse } from "next/server";
import { KnowledgeError } from "../../../src/knowledge/service.ts";
import { errorResponse } from "../_helpers.ts";

/** Map knowledge-boundary errors to typed HTTP responses (audited at the service layer). */
export function knowledgeErrorResponse(error: unknown): NextResponse {  if (error instanceof KnowledgeError) {
    const code: string = error.code;
    const message: string = error.message;
    if (code === "denied") return errorResponse("DENIED", message, false);
    if (code === "busy") return errorResponse("BUSY", message, true);
    if (code === "not_found") return errorResponse("NOT_FOUND", message, false);
    if (code === "stale" || code === "stale_version") return errorResponse("STALE_PROPOSAL", message, false);
    if (code === "command_conflict") return errorResponse("CONFLICT", message, false);
    if (code === "cross_business") return errorResponse("CROSS_BOOKING", message, false);
    return errorResponse("INVALID_REQUEST", message, false);
  }
  throw error;
}

/**
 * Deployment mode derived from actual record sources: the deployment stays
 * explicitly demo, while the fictional flag reflects content (owner-manual
 * sources are not fictional). No unconditional claims either way.
 */
export function deploymentMode(sources: { fictional?: boolean }[]): {
  kind: "demo";
  label: "DEMO ONLY";
  fictional: boolean;
  simulated: true;
} {
  const fictional = sources.length > 0 && sources.every((source) => source.fictional === true);
  return { kind: "demo", label: "DEMO ONLY", fictional, simulated: true };
}

export function collectSources(value: unknown, out: { fictional?: boolean }[]): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectSources(entry, out);
    return;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.locator === "string") {
      out.push({ fictional: record.fictional === true });
    }
    for (const nested of Object.values(record)) collectSources(nested, out);
  }
}
