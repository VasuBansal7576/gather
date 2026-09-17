import { NextResponse, type NextRequest } from "next/server";
import { getRuntime } from "../../../../src/server/runtime.ts";
import { assertSameOrigin, readHeaders } from "../../../../src/server/validation.ts";
import { unknownErrorResponse } from "../../_helpers.ts";
import { ServiceError } from "../../../../src/server/booking-service.ts";

export const dynamic = "force-dynamic";

/**
 * POST /api/intents/reconcile — read-only provider reconciliation for one
 * stable operation key, resyncing every intent whose steps reference it.
 * Missing provider evidence leaves the step uncertain; it never licenses a
 * blind retry.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    assertSameOrigin(readHeaders(request));
    if ((request.headers.get("content-type") ?? "").includes("application/json") === false) {
      return unknownErrorResponse(new Error("Content-Type must be application/json"));
    }
    const body: unknown = await request.json().catch(() => undefined);
    const operationKey = typeof body === "object" && body !== null ? (body as Record<string, unknown>).operationKey : undefined;
    if (typeof operationKey !== "string" || operationKey.trim().length === 0) {
      throw new ServiceError("INVALID_REQUEST", "operationKey must be a non-empty string", false);
    }
    const runtime = getRuntime();
    const report = await runtime.intents.reconcile(operationKey);
    return NextResponse.json({
      operationKey: report.operationKey,
      outcome: report.outcome,
      execution: report.execution,
      intents: report.intents.map((intent) => runtime.intents.toDTO(intent)),
      ...(report.error === undefined ? {} : { error: report.error }),
    });
  } catch (error) {
    return unknownErrorResponse(error);
  }
}
