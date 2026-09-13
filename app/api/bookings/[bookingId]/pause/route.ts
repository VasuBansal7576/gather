import { NextResponse, type NextRequest } from "next/server";
import { CoordinationLedger } from "../../../../../src/coordination/ledger.ts";
import {
  parsePauseBody,
  pauseBooking,
  resumeBooking,
  type RevisionsDeps,
} from "../../../../../src/server/booking-revisions/index.ts";
import { getRuntime, ownerId } from "../../../../../src/server/runtime.ts";
import { assertSameOrigin, readHeaders } from "../../../../../src/server/validation.ts";
import { unknownErrorResponse } from "../../../_helpers.ts";

export const dynamic = "force-dynamic";

function revisionsDeps(): RevisionsDeps {
  const runtime = getRuntime();
  return {
    store: runtime.store,
    booking: runtime.deps,
    ownerId: ownerId(),
    ledger: new CoordinationLedger(runtime.store.db),
  };
}

export async function POST(request: NextRequest, context: { params: Promise<{ bookingId: string }> }): Promise<NextResponse> {
  try {
    assertSameOrigin(readHeaders(request));
    if ((request.headers.get("content-type") ?? "").includes("application/json") === false) {
      return unknownErrorResponse(new Error("Content-Type must be application/json"));
    }
    const { bookingId } = await context.params;
    const body: unknown = await request.json().catch(() => undefined);
    const parsed = parsePauseBody(body, bookingId);
    const deps = revisionsDeps();
    const response = parsed.action === "resume"
      ? resumeBooking(deps, parsed.binding, parsed.note)
      : pauseBooking(deps, parsed.binding, parsed.note);
    return NextResponse.json(response);
  } catch (error) {
    return unknownErrorResponse(error);
  }
}
