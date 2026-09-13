import { NextResponse } from "next/server";
import { getWorkspace } from "../../../src/server/booking-service.ts";
import { getRuntime } from "../../../src/server/runtime.ts";
import { unknownErrorResponse } from "../_helpers.ts";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    const runtime = getRuntime();
    return NextResponse.json(getWorkspace(runtime.store, { ownerId: runtime.deps.ownerId, calendarId: runtime.deps.calendarId }));
  } catch (error) {
    return unknownErrorResponse(error);
  }
}
