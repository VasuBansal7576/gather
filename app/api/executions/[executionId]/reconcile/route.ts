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
    // ADR-006 durable progress (opt-in): `{ intent: true }` in the JSON body
    // commits the reconciliation as a durable intent and returns its handle
    // (202) so long-running recovery reports persisted progress via
    // GET /api/intents/:id. Same authority and error mapping as the sync
    // path. Absent the flag, the synchronous behavior is byte-identical.
    const body: unknown = await request.json().catch(() => undefined);
    if (typeof body === "object" && body !== null && (body as Record<string, unknown>).intent === true) {
      const { intent, duplicate } = runtime.intents.enqueue({
        command: { kind: "reconcile_execution", executionId },
      });
      const settled = await runtime.intents.drive(intent.id, "http-api");
      return NextResponse.json(
        { intentId: settled.id, duplicate, intent: runtime.intents.toDTO(settled) },
        { status: 202 },
      );
    }
    const response = await reconcileExecution(runtime.deps, executionId);
    return NextResponse.json(response);
  } catch (error) {
    return unknownErrorResponse(error);
  }
}
