import { NextResponse } from "next/server";
import { getConnectionService, type ConnectionProvider } from "../../../../../src/server/connections/index.ts";
import { assertSameOrigin, parseId, readHeaders, ValidationError } from "../../../../../src/server/validation.ts";
import { connectionErrorResponse } from "../../_helpers.ts";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ provider: string }> }): Promise<NextResponse> {
  try {
    assertSameOrigin(readHeaders(req));
    const provider = (await ctx.params).provider;
    if (provider !== "google") throw new ValidationError(`Unsupported provider: ${provider}`);
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const businessId = parseId(body.businessId, "businessId");
    const displayName = typeof body.displayName === "string" ? body.displayName : undefined;
    const result = getConnectionService().startAuthorization({
      businessId,
      provider: provider as ConnectionProvider,
      displayName,
    });
    return NextResponse.json(result);
  } catch (error) {
    return connectionErrorResponse(error);
  }
}
