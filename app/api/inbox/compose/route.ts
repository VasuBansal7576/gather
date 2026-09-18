import { NextResponse, type NextRequest } from "next/server";
import {
  composePreparedMessage,
  PREPARED_COMPOSER_ACCOUNT,
} from "../../../../src/intake/compose.ts";
import {
  PREPARED_BUSINESS_ID,
  PREPARED_GMAIL_ACCOUNT_ID,
} from "../../../../src/server/demo-fixtures.ts";
import { gatherMode, getRuntime } from "../../../../src/server/runtime.ts";
import { assertSameOrigin, readHeaders } from "../../../../src/server/validation.ts";
import { unknownErrorResponse } from "../../_helpers.ts";

export const dynamic = "force-dynamic";

/**
 * POST /api/inbox/compose — prepared-mode only (ADR-003).
 *
 * Lets a human type a message into the prepared business inbox and watch
 * the scripted domain gate classify it. No mail or Drive access happens
 * here, no recipient/account/business can be chosen beyond the prepared
 * scope, and nothing is sent or booked — the response is the labelled
 * classification plus the durable composed row. In live mode this route
 * returns 403: live inboxes are read through the connected account, never
 * written by typed mail.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    assertSameOrigin(readHeaders(request));
    if (gatherMode() === "live") {
      return NextResponse.json(
        {
          code: "DENIED",
          message: "The inbox composer is prepared-mode only; live inboxes are read through the connected account, never written by typed mail.",
          retryable: false,
          demo: true,
        },
        { status: 403 },
      );
    }
    const body: unknown = await request.json().catch(() => undefined);
    const { store } = getRuntime();
    // Prepared scope is server-resolved: the composer can never select a
    // business or account — it lands in the prepared business under the
    // fictional composer account, or fails honestly when nothing is seeded.
    let businessId = PREPARED_BUSINESS_ID;
    let accountId = PREPARED_GMAIL_ACCOUNT_ID;
    try {
      store.getBusiness(businessId);
    } catch {
      const fallback = store.listBusinesses()[0];
      if (fallback === undefined) {
        return NextResponse.json(
          {
            code: "NOT_FOUND",
            message: "No prepared business is seeded yet — POST /api/demo/init with a scenario first.",
            retryable: false,
            demo: true,
          },
          { status: 404 },
        );
      }
      businessId = fallback.id;
      accountId = PREPARED_COMPOSER_ACCOUNT;
    }
    const result = await composePreparedMessage(
      { store, mode: gatherMode(), businessId, accountId },
      body,
    );
    return NextResponse.json({
      demo: true,
      simulated: true,
      mode: "prepared",
      message: {
        id: result.message.id,
        from: result.message.from,
        to: result.message.to,
        subject: result.message.subject,
        receivedAt: result.message.receivedAt,
        sourceTag: result.message.sourceTag,
      },
      duplicate: result.duplicate,
      classification: {
        outcome: result.classification.outcome,
        reasons: result.classification.reasons,
        missingFields: result.classification.missingFields,
        extracted: result.classification.extracted,
      },
      classifier: result.classifier,
      notice: "DEMO ONLY: composed into the fictional prepared inbox and classified by the scripted domain gate. Nothing was sent, linked, or booked.",
    });
  } catch (error) {
    return unknownErrorResponse(error);
  }
}
