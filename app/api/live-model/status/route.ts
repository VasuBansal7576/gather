import { NextResponse, type NextRequest } from "next/server";
import { getProfile, isProfileAvailable, listProfiles } from "../../../../src/integrations/registry.ts";
import type { IntegrationProfileId } from "../../../../src/integrations/contracts.ts";
import { getConnectionService } from "../../../../src/server/connections/index.ts";
import { getRuntime } from "../../../../src/server/runtime.ts";
import { liveGateReport } from "../../../../src/server/live-model/live-status.ts";
import { assertSameOrigin, readHeaders } from "../../../../src/server/validation.ts";
import { unknownErrorResponse } from "../../_helpers.ts";

export const dynamic = "force-dynamic";

const PROFILE_IDS = ["base", "assemblyai", "amazon", "nebius"] as const;

/**
 * GET /api/live-model/status?profile=base — owner-visible live capability
 * gate (ADR-006 / C11 / C12).
 *
 * Reports the IntegrationProfile, per-capability gate results, and the exact
 * missing evidence blocking live verification. Without operator-supplied
 * accounts/credentials the report is explicitly BLOCKED — never passed —
 * and no fixture is injected into the empty-account path. This route makes
 * no provider calls and authorizes no effects; collecting evidence never
 * proves a live outcome.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    assertSameOrigin(readHeaders(request));
    const raw = new URL(request.url).searchParams.get("profile") ?? "base";
    if (!(PROFILE_IDS as readonly string[]).includes(raw)) {
      return unknownErrorResponse(new Error(`Unknown integration profile: ${raw}`));
    }
    const profile = raw as IntegrationProfileId;
    const runtime = getRuntime();
    const report = liveGateReport(
      {
        store: runtime.store,
        providerReadiness: () => getConnectionService().providerReadiness(),
      },
      profile,
    );
    return NextResponse.json({
      profile: getProfile(profile),
      available: isProfileAvailable(profile),
      profiles: listProfiles().map((entry) => ({ id: entry.id, label: entry.label, available: isProfileAvailable(entry.id) })),
      gate: report,
    });
  } catch (error) {
    return unknownErrorResponse(error);
  }
}
