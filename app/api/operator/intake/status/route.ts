import { NextResponse } from "next/server";
import { OperatorIntakeStore } from "../../../../../src/server/operator-runtime/store.ts";
import { getOperatorDeps } from "../../../../../src/server/operator-runtime/host.ts";
import { unknownErrorResponse } from "../../../_helpers.ts";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    const deps = getOperatorDeps();
    if (!deps) {
      return NextResponse.json(
        { code: "INTAKE_NOT_CONFIGURED", message: "Operator runtime is not wired by the host", retryable: false, demo: true },
        { status: 503 },
      );
    }
    const intake = new OperatorIntakeStore(deps.store.db);
    return NextResponse.json({
      simulation: intake.latestSimulation(deps.accountId),
      latest: intake.latestBatch(deps.accountId) ?? null,
      cursor: intake.getCursor(deps.accountId) ?? null,
    });
  } catch (error) {
    return unknownErrorResponse(error);
  }
}
