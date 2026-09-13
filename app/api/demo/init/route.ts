import { NextResponse, type NextRequest } from "next/server";
import { DEMO_MARKER, type DemoInitResponseDTO } from "../../../../src/server/dto.ts";
import { seedDemoFixtures } from "../../../../src/server/demo-fixtures.ts";
import { getRuntime } from "../../../../src/server/runtime.ts";
import { assertSameOrigin, parseDemoInitBody, readHeaders } from "../../../../src/server/validation.ts";
import { unknownErrorResponse } from "../../_helpers.ts";

export const dynamic = "force-dynamic";

/** Durable fixture initialization. Explicitly demo: requires { "demo": true }. */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    assertSameOrigin(readHeaders(request));
    const body: unknown = await request.json().catch(() => undefined);
    parseDemoInitBody(body);
    const runtime = getRuntime();
    const summary = seedDemoFixtures(runtime.store);
    const response: DemoInitResponseDTO = {
      demo: true,
      mode: DEMO_MARKER,
      businessId: summary.businessId,
      bookingIds: summary.bookingIds,
      proposalIds: summary.proposalIds,
      notice: "DEMO ONLY: seeded fictional records. Not live integrations; receipts are simulated.",
    };
    return NextResponse.json(response);
  } catch (error) {
    return unknownErrorResponse(error);
  }
}
