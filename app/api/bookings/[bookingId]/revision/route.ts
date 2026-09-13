import { NextResponse, type NextRequest } from "next/server";
import { CoordinationLedger } from "../../../../../src/coordination/ledger.ts";
import { parseRevisionBody, requestRevision, type RevisionsDeps } from "../../../../../src/server/booking-revisions/index.ts";
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
    // No hold-release connector is wired into this runtime: revision guards
    // treat unreleased obsolete holds as explicitly blocked. The integration
    // hook is the injectable `holdRelease` port on RevisionsDeps.
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
    const input = parseRevisionBody(body, bookingId);
    const response = await requestRevision(revisionsDeps(), input);
    return NextResponse.json(response);
  } catch (error) {
    return unknownErrorResponse(error);
  }
}
