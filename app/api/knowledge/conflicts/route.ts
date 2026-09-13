import { NextResponse, type NextRequest } from "next/server";
import { getRuntime, ownerId } from "../../../../src/server/runtime.ts";
import { KnowledgeService } from "../../../../src/knowledge/service.ts";
import { assertSameOrigin, readHeaders } from "../../../../src/server/validation.ts";
import { unknownErrorResponse } from "../../_helpers.ts";
import { collectSources, deploymentMode, knowledgeErrorResponse } from "../_mapper.ts";

export const dynamic = "force-dynamic";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/**
 * Business-wide account conflicts for owner review. Read-only: lists active
 * cross-account revision groups with their exact revision ids — the same
 * ids a resolution must command back.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    assertSameOrigin(readHeaders(request));
    const businessId = request.nextUrl.searchParams.get("businessId");
    if (!businessId) return unknownErrorResponse(new Error("businessId query is required"));
    const runtime = getRuntime();
    // Ownership guard (established local-owner model): fail closed on
    // unknown businesses before listing anything.
    runtime.store.getBusiness(businessId);
    const service = new KnowledgeService(runtime.store);
    const conflicts = service.listConflicts(businessId);
    const found: { fictional?: boolean }[] = [];
    collectSources(conflicts, found);
    return NextResponse.json({ mode: deploymentMode(found), conflicts });
  } catch (error) {
    try {
      return knowledgeErrorResponse(error);
    } catch {
      return unknownErrorResponse(error);
    }
  }
}

/**
 * Resolve one conflict to an exact winning revision. The owner identity is
 * always host-derived — request-supplied actors are ignored — and the
 * business scope is derived from the validated request, never trusted
 * blindly: resolveConflict re-checks the exact commanded set atomically
 * and rejects stale views (HTTP 409) instead of resolving unseen rivals.
 * A stale rejection forces fresh review; the client must never retry
 * approval against the new set automatically.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    assertSameOrigin(readHeaders(request));
    if ((request.headers.get("content-type") ?? "").includes("application/json") === false) {
      return unknownErrorResponse(new Error("Content-Type must be application/json"));
    }
    const body: unknown = await request.json().catch(() => undefined);
    if (!isRecord(body)) return unknownErrorResponse(new Error("Request body must be a JSON object"));
    const businessId = nonEmptyString(body.businessId);
    const key = nonEmptyString(body.key);
    if (!businessId) return unknownErrorResponse(new Error("businessId is required"));
    if (!key) return unknownErrorResponse(new Error("key is required"));
    const runtime = getRuntime();
    runtime.store.getBusiness(businessId);
    const service = new KnowledgeService(runtime.store);
    const { actor: _ignored, ...params } = body;
    const result = service.resolveConflict({
      businessId,
      actor: { kind: "owner", id: ownerId() },
      key,
      ...(nonEmptyString(body.subjectId) === undefined ? {} : { subjectId: body.subjectId as string }),
      ...(body.scope === "booking" || body.scope === "customer" ? { scope: body.scope } : {}),
      ...(nonEmptyString(body.scopeId) === undefined ? {} : { scopeId: body.scopeId as string }),
      winningRevisionId: body.winningRevisionId,
      consideredRevisionIds: body.consideredRevisionIds,
      ...(nonEmptyString(body.commandId) === undefined ? {} : { commandId: body.commandId as string }),
    } as Parameters<KnowledgeService["resolveConflict"]>[0]);
    const found: { fictional?: boolean }[] = [];
    collectSources(result, found);
    return NextResponse.json({ mode: deploymentMode(found), resolution: result });
  } catch (error) {
    try {
      return knowledgeErrorResponse(error);
    } catch {
      return unknownErrorResponse(error);
    }
  }
}
