import { NextResponse } from "next/server";
import { operatorHealth } from "../../../../src/server/operator-runtime/health.ts";
import { getOperatorDeps } from "../../../../src/server/operator-runtime/host.ts";
import { unknownErrorResponse } from "../../_helpers.ts";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    const deps = getOperatorDeps();
    if (!deps) {
      return NextResponse.json(
        { code: "INTAKE_NOT_CONFIGURED", message: "Operator runtime is not wired by the host; no simulated health is reported", retryable: false, demo: true },
        { status: 503 },
      );
    }
    return NextResponse.json(operatorHealth(deps));
  } catch (error) {
    return unknownErrorResponse(error);
  }
}
