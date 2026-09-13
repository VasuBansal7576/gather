import { NextResponse, type NextRequest } from "next/server";
import { getRuntime } from "../../../../src/server/runtime.ts";
import { KnowledgeService } from "../../../../src/knowledge/service.ts";
import { assertSameOrigin, readHeaders } from "../../../../src/server/validation.ts";
import { unknownErrorResponse } from "../../_helpers.ts";
import { collectSources, deploymentMode, knowledgeErrorResponse } from "../_mapper.ts";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    assertSameOrigin(readHeaders(request));
    const businessId = request.nextUrl.searchParams.get("businessId");
    if (!businessId) return unknownErrorResponse(new Error("businessId query is required"));
    const runtime = getRuntime();
    const service = new KnowledgeService(runtime.store);
    const snapshot = service.snapshotForOffers(businessId);
    const found: { fictional?: boolean }[] = []; collectSources(snapshot, found);
    return NextResponse.json({ mode: deploymentMode(found), snapshot });
  } catch (error) {
    try {
      return knowledgeErrorResponse(error);
    } catch {
      return unknownErrorResponse(error);
    }
  }
}
