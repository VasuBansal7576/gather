import { NextResponse } from "next/server";
import { getConnectionService } from "../../../../../src/server/connections/index.ts";
import { assertSameOrigin, parseId, readHeaders, ValidationError } from "../../../../../src/server/validation.ts";
import { connectionErrorResponse } from "../../_helpers.ts";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ provider: string }> }): Promise<NextResponse> {
  try {
    assertSameOrigin(readHeaders(req));
    const provider = (await ctx.params).provider;
    if (provider !== "google") throw new ValidationError(`Unsupported provider: ${provider}`);
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const accountId = parseId(body.accountId, "accountId");
    const businessId = parseId(body.businessId, "businessId");
    const result = await getConnectionService().disconnect({ accountId, businessId });
    return NextResponse.json(result);
  } catch (error) {
    return connectionErrorResponse(error);
  }
}
