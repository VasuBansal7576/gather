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
    const runtime = getRuntime();
    // ADR-006 durable progress (opt-in): `{ intent: true }` commits the
    // exact approval as a durable intent and returns its handle (202) so
    // long-running approval work reports persisted progress via
    // GET /api/intents/:id. Same authority and error mapping as the sync
    // path — enqueue validates the exact version before anything executes.
    // Absent the flag, the synchronous behavior is byte-identical.
    if (typeof body === "object" && body !== null && (body as Record<string, unknown>).intent === true) {
      const input = parseApproveBody(body, bookingId);
      const { intent, duplicate } = runtime.intents.enqueue({
        command: {
          kind: "approve_booking_proposal",
          bookingId: input.bookingId,
          proposedActionId: input.proposedActionId,
          proposalVersion: input.proposalVersion,
          proposalFingerprint: input.proposalFingerprint,
        },
      });
      const settled = await runtime.intents.drive(intent.id, "http-api");
      return NextResponse.json(
        { intentId: settled.id, duplicate, intent: runtime.intents.toDTO(settled) },
        { status: 202 },
      );
    }
    const input = parseApproveBody(body, bookingId);
    const response = await approveAndExecute(runtime.deps, input);
    return NextResponse.json(response);
  } catch (error) {
    return unknownErrorResponse(error);
  }
}
