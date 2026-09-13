import { NextResponse } from "next/server";
import { KnowledgeError } from "../../../src/knowledge/service.ts";
import { errorResponse } from "../_helpers.ts";

/** Map knowledge-boundary errors to typed HTTP responses (audited at the service layer). */
export function knowledgeErrorResponse(error: unknown): NextResponse {
  if (error instanceof KnowledgeError) {
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
