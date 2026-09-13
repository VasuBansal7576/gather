#!/usr/bin/env node
/**
 * Live-model journey runner (integration hook).
 *
 * Exact run command (from the repository root, Node >= 22):
 *   node --experimental-strip-types scripts/gather-live-model.mjs \
 *     --business <businessId> --thread <threadId> \
 *     --file <driveFileId> --calendar <calendarId> \
 *     [--allow-live] [--idempotency-key <key>]
 *
 * Without --allow-live (or before Chief assigns the account/recipient and
 * I delivers the authorized model auth path) the run refuses honestly with
 * a typed LIVE_NOT_AUTHORIZED / MODEL_UNCONFIGURED error — no model
 * executes, nothing sends, nothing is read outside the designated sources.
 *
 * Exit codes: 0 proposal prepared, 2 usage, 3 refused (not authorized or
 * model unconfigured), 4 tool/policy failure.
 */

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

async function main() {
  const businessId = arg("--business");
  const threadId = arg("--thread");
  const fileId = arg("--file");
  const calendarId = arg("--calendar");
  if (!businessId || !threadId || !fileId || !calendarId) {
    console.error("usage: gather-live-model.mjs --business <id> --thread <threadId> --file <driveFileId> --calendar <calendarId> [--allow-live] [--idempotency-key <key>]");
    process.exit(2);
  }
  const { getRuntime } = await import("../src/server/runtime.ts");
  const { runLiveModelJourney, LiveModelError } = await import("../src/server/live-model/index.ts");
  const runtime = getRuntime();
  try {
    const record = await runLiveModelJourney(
      {
        businessId,
        threadId,
        fileId,
        calendarId,
        mode: "live",
        allowLive: process.argv.includes("--allow-live"),
        ...(arg("--idempotency-key") === undefined ? {} : { idempotencyKey: arg("--idempotency-key") }),
      },
      { store: runtime.store, providers: runtime.providers },
    );
    console.log(JSON.stringify(record, null, 2));
    process.exit(0);
  } catch (error) {
    if (error instanceof LiveModelError) {
      console.error(`${error.code}: ${error.message}`);
      process.exit(error.code === "LIVE_NOT_AUTHORIZED" || error.code === "MODEL_UNCONFIGURED" ? 3 : 4);
    }
    console.error(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(4);
  }
}

await main();
