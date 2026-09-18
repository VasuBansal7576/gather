import { NextResponse } from "next/server";
import { IntakeDomainStore } from "../../../../../src/intake/store.ts";
import { getOperatorDeps } from "../../../../../src/server/operator-runtime/host.ts";
import { SourceSyncStore } from "../../../../../src/server/sources/store.ts";
import { describeScanState } from "../../../../../src/server/sources/messages.ts";
import { unknownErrorResponse } from "../../../_helpers.ts";

export const dynamic = "force-dynamic";

/**
 * Owner-visible source coverage (ADR-007/C03): the declared scope, window,
 * partition states, exclusions and the honest scan-state sentence. Failed
 * or partial coverage never reports as a completed empty scan.
 */
export async function GET(): Promise<NextResponse> {
  try {
    const deps = getOperatorDeps();
    if (!deps) {
      return NextResponse.json(
        { code: "INTAKE_NOT_CONFIGURED", message: "Operator runtime is not wired by the host", retryable: false, demo: true },
        { status: 503 },
      );
    }
    const sync = new SourceSyncStore(deps.store.db);
    const coverages = deps.sources?.coverage() ?? sync.listScanStates(deps.accountId).map((state) => state.coverage);
    const latest = coverages[0];
    const domain = new IntakeDomainStore(deps.store.db).counts(deps.accountId);
    const emailsScanned = sync
      .listRecords(deps.accountId)
      .filter((record) => (record.channel === "inbox" || record.channel === "sent") && record.status !== "deleted").length;
    const message = describeScanState({
      coverage: latest,
      emailsScanned,
      eligibleInquiries: domain.eligible,
    });
    return NextResponse.json({
      simulation: deps.inbox.provenance.simulated,
      accountId: deps.accountId,
      coverage: latest ?? null,
      coverages,
      scanState: message,
      expansion: latest === undefined ? null : { action: "POST /api/operator/intake/scan {expandWindows:1}", windowDays: latest.windowDays },
    });
  } catch (error) {
    return unknownErrorResponse(error);
  }
}
