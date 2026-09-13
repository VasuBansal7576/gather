import { NextResponse } from "next/server";
import { getConnectionService } from "../../../src/server/connections/index.ts";
import { parseId } from "../../../src/server/validation.ts";
import { connectionErrorResponse } from "./_helpers.ts";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<NextResponse> {
  try {
    const businessId = parseId(new URL(req.url).searchParams.get("businessId"), "businessId");
    return NextResponse.json(getConnectionService().getConnections(businessId));
  } catch (error) {
    return connectionErrorResponse(error);
  }
}
