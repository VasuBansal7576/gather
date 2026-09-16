#!/usr/bin/env node
/**
 * Actual live-model MCP tool turn (explicitly authorized execution only).
 *
 * Boots a REAL GatherOpenClawRuntime against the persistent isolated auth
 * root, registers exactly one harmless live MCP tool (static ping, no
 * reads, no writes, no providers), submits one model task instructing a
 * single tool call, waits with the remote run identity preserved across
 * wait timeouts, then reports the model/tool receipt evidence and shuts
 * the owned runtime down (no orphan).
 *
 * Auth: subscription OAuth profile created by explicit owner login in the
 * root's own auth store; model openai/gpt-5.6-luna only (no alternate, no
 * API-key fallback). This script never logs credentials.
 *
 * Usage:
 *   node --experimental-strip-types scripts/gather-live-turn.mjs \
 *     --root /Users/vasu/Desktop/gather/.runtime/openclaw-live \
 *     [--gateway-port 0] [--idempotency-key <key>] [--wait-ms 300000]
 */

import { createServer } from "node:net";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { GatherOpenClawRuntime } from "../src/runtime/openclaw-runtime.ts";
import { defineGatherTool } from "../src/runtime/mcp.ts";

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
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

const LIVE_ROOT = arg("--root", "/Users/vasu/Desktop/gather/.runtime/openclaw-live");
const IDEMPOTENCY_KEY = arg("--idempotency-key", `gather:live-turn:ping:${Date.now()}`);
const WAIT_BUDGET_MS = Number(arg("--wait-ms", "300000"));
const WAIT_SLICE_MS = 60000;

const pingTool = defineGatherTool({
  name: "gather_live_ping",
  description: "Harmless liveness probe for the authorized live-model turn. Returns a static token; reads nothing, writes nothing, calls no provider.",
  inputSchema: {},
  execution: "live",
  handler: async () => ({
    content: [{ type: "text", text: "live-ping-ok" }],
    structuredContent: { pong: "live-ping-ok" },
  }),
});

const PROFILE_ID = process.env.GATHER_MODEL_PROFILE_ID;
const PROFILE_EMAIL = process.env.GATHER_MODEL_EMAIL;
if (!PROFILE_ID || !PROFILE_EMAIL) {
  console.error("GATHER_MODEL_PROFILE_ID and GATHER_MODEL_EMAIL are required (OpenClaw OAuth auth profile)");
  process.exit(2);
}

async function main() {
  const gatewayPort = Number(arg("--gateway-port", "0")) || (await freeLoopbackPort());
  const runtime = new GatherOpenClawRuntime({
    rootDir: LIVE_ROOT,
    gatewayPort,
    executable: { command: process.env.GATHER_OPENCLAW_BIN ?? "/opt/homebrew/bin/openclaw" },
    model: {
      model: "openai/gpt-5.6-luna",
      auth: {
        profileId: PROFILE_ID,
        provider: "openai",
        mode: "oauth",
        email: PROFILE_EMAIL,
      },
    },
    mcpTools: [pingTool],
    mcpPort: 0,
    connectTimeoutMs: Number(arg("--connect-timeout-ms", "120000")),
  });
  // Configured-unverified labeling (N cde4775): configuration alone never
  // proves OAuth or model readiness — verified is always false here. The
  // gate admits only an explicit supported selection; actual verification
  // is the live run receipt below, produced against the separately managed
  // live auth root.
  const status = runtime.modelStatus();
  if (!status.configured) throw new Error(`model gate refusing live turn: ${status.reason}`);
  if (status.verified !== false) throw new Error("model gate mislabeled: configuration must never report verified");

  let runId = null;
  try {
    // Cold-listener backoff: a healthy child can be slow to accept the
    // first WS handshake (plugin init, catalog fetch). Retry start a
    // bounded number of times; each attempt shuts its child down cleanly
    // before the next, so no orphan accumulates. Auth is already proven
    // by the child's own model/auth resolution — this retries readiness
    // only, never credentials.
    const START_ATTEMPTS = Number(arg("--start-attempts", "3"));
    let booted = false;
    let lastStartError = null;
    for (let attempt = 1; attempt <= START_ATTEMPTS; attempt += 1) {
      try {
        await runtime.start();
        booted = true;
        break;
      } catch (error) {
        lastStartError = error;
        console.error(`start attempt ${attempt}/${START_ATTEMPTS} failed: ${error instanceof Error ? error.message : String(error)}`);
        await runtime.stop().catch(() => undefined);
        if (attempt < START_ATTEMPTS) await new Promise((r) => setTimeout(r, 5000));
      }
    }
    if (!booted) throw lastStartError ?? new Error("runtime failed to start");
    const tasks = runtime.tasks;
    const submitted = await tasks.submitTask({
      bookingId: "live-turn-ping-001",
      message: [
        "Call the gather_live_ping tool exactly once with empty arguments.",
        "Then reply with exactly the text the tool returned and nothing else.",
        "Do not call any other tool. Do not browse, read files, or send messages.",
      ].join(" "),
      idempotencyKey: IDEMPOTENCY_KEY,
      label: "gather:live-turn:ping",
      runTimeoutMs: 240000,
    });
    runId = submitted.runId;
    const started = Date.now();
    let wait = null;
    for (;;) {
      wait = await tasks.waitForRun({ runId, timeoutMs: Math.min(WAIT_SLICE_MS, Math.max(WAIT_BUDGET_MS - (Date.now() - started), 1)) });
      if (wait.status === "ok" || wait.status === "error") break;
      // timeout/unknown/pending: wait-only, the remote run continues under
      // its id — never orphan, never assume completion.
      if (Date.now() - started >= WAIT_BUDGET_MS) break;
    }
    let history = null;
    let historyError = null;
    try {
      history = await tasks.sessionHistory({ sessionKey: submitted.sessionKey, limit: 20 });
    } catch (error) {
      historyError = error instanceof Error ? error.message : String(error);
    }
    const receipt = {
      model: "openai/gpt-5.6-luna",
      profileId: PROFILE_ID,
      gatewayPort,
      runId,
      sessionKey: submitted.sessionKey,
      idempotencyKey: IDEMPOTENCY_KEY,
      waitStatus: wait.status,
      executionMayContinue: wait.executionMayContinue,
      history,
      historyError,
    };
    console.log(JSON.stringify(receipt, null, 2));
    if (wait.status !== "ok") {
      console.error(`live turn not terminal: wait=${wait.status}; remote run identity preserved as ${runId}`);
      process.exitCode = 1;
    }
  } finally {
    // Owned process reaped here; the run identity above survives for resume.
    await runtime.stop().catch((error) => {
      console.error(`runtime stop failed (process retained, investigate): ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
  }
}

main().catch((error) => {
  console.error(`live turn failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(2);
});
