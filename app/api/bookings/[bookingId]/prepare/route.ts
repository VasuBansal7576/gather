import { NextResponse, type NextRequest } from "next/server";
import { getRuntime, ownerId } from "../../../../../src/server/runtime.ts";
import { prepareBookingProposal } from "../../../../../src/server/business-operator/index.ts";
import type { OperatorPrepareRequest } from "../../../../../src/server/business-operator/index.ts";
import { assertSameOrigin, readHeaders } from "../../../../../src/server/validation.ts";
import { unknownErrorResponse } from "../../../_helpers.ts";
import { knowledgeErrorResponse } from "../../../knowledge/_mapper.ts";
import { ServiceError } from "../../../../../src/server/booking-service.ts";

export const dynamic = "force-dynamic";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Prepare a booking proposal from trusted current state and, when the offer
 * is feasible and fully specified, persist the exact proposal. This route
 * never approves, sends, or holds — execution stays in approve/retry.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ bookingId: string }> }): Promise<NextResponse> {
  try {
    assertSameOrigin(readHeaders(request));
    if ((request.headers.get("content-type") ?? "").includes("application/json") === false) {
      return unknownErrorResponse(new Error("Content-Type must be application/json"));
    }
    const { bookingId } = await context.params;
    const body: unknown = await request.json().catch(() => undefined);
    if (!isRecord(body)) return unknownErrorResponse(new Error("Request body must be a JSON object"));
    const runtime = getRuntime();
    const response = await prepareBookingProposal(
      { store: runtime.store, booking: runtime.deps, ownerId: ownerId(), availability: runtime.deps.calendar },
      { ...(body as Record<string, unknown>), bookingId } as unknown as OperatorPrepareRequest,
    );
    return NextResponse.json(response);
  } catch (error) {
    if (error instanceof ServiceError) return unknownErrorResponse(error);
    try {
      return knowledgeErrorResponse(error);
    } catch {
      return unknownErrorResponse(error);
    }
  }
}
