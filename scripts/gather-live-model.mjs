#!/usr/bin/env node
/**
 * Live-model execution runner (integration hook).
 *
 * Exact verification command (scripted MCP loop, no live requests):
 *   node --experimental-strip-types --test tests/live-model-execution.test.ts
 *
 * Exact live-attempt command (refuses honestly until consent, the
 * designated account/recipient, and the authorized model path land):
 *   node --experimental-strip-types scripts/gather-live-model.mjs \
 *     --business <businessId> --thread <threadId> \
 *     --file <driveFileId> --calendar <calendarId> \
 *     --model openai-codex/gpt-5.6-luna --auth-profile <profileId> \
 *     [--allow-live] [--idempotency-key <key>]
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
    console.error("usage: gather-live-model.mjs --business <id> --thread <threadId> --file <driveFileId> --calendar <calendarId> --model <provider/model> --auth-profile <profileId> [--allow-live] [--idempotency-key <key>]");
    process.exit(2);
  }
  const { getRuntime } = await import("../src/server/runtime.ts");
  const { runLiveExecution, LiveModelError } = await import("../src/server/live-model/index.ts");
  const runtime = getRuntime();
  const modelRef = arg("--model");
  const profileId = arg("--auth-profile");
  try {
    const record = await runLiveExecution(
      {
        businessId,
        threadId,
        fileId,
        calendarId,
        mode: "live",
        allowLive: process.argv.includes("--allow-live"),
        ...(arg("--idempotency-key") === undefined ? {} : { idempotencyKey: arg("--idempotency-key") }),
      },
      {
        store: runtime.store,
        providers: runtime.providers,
        ...(modelRef === undefined || profileId === undefined
          ? {}
          : { model: { model: modelRef, auth: { provider: modelRef.split("/")[0], mode: "oauth", profileId } } }),
      },
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
