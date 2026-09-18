import { NextResponse, type NextRequest } from "next/server";
import { getRuntime } from "../../../../../src/server/runtime.ts";
import { assertSameOrigin, readHeaders } from "../../../../../src/server/validation.ts";
import { unknownErrorResponse } from "../../../_helpers.ts";

export const dynamic = "force-dynamic";

/**
 * POST /api/intents/:id/advance — explicitly re-drive a runnable intent
 * (queued/retryable/uncertain, or a dead `running` claim past its lease).
 * Reconcile-first: reclaimed or uncertain steps are resolved against provider
 * evidence before any new write. Terminal intents return their persisted
 * state unchanged.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ intentId: string }> }): Promise<NextResponse> {
  try {
    assertSameOrigin(readHeaders(request));
    const { intentId } = await context.params;
    const runtime = getRuntime();
    // Explicit owner action may reopen a blocked intent; drains never do.
    const settled = await runtime.intents.drive(intentId, "http-api", { reopenBlocked: true });
    return NextResponse.json({ intent: runtime.intents.toDTO(settled) });
  } catch (error) {
    return unknownErrorResponse(error);
  }
}
