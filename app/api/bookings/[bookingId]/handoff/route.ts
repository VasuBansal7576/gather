import { NextResponse, type NextRequest } from "next/server";
import { handoffForBooking } from "../../../../../src/server/booking-delivery/index.ts";
import { getDeliveryRuntime } from "../../../../../src/server/booking-delivery/runtime.ts";
import { assertSameOrigin, readHeaders } from "../../../../../src/server/validation.ts";
import { unknownErrorResponse } from "../../../_helpers.ts";

export const dynamic = "force-dynamic";

/** Operational handoff tied to the accepted proposal version. */
export async function GET(request: NextRequest, context: { params: Promise<{ bookingId: string }> }): Promise<NextResponse> {
  try {
    assertSameOrigin(readHeaders(request));
    const { bookingId } = await context.params;
    const { deps } = getDeliveryRuntime();
    const response = await handoffForBooking(deps, bookingId);
    return NextResponse.json(response);
  } catch (error) {
    return unknownErrorResponse(error);
  }
}
