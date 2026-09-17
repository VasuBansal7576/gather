import { NextResponse, type NextRequest } from "next/server";
import { getRuntime } from "../../../../src/server/runtime.ts";
import { unknownErrorResponse } from "../../_helpers.ts";

export const dynamic = "force-dynamic";

/** GET /api/intents/:id — persisted durable progress for one intent. */
export async function GET(_request: NextRequest, context: { params: Promise<{ intentId: string }> }): Promise<NextResponse> {
  try {
    const { intentId } = await context.params;
    const runtime = getRuntime();
    return NextResponse.json({ intent: runtime.intents.toDTO(runtime.intents.get(intentId)) });
  } catch (error) {
    return unknownErrorResponse(error);
  }
}
