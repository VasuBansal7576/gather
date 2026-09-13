#!/usr/bin/env node

/**
 * Verifies the Gather-owned isolated OpenClaw runtime end to end:
 *   provision -> gateway boot -> WS handshake (hello-ok) -> read-only RPC ->
 *   orderly shutdown.
 *
 * Everything lives under <repo>/.runtime/openclaw (gitignored). No personal
 * ~/.openclaw path is read; the child gets a minimal env with OPENCLAW_HOME
 * pointed at Gather-owned directories. No model/provider call is made —
 * readiness uses operator.read RPCs only.
 *
 * Usage:
 *   node scripts/openclaw-doctor.mjs [--json] [--keep]
 *   --keep   leave .runtime/openclaw state for inspection (default: remove)
 */

import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  GatherGatewayConnection,
  GatherRuntimeTasks,
  OpenClawGatewayProcess,
  ensureLayoutDirectories,
  resolveGatherOpenClawLayout,
  writeGatewayConfig,
} from "../src/runtime/index.ts";

const DEFAULT_PORT = 19191;

function parseArguments(argv) {
  const options = { json: false, keep: false, port: DEFAULT_PORT };
  for (const argument of argv) {
    if (argument === "--json") options.json = true;
    else if (argument === "--keep") options.keep = true;
    else if (argument.startsWith("--port=")) {
      options.port = Number.parseInt(argument.slice("--port=".length), 10);
    } else if (argument === "--help") {
      process.stdout.write("Usage: node scripts/openclaw-doctor.mjs [--json] [--keep] [--port=N]\n");
      process.exit(0);
    } else throw new Error(`Unknown option: ${argument}`);
  }
  return options;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  return pathToFileURL(resolve(process.argv[1])).href === pathToFileURL(fileURLToPath(import.meta.url)).href;
}

export async function runOpenClawDoctor({ cwd = process.cwd(), port = DEFAULT_PORT, keep = false, emit } = {}) {
  const checks = [];
  const record = (status, name, detail) => {
    checks.push({ status, name, detail });
    emit?.(`${status === "pass" ? "PASS" : status === "fail" ? "FAIL" : "SKIP"} ${name}: ${detail}`);
  };

  const layout = resolveGatherOpenClawLayout({
    rootDir: join(cwd, ".runtime", "openclaw"),
    port,
  });

  let process_ = null;
  let connection = null;
  try {
    ensureLayoutDirectories(layout);
    const configPath = writeGatewayConfig(layout);
    record("pass", "provision", `Gather-owned config written to ${configPath} (token via env substitution, no secrets in file).`);

    process_ = new OpenClawGatewayProcess({
      layout,
      log: (line) => emit?.(`  ${line}`),
    });
    await process_.start();
    record("pass", "gateway boot", `openclaw gateway running (pid ${process_.pid}) on loopback port ${layout.port}.`);

    connection = new GatherGatewayConnection({
      url: `ws://127.0.0.1:${layout.port}`,
      token: process_.gatewayToken,
    });
    const hello = await connection.connect({ timeoutMs: 30000 });
    record("pass", "hello-ok", `protocol ${hello.protocol}, server ${hello.server?.version ?? "unknown"}, ${hello.features?.methods?.length ?? 0} methods.`);

    const tasks = new GatherRuntimeTasks(connection);
    const status = await tasks.gatewayStatus();
    record("pass", "status RPC", `gateway status responded (${JSON.stringify(status).slice(0, 200)}).`);

    const sessions = await tasks.listSessions();
    const count = Array.isArray(sessions) ? sessions.length : (sessions?.sessions?.length ?? "n/a");
    record("pass", "sessions.list RPC", `session index readable (${count} rows).`);

    await connection.close();
    connection = null;
    record("pass", "client close", "WS client closed cleanly.");

    await process_.stop(10000);
    record("pass", "shutdown", `gateway child stopped (state=${process_.currentState}).`);
    process_ = null;
  } catch (error) {
    record("fail", "runtime", error instanceof Error ? error.message : String(error));
    if (process_) {
      const tail = process_.diagnosticsTail.slice(-10).join("\n");
      if (tail) emit?.(`stderr tail:\n${tail}`);
    }
  } finally {
    if (connection) await connection.close().catch(() => {});
    if (process_) await process_.stop(5000).catch(() => {});
    if (!keep) rmSync(layout.rootDir, { recursive: true, force: true });
  }

  const failed = checks.filter((check) => check.status === "fail");
  emit?.(failed.length === 0 ? "OpenClaw doctor passed." : `OpenClaw doctor failed: ${failed.length} check(s).`);
  return { checks, ok: failed.length === 0, layout };
}

if (isMainModule()) {
  const options = parseArguments(process.argv.slice(2));
  const result = await runOpenClawDoctor({
    port: options.port,
    keep: options.keep,
    emit: options.json ? undefined : (line) => console.log(line),
  });
  if (options.json) process.stdout.write(`${JSON.stringify({ ok: result.ok, checks: result.checks }, null, 2)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}
