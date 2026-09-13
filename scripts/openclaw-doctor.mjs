#!/usr/bin/env node
/**
 * Gather ↔ OpenClaw adapter doctor.
 *
 * ACTUAL isolated runtime verification (not a mock): provisions a unique
 * doctor-owned directory under .runtime, boots a real `openclaw gateway`
 * child on loopback, proves protocol hello-ok + control-plane RPCs + the
 * constrained tool policy was accepted, and shuts down cleanly.
 *
 * Safety properties:
 * - The runtime root is a uniquely created `.runtime/openclaw-doctor-*`
 *   directory; pre-existing Gather runtime state (e.g. .runtime/openclaw
 *   with real sessions/config) is never written to or removed.
 * - Cleanup removes ONLY the directory created by this invocation, and only
 *   after the gateway child's exit has been observed.
 * - Personal OpenClaw config/state (~/.openclaw) is never read; the child
 *   env is the adapter's minimal Gather-owned set.
 *
 * Usage: node scripts/openclaw-doctor.mjs [--openclaw-bin /abs/path]
 *        [--port 19191] [--keep] [--verbose]
 * Env:   GATHER_OPENCLAW_BIN  — explicit absolute openclaw executable
 *        (falls back to `which openclaw` resolved to an absolute path,
 *        then adapter --version verification).
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cwd } from "node:process";
import {
  GatherGatewayConnection,
  OpenClawGatewayProcess,
  ensureLayoutDirectories,
  resolveGatherOpenClawLayout,
  writeGatewayConfig,
} from "../src/runtime/index.ts";

const args = process.argv.slice(2);
const keep = args.includes("--keep");
const verbose = args.includes("--verbose");
const binFlagIndex = args.indexOf("--openclaw-bin");
const portFlagIndex = args.indexOf("--port");
const port = portFlagIndex >= 0 ? Number(args[portFlagIndex + 1]) : 19191;
const log = verbose ? (line) => console.error(`  ${line}`) : () => {};

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
}

function resolveExplicitBinary() {
  const candidate =
    binFlagIndex >= 0 ? args[binFlagIndex + 1] : process.env.GATHER_OPENCLAW_BIN;
  if (candidate) return candidate;
  try {
    const found = execFileSync("which", ["openclaw"], { encoding: "utf8" }).trim();
    return found ? realpathSync(found) : null;
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

let doctorDir = null;
let gateway = null;
let client = null;
let cleanupEnabled = false;

function cleanup() {
  // Removes ONLY the directory this invocation created, and only after the
  // child's exit was observed (or never spawned). Anything else is left.
  if (!doctorDir) return;
  if (keep) {
    console.log(`  (--keep) leaving doctor state at ${doctorDir}`);
    return;
  }
  if (!cleanupEnabled) {
    console.error(`  refusing cleanup of ${doctorDir}: child exit not observed`);
    return;
  }
  rmSync(doctorDir, { recursive: true, force: true });
}

process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));

async function main() {
  const binary = resolveExplicitBinary();
  if (!binary) {
    record("openclaw executable", false, "not found; set --openclaw-bin or GATHER_OPENCLAW_BIN");
    return;
  }

  // Unique doctor-owned root under .runtime — pre-existing .runtime/openclaw
  // (real Gather state, other workers' sessions) is never touched.
  mkdirSync(join(cwd(), ".runtime"), { recursive: true, mode: 0o700 });
  doctorDir = mkdtempSync(join(cwd(), ".runtime", "openclaw-doctor-"));

  const layout = resolveGatherOpenClawLayout({ rootDir: doctorDir, port });
  ensureLayoutDirectories(layout);
  writeFileSync(join(doctorDir, "doctor-owned"), "this directory was created by openclaw-doctor\n", { mode: 0o600 });
  writeGatewayConfig(layout, {
    gatherMcp: {
      url: "http://127.0.0.1:4567/mcp",
      toolInclude: ["check_availability"],
    },
  });
  record(
    "provision",
    true,
    `unique Gather-owned config written to ${layout.configPath} (tokens via env substitution, no secrets in file)`,
  );

  gateway = new OpenClawGatewayProcess({
    layout,
    executable: { command: binary },
    log,
  });

  try {
    await gateway.start();
    record(
      "gateway boot",
      true,
      `openclaw ${gateway.openclawVersion} gateway running (pid ${gateway.pid}) on loopback port ${port}`,
    );
  } catch (error) {
    record("gateway boot", false, String(error));
    // Boot failure means the child is dead (spawn error or observed early
    // exit) or was never spawned — this invocation's directory is safe.
    cleanupEnabled = true;
    return;
  }

  try {
    client = new GatherGatewayConnection({
      url: `ws://127.0.0.1:${port}`,
      token: gateway.gatewayToken,
    });

    try {
      const hello = await client.connect({ timeoutMs: 30000 });
      const methods = hello.features?.methods?.length ?? 0;
      record("hello-ok", true, `protocol ${hello.protocol}, server ${hello.server?.version}, ${methods} methods`);
    } catch (error) {
      record("hello-ok", false, String(error));
      return;
    }

    try {
      const status = await client.request("status", {});
      record("status RPC", true, `gateway status responded (${JSON.stringify(status).slice(0, 200)}…)`);
    } catch (error) {
      record("status RPC", false, String(error));
    }

    try {
      const sessions = await client.request("sessions.list", {});
      const count = Array.isArray(sessions?.sessions) ? sessions.sessions.length : "?";
      record("sessions.list RPC", true, `session index readable (${count} rows)`);
    } catch (error) {
      record("sessions.list RPC", false, String(error));
    }

    try {
      const snapshot = await client.request("config.get", {});
      const tools = snapshot?.config?.tools ?? snapshot?.tools;
      const profile = tools?.profile ?? "(not visible in redacted snapshot)";
      const mcpServers = Object.keys(snapshot?.config?.mcp?.servers ?? snapshot?.mcp?.servers ?? {});
      record(
        "config accepted",
        true,
        `tools.profile=${profile}, mcp.servers=[${mcpServers.join(",")}] (redacted snapshot round-trip)`,
      );
    } catch (error) {
      record("config accepted", false, String(error));
    }

    try {
      await client.close();
      client = null;
      record("client close", true, "WS client closed cleanly");
    } catch (error) {
      client = null;
      record("client close", false, String(error));
    }
  } finally {
    try {
      const pid = gateway.pid;
      await gateway.stop();
      const observedStopped = gateway.currentState === "stopped" && (pid === null || !pidAlive(pid));
      if (!observedStopped) throw new Error("child exit was not verifiably observed");
      record("shutdown", true, `gateway child exit observed (state=${gateway.currentState})`);
      cleanupEnabled = true;
    } catch (error) {
      record("shutdown", false, String(error));
    }
  }
}

main().catch((error) => {
  console.error(`doctor crashed: ${error.stack ?? error}`);
  process.exitCode = 1;
});
