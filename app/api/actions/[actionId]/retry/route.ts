import { NextResponse, type NextRequest } from "next/server";
import { retryFailedSteps } from "../../../../../src/server/booking-service.ts";
import { getRuntime } from "../../../../../src/server/runtime.ts";
import { assertSameOrigin, parseId, readHeaders } from "../../../../../src/server/validation.ts";
import { unknownErrorResponse } from "../../../_helpers.ts";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, context: { params: Promise<{ actionId: string }> }): Promise<NextResponse> {
  try {
    assertSameOrigin(readHeaders(request));
    const { actionId } = await context.params;
    parseId(actionId, "actionId");
    const runtime = getRuntime();
    const response = await retryFailedSteps(runtime.deps, actionId);
    return NextResponse.json(response);
  } catch (error) {
    return unknownErrorResponse(error);
  }
}
