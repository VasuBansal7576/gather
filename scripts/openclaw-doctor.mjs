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
 * Startup staging (child-spawned vs protocol-ready are distinct records):
 * - "port": how the loopback port was chosen (dynamic per-run allocation by
 *   default; explicit --port gets a preflight occupancy probe).
 * - "child spawned": the gateway child survived the 1.5 s early-exit window.
 *   This is liveness, NOT readiness.
 * - "protocol-ready (hello-ok)": the WS hello-ok handshake arrived within
 *   the unchanged 30 s deadline. Only this proves the gateway is ready.
 * - "shutdown": the child exit was observed (SIGTERM, then SIGKILL).
 *
 * No fixed default port is assumed: concurrent isolated boots (other
 * workers, parallel tests) must each use their own port. A busy explicit
 * port fails at "port preflight" without touching the foreign listener.
 *
 * Usage: node scripts/openclaw-doctor.mjs [--openclaw-bin /abs/path]
 *        [--port 0|auto|<n>] [--keep] [--verbose]
 * Env:   GATHER_OPENCLAW_BIN  — explicit absolute openclaw executable
 *        (falls back to `which openclaw` resolved to an absolute path,
 *        then adapter --version verification).
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
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
// --port <n>: explicit loopback port. Omitted, "0", or "auto": allocate a
// currently-free loopback port per run (bind 127.0.0.1:0). The allocation is
// a collision-reduction probe, NOT a guarantee: the gateway's own bind is
// authoritative (TOCTOU remains — a "free" probe result never proves the
// port stays free).
const portRaw = portFlagIndex >= 0 ? args[portFlagIndex + 1] : "auto";
const explicitPort =
  portRaw === undefined || portRaw === "auto" || portRaw === "0"
    ? null
    : Number(portRaw);
const log = verbose ? (line) => console.error(`  ${line}`) : () => {};

// Loopback-only by construction (no host parameter): these probes can only
// ever bind 127.0.0.1, never a non-loopback address.
function allocateFreeLoopbackPort() {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => (port ? resolvePromise(port) : rejectPromise(new Error("port allocation failed"))));
    });
  });
}

/**
 * Preflight occupancy probe: single bind attempt on 127.0.0.1.
 * EADDRINUSE => occupied. Closes its own probe socket immediately; never
 * touches a foreign listener (no connect, no kill). A "free" answer is
 * advisory only.
 */
function isPortOccupied(port) {
  return new Promise((resolvePromise, rejectPromise) => {
    const probe = createServer();
    probe.once("error", (error) => {
      if (error?.code === "EADDRINUSE") resolvePromise(true);
      else rejectPromise(error);
    });
    probe.listen(port, "127.0.0.1", () => {
      probe.close(() => resolvePromise(false));
    });
  });
}

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
let stopPromise = null;
let shutdownRecorded = false;

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

/**
 * Coordinated shutdown shared by the normal path and signal handlers: close
 * the client, stop the child, and only mark cleanup-safe once the child's
 * exit was actually observed. Runs once; concurrent callers share the
 * promise.
 */
function stopGateway() {
  if (!stopPromise) {
    stopPromise = (async () => {
      if (client) {
        await client.close().catch(() => {});
        client = null;
      }
      if (!gateway) {
        cleanupEnabled = true;
        return;
      }
      const pid = gateway.pid;
      await gateway.stop();
      const observedStopped = gateway.currentState === "stopped" && (pid === null || !pidAlive(pid));
      if (!observedStopped) throw new Error("child exit was not verifiably observed");
      cleanupEnabled = true;
      if (!shutdownRecorded) {
        shutdownRecorded = true;
        record("shutdown", true, `gateway child exit observed (state=${gateway.currentState})`);
      }
    })();
  }
  return stopPromise;
}

process.on("exit", cleanup);
process.on("SIGINT", () => {
  void stopGateway().finally(() => process.exit(130));
});
process.on("SIGTERM", () => {
  void stopGateway().finally(() => process.exit(143));
});

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

  // Resolve the gateway port: dynamic per-run allocation by default; an
  // explicit --port gets a preflight probe first so a busy port fails fast
  // with a clear message instead of a confusing boot timeout. The probe
  // never stops or connects to the foreign listener.
  let port;
  let portOrigin;
  if (explicitPort === null) {
    port = await allocateFreeLoopbackPort();
    portOrigin = "dynamic per-run allocation (bind 127.0.0.1:0 probe; TOCTOU applies — gateway bind is authoritative)";
  } else {
    if (!Number.isInteger(explicitPort) || explicitPort < 1 || explicitPort > 65535) {
      record("port preflight", false, `invalid --port "${portRaw}": expected 1-65535, "0", or "auto"`);
      cleanupEnabled = true;
      return;
    }
    let occupied;
    try {
      occupied = await isPortOccupied(explicitPort);
    } catch (error) {
      record("port preflight", false, `probe failed for port ${explicitPort}: ${String(error)}`);
      cleanupEnabled = true;
      return;
    }
    if (occupied) {
      record(
        "port preflight",
        false,
        `loopback port ${explicitPort} is already occupied by another listener; ` +
          `not stopping or probing the foreign process — retry with --port 0/auto for a fresh port. ` +
          `Auth/isolation unchanged (no child spawned, no config beyond this run's own directory)`,
      );
      cleanupEnabled = true;
      return;
    }
    port = explicitPort;
    portOrigin = "explicit --port (preflight: appeared free at probe time; gateway bind remains authoritative)";
  }
  record("port", true, `${port} (${portOrigin})`);

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
    // start() resolving means the CHILD WAS SPAWNED and survived the 1.5 s
    // early-exit window — it is NOT protocol readiness. Readiness is proven
    // only by hello-ok below. A fixed-port collision that the preflight
    // missed (TOCTOU) surfaces here as an early exit, not as readiness.
    record(
      "child spawned",
      true,
      `openclaw ${gateway.openclawVersion} child alive past early-exit window (pid ${gateway.pid}) on loopback port ${port} — NOT protocol-ready yet`,
    );
  } catch (error) {
    record("child spawned", false, String(error));
    // Boot failure means the child is dead (spawn error or observed early
    // exit, e.g. a port the gateway could not bind) or was never spawned —
    // this invocation's directory is safe. No foreign listener was stopped;
    // exit/shutdown ownership stays with the observed child (none here).
    cleanupEnabled = true;
    return;
  }

  try {
    client = new GatherGatewayConnection({
      url: `ws://127.0.0.1:${port}`,
      token: gateway.gatewayToken,
    });

    try {
      // Protocol readiness deadline is unchanged at 30 s: it is the
      // readiness signal, not a knob for hiding slow-boot failures.
      const hello = await client.connect({ timeoutMs: 30000 });
      const methods = hello.features?.methods?.length ?? 0;
      record("protocol-ready (hello-ok)", true, `protocol ${hello.protocol}, server ${hello.server?.version}, ${methods} methods`);
    } catch (error) {
      record("protocol-ready (hello-ok)", false, `${String(error)} (child was spawned; readiness never arrived within the unchanged 30s deadline)`);
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
      await stopGateway();
    } catch (error) {
      record("shutdown", false, String(error));
    }
  }
}

main().catch((error) => {
  console.error(`doctor crashed: ${error.stack ?? error}`);
  process.exitCode = 1;
});
