import { NextResponse } from "next/server";
import { IncidentStore } from "../../../../src/incidents/store.ts";
import { getRuntime } from "../../../../src/server/runtime.ts";
import { unknownErrorResponse } from "../../_helpers.ts";

export const dynamic = "force-dynamic";

/** GET /api/incidents/:id — one owner-visible repair thread. Read-only. */
export async function GET(_request: Request, context: { params: Promise<{ incidentId: string }> }): Promise<NextResponse> {
  try {
    const { incidentId } = await context.params;
    const runtime = getRuntime();
    const store = new IncidentStore(runtime.store.db);
    return NextResponse.json({ demo: true, incident: store.get(incidentId) });
  } catch (error) {
    return unknownErrorResponse(error);
  }
}
