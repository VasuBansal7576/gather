import { NextResponse } from "next/server";
import { ConnectionError, getConnectionService } from "../../../../../src/server/connections/index.ts";
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
    if (url.searchParams.get("format") === "json") return NextResponse.json(result);
    return NextResponse.redirect(new URL(`/?connected=${provider}`, url.origin));
  } catch (error) {
    const codeOut = error instanceof ConnectionError ? error.code : "INVALID_REQUEST";
    if (url.searchParams.get("format") === "json") {
      const { connectionErrorResponse } = await import("../../_helpers.ts");
      return connectionErrorResponse(error);
    }
    return NextResponse.redirect(new URL(`/?connectionError=${codeOut}`, url.origin));
  }
}
