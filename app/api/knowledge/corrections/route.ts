import { NextResponse, type NextRequest } from "next/server";
import { getRuntime, ownerId } from "../../../../src/server/runtime.ts";
import { decideOperator } from "../../../../src/server/business-operator/index.ts";
import { publishCorrectionEvent } from "../../../../src/knowledge/review.ts";
import { assertSameOrigin, readHeaders } from "../../../../src/server/validation.ts";
import { unknownErrorResponse } from "../../_helpers.ts";
import { ServiceError } from "../../../../src/server/booking-service.ts";
import { collectSources, deploymentMode, knowledgeErrorResponse } from "../_mapper.ts";

export const dynamic = "force-dynamic";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * POST /api/knowledge/corrections
 * Owner correction plus changed-policy event to affected pending work.
 * Accepted snapshots stay immutable; no exception is promoted. The
 * correction itself runs through the strict validated host boundary
 * (decideOperator) with the host-derived owner identity.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    assertSameOrigin(readHeaders(request));
    if ((request.headers.get("content-type") ?? "").includes("application/json") === false) {
      return unknownErrorResponse(new Error("Content-Type must be application/json"));
    }
    const body: unknown = await request.json().catch(() => undefined);
    if (!isRecord(body) || typeof body.businessId !== "string") {
      return unknownErrorResponse(new Error("businessId is required"));
    }
    if (typeof body.key !== "string") {
      return unknownErrorResponse(new Error("key is required"));
    }
    if (typeof body.expectedRevision !== "number" || !Number.isInteger(body.expectedRevision)) {
      return unknownErrorResponse(new Error("expectedRevision must be an integer"));
    }
    if (!isRecord(body.value)) {
      return unknownErrorResponse(new Error("value must be an object"));
    }
    const runtime = getRuntime();
    const deps = {
      store: runtime.store,
      booking: runtime.deps,
      ownerId: ownerId(),
      availability: runtime.deps.calendar,
    };
    // Strict host-boundary correction first (validates sources, binds the
    // owner actor, enforces expectedRevision). The event below only flags
    // pending proposals; accepted snapshots are retained untouched.
    const params: Record<string, unknown> = {
      businessId: body.businessId,
      key: body.key,
      expectedRevision: body.expectedRevision,
      value: body.value,
      ...(typeof body.subjectId === "string" ? { subjectId: body.subjectId } : {}),
      ...(body.sourceReferences === undefined ? {} : { sourceReferences: body.sourceReferences }),
      ...(typeof body.commandId === "string" ? { commandId: body.commandId } : {}),
    };
    const confirm = decideOperator(deps, "correct", params) as {
      revision: { revision: number };
    };
    const event = publishCorrectionEvent(runtime.store, {
      businessId: body.businessId,
      actor: { kind: "owner", id: ownerId() },
      key: body.key,
      ...(typeof body.subjectId === "string" ? { subjectId: body.subjectId } : {}),
      revision: confirm.revision.revision,
    });
    const found: { fictional?: boolean }[] = [];
    collectSources(event, found);
    return NextResponse.json({ mode: deploymentMode(found), event });
  } catch (error) {
    if (error instanceof ServiceError) return unknownErrorResponse(error);
    try {
      return knowledgeErrorResponse(error);
    } catch {
      return unknownErrorResponse(error);
    }
  }
}
