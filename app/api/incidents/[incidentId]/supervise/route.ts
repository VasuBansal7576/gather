import { NextResponse, type NextRequest } from "next/server";
import { superviseIncident } from "../../../../../src/incidents/supervisor.ts";
import { IncidentStore } from "../../../../../src/incidents/store.ts";
import { getRuntime } from "../../../../../src/server/runtime.ts";
import { assertSameOrigin, readHeaders } from "../../../../../src/server/validation.ts";
import { unknownErrorResponse } from "../../../_helpers.ts";

export const dynamic = "force-dynamic";

/**
 * POST /api/incidents/:id/supervise — run the bounded supervisor loop over
 * one incident with server-wired read-only ports only.
 *
 * The ONLY repair port wired here is read-only reconciliation against the
 * durable provider-receipt table: an execution_uncertain incident whose
 * operation key has a matching durable receipt in the same booking scope
 * can genuinely recover over HTTP. Every other catalog action has no port
 * and blocks honestly with its precondition reason: no runtime restarts,
 * no sync/account/config/intent effects are reachable over HTTP. Full
 * recovery paths are proven in the incident test suite with explicit
 * ports; this endpoint demonstrates the honest loop (diagnose -> bounded
 * attempts -> recovered or blocked) without inventing authority.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ incidentId: string }> }): Promise<NextResponse> {
  try {
    assertSameOrigin(readHeaders(request));
    const { incidentId } = await context.params;
    const runtime = getRuntime();
    const store = runtime.store;
    const incidents = new IncidentStore(store.db);
    const current = incidents.get(incidentId);
    const operationKey = current.symptom.operation;
    const bookingMatch = /^booking:(.+)$/.exec(current.symptom.resource);
    const result = await superviseIncident(incidents, incidentId, {
      execution: {
        operationIdentity: operationKey && bookingMatch ? { operationKey, bookingId: bookingMatch[1] } : undefined,
        authorizedRead: true,
        reconcileByExternalId: async (key: string) => {
          const receipt = store.getProviderReceipt(key);
          if (!receipt) return { matched: false, reason: "no durable provider receipt for this operation key" };
          return { matched: true, providerResult: JSON.stringify(receipt.receipt).slice(0, 500), bookingId: bookingMatch?.[1] ?? "" };
        },
      },
    });
    return NextResponse.json({ demo: true, incident: result.incident, bookingContinued: result.bookingContinued });
  } catch (error) {
    return unknownErrorResponse(error);
  }
}
