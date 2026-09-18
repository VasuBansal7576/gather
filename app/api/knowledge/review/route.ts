import { NextResponse, type NextRequest } from "next/server";
import { getRuntime, ownerId } from "../../../../src/server/runtime.ts";
import { KnowledgeService } from "../../../../src/knowledge/service.ts";
import { PreparedKnowledgePort } from "../../../../src/knowledge/prepared.ts";
import {
  batchConfirmCandidates,
  describeAvailability,
  inspectSourceClaims,
} from "../../../../src/knowledge/review.ts";
import { assertSameOrigin, readHeaders } from "../../../../src/server/validation.ts";
import { unknownErrorResponse } from "../../_helpers.ts";
import { collectSources, deploymentMode, knowledgeErrorResponse } from "../_mapper.ts";

export const dynamic = "force-dynamic";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * GET /api/knowledge/review?businessId=...&sourceLocator=...
 * Inspect one document's parsed claims: pending candidates with sources and
 * uncertainty, current confirmed counterparts, missing keys, and the honest
 * availability state (no-facts vs unavailable vs stale).
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    assertSameOrigin(readHeaders(request));
    const businessId = request.nextUrl.searchParams.get("businessId");
    const sourceLocator = request.nextUrl.searchParams.get("sourceLocator");
    if (!businessId) return unknownErrorResponse(new Error("businessId query is required"));
    if (!sourceLocator) return unknownErrorResponse(new Error("sourceLocator query is required"));
    const runtime = getRuntime();
    const service = new KnowledgeService(runtime.store);
    const port = new PreparedKnowledgePort(service, businessId);
    const inspection = inspectSourceClaims(service, { businessId, sourceLocator });
    const availability = describeAvailability(port, { businessId });
    const found: { fictional?: boolean }[] = [];
    collectSources(inspection, found);
    return NextResponse.json({
      mode: deploymentMode(found),
      inspection,
      availability,
    });
  } catch (error) {
    try {
      return knowledgeErrorResponse(error);
    } catch {
      return unknownErrorResponse(error);
    }
  }
}

/**
 * POST /api/knowledge/review { businessId, candidateIds, commandPrefix? }
 * Batch-confirm inspected candidates. The approving actor is always the
 * host-derived owner; request-supplied actors are ignored.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    assertSameOrigin(readHeaders(request));
    if ((request.headers.get("content-type") ?? "").includes("application/json") === false) {
      return unknownErrorResponse(new Error("Content-Type must be application/json"));
    }
    const body: unknown = await request.json().catch(() => undefined);
    if (!isRecord(body) || typeof body.businessId !== "string") {
      return unknownErrorResponse(new Error("businessId is required"));
    }
    if (!Array.isArray(body.candidateIds) || body.candidateIds.some((id) => typeof id !== "string")) {
      return unknownErrorResponse(new Error("candidateIds must be a string array"));
    }
    if (body.commandPrefix !== undefined && typeof body.commandPrefix !== "string") {
      return unknownErrorResponse(new Error("commandPrefix must be a string when present"));
    }
    const runtime = getRuntime();
    const service = new KnowledgeService(runtime.store);
    const result = batchConfirmCandidates(service, {
      businessId: body.businessId,
      actor: { kind: "owner", id: ownerId() },
      candidateIds: body.candidateIds,
      ...(typeof body.commandPrefix === "string" ? { commandPrefix: body.commandPrefix } : {}),
    });
    const found: { fictional?: boolean }[] = [];
    collectSources(result, found);
    return NextResponse.json({ mode: deploymentMode(found), result });
  } catch (error) {
    try {
      return knowledgeErrorResponse(error);
    } catch {
      return unknownErrorResponse(error);
    }
  }
}
