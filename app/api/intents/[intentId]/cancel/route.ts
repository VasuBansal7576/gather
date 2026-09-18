import { NextResponse, type NextRequest } from "next/server";
import { ownerIdentity } from "../../../../../src/server/booking-service.ts";
import { getRuntime } from "../../../../../src/server/runtime.ts";
import { assertSameOrigin, readHeaders } from "../../../../../src/server/validation.ts";
import { unknownErrorResponse } from "../../../_helpers.ts";

export const dynamic = "force-dynamic";

/**
 * POST /api/intents/:id/cancel — owner-attested cancellation. Fences the live
 * claim so no further step dispatches after the next await boundary; already
 * landed effects keep their durable receipts. Terminal records retain their
 * state (applied:false on completed/cancelled).
 */
export async function POST(request: NextRequest, context: { params: Promise<{ intentId: string }> }): Promise<NextResponse> {
  try {
    assertSameOrigin(readHeaders(request));
    const { intentId } = await context.params;
    const runtime = getRuntime();
    const result = runtime.intents.cancel(intentId, ownerIdentity(runtime.deps));
    return NextResponse.json({ intent: runtime.intents.toDTO(result.intent), applied: result.applied });
  } catch (error) {
    return unknownErrorResponse(error);
  }
}
