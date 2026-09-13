import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, chmodSync, constants, existsSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { GatherOpenClawLayout } from "./layout.ts";

/**
 * Supervises the isolated `openclaw gateway` child process.
 *
 * Follows the supported embedding contract:
 * https://docs.openclaw.ai/gateway/embedding
 * - Spawn the installed openclaw executable; do not vendor or flatten it.
 * - Host owns lifecycle: OPENCLAW_NO_RESPAWN=1 keeps update restarts inside
 *   the tracked PID instead of detaching a child.
 * - OPENCLAW_DISABLE_BONJOUR=1 (host owns discovery), OPENCLAW_SKIP_CHANNELS=1
 *   (control-plane only; Gather owns Gmail/Calendar connectors itself),
 *   OPENCLAW_EXEC_SHELL_SNAPSHOT=0.
 * - Config-class startup failures exit 78 (EX_CONFIG); repair once with
 *   `openclaw doctor --fix --yes --non-interactive` under the same env, retry
 *   once, then surface the failure. Never scrape stderr for decisions.
 *
 * Isolation: the child gets a MINIMAL environment (not process.env) so
 * personal OPENCLAW_* variables or provider keys cannot leak in, and
 * OPENCLAW_HOME + HOME both point at the Gather-owned home dir so no
 * personal-home config fallback is possible. No login-shell env import is
 * enabled (OPENCLAW_LOAD_SHELL_ENV is never set), and caller-supplied env is
 * restricted to an explicit diagnostic allowlist.
 */

export const OPENCLAW_EX_CONFIG_EXIT_CODE = 78;

/**
 * Allocates a currently-free loopback port by binding 127.0.0.1:0 and
 * releasing it. Loopback-only by construction: there is no host parameter,
 * so this helper cannot be pointed at a non-loopback address. This REDUCES
 * collision probability versus fixed ports but does NOT eliminate the bind
 * race (TOCTOU): another process may claim the port between release and
 * the gateway's own bind. The gateway's bind is authoritative — callers
 * must treat a later EADDRINUSE / early-exit as the real signal, never the
 * probe result.
 */
export async function allocateLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  if (!port) throw new Error("failed to allocate a loopback port");
  return port;
}

/**
 * Occupancy preflight with an unambiguous occupied/free answer. Single bind
 * attempt on 127.0.0.1: EADDRINUSE => occupied (true); successful listen =>
 * free (false). Loopback-only by construction: there is no host parameter,
 * so this helper cannot probe (or bind) a non-loopback address. The probe
 * socket is closed immediately and no foreign listener is ever touched (no
 * connect flood, no kill, no SO_REUSEPORT takeover).
 *
 * Same TOCTOU caveat as allocateLoopbackPort: a "free" answer is advisory
 * only — the gateway's own bind is authoritative.
 */
export async function checkLoopbackPortOccupied(port: number): Promise<boolean> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid loopback port for occupancy probe: ${port}`);
  }
  return await new Promise<boolean>((resolvePromise, rejectPromise) => {
    const probe = createServer();
    probe.once("error", (error: NodeJS.ErrnoException) => {
      if (error?.code === "EADDRINUSE") {
        resolvePromise(true);
      } else {
        rejectPromise(error);
      }
    });
    probe.listen(port, "127.0.0.1", () => {
      probe.close(() => resolvePromise(false));
    });
  });
}

export interface OpenClawExecutable {
  /**
   * Absolute path to the executable, e.g. "/opt/homebrew/bin/openclaw" or an
   * absolute node binary when args[0] is an .mjs package entry. Bare command
   * names are rejected: the adapter never selects a runtime via PATH lookup.
   */
  command: string;
  /**
   * Arguments prepended before the subcommand, e.g.
   * ["/path/to/openclaw.mjs"] when command is a node binary.
   */
  args?: string[];
}

export type ExecutableSource = "explicit" | "package";

export interface ResolvedExecutable {
  executable: OpenClawExecutable;
  source: ExecutableSource;
}

function assertReadableFile(path: string, what: string): void {
  if (!existsSync(path)) throw new Error(`${what} does not exist: ${path}`);
  if (!statSync(path).isFile()) throw new Error(`${what} is not a regular file: ${path}`);
}

function assertExecutableFile(path: string, what: string): void {
  assertReadableFile(path, what);
  if (process.platform !== "win32") {
    try {
      accessSync(path, constants.X_OK);
    } catch {
      throw new Error(`${what} is not executable: ${path}`);
    }
  }
}

/**
 * Resolves the openclaw package entry via import.meta (supported embedding
 * pattern: package main entry's sibling `openclaw.mjs`). Returns null when
 * the package is not installed in this project.
 */
export function resolveInstalledPackageEntry(): string | null {
  try {
    const packageEntry = fileURLToPath(import.meta.resolve("openclaw"));
    const entry = resolve(dirname(packageEntry), "..", "openclaw.mjs");
    return existsSync(entry) ? entry : null;
  } catch {
    return null;
  }
}

/**
 * Resolves a verified executable. Explicit executables are validated (must be
 * an absolute existing executable file; args[0] must exist when given). With
 * no explicit executable, the installed `openclaw` package entry is used when
 * resolvable; otherwise this throws rather than falling back to a PATH lookup
 * that could pick an arbitrary runtime.
 */
export function resolveOpenClawExecutable(input: {
  executable?: OpenClawExecutable;
}): ResolvedExecutable {
  if (input.executable) {
    const exe = input.executable;
    if (!exe.command.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(exe.command)) {
      throw new Error(
        `openclaw executable must be an absolute validated path, got bare command "${exe.command}"`,
      );
    }
    assertExecutableFile(exe.command, "openclaw executable");
    if (exe.args && exe.args.length > 0) {
      assertReadableFile(exe.args[0]!, "openclaw package entry");
    }
    return { executable: exe, source: "explicit" };
  }
  const entry = resolveInstalledPackageEntry();
  if (entry) {
    return {
      executable: { command: process.execPath, args: [entry] },
      source: "package",
    };
  }
  throw new Error(
    "no verified openclaw executable: the openclaw package is not resolvable from this project; " +
      "pass an explicit absolute OpenClawExecutable",
  );
}

/**
 * Verifies the resolved executable actually reports an OpenClaw version.
 * Runs `<exe> --version` with a minimal env and requires an `OpenClaw x.y.z`
 * banner. Returns the reported version string.
 */
export function verifyOpenClawExecutable(
  resolved: ResolvedExecutable,
  env: Record<string, string>,
): string {
  const result = spawnSync(
    resolved.executable.command,
    [...(resolved.executable.args ?? []), "--version"],
    { env: env as NodeJS.ProcessEnv, encoding: "utf8", timeout: 15000 },
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  const match = output.match(/OpenClaw\s+(\d+\.\d+\.\d+(?:-\S+)?)/i);
  if (result.error || result.status !== 0 || !match) {
    throw new Error(
      `openclaw executable failed --version verification ` +
        `(status=${result.status}, error=${result.error?.message ?? "none"}): ${output.slice(0, 300)}`,
    );
  }
  return match[1]!;
}

export interface GatewayProcessOptions {
  layout: GatherOpenClawLayout;
  /**
   * Verified executable; when omitted the installed openclaw package entry is
   * resolved. Bare PATH commands are never used.
   */
  executable?: OpenClawExecutable;
  /** Pre-generated token; generated and persisted when omitted. */
  gatewayToken?: string;
  /**
   * Narrow shared secret for the Gather MCP boundary; passed to the child as
   * GATHER_MCP_TOKEN for config header substitution. Adapter-internal, never
   * overridable by extraEnv.
   */
  mcpToken?: string;
  /**
   * Diagnostics-only additions; restricted to EXTRA_ENV_ALLOWLIST. Overrides
   * of isolation keys or runtime toggles (e.g. OPENCLAW_NO_RESPAWN,
   * OPENCLAW_SKIP_CHANNELS, OPENCLAW_LOAD_SHELL_ENV, NODE_OPTIONS) are
   * rejected — no personal imports or policy weakening.
   */
  extraEnv?: Record<string, string>;
  log?: (line: string) => void;
}

const ISOLATION_ENV_KEYS = new Set([
  "OPENCLAW_HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_WORKSPACE_DIR",
  "OPENCLAW_GATEWAY_PORT",
  "OPENCLAW_GATEWAY_TOKEN",
  "GATHER_MCP_TOKEN",
  "HOME",
  "TMPDIR",
]);

/**
 * Only these caller-supplied variables may reach the child. Diagnostics
 * surface only — never auth, lifecycle, policy, or loader knobs.
 */
export const EXTRA_ENV_ALLOWLIST = new Set([
  "OPENCLAW_LOG_LEVEL",
  "OPENCLAW_DIAGNOSTICS",
  "OPENCLAW_DIAGNOSTICS_TIMELINE_PATH",
  "OPENCLAW_DEBUG_SSE",
  "OPENCLAW_DEBUG_MODEL_TRANSPORT",
]);

export function tokenFilePath(layout: GatherOpenClawLayout): string {
  return join(layout.secretsDir, "gateway-token");
}

export function mcpTokenFilePath(layout: GatherOpenClawLayout): string {
  return join(layout.secretsDir, "mcp-token");
}

function writeSecret(path: string, value: string): void {
  writeFileSync(path, `${value}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Generates and persists a Gather-only shared secret (mode 0600). */
export function ensureGatewayToken(layout: GatherOpenClawLayout): string {
  const token = `gather-gw-${randomBytes(24).toString("base64url")}`;
  writeSecret(tokenFilePath(layout), token);
  return token;
}

/** Generates and persists the MCP boundary bearer token (mode 0600). */
export function ensureMcpToken(layout: GatherOpenClawLayout): string {
  const token = `gather-mcp-${randomBytes(24).toString("base64url")}`;
  writeSecret(mcpTokenFilePath(layout), token);
  return token;
}

/**
 * Builds the minimal child environment. Deliberately NOT derived from
 * process.env: only the variables listed here reach the gateway process.
 */
export function buildGatewayChildEnv(
  layout: GatherOpenClawLayout,
  gatewayToken: string,
  extraEnv: Record<string, string> = {},
  internal: { mcpToken?: string } = {},
): Record<string, string> {
  for (const key of Object.keys(extraEnv)) {
    if (ISOLATION_ENV_KEYS.has(key)) {
      throw new Error(`extraEnv may not override isolation variable ${key}`);
    }
    if (!EXTRA_ENV_ALLOWLIST.has(key)) {
      throw new Error(`extraEnv key ${key} is not in the diagnostic allowlist`);
    }
  }
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin",
    HOME: layout.homeDir,
    TMPDIR: layout.tmpDir,
    LANG: process.env.LANG ?? "en_US.UTF-8",
    OPENCLAW_HOME: layout.homeDir,
    OPENCLAW_STATE_DIR: layout.stateDir,
    OPENCLAW_CONFIG_PATH: layout.configPath,
    OPENCLAW_WORKSPACE_DIR: layout.workspaceDir,
    OPENCLAW_GATEWAY_PORT: String(layout.port),
    OPENCLAW_GATEWAY_TOKEN: gatewayToken,
    OPENCLAW_CONFIG_READONLY: "1",
    OPENCLAW_SKIP_CHANNELS: "1",
    OPENCLAW_NO_RESPAWN: "1",
    OPENCLAW_DISABLE_BONJOUR: "1",
    OPENCLAW_EXEC_SHELL_SNAPSHOT: "0",
    ...extraEnv,
  };
  if (internal.mcpToken) env.GATHER_MCP_TOKEN = internal.mcpToken;
  return env;
}

export interface SpawnLike {
  (
    command: string,
    args: string[],
    options: { env: Record<string, string>; stdio: ["ignore", "pipe", "pipe"] },
  ): ChildProcess;
}

export type GatewayProcessState =
  | "stopped"
  | "starting"
  | "running"
  | "repairing"
  | "stopping"
  | "failed";

interface ChildExit {
  code: number | null;
  signal: string | null;
}

export class OpenClawGatewayProcess {
  readonly layout: GatherOpenClawLayout;
  readonly gatewayToken: string;
  readonly resolvedExecutable: ResolvedExecutable;
  /** Reported by `--version` verification during start(); null until then. */
  openclawVersion: string | null = null;
  private readonly extraEnv: Record<string, string>;
  private readonly mcpToken?: string;
  private readonly log: (line: string) => void;
  private readonly spawnFn: SpawnLike;
  private readonly verify: boolean;
  private child: ChildProcess | null = null;
  private exitPromise: Promise<ChildExit> | null = null;
  private spawnErrorPromise: Promise<Error> | null = null;
  private state: GatewayProcessState = "stopped";
  private lastExit: ChildExit | null = null;
  private stderrTail: string[] = [];
  private repairAttempted = false;

  constructor(
    options: GatewayProcessOptions,
    deps: { spawnFn?: SpawnLike; skipExecutableVerification?: boolean } = {},
  ) {
    this.layout = options.layout;
    this.gatewayToken = options.gatewayToken ?? ensureGatewayToken(options.layout);
    this.resolvedExecutable = resolveOpenClawExecutable({
      executable: options.executable,
    });
    this.extraEnv = options.extraEnv ?? {};
    this.mcpToken = options.mcpToken;
    this.log = options.log ?? (() => {});
    this.spawnFn = deps.spawnFn ?? (spawn as unknown as SpawnLike);
    this.verify = deps.skipExecutableVerification !== true;
  }

  get currentState(): GatewayProcessState {
    return this.state;
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  get diagnosticsTail(): string[] {
    return [...this.stderrTail];
  }

  get env(): Record<string, string> {
    return buildGatewayChildEnv(this.layout, this.gatewayToken, this.extraEnv, {
      mcpToken: this.mcpToken,
    });
  }

  private spawnGateway(): ChildProcess {
    const child = this.spawnFn(
      this.resolvedExecutable.executable.command,
      [...(this.resolvedExecutable.executable.args ?? []), "gateway"],
      { env: this.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    this.exitPromise = new Promise<ChildExit>((resolvePromise) => {
      child.once("exit", (code, signal) => resolvePromise({ code, signal }));
    });
    this.spawnErrorPromise = new Promise<Error>((resolvePromise) => {
      child.once("error", (error) => resolvePromise(error));
    });
    this.lastExit = null;
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        this.stderrTail.push(line);
        if (this.stderrTail.length > 50) this.stderrTail.shift();
        this.log(`[openclaw] ${line}`);
      }
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (line.trim()) this.log(`[openclaw] ${line}`);
      }
    });
    child.on("exit", (code, signal) => {
      this.lastExit = { code, signal };
      if (this.state !== "stopping" && this.state !== "failed") {
        this.state = "stopped";
      }
      this.child = null;
    });
    child.on("error", () => {
      if (this.state !== "stopping") this.state = "failed";
    });
    return child;
  }

  /**
   * Verifies the executable (one `--version` probe under the minimal env),
   * then starts the gateway. Resolves once the process survives the early
   * window — that means the CHILD WAS SPAWNED AND IS ALIVE, not that the
   * gateway is protocol-ready. Callers wait for protocol readiness
   * (hello-ok) via the client — never for a log substring, never for this
   * return. The 1.5 s window only filters fast crashes (bad binary, bad
   * config, occupied port); a slow boot that passes the window but never
   * reaches hello-ok is still a startup failure at the hello-ok deadline
   * (default 30 s, unchanged).
   *
   * A spawn-level error (missing/permission-denied executable) rejects
   * immediately instead of being mistaken for a running child. A child that
   * exits 78 (EX_CONFIG) triggers one `doctor --fix` repair under the same
   * minimal env and one retry.
   */
  async start(): Promise<void> {
    if (this.state === "running" || this.state === "starting") {
      throw new Error(`gateway process already ${this.state}`);
    }
    this.state = "starting";

    if (this.verify) {
      this.openclawVersion = verifyOpenClawExecutable(this.resolvedExecutable, this.env);
      this.log(`[adapter] verified openclaw ${this.openclawVersion} (${this.resolvedExecutable.source})`);
    }

    this.child = this.spawnGateway();
    const spawnedPid = this.child.pid ?? null;
    const first = await this.waitForEarlyExitOrError(1500);
    if (first === null) {
      this.state = "running";
      this.log(
        `[adapter] child spawned (pid ${spawnedPid}) and alive past the 1.5s early-exit window ` +
          `— NOT protocol-ready; awaiting hello-ok on loopback port ${this.layout.port}`,
      );
      return;
    }
    if (first.kind === "error") {
      this.state = "failed";
      throw new Error(
        `openclaw gateway failed to spawn: ${first.error.message}`,
      );
    }
    if (first.code !== OPENCLAW_EX_CONFIG_EXIT_CODE) {
      this.state = "failed";
      throw new Error(
        `openclaw gateway exited early with code ${first.code}: ${this.stderrTail.join("\n")}`,
      );
    }

    if (this.repairAttempted) {
      this.state = "failed";
      throw new Error(
        `openclaw gateway still exits ${OPENCLAW_EX_CONFIG_EXIT_CODE} after doctor repair: ${this.stderrTail.join("\n")}`,
      );
    }
    this.repairAttempted = true;
    this.state = "repairing";
    await this.runDoctorRepair();
    this.state = "starting";
    this.child = this.spawnGateway();
    const retriedPid = this.child.pid ?? null;
    const second = await this.waitForEarlyExitOrError(1500);
    if (second === null) {
      this.state = "running";
      this.log(
        `[adapter] child spawned after repair (pid ${retriedPid}) and alive past the 1.5s early-exit window ` +
          `— NOT protocol-ready; awaiting hello-ok on loopback port ${this.layout.port}`,
      );
      return;
    }
    this.state = "failed";
    throw new Error(
      second.kind === "error"
        ? `openclaw gateway failed to spawn after repair: ${second.error.message}`
        : `openclaw gateway exited with code ${second.code} after repair retry: ${this.stderrTail.join("\n")}`,
    );
  }

  /**
   * Resolves {kind:"exit"} / {kind:"error"} if the child exits or errors
   * within graceMs, else null (still running).
   */
  private waitForEarlyExitOrError(
    graceMs: number,
  ): Promise<{ kind: "exit"; code: number | null } | { kind: "error"; error: Error } | null> {
    if (!this.child || !this.exitPromise || !this.spawnErrorPromise) {
      return Promise.resolve({ kind: "exit", code: this.lastExit?.code ?? null });
    }
    const exit = this.exitPromise.then(({ code }) => ({ kind: "exit" as const, code }));
    const error = this.spawnErrorPromise.then((err) => ({ kind: "error" as const, error: err }));
    const alive = new Promise<null>((resolvePromise) =>
      setTimeout(() => resolvePromise(null), graceMs),
    );
    return Promise.race([exit, error, alive]);
  }

  private runDoctorRepair(): Promise<void> {
    const args = [
      ...(this.resolvedExecutable.executable.args ?? []),
      "doctor",
      "--fix",
      "--yes",
      "--non-interactive",
    ];
    return new Promise((resolvePromise, rejectPromise) => {
      const doctor = this.spawnFn(this.resolvedExecutable.executable.command, args, {
        env: this.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      doctor.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      doctor.on("exit", (code) => {
        if (code === 0) {
          resolvePromise();
        } else {
          rejectPromise(
            new Error(`openclaw doctor --fix failed with code ${code}: ${stderr.slice(-2000)}`),
          );
        }
      });
      doctor.on("error", (error) => rejectPromise(error));
    });
  }

  /**
   * SIGTERM, wait exitTimeoutMs for the OBSERVED child exit, then SIGKILL and
   * wait again. The process is never reported stopped and its resources are
   * never released without an observed exit event: if no exit is observed
   * even after SIGKILL the state becomes "failed" and stop() rejects.
   */
  async stop(exitTimeoutMs = 10000, killGraceMs = 5000): Promise<void> {
    const child = this.child;
    const exitPromise = this.exitPromise;
    this.state = "stopping";
    if (!child || !exitPromise) {
      // Either never started or the exit was already observed by the
      // exit handler — in both cases the child is verifiably gone.
      this.state = "stopped";
      return;
    }

    child.kill("SIGTERM");
    const first = await Promise.race([
      exitPromise.then(() => "exited" as const),
      new Promise<"timeout">((resolvePromise) =>
        setTimeout(() => resolvePromise("timeout"), exitTimeoutMs),
      ),
    ]);

    if (first === "timeout") {
      child.kill("SIGKILL");
      const second = await Promise.race([
        exitPromise.then(() => "exited" as const),
        new Promise<"timeout">((resolvePromise) =>
          setTimeout(() => resolvePromise("timeout"), killGraceMs),
        ),
      ]);
      if (second === "timeout") {
        // No observed exit even after SIGKILL: do not claim stopped, do not
        // release the child reference.
        this.state = "failed";
        throw new Error(
          `openclaw gateway (pid ${child.pid}) did not exit after SIGKILL within ${killGraceMs}ms`,
        );
      }
    }

    this.child = null;
    this.state = "stopped";
  }
}
