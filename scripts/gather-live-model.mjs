#!/usr/bin/env node
/**
 * Live-model execution runner — REAL runtime path.
 *
 * runLiveExecution(live) starts the owned GatherOpenClawRuntime (isolated
 * gateway child + run-scoped MCP boundary + authenticated hello-ok),
 * submits the journey instruction through runtime.tasks, waits on the real
 * gateway run id, and reads the SERVER-SIDE results (durable tool-call
 * audit + the proposal the prepare_proposal handler persisted). There is
 * no scripted planner on this path — the model itself calls the four
 * run-bound tools through the gateway's MCP client.
 *
 * Scripted verification (no gateway, no model):
 *   node --experimental-strip-types --test tests/live-model-execution.test.ts
 *
 * Live attempt (requires consent env + --allow-live; I runs it):
 *   GATHER_LIVE_CONSENT=1 GATHER_DATABASE_PATH=<db> \
 *   node --experimental-strip-types scripts/gather-live-model.mjs \
 *     --business <businessId> --thread <threadId> \
 *     --file <driveFileId> --calendar <calendarId> --allow-live \
 *     [--root <runtimeRoot>] [--gateway-port <port>] [--db <sqlitePath>] \
 *     [--idempotency-key <key>] [--wait-ms 300000]
 *
 * Model is pinned to the verified subscription profile (openai/gpt-5.6-luna
 * via openai:bansalv8198@gmail.com — OAuth, never an API key). Exit codes:
 * 0 proposal prepared, 2 usage, 3 refused (not authorized or model
 * unconfigured), 4 tool/policy failure.
 */

import { createServer } from "node:net";
import { join } from "node:path";
import { cwd } from "node:process";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

async function freeLoopbackPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise((resolve) => server.close(() => resolve()));
  if (!port) throw new Error("loopback port allocation failed");
  return port;
}

const MODEL = {
  model: "openai/gpt-5.6-luna",
  auth: { provider: "openai", mode: "oauth", profileId: "openai:bansalv8198@gmail.com" },
};

async function main() {
  const businessId = arg("--business");
  const threadId = arg("--thread");
  const fileId = arg("--file");
  const calendarId = arg("--calendar");
  if (!businessId || !threadId || !fileId || !calendarId) {
    console.error("usage: gather-live-model.mjs --business <id> --thread <threadId> --file <driveFileId> --calendar <calendarId> --allow-live [--root <runtimeRoot>] [--gateway-port <port>] [--db <sqlitePath>] [--idempotency-key <key>] [--wait-ms <ms>]");
    process.exit(2);
  }
  const db = arg("--db");
  if (db) process.env.GATHER_DATABASE_PATH = db;
  const { getRuntime } = await import("../src/server/runtime.ts");
  const { runLiveExecution, LiveModelError } = await import("../src/server/live-model/index.ts");
  const runtime = getRuntime();
  // A live run owns a real gateway child: it needs a unique Gather-owned
  // root and a caller-assigned (or freshly allocated) loopback port.
  const live = process.argv.includes("--allow-live");
  if (!live) {
    console.error("LIVE_NOT_AUTHORIZED: this runner only performs live runs; pass --allow-live (and set GATHER_LIVE_CONSENT) or use the scripted test suite");
    process.exit(3);
  }
  const rootDir = arg("--root") ?? join(cwd(), ".runtime", `openclaw-live-model-${Date.now()}`);
  const gatewayPort = Number(arg("--gateway-port") ?? 0) || (await freeLoopbackPort());
  const waitMs = Number(arg("--wait-ms") ?? 300000);
  try {
    const record = await runLiveExecution(
      {
        businessId,
        threadId,
        fileId,
        calendarId,
        mode: live ? "live" : "scripted",
        allowLive: live,
        runTimeoutMs: waitMs,
        ...(arg("--idempotency-key") === undefined ? {} : { idempotencyKey: arg("--idempotency-key") }),
      },
      {
        store: runtime.store,
        providers: runtime.providers,
        model: MODEL,
        runtimeRootDir: rootDir,
        gatewayPort,
        runTimeoutMs: waitMs,
      },
    );
    console.log(JSON.stringify(record, null, 2));
    process.exit(record.status === "ok" ? 0 : 1);
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
