import { NextResponse, type NextRequest } from "next/server";
import { getOperatorDeps } from "../../../../src/server/operator-runtime/host.ts";
import { unknownErrorResponse } from "../../_helpers.ts";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const deps = getOperatorDeps();
    if (!deps) {
      return NextResponse.json(
        { code: "INTAKE_NOT_CONFIGURED", message: "Operator runtime is not wired by the host", retryable: false, demo: true },
        { status: 503 },
      );
    }
    const limit = Number(request.nextUrl.searchParams.get("limit") ?? "25");
    const now = deps.now ? deps.now() : new Date().toISOString();
    return NextResponse.json(deps.ledger.listDueWork({ nowIso: now, limit }));
  } catch (error) {
    return unknownErrorResponse(error);
  }
}
