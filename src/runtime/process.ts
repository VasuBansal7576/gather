import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
 * enabled (OPENCLAW_LOAD_SHELL_ENV is never set).
 */

export const OPENCLAW_EX_CONFIG_EXIT_CODE = 78;

export interface OpenClawExecutable {
  /** Executable to spawn, e.g. "openclaw" or an absolute node binary. */
  command: string;
  /**
   * Arguments prepended before "gateway". Use ["/path/to/openclaw.mjs"] with
   * command=process.execPath when spawning the package entry directly.
   */
  args?: string[];
}

export interface GatewayProcessOptions {
  layout: GatherOpenClawLayout;
  /** Defaults to { command: "openclaw" } resolved via PATH. */
  executable?: OpenClawExecutable;
  /** Pre-generated token; generated and persisted when omitted. */
  gatewayToken?: string;
  /** Extra OPENCLAW_*-safe env additions. Must not override isolation keys. */
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
  "HOME",
  "TMPDIR",
]);

export function tokenFilePath(layout: GatherOpenClawLayout): string {
  return join(layout.secretsDir, "gateway-token");
}

/** Generates and persists a Gather-only gateway token (mode 0600). */
export function ensureGatewayToken(layout: GatherOpenClawLayout): string {
  const token = `gather-gw-${randomBytes(24).toString("base64url")}`;
  writeFileSync(tokenFilePath(layout), `${token}\n`, { mode: 0o600 });
  chmodSync(tokenFilePath(layout), 0o600);
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
): Record<string, string> {
  for (const key of Object.keys(extraEnv)) {
    if (ISOLATION_ENV_KEYS.has(key)) {
      throw new Error(`extraEnv may not override isolation variable ${key}`);
    }
  }
  return {
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

export class OpenClawGatewayProcess {
  readonly layout: GatherOpenClawLayout;
  readonly gatewayToken: string;
  private readonly executable: OpenClawExecutable;
  private readonly extraEnv: Record<string, string>;
  private readonly log: (line: string) => void;
  private readonly spawnFn: SpawnLike;
  private child: ChildProcess | null = null;
  private state: GatewayProcessState = "stopped";
  private exitCode: number | null = null;
  private exitSignal: string | null = null;
  private stderrTail: string[] = [];
  private repairAttempted = false;

  constructor(options: GatewayProcessOptions, deps: { spawnFn?: SpawnLike } = {}) {
    this.layout = options.layout;
    this.gatewayToken = options.gatewayToken ?? ensureGatewayToken(options.layout);
    this.executable = options.executable ?? { command: "openclaw" };
    this.extraEnv = options.extraEnv ?? {};
    this.log = options.log ?? (() => {});
    this.spawnFn = deps.spawnFn ?? (spawn as unknown as SpawnLike);
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
    return buildGatewayChildEnv(this.layout, this.gatewayToken, this.extraEnv);
  }

  private spawnGateway(): ChildProcess {
    const child = this.spawnFn(
      this.executable.command,
      [...(this.executable.args ?? []), "gateway"],
      { env: this.env, stdio: ["ignore", "pipe", "pipe"] },
    );
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
      this.exitCode = code;
      this.exitSignal = signal;
      if (this.state !== "stopping" && this.state !== "failed") {
        this.state = "stopped";
      }
      this.child = null;
    });
    child.on("error", () => {
      this.state = "failed";
    });
    return child;
  }

  /**
   * Starts the gateway process. Resolves once the process is spawned; callers
   * wait for protocol readiness (hello-ok) via the client, per the embedding
   * contract — never for a log substring.
   *
   * If the child exits 78 (EX_CONFIG) the supervisor runs
   * `openclaw doctor --fix --yes --non-interactive` once under the same env,
   * retries startup once, then rejects with the diagnostics tail.
   */
  async start(): Promise<void> {
    if (this.state === "running" || this.state === "starting") {
      throw new Error(`gateway process already ${this.state}`);
    }
    this.state = "starting";
    this.exitCode = null;
    this.exitSignal = null;

    this.child = this.spawnGateway();
    const firstExit = await this.waitForEarlyExit(1500);
    if (firstExit === null) {
      this.state = "running";
      return;
    }
    if (firstExit !== OPENCLAW_EX_CONFIG_EXIT_CODE) {
      this.state = "failed";
      throw new Error(
        `openclaw gateway exited early with code ${firstExit}: ${this.stderrTail.join("\n")}`,
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
    const secondExit = await this.waitForEarlyExit(1500);
    if (secondExit === null) {
      this.state = "running";
      return;
    }
    this.state = "failed";
    throw new Error(
      `openclaw gateway exited with code ${secondExit} after repair retry: ${this.stderrTail.join("\n")}`,
    );
  }

  /**
   * Returns the exit code if the child exits within graceMs, else null.
   * A still-running child after the grace window counts as "started"; real
   * readiness is proven by the protocol handshake, not process survival.
   */
  private waitForEarlyExit(graceMs: number): Promise<number | null> {
    const child = this.child;
    if (!child) return Promise.resolve(this.exitCode);
    if (this.exitCode !== null) return Promise.resolve(this.exitCode);
    return new Promise((resolvePromise) => {
      const timer = setTimeout(() => {
        child.off("exit", onExit);
        resolvePromise(null);
      }, graceMs);
      const onExit = (code: number | null) => {
        clearTimeout(timer);
        resolvePromise(code ?? 1);
      };
      child.once("exit", onExit);
    });
  }

  private runDoctorRepair(): Promise<void> {
    const args = [...(this.executable.args ?? []), "doctor", "--fix", "--yes", "--non-interactive"];
    return new Promise((resolvePromise, rejectPromise) => {
      const doctor = this.spawnFn(this.executable.command, args, {
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
   * SIGTERM, wait exitTimeoutMs, then SIGKILL. Resolves when the child is
   * gone. Shutdown of the WS client is the caller's job and happens first;
   * per the embedding contract the gateway broadcasts a `shutdown` event
   * before an orderly close.
   */
  async stop(exitTimeoutMs = 10000): Promise<void> {
    const child = this.child;
    this.state = "stopping";
    if (!child) {
      this.state = this.exitCode === null ? "stopped" : "failed";
      return;
    }
    const exited = new Promise<number | null>((resolvePromise) => {
      if (this.exitCode !== null) {
        resolvePromise(this.exitCode);
        return;
      }
      child.once("exit", (code) => resolvePromise(code));
    });
    child.kill("SIGTERM");
    const result = await Promise.race([
      exited,
      new Promise<"timeout">((resolvePromise) =>
        setTimeout(() => resolvePromise("timeout"), exitTimeoutMs),
      ),
    ]);
    if (result === "timeout" && this.child) {
      this.child.kill("SIGKILL");
      await new Promise<void>((resolvePromise) => {
        this.child?.once("exit", () => resolvePromise());
        setTimeout(resolvePromise, 5000);
      });
    }
    this.child = null;
    this.state = "stopped";
  }
}
