import { NextResponse, type NextRequest } from "next/server";
import { getOperatorDeps } from "../../../../../src/server/operator-runtime/host.ts";
import { assertSameOrigin, readHeaders, ValidationError } from "../../../../../src/server/validation.ts";
import { unknownErrorResponse } from "../../../_helpers.ts";

export const dynamic = "force-dynamic";

/**
 * Owner-triggered source scan / history expansion (ADR-007). The scope is
 * server-derived from the wired port — the body may only request the
 * expansion step count, never account, business, or provider targets.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    assertSameOrigin(readHeaders(request));
    const deps = getOperatorDeps();
    if (!deps || deps.sources === undefined) {
      return NextResponse.json(
        { code: "INTAKE_NOT_CONFIGURED", message: "Source pipeline is not wired by the host", retryable: false, demo: true },
        { status: 503 },
      );
    }
    let expandWindows = 0;
    let limit: number | undefined;
    const raw: unknown = await request.json().catch(() => ({}));
    if (typeof raw === "object" && raw !== null) {
      const body = raw as Record<string, unknown>;
      if (body.expandWindows !== undefined) {
        if (!Number.isInteger(body.expandWindows) || (body.expandWindows as number) < 1 || (body.expandWindows as number) > 12) {
          throw new ValidationError("expandWindows must be an integer between 1 and 12");
        }
        expandWindows = body.expandWindows as number;
      }
      if (body.limit !== undefined) {
        if (!Number.isInteger(body.limit) || (body.limit as number) < 1 || (body.limit as number) > 500) {
          throw new ValidationError("limit must be an integer between 1 and 500");
        }
        limit = body.limit as number;
      }
    }
    const result = expandWindows > 0
      ? await deps.sources.expandHistory(expandWindows)
      : await deps.sources.scan({ ...(limit === undefined ? {} : { limit }) });
    return NextResponse.json({
      simulation: deps.inbox.provenance.simulated,
      emitted: result.records.length,
      events: result.events.map((event) => ({ kind: event.kind, sourceKey: event.sourceKey, version: event.version ?? null })),
      exhausted: result.exhausted,
      nextCursor: result.nextCursor ?? null,
      coverage: result.coverage,
    });
  } catch (error) {
    return unknownErrorResponse(error);
  }
}
