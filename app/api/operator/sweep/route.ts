import { NextResponse, type NextRequest } from "next/server";
import { runOperatorSweep } from "../../../../src/runtime/operator-bridge.ts";
import { assertSameOrigin, readHeaders } from "../../../../src/server/validation.ts";
import { getOperatorDeps } from "../../../../src/server/operator-runtime/host.ts";
import { unknownErrorResponse } from "../../_helpers.ts";

export const dynamic = "force-dynamic";

/** Host-invoked sweep trigger (same-origin guarded). Runs intake + due-work drain. */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    assertSameOrigin(readHeaders(request));
    const deps = getOperatorDeps();
    if (!deps) {
      return NextResponse.json(
        { code: "INTAKE_NOT_CONFIGURED", message: "Operator runtime is not wired by the host", retryable: false, demo: true },
        { status: 503 },
      );
    }
    return NextResponse.json(await runOperatorSweep(deps));
  } catch (error) {
    return unknownErrorResponse(error);
  }
}
