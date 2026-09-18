import { NextResponse, type NextRequest } from "next/server";
import { FAULT_CATALOG, injectFault } from "../../../src/incidents/faults.ts";
import { IncidentStore } from "../../../src/incidents/store.ts";
import { getRuntime } from "../../../src/server/runtime.ts";
import { assertSameOrigin, readHeaders } from "../../../src/server/validation.ts";
import { unknownErrorResponse } from "../_helpers.ts";

export const dynamic = "force-dynamic";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * GET /api/faults — prepared fault-injection catalog. Every entry carries
 * its kind label (scripted vs real-restart-opt-in); nothing here is real
 * runtime evidence.
 */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ demo: true, faults: FAULT_CATALOG });
}

/**
 * POST /api/faults — inject one prepared fault and emit its scoped
 * incident. Same-origin guarded. The real-restart fault refuses without
 * explicit opt-in (GATHER_TEST_REAL_RESTART=1); all other faults are
 * labelled scripted fixtures.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    assertSameOrigin(readHeaders(request));
    if ((request.headers.get("content-type") ?? "").includes("application/json") === false) {
      return unknownErrorResponse(new Error("Content-Type must be application/json"));
    }
    const body: unknown = await request.json().catch(() => undefined);
    if (!isRecord(body) || typeof body.faultId !== "string" || body.faultId.length === 0) {
      return unknownErrorResponse(new Error("faultId is required"));
    }
    let injected;
    try {
      injected = injectFault(body.faultId);
    } catch (error) {
      // Opt-in refusal is a 403, not a 400: the fault exists but this
      // caller is not authorized to trigger a real process.
      return NextResponse.json(
        { code: "DENIED", message: error instanceof Error ? error.message : String(error), retryable: false, demo: true },
        { status: 403 },
      );
    }
    const runtime = getRuntime();
    const store = new IncidentStore(runtime.store.db);
    const { incident, duplicate } = store.emit({ source: injected.source, symptom: injected.symptom });
    return NextResponse.json({ demo: true, faultId: injected.faultId, duplicate, incident }, { status: duplicate ? 200 : 201 });
  } catch (error) {
    return unknownErrorResponse(error);
  }
}
