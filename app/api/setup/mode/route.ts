import { NextResponse } from "next/server";
import {
  listPreparedInbox,
  listPreparedScenarios,
  readPreparedState,
} from "../../../../src/server/demo-fixtures.ts";
import { getRuntime, runtimeModeInfo } from "../../../../src/server/runtime.ts";
import { unknownErrorResponse } from "../../_helpers.ts";

export const dynamic = "force-dynamic";

/**
 * Owner-visible mode report for the first-run chooser and the persistent
 * simulation badge. Reports the real selected mode, the state location, and
 * the prepared scenario's durable counts. Live onboarding stays disabled
 * until its owning ADR passes; nothing here enables it.
 */
export async function GET(): Promise<NextResponse> {
  try {
    const runtime = getRuntime();
    const info = runtimeModeInfo();
    const prepared = readPreparedState(runtime.store);
    const inbox = prepared ? listPreparedInbox(runtime.store) : [];
    return NextResponse.json({
      managed: info.managed,
      mode: info.managed ? info.mode : null,
      installRoot: info.installRoot ?? null,
      stateDir: info.stateDir ?? null,
      databasePath: info.databasePath,
      customDatabasePath: info.customDatabasePath,
      simulated: info.managed ? info.mode === "prepared" : true,
      live: {
        available: false,
        reason: "Live onboarding is not available in this build; it arrives with the live-mode milestone.",
      },
      scenarios: listPreparedScenarios(),
      prepared: prepared
        ? {
            scenario: prepared.scenario,
            coverage: prepared.coverage,
            coverageDetail: prepared.coverageDetail,
            inboxCount: prepared.inboxCount,
            busyBlockCount: prepared.busyBlockCount,
            offerCount: prepared.offerCount,
            demoClockAnchor: prepared.demoClockAnchor,
            inbox: inbox.map((message) => ({
              id: message.id,
              kind: message.kind,
              subject: message.subject,
              from: message.from,
              receivedAt: message.receivedAt,
            })),
          }
        : null,
    });
  } catch (error) {
    return unknownErrorResponse(error);
  }
}
