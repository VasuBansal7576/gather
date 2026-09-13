import { NextResponse, type NextRequest } from "next/server";
import { reconcileExecution } from "../../../../../src/server/booking-service.ts";
import { getRuntime } from "../../../../../src/server/runtime.ts";
import { assertSameOrigin, parseId, readHeaders } from "../../../../../src/server/validation.ts";
import { unknownErrorResponse } from "../../../_helpers.ts";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, context: { params: Promise<{ executionId: string }> }): Promise<NextResponse> {
  try {
    assertSameOrigin(readHeaders(request));
    const { executionId } = await context.params;
    parseId(executionId, "executionId");
    const runtime = getRuntime();
    const response = await reconcileExecution(runtime.deps, executionId);
    return NextResponse.json(response);
  } catch (error) {
    return unknownErrorResponse(error);
  }
}
