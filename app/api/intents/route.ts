import { NextResponse, type NextRequest } from "next/server";
import { assertValidEnqueueBody, type IntentState } from "../../../src/intents/index.ts";
import { ServiceError } from "../../../src/server/booking-service.ts";
import { getRuntime } from "../../../src/server/runtime.ts";
import { assertSameOrigin, readHeaders } from "../../../src/server/validation.ts";
import { unknownErrorResponse } from "../_helpers.ts";

export const dynamic = "force-dynamic";

const INTENT_STATES = new Set(["queued", "running", "completed", "retryable", "uncertain", "blocked", "cancelled"]);

/**
 * POST /api/intents — durable command submission (ADR-002 / C06). The intent
 * is validated and committed before the 202; the response carries the
 * durable handle, never a premature success claim. A best-effort bounded
 * advance runs inline so installs without a connected account still
 * progress; the persisted `state` field always tells the truth
 * (queued/running/completed/retryable/uncertain/blocked/cancelled).
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    assertSameOrigin(readHeaders(request));
    if ((request.headers.get("content-type") ?? "").includes("application/json") === false) {
      return unknownErrorResponse(new Error("Content-Type must be application/json"));
    }
    const body: unknown = await request.json().catch(() => undefined);
    const input = assertValidEnqueueBody(body);
    const runtime = getRuntime();
    const { intent, duplicate } = runtime.intents.enqueue(input);
    // drive() is a no-op for terminal or concurrently claimed intents.
    const settled = await runtime.intents.drive(intent.id, "http-api");
    return NextResponse.json(
      { intentId: settled.id, duplicate, intent: runtime.intents.toDTO(settled) },
      { status: 202 },
    );
  } catch (error) {
    return unknownErrorResponse(error);
  }
}

/** GET /api/intents — durable intent listing with optional scope filters. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const runtime = getRuntime();
    const url = new URL(request.url);
    const state = url.searchParams.get("state") ?? undefined;
    if (state !== undefined && !INTENT_STATES.has(state)) {
      throw new ServiceError("INVALID_REQUEST", `Unknown intent state filter: ${state}`, false);
    }
    const limitParam = url.searchParams.get("limit");
    const limit = limitParam === null ? undefined : Number.parseInt(limitParam, 10);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw new ServiceError("INVALID_REQUEST", "limit must be a positive integer", false);
    }
    const intents = runtime.intents.list({
      ...(url.searchParams.get("businessId") === null ? {} : { businessId: url.searchParams.get("businessId") as string }),
      ...(url.searchParams.get("bookingId") === null ? {} : { bookingId: url.searchParams.get("bookingId") as string }),
      ...(state === undefined ? {} : { state: state as IntentState }),
      ...(limit === undefined ? {} : { limit }),
    });
    return NextResponse.json({ intents: intents.map((intent) => runtime.intents.toDTO(intent)) });
  } catch (error) {
    return unknownErrorResponse(error);
  }
}
