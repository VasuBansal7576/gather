import { NextResponse } from "next/server";
import { ConnectionError, getConnectionService } from "../../../../../src/server/connections/index.ts";
import { refreshProactiveHost } from "../../../../../src/server/proactive/index.ts";
import { ValidationError } from "../../../../../src/server/validation.ts";

export const dynamic = "force-dynamic";

/**
 * Google redirects the owner's browser here after consent. The route only
 * relays code+state into the service — all validation (state hash, expiry,
 * replay, PKCE, scope coverage, verified identity, business binding) happens
 * there. On completion it redirects back to the UI with a status hint;
 * `?format=json` returns the result body instead for scripted flows.
 */
export async function GET(req: Request, ctx: { params: Promise<{ provider: string }> }): Promise<NextResponse> {
  const { provider } = await ctx.params;
  const url = new URL(req.url);
  try {
    if (provider !== "google") throw new ValidationError(`Unsupported provider: ${provider}`);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) throw new ValidationError("Callback requires code and state");
    const result = await getConnectionService().completeAuthorization({ code, state });
    // A fresh connection may make an account eligible for durable inquiry
    // capture: reconcile proactive registrations now (best-effort; the
    // authorization result below is authoritative either way).
    await refreshProactiveHost().catch(() => undefined);
    if (url.searchParams.get("format") === "json") return NextResponse.json(result);
    const target = new URL("/setup", url.origin);
    target.searchParams.set("businessId", result.businessId);
    target.searchParams.set("connected", provider);
    return NextResponse.redirect(target);
  } catch (error) {
    const codeOut = error instanceof ConnectionError ? error.code : "INVALID_REQUEST";
    if (url.searchParams.get("format") === "json") {
      const { connectionErrorResponse } = await import("../../_helpers.ts");
      return connectionErrorResponse(error);
    }
    const target = new URL("/setup", url.origin);
    const state = url.searchParams.get("state");
    const businessId = state ? getConnectionService().peekSessionBusinessId(state) : undefined;
    if (businessId) target.searchParams.set("businessId", businessId);
    target.searchParams.set("connectionError", codeOut);
    return NextResponse.redirect(target);
  }
}
