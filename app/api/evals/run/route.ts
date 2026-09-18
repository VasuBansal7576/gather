import { NextResponse, type NextRequest } from "next/server";
import { getRuntime } from "../../../../src/server/runtime.ts";
import { KnowledgeService } from "../../../../src/knowledge/service.ts";
import { PreparedKnowledgePort } from "../../../../src/knowledge/prepared.ts";
import { loadCaseSet } from "../../../../src/evals/case-set.ts";
import { compareRuns, runCaseSet, type EvalRun } from "../../../../src/evals/runner.ts";
import { assertSameOrigin, readHeaders } from "../../../../src/server/validation.ts";
import { unknownErrorResponse } from "../../_helpers.ts";

export const dynamic = "force-dynamic";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEvalRun(value: unknown): value is EvalRun {
  return (
    isRecord(value) &&
    typeof value.caseSetVersion === "string" &&
    typeof value.businessId === "string" &&
    Array.isArray(value.answeredIds) &&
    Array.isArray(value.outcomes)
  );
}

/**
 * POST /api/evals/run
 * - { action: 'run', businessId, onlyIds? } runs the versioned case set
 *   against this business's prepared KnowledgePort and returns the run with
 *   honest denominators (unanswered cases are unmeasured, never scored).
 * - { action: 'compare', before, after } compares two runs from the same
 *   case-set version; added cases are reported as denominator changes, never
 *   as improvement. No causal business-improvement claim is ever made.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    assertSameOrigin(readHeaders(request));
    if ((request.headers.get("content-type") ?? "").includes("application/json") === false) {
      return unknownErrorResponse(new Error("Content-Type must be application/json"));
    }
    const body: unknown = await request.json().catch(() => undefined);
    if (!isRecord(body) || typeof body.action !== "string") {
      return unknownErrorResponse(new Error("action must be run or compare"));
    }
    if (body.action === "run") {
      if (typeof body.businessId !== "string") {
        return unknownErrorResponse(new Error("run requires businessId"));
      }
      if (body.onlyIds !== undefined && (!Array.isArray(body.onlyIds) || body.onlyIds.some((id) => typeof id !== "string"))) {
        return unknownErrorResponse(new Error("onlyIds must be a string array when present"));
      }
      const runtime = getRuntime();
      const service = new KnowledgeService(runtime.store);
      const port = new PreparedKnowledgePort(service, body.businessId);
      const run = runCaseSet(port, body.businessId, loadCaseSet(), {
        ...(Array.isArray(body.onlyIds) ? { onlyIds: body.onlyIds as string[] } : {}),
      });
      return NextResponse.json({ run });
    }
    if (body.action === "compare") {
      if (!isEvalRun(body.before) || !isEvalRun(body.after)) {
        return unknownErrorResponse(new Error("compare requires before and after runs"));
      }
      return NextResponse.json({ comparison: compareRuns(body.before, body.after) });
    }
    return unknownErrorResponse(new Error("action must be run or compare"));
  } catch (error) {
    return unknownErrorResponse(error);
  }
}
