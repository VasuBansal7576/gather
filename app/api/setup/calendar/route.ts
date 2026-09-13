import { NextResponse } from "next/server";
import { getConnectionService } from "../../../../src/server/connections/index.ts";
import { getRuntime, ownerId } from "../../../../src/server/runtime.ts";
import {
  bindBusinessCalendar,
  CalendarBindError,
  getBusinessCalendar,
} from "../../../../src/server/proactive/index.ts";
import { assertSameOrigin, parseId, readHeaders, ValidationError } from "../../../../src/server/validation.ts";
import { connectionErrorResponse } from "../../connections/_helpers.ts";

export const dynamic = "force-dynamic";

/**
 * Scoped owner calendar choice. The owner supplies a business and an opaque
 * calendar id (copied from their own Google calendar); the server pins it
 * to that business's single verified connected calendar account. Responses
 * name only the business, calendar id, and account display name — never
 * account ids or binding internals. Missing or ambiguous calendar accounts
 * fail with an owner-actionable code; use-time resolution re-verifies the
 * binding on every call, so nothing here authorizes an arbitrary
 * model-chosen calendar.
 */
export async function GET(req: Request): Promise<NextResponse> {
  try {
    const url = new URL(req.url);
    const businessId = parseId(url.searchParams.get("businessId"), "businessId");
    const runtime = getRuntime();
    const binding = getBusinessCalendar({
      store: runtime.store,
      connectionService: getConnectionService(),
      businessId,
    });
    if (!binding) {
      return NextResponse.json({ businessId, bound: false }, { status: 404 });
    }
    return NextResponse.json(binding);
  } catch (error) {
    return connectionErrorResponse(error);
  }
}

export async function POST(req: Request): Promise<NextResponse> {
  try {
    assertSameOrigin(readHeaders(req));
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const businessId = parseId(body.businessId, "businessId");
    if (typeof body.calendarId !== "string") throw new ValidationError("calendarId must be a string");
    const runtime = getRuntime();
    const binding = bindBusinessCalendar({
      store: runtime.store,
      connectionService: getConnectionService(),
      ownerId: ownerId(),
      businessId,
      calendarId: body.calendarId,
    });
    return NextResponse.json(binding);
  } catch (error) {
    if (error instanceof CalendarBindError) {
      return NextResponse.json({ code: error.code, message: error.message, retryable: error.retryable }, { status: 409 });
    }
    return connectionErrorResponse(error);
  }
}
