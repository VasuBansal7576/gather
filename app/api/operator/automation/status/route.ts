import { NextResponse, type NextRequest } from "next/server";
import { assertSameOrigin, readHeaders } from "../../../../../src/server/validation.ts";
import { getOperatorDeps, getOperatorDepsFor, listOperatorAccounts } from "../../../../../src/server/operator-runtime/host.ts";
import { getProactiveBinding, listProactiveBindingsForAccounts } from "../../../../../src/server/operator-runtime/automation.ts";
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
    // Proactive bindings live in a separate registry from operator deps:
    // only bindings whose accounts are actually wired are authoritative —
    // an unscoped listing must never leak entries for unwired accounts.
    // `watching` is true only for a running binding whose latest sweep
    // succeeded: nothing here claims watching before real registration
    // and a first successful sweep.
    const bindings = (accountId
      ? [getProactiveBinding(deps.accountId)].filter((b) => b !== undefined)
      : listProactiveBindingsForAccounts(listOperatorAccounts())
    ).map((binding) => ({
      ...binding,
      watching: binding.status === "running" && binding.lastOk === true,
    }));
    return NextResponse.json({ demo: true, accountId: deps.accountId, bindings });
  } catch (error) {
    return unknownErrorResponse(error);
  }
}
