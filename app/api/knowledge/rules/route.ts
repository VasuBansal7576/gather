import { NextResponse, type NextRequest } from "next/server";
import { getRuntime, ownerId } from "../../../../src/server/runtime.ts";
import { KnowledgeService } from "../../../../src/knowledge/service.ts";
import { confirmParsedRule, parseOwnerRuleText } from "../../../../src/knowledge/rules.ts";
import { assertSameOrigin, readHeaders } from "../../../../src/server/validation.ts";
import { unknownErrorResponse } from "../../_helpers.ts";
import { knowledgeErrorResponse } from "../_mapper.ts";

export const dynamic = "force-dynamic";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * POST /api/knowledge/rules
 * - { action: 'parse', text } renders the parsed scope (or clarification
 *   questions) for owner review. Parsing alone changes nothing.
 * - { action: 'confirm', draft, expectedRevision?, commandId? } writes the
 *   parsed draft through the versioned owner decisions. The actor is always
 *   the host-derived owner; model/content text can never confirm.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    assertSameOrigin(readHeaders(request));
    if ((request.headers.get("content-type") ?? "").includes("application/json") === false) {
      return unknownErrorResponse(new Error("Content-Type must be application/json"));
    }
    const body: unknown = await request.json().catch(() => undefined);
    if (!isRecord(body) || typeof body.action !== "string") {
      return unknownErrorResponse(new Error("action must be parse or confirm"));
    }
    if (body.action === "parse") {
      if (typeof body.text !== "string") {
        return unknownErrorResponse(new Error("parse requires text"));
      }
      return NextResponse.json({ result: parseOwnerRuleText(body.text) });
    }
    if (body.action === "confirm") {
      if (typeof body.businessId !== "string" || !isRecord(body.draft)) {
        return unknownErrorResponse(new Error("confirm requires businessId and draft"));
      }
      const runtime = getRuntime();
      const service = new KnowledgeService(runtime.store);
      const draft = body.draft as unknown as Parameters<typeof confirmParsedRule>[1]["draft"];
      const result = confirmParsedRule(service, {
        businessId: body.businessId,
        actor: { kind: "owner", id: ownerId() },
        draft,
        ...(typeof body.expectedRevision === "number" ? { expectedRevision: body.expectedRevision } : {}),
        ...(typeof body.commandId === "string" ? { commandId: body.commandId } : {}),
      });
      return NextResponse.json({ result });
    }
    return unknownErrorResponse(new Error("action must be parse or confirm"));
  } catch (error) {
    try {
      return knowledgeErrorResponse(error);
    } catch {
      return unknownErrorResponse(error);
    }
  }
}
