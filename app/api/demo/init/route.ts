import { NextResponse, type NextRequest } from "next/server";
import { DEMO_MARKER, type DemoInitResponseDTO } from "../../../../src/server/dto.ts";
import {
  isPreparedScenarioId,
  seedPreparedFixtures,
  type PreparedScenarioId,
} from "../../../../src/server/demo-fixtures.ts";
import { gatherMode, getRuntime, isManagedInstall } from "../../../../src/server/runtime.ts";
import { assertSameOrigin, parseDemoInitBody, readHeaders, ValidationError } from "../../../../src/server/validation.ts";
import { unknownErrorResponse } from "../../_helpers.ts";

export const dynamic = "force-dynamic";

/** Response gains scenario fields additively; existing clients see the same required keys. */
interface DemoInitResponse extends DemoInitResponseDTO {
  scenario: PreparedScenarioId;
  inboxCount: number;
  busyBlockCount: number;
  offerCount: number;
  coverage: string;
  coverageDetail: string;
}

/**
 * Durable fixture initialization. Explicitly demo: requires { "demo": true }.
 *
 * Compatibility: a bare { "demo": true } keeps the legacy two-proposal seed
 * in unmanaged runs, exactly as before. The optional `scenario` field selects
 * a named prepared scenario (default "glasshouse" under a managed install);
 * "legacy" names the old regression seed explicitly. Fixtures are never
 * seeded into a managed live-mode store.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    assertSameOrigin(readHeaders(request));
    const body: unknown = await request.json().catch(() => undefined);
    parseDemoInitBody(body);
    const rawScenario = (body as Record<string, unknown>).scenario;
    if (rawScenario !== undefined && !isPreparedScenarioId(rawScenario)) {
      throw new ValidationError(`scenario must be one of: glasshouse, empty, non-event, partial, connection-failed, legacy`);
    }
    const managed = isManagedInstall();
    if (managed && gatherMode() === "live") {
      return NextResponse.json(
        { code: "DENIED", message: "Fixtures are never seeded into live state.", retryable: false, demo: true },
        { status: 403 },
      );
    }
    const scenario: PreparedScenarioId = rawScenario ?? (managed ? "glasshouse" : "legacy");
    const runtime = getRuntime();
    const summary = seedPreparedFixtures(runtime.store, scenario);
    const response: DemoInitResponse = {
      demo: true,
      mode: DEMO_MARKER,
      businessId: summary.businessId,
      bookingIds: summary.bookingIds,
      proposalIds: summary.proposalIds,
      scenario: summary.scenario,
      inboxCount: summary.inboxCount,
      busyBlockCount: summary.busyBlockCount,
      offerCount: summary.offerCount,
      coverage: summary.coverage,
      coverageDetail: summary.coverageDetail,
      notice: "DEMO ONLY: seeded fictional records. Not live integrations; receipts are simulated.",
    };
    return NextResponse.json(response);
  } catch (error) {
    return unknownErrorResponse(error);
  }
}
