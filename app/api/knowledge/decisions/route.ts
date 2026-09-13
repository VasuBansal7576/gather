import { NextResponse, type NextRequest } from "next/server";
import { getRuntime, ownerId } from "../../../../src/server/runtime.ts";
import { decideOperator, type OperatorDecisionKind } from "../../../../src/server/business-operator/index.ts";
import { assertSameOrigin, readHeaders } from "../../../../src/server/validation.ts";
import { unknownErrorResponse } from "../../_helpers.ts";
import { collectSources, deploymentMode, knowledgeErrorResponse } from "../_mapper.ts";
import { ServiceError } from "../../../../src/server/booking-service.ts";

export const dynamic = "force-dynamic";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const KINDS = new Set(["confirm", "correct", "reject", "exception"]);

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    assertSameOrigin(readHeaders(request));
    if ((request.headers.get("content-type") ?? "").includes("application/json") === false) {
      return unknownErrorResponse(new Error("Content-Type must be application/json"));
    }
    const body: unknown = await request.json().catch(() => undefined);
    if (!isRecord(body) || typeof body.kind !== "string" || !KINDS.has(body.kind)) {
      return unknownErrorResponse(new Error("Decision kind must be confirm, correct, reject, or exception"));
    }
    // The approving actor is always the host-derived owner identity:
    // request-supplied actors (including customer or model text) are ignored.
    const { actor: _ignored, kind: _kind, ...params } = body;
    const runtime = getRuntime();
    const result = decideOperator(
      { store: runtime.store, booking: runtime.deps, ownerId: ownerId(), availability: runtime.deps.calendar },
      body.kind as OperatorDecisionKind,
      params,
    );
    const found: { fictional?: boolean }[] = []; collectSources(result, found);
    return NextResponse.json({ mode: deploymentMode(found), kind: body.kind, result });
  } catch (error) {
    if (error instanceof ServiceError) return unknownErrorResponse(error);
    try {
      return knowledgeErrorResponse(error);
    } catch {
      return unknownErrorResponse(error);
    }
  }
}
