import { NextResponse, type NextRequest } from "next/server";
import { assertSameOrigin, readHeaders } from "../../../../src/server/validation.ts";
import { getOperatorDeps, getOperatorDepsFor } from "../../../../src/server/operator-runtime/host.ts";
import { retryDeadLetteredItem } from "../../../../src/server/operator-runtime/intake.ts";
import { unknownErrorResponse } from "../../_helpers.ts";

export const dynamic = "force-dynamic";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Explicit authorized dead-letter recovery (same-origin guarded, host
 * only). Scope is server-derived: the account must name a registered
 * binding (or the single default), and the business always comes from that
 * binding — an untrusted account selection without ownership is refused.
 * Re-arms exactly one validated dead-lettered message; never approvals,
 * links, or bulk retries.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    assertSameOrigin(readHeaders(request));
    if ((request.headers.get("content-type") ?? "").includes("application/json") === false) {
      return unknownErrorResponse(new Error("Content-Type must be application/json"));
    }
    const body: unknown = await request.json().catch(() => undefined);
    if (!isRecord(body) || typeof body.messageId !== "string" || body.messageId.length === 0) {
      return unknownErrorResponse(new Error("messageId is required"));
    }
    const accountId = typeof body.accountId === "string" && body.accountId.length > 0 ? body.accountId : undefined;
    const deps = accountId ? getOperatorDepsFor(accountId) : getOperatorDeps();
    if (!deps) {
      return NextResponse.json(
        { code: "INTAKE_NOT_CONFIGURED", message: "Operator runtime is not wired by the host", retryable: false, demo: true },
        { status: 503 },
      );
    }
    if (accountId && accountId !== deps.accountId) {
      return unknownErrorResponse(new Error("accountId does not match a registered operator binding"));
    }
    const item = retryDeadLetteredItem(
      { store: deps.store, accountId: deps.accountId, businessId: deps.businessId },
      { messageId: body.messageId },
    );
    return NextResponse.json({ demo: true, item: { id: item.id, messageId: item.messageId, status: item.status, dead: item.dead, attempts: item.attempts } });
  } catch (error) {
    return unknownErrorResponse(error);
  }
}
