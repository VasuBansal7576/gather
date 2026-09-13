import { NextResponse } from "next/server";
import { getRuntime } from "../../../../src/server/runtime.ts";
import { LiveModelError, runLiveExecution } from "../../../../src/server/live-model/index.ts";
import type { GatherModelSelection } from "../../../../src/runtime/config.ts";
import { assertSameOrigin, parseId, readHeaders, ValidationError } from "../../../../src/server/validation.ts";
import { connectionErrorResponse } from "../../connections/_helpers.ts";

export const dynamic = "force-dynamic";

const STATUS_BY_CODE: Record<string, number> = {
  MODEL_UNCONFIGURED: 503,
  LIVE_NOT_AUTHORIZED: 409,
  INVALID_REQUEST: 400,
  TOOL_FAILURE: 502,
  POLICY_VIOLATION: 422,
};

function parseModel(value: unknown): GatherModelSelection | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ValidationError("model must be an object { model, auth }");
  }
  return value as GatherModelSelection;
}

/**
 * Owner-scoped execution entry: ONE designated inquiry thread, ONE
 * designated venue-policy file, ONE owner-chosen calendar. The model
 * drives the four registered Gather MCP tools; the journey prepares a
 * source-linked proposal for owner approval — it never approves, sends,
 * or reads outside the designated sources, and stays closed
 * (LIVE_NOT_AUTHORIZED / MODEL_UNCONFIGURED) until consent, the
 * designated account/recipient, and the authorized model path all land.
 * Model-driven tool calling wires up with I's path; until then this
 * entry fails closed with explicit codes instead of simulating success.
 */
export async function POST(req: Request): Promise<NextResponse> {
  try {
    assertSameOrigin(readHeaders(req));
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const businessId = parseId(body.businessId, "businessId");
    const threadId = parseId(body.threadId, "threadId");
    const fileId = parseId(body.fileId, "fileId");
    const calendarId = parseId(body.calendarId, "calendarId");
    if (body.idempotencyKey !== undefined && typeof body.idempotencyKey !== "string") {
      throw new ValidationError("idempotencyKey must be a string");
    }
    const runtime = getRuntime();
    const record = await runLiveExecution(
      {
        businessId,
        threadId,
        fileId,
        calendarId,
        mode: "live",
        allowLive: body.allowLive === true,
        ...(typeof body.idempotencyKey === "string" ? { idempotencyKey: body.idempotencyKey } : {}),
      },
      { store: runtime.store, providers: runtime.providers, model: parseModel(body.model) },
    );
    return NextResponse.json({ run: record });
  } catch (error) {
    if (error instanceof LiveModelError) {
      return NextResponse.json(
        { code: error.code, message: error.message, retryable: error.retryable },
        { status: STATUS_BY_CODE[error.code] ?? 500 },
      );
    }
    return connectionErrorResponse(error);
  }
}
