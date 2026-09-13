import { NextResponse, type NextRequest } from "next/server";
import { assertSameOrigin, readHeaders } from "../../../../../src/server/validation.ts";
import { getOperatorDeps, getOperatorDepsFor } from "../../../../../src/server/operator-runtime/host.ts";
import { getProactiveBinding, listProactiveBindings } from "../../../../../src/server/operator-runtime/automation.ts";
import { unknownErrorResponse } from "../../../_helpers.ts";

export const dynamic = "force-dynamic";

/**
 * Real scheduler registration state: reports running bindings only. An
 * unwired account reports intake-not-configured, never a fabricated
 * schedule.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    assertSameOrigin(readHeaders(request));
    const accountId = request.nextUrl.searchParams.get("accountId");
    const deps = accountId ? getOperatorDepsFor(accountId) : getOperatorDeps();
    if (!deps) {
      return NextResponse.json(
        { code: "INTAKE_NOT_CONFIGURED", message: "Operator runtime is not wired by the host", retryable: false, demo: true },
        { status: 503 },
      );
    }
    if (accountId && accountId !== deps.accountId) {
      return unknownErrorResponse(new Error("accountId does not match a registered operator binding"));
    }
    const bindings = accountId
      ? [getProactiveBinding(deps.accountId)].filter((b) => b !== undefined)
      : listProactiveBindings();
    return NextResponse.json({ demo: true, accountId: deps.accountId, bindings });
  } catch (error) {
    return unknownErrorResponse(error);
  }
}
