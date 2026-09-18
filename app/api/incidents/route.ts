import { NextResponse, type NextRequest } from "next/server";
import { IncidentStore, type EmitIncidentInput } from "../../../src/incidents/store.ts";
import type { IncidentSource, IncidentStatus } from "../../../src/incidents/types.ts";
import { getRuntime } from "../../../src/server/runtime.ts";
import { assertSameOrigin, readHeaders } from "../../../src/server/validation.ts";
import { unknownErrorResponse } from "../_helpers.ts";

export const dynamic = "force-dynamic";

const SOURCES: IncidentSource[] = ["intent_failure", "health", "deadletter", "fault_injection"];
const STATUSES: IncidentStatus[] = ["open", "recovering", "recovered", "blocked"];
const EVIDENCE = ["prepared", "scripted-runtime", "real-runtime", "live-provider"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertEmitBody(body: unknown): EmitIncidentInput {
  if (!isRecord(body)) throw new Error("Request body must be a JSON object");
  if (!SOURCES.includes(body.source as IncidentSource)) {
    throw new Error(`source must be one of ${SOURCES.join(", ")}`);
  }
  const symptom = body.symptom;
  if (!isRecord(symptom) || typeof symptom.signature !== "string" || symptom.signature.length === 0) {
    throw new Error("symptom.signature is required");
  }
  if (typeof symptom.resource !== "string" || symptom.resource.length === 0) {
    throw new Error("symptom.resource is required");
  }
  if (typeof symptom.detail !== "string" || symptom.detail.length === 0) {
    throw new Error("symptom.detail is required");
  }
  if (!(EVIDENCE as readonly string[]).includes(symptom.evidence as string)) {
    throw new Error(`symptom.evidence must be one of ${EVIDENCE.join(", ")}`);
  }
  return {
    source: body.source as IncidentSource,
    symptom: {
      signature: symptom.signature,
      resource: symptom.resource,
      ...(typeof symptom.operation === "string" ? { operation: symptom.operation } : {}),
      detail: symptom.detail,
      evidence: symptom.evidence as EmitIncidentInput["symptom"]["evidence"],
    },
  };
}

/**
 * GET /api/incidents — owner-visible repair threads (C10). Lists persisted
 * incidents, optionally filtered by ?status=. Read-only.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const runtime = getRuntime();
    const store = new IncidentStore(runtime.store.db);
    const url = new URL(request.url);
    const statusParam = url.searchParams.get("status");
    const status = statusParam === null ? undefined : statusParam;
    if (status !== undefined && !STATUSES.includes(status as IncidentStatus)) {
      return unknownErrorResponse(new Error(`Unknown incident status filter: ${status}`));
    }
    const incidents = store.list(status as IncidentStatus | undefined);
    return NextResponse.json({ demo: true, incidents });
  } catch (error) {
    return unknownErrorResponse(error);
  }
}

/**
 * POST /api/incidents — emit (or deduplicate) a scoped incident from an
 * intent failure, health signal, dead-letter, or prepared fault injection.
 * Same-origin guarded; dedupes by affected resource/operation + signature.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    assertSameOrigin(readHeaders(request));
    if ((request.headers.get("content-type") ?? "").includes("application/json") === false) {
      return unknownErrorResponse(new Error("Content-Type must be application/json"));
    }
    const body: unknown = await request.json().catch(() => undefined);
    const input = assertEmitBody(body);
    const runtime = getRuntime();
    const store = new IncidentStore(runtime.store.db);
    const { incident, duplicate } = store.emit(input);
    return NextResponse.json({ demo: true, duplicate, incident }, { status: duplicate ? 200 : 201 });
  } catch (error) {
    return unknownErrorResponse(error);
  }
}
