import { NextResponse, type NextRequest } from "next/server";
import { composeAcceptanceLink } from "../../../../../src/server/business-operator/operator.ts";
import { configuredAcceptanceKeyring } from "../../../../../src/server/acceptance/index.ts";
import { getRuntime } from "../../../../../src/server/runtime.ts";
import { assertSameOrigin, readHeaders } from "../../../../../src/server/validation.ts";
import { unknownErrorResponse } from "../../../_helpers.ts";

export const dynamic = "force-dynamic";

/** Owner-side composition only: this route issues a link and never accepts a click. */
export async function POST(request: NextRequest, context: { params: Promise<{ bookingId: string }> }): Promise<NextResponse> {
  try {
    assertSameOrigin(readHeaders(request));
    if (!(request.headers.get("content-type") ?? "").includes("application/json")) throw new Error("Content-Type must be application/json");
    const body: unknown = await request.json().catch(() => undefined);
    if (body === null || typeof body !== "object" || Array.isArray(body)) throw new Error("Acceptance composition requires a JSON object");
    const values = body as Record<string, unknown>;
    const text = (key: string): string => {
      const value = values[key];
      if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${key} is required`);
      return value.trim();
    };
    const { bookingId } = await context.params;
    const runtime = getRuntime();
    const booking = runtime.store.getBooking(bookingId);
    const action = runtime.store.getCurrentProposalAction(bookingId);
    if (!action) throw new Error(`No current proposal exists for booking ${bookingId}`);
    const keyring = configuredAcceptanceKeyring();
    if (!keyring) return NextResponse.json({ error: "Acceptance signing is unavailable until GATHER_ACCEPTANCE_KEY is configured" }, { status: 503 });
    const response = composeAcceptanceLink({ store: runtime.store, acceptanceKeyring: keyring }, action, {
      businessId: booking.businessId, customerEmail: text("customerEmail"), mailbox: text("mailbox"), issuedAt: text("issuedAt"), expiresAt: text("expiresAt"),
    });
    return NextResponse.json(response);
  } catch (error) {
    return unknownErrorResponse(error);
  }
}
