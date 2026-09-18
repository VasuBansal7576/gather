import { NextResponse, type NextRequest } from "next/server";
import { getRuntime, ownerId } from "../../../../src/server/runtime.ts";
import { KnowledgeService } from "../../../../src/knowledge/service.ts";
import { validateConcessionForm } from "../../../../src/knowledge/concessions.ts";
import { assertSameOrigin, readHeaders } from "../../../../src/server/validation.ts";
import { unknownErrorResponse } from "../../_helpers.ts";
import { knowledgeErrorResponse } from "../_mapper.ts";

export const dynamic = "force-dynamic";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * POST /api/knowledge/concessions
 * - { action: 'validate', form } checks the scoped concession form and
 *   returns the canonical draft plus the exact-approval notice. Nothing is
 *   written and no send authority is granted (there is none to grant).
 * - { action: 'confirm', form, commandId? } validates, then records the
 *   scoped exception through the owner-only service path with the
 *   host-derived owner identity.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    assertSameOrigin(readHeaders(request));
    if ((request.headers.get("content-type") ?? "").includes("application/json") === false) {
      return unknownErrorResponse(new Error("Content-Type must be application/json"));
    }
    const body: unknown = await request.json().catch(() => undefined);
    if (!isRecord(body) || typeof body.action !== "string" || !isRecord(body.form)) {
      return unknownErrorResponse(new Error("action (validate|confirm) and form are required"));
    }
    const form = body.form as Parameters<typeof validateConcessionForm>[0];
    if (body.action === "validate") {
      return NextResponse.json({ draft: validateConcessionForm(form) });
    }
    if (body.action === "confirm") {
      if (typeof body.businessId !== "string") {
        return unknownErrorResponse(new Error("confirm requires businessId"));
      }
      const draft = validateConcessionForm(form);
      const runtime = getRuntime();
      const service = new KnowledgeService(runtime.store);
      const result = service.addScopedException({
        businessId: body.businessId,
        actor: { kind: "owner", id: ownerId() },
        policyId: `owner-concession-form:${draft.scope.type}/${draft.scope.id}`,
        effect: "allow",
        scope: draft.scope.type,
        scopeId: draft.scope.id,
        value: draft.value,
        ...(typeof body.commandId === "string" ? { commandId: body.commandId } : {}),
      });
      return NextResponse.json({
        result: {
          factId: result.fact.id,
          revision: result.revision.revision,
          duplicate: result.duplicate,
          scopeLabel: draft.scopeLabel,
          limits: draft.limits,
          sendAuthority: draft.sendAuthority,
          approvalNotice: draft.approvalNotice,
        },
      });
    }
    return unknownErrorResponse(new Error("action must be validate or confirm"));
  } catch (error) {
    try {
      return knowledgeErrorResponse(error);
    } catch {
      return unknownErrorResponse(error);
    }
  }
}
