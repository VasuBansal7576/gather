import { NextResponse, type NextRequest } from "next/server";
import { CoordinationLedger } from "../../../../../src/coordination/ledger.ts";
import {
  parseCancellationBody,
  requestCancellation,
  toVerifyRequest,
  verifyCancellation,
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
    // No hold-release connector is wired into this runtime: verification
    // without release proof stays explicitly blocked (never cancelled).
    // The integration hook is the injectable `holdRelease` port.
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
    const parsed = parseCancellationBody(body, bookingId);
    const deps = revisionsDeps();
    const response = parsed.action === "verify"
      ? await verifyCancellation(deps, toVerifyRequest(parsed))
      : requestCancellation(deps, parsed.binding, parsed.note);
    return NextResponse.json(response);
  } catch (error) {
    return unknownErrorResponse(error);
  }
}
