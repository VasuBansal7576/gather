import { NextResponse, type NextRequest } from "next/server";
import { approveAndExecute } from "../../../../../src/server/booking-service.ts";
import { getRuntime } from "../../../../../src/server/runtime.ts";
import { assertSameOrigin, parseApproveBody, readHeaders } from "../../../../../src/server/validation.ts";
import { unknownErrorResponse } from "../../../_helpers.ts";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, context: { params: Promise<{ bookingId: string }> }): Promise<NextResponse> {
  try {
    assertSameOrigin(readHeaders(request));
    if ((request.headers.get("content-type") ?? "").includes("application/json") === false) {
      return unknownErrorResponse(new Error("Content-Type must be application/json"));
    }
    const { bookingId } = await context.params;
    const body: unknown = await request.json().catch(() => undefined);
    const input = parseApproveBody(body, bookingId);
    const runtime = getRuntime();
    const response = await approveAndExecute(runtime.deps, input);
    return NextResponse.json(response);
  } catch (error) {
    return unknownErrorResponse(error);
  }
}
