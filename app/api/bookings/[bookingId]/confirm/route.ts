import { NextResponse, type NextRequest } from "next/server";
import { confirmBooking } from "../../../../../src/server/booking-delivery/index.ts";
import { getDeliveryRuntime } from "../../../../../src/server/booking-delivery/runtime.ts";
import { parseConfirmBody } from "../../../../../src/server/booking-delivery/validation.ts";
import { assertSameOrigin, readHeaders } from "../../../../../src/server/validation.ts";
import { unknownErrorResponse } from "../../../_helpers.ts";

export const dynamic = "force-dynamic";

/** Guarded confirmation: revalidates proofs immediately before the transition. */
export async function POST(request: NextRequest, context: { params: Promise<{ bookingId: string }> }): Promise<NextResponse> {
  try {
    assertSameOrigin(readHeaders(request));
    if ((request.headers.get("content-type") ?? "").includes("application/json") === false) {
      return unknownErrorResponse(new Error("Content-Type must be application/json"));
    }
    const { bookingId } = await context.params;
    const body: unknown = await request.json().catch(() => undefined);
    const input = parseConfirmBody(body, bookingId);
    const { deps } = getDeliveryRuntime();
    const response = await confirmBooking(deps, input);
    return NextResponse.json(response);
  } catch (error) {
    return unknownErrorResponse(error);
  }
}
