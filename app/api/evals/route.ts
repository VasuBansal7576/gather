import { NextResponse, type NextRequest } from "next/server";
import { loadCaseSet } from "../../../src/evals/case-set.ts";
import { assertSameOrigin, readHeaders } from "../../../src/server/validation.ts";
import { unknownErrorResponse } from "../_helpers.ts";

export const dynamic = "force-dynamic";

/**
 * GET /api/evals — the versioned regression case set (ids, questions and
 * expectations). Scores are computed per business by POST /api/evals/run.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    assertSameOrigin(readHeaders(request));
    const caseSet = loadCaseSet();
    return NextResponse.json({ caseSet });
  } catch (error) {
    return unknownErrorResponse(error);
  }
}
