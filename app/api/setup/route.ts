import { NextResponse } from "next/server";
import { getConnectionService } from "../../../src/server/connections/index.ts";
import { getRuntime } from "../../../src/server/runtime.ts";
import { connectionErrorResponse } from "../connections/_helpers.ts";

export const dynamic = "force-dynamic";

/**
 * Owner-scoped setup overview: every business in this local Gather store
 * belongs to the configured local owner — the ownerId is server-derived and
 * never taken from the request. Provider readiness is global metadata so the
 * setup UI can show "not configured" without asking for internal ids.
 */
export async function GET(): Promise<NextResponse> {
  try {
    const runtime = getRuntime();
    const businesses = runtime.store.listBusinesses().map((business) => ({
      id: business.id,
      name: business.name,
      timezone: business.timezone,
    }));
    return NextResponse.json({
      ownerId: runtime.deps.ownerId,
      businesses,
      providers: getConnectionService().providerReadiness(),
    });
  } catch (error) {
    return connectionErrorResponse(error);
  }
}
