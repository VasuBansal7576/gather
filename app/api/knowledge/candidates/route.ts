import { NextResponse, type NextRequest } from "next/server";
import { getRuntime } from "../../../../src/server/runtime.ts";
import { KnowledgeService, type IntakeCandidateInput } from "../../../../src/knowledge/service.ts";
import { assertSameOrigin, readHeaders } from "../../../../src/server/validation.ts";
import { unknownErrorResponse } from "../../_helpers.ts";
import { collectSources, deploymentMode, knowledgeErrorResponse } from "../_mapper.ts";

export const dynamic = "force-dynamic";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    assertSameOrigin(readHeaders(request));
    if ((request.headers.get("content-type") ?? "").includes("application/json") === false) {
      return unknownErrorResponse(new Error("Content-Type must be application/json"));
    }
    const body: unknown = await request.json().catch(() => undefined);
    if (!isRecord(body)) return unknownErrorResponse(new Error("Request body must be a JSON object"));
    const runtime = getRuntime();
    const service = new KnowledgeService(runtime.store);
    const candidate = service.intakeCandidate(body as unknown as IntakeCandidateInput);
    const found: { fictional?: boolean }[] = []; collectSources(candidate, found);
    return NextResponse.json({ mode: deploymentMode(found), candidate });
  } catch (error) {
    try {
      return knowledgeErrorResponse(error);
    } catch {
      return unknownErrorResponse(error);
    }
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    assertSameOrigin(readHeaders(request));
    const businessId = request.nextUrl.searchParams.get("businessId");
    const status = request.nextUrl.searchParams.get("status");
    if (!businessId) return unknownErrorResponse(new Error("businessId query is required"));
    const runtime = getRuntime();
    const service = new KnowledgeService(runtime.store);
    const candidates = service.listCandidates(businessId, status ? { status } : {});
    const found: { fictional?: boolean }[] = []; collectSources(candidates, found);
    return NextResponse.json({ mode: deploymentMode(found), candidates });
  } catch (error) {
    try {
      return knowledgeErrorResponse(error);
    } catch {
      return unknownErrorResponse(error);
    }
  }
}
