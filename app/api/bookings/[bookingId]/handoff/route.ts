import { NextResponse, type NextRequest } from "next/server";
import { handoffForBooking, recordHandoff } from "../../../../../src/server/booking-delivery/index.ts";
import { getDeliveryRuntime } from "../../../../../src/server/booking-delivery/runtime.ts";
import { assertSameOrigin, readHeaders } from "../../../../../src/server/validation.ts";
import { unknownErrorResponse } from "../../../_helpers.ts";

export const dynamic = "force-dynamic";

/**
 * Read-only operational handoff view for the current proposal. Reports the
 * latest persisted revision; never creates one.
 */
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

/**
 * Explicit build command: evaluates fresh and persists a new numbered
 * handoff revision tied to the exact accepted proposal version.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ bookingId: string }> }): Promise<NextResponse> {
  try {
    assertSameOrigin(readHeaders(request));
    const { bookingId } = await context.params;
    const { deps } = getDeliveryRuntime();
    const response = await recordHandoff(deps, bookingId);
    return NextResponse.json(response);
  } catch (error) {
    return unknownErrorResponse(error);
  }
}
