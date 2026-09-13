import { NextResponse, type NextRequest } from "next/server";
import { getRuntime } from "../../../../src/server/runtime.ts";
import { KnowledgeService } from "../../../../src/knowledge/service.ts";
import { assertSameOrigin, readHeaders } from "../../../../src/server/validation.ts";
import { unknownErrorResponse } from "../../_helpers.ts";
import { collectSources, deploymentMode, knowledgeErrorResponse } from "../_mapper.ts";

export const dynamic = "force-dynamic";

/**
 * Active confirmed facts with revision/scope/review metadata. The owner
 * knowledge view needs exact revisions to correct a fact (optimistic
 * concurrency) and scope data to keep exceptions scoped — the offers
 * snapshot deliberately strips that metadata, so this read exists for the
 * review UI only and changes nothing.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    assertSameOrigin(readHeaders(request));
    const businessId = request.nextUrl.searchParams.get("businessId");
    if (!businessId) return unknownErrorResponse(new Error("businessId query is required"));
    const runtime = getRuntime();
    // Ownership guard (established local-owner model: every business row in
    // this store belongs to the configured local owner). Fail closed on
    // unknown businesses.
    runtime.store.getBusiness(businessId);
    const service = new KnowledgeService(runtime.store);
    const facts = service.listFacts(businessId);
    const found: { fictional?: boolean }[] = []; collectSources(facts, found);
    return NextResponse.json({ mode: deploymentMode(found), facts });
  } catch (error) {
    try {
      return knowledgeErrorResponse(error);
    } catch {
      return unknownErrorResponse(error);
    }
  }
}
