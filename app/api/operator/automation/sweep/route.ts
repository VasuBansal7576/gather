import { NextResponse, type NextRequest } from "next/server";
import { assertSameOrigin, readHeaders } from "../../../../../src/server/validation.ts";
import { getOperatorDeps, getOperatorDepsFor } from "../../../../../src/server/operator-runtime/host.ts";
import { tickBinding } from "../../../../../src/server/operator-runtime/automation.ts";
import { unknownErrorResponse } from "../../../_helpers.ts";

export const dynamic = "force-dynamic";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Host-invoked manual sweep trigger (same-origin guarded): runs exactly one
 * guarded cycle for the server-resolved binding and reports it. Scope comes
 * from registered bindings only — never from untrusted account selection.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    assertSameOrigin(readHeaders(request));
    if ((request.headers.get("content-type") ?? "").includes("application/json") === false) {
      return unknownErrorResponse(new Error("Content-Type must be application/json"));
    }
    const body: unknown = await request.json().catch(() => undefined);
    const accountId = isRecord(body) && typeof body.accountId === "string" ? body.accountId : undefined;
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
    return NextResponse.json({ demo: true, ...(await tickBinding(deps.accountId)) });
  } catch (error) {
    return unknownErrorResponse(error);
  }
}
