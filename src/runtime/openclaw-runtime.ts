import { resolveModelConfig, writeGatewayConfig, ModelConfigError, type GatherGatewayConfigOptions, type GatherMcpServerRef, type GatherModelSelection } from "./config.ts";
import {
  GatherGatewayConnection,
  type GatherGatewayClientOptions,
  type GatewayConnectionState,
  type GatewayRequestChannel,
} from "./client.ts";
import { ensureLayoutDirectories, resolveGatherOpenClawLayout, type GatherOpenClawLayout } from "./layout.ts";
import { GatherMcpBoundary, type GatherTool } from "./mcp.ts";
import {
  ensureMcpToken,
  OpenClawGatewayProcess,
  type GatewayProcessOptions,
  type GatewayProcessState,
  type OpenClawExecutable,
} from "./process.ts";
import { GatherRuntimeTasks } from "./tasks.ts";

/**
 * Top-level facade: provision -> boot -> protocol readiness -> RPC -> shutdown
 * for the Gather-owned isolated OpenClaw gateway.
 *
 * Lifecycle is explicit at every step:
 *   provision()  — create Gather-owned dirs, generate tokens, write config
 *   start()      — spawn `openclaw gateway`, connect WS, resolve on hello-ok
 *   tasks        — submitTask / waitForRun / sessionHistory / listSessions
 *   stop()       — close WS client, then SIGTERM (SIGKILL after grace)
 */

export interface GatherOpenClawRuntimeOptions {
  /** Gather-owned root, e.g. <repo>/.runtime/openclaw. */
  rootDir: string;
  /** Dedicated loopback port for the gateway WS/HTTP listener. */
  gatewayPort: number;
  /**
   * Explicit model selection for the isolated agent (model + authorized
   * subscription-profile metadata, ids only — never credentials).
   * Optional: when absent, provision/start keep the existing
   * control-plane/demo behavior and `modelStatus()` reports not-ready.
   */
  model?: GatherModelSelection;
  /** Optional Gather-owned MCP tools to expose to the isolated agent. */
  mcpTools?: readonly GatherTool[];
  /** Port for the MCP boundary; 0 = ephemeral (recommended). */
  mcpPort?: number;
  /**
   * Explicit validated executable (absolute path). When omitted, the
   * installed openclaw package entry is resolved; a bare PATH lookup is
   * never used.
   */
  executable?: OpenClawExecutable;
  connectTimeoutMs?: number;
  stopTimeoutMs?: number;
  log?: (line: string) => void;
}

/**
 * Narrow structural seams for lifecycle tests — plain objects satisfying the
 * public surface the facade actually uses; no casts into private-rich
 * classes. `OpenClawGatewayProcess` and `GatherGatewayConnection` satisfy
 * these interfaces structurally.
 */
export interface RuntimeProcessLike {
  readonly gatewayToken: string;
  readonly pid: number | null;
  readonly currentState: GatewayProcessState;
  start(): Promise<void>;
  stop(exitTimeoutMs?: number, killGraceMs?: number): Promise<void>;
}

export interface RuntimeConnectionLike extends GatewayRequestChannel {
  readonly currentState: GatewayConnectionState;
  connect(opts?: { timeoutMs?: number }): Promise<unknown>;
  close(opts?: { timeoutMs?: number }): Promise<void>;
}

/** Narrow structural seam for the MCP boundary; GatherMcpBoundary satisfies it. */
export interface RuntimeMcpBoundaryLike {
  readonly toolNames: string[];
  listen(input: { host?: string; port: number }): Promise<{ url: string; port: number }>;
  close(): Promise<void>;
}

export interface GatherRuntimeDeps {
  processFactory?: (options: GatewayProcessOptions) => RuntimeProcessLike;
  connectionFactory?: (options: GatherGatewayClientOptions) => RuntimeConnectionLike;
  mcpBoundaryFactory?: (options: { tools: readonly GatherTool[]; authToken: string }) => RuntimeMcpBoundaryLike;
}

export class GatherOpenClawRuntime {
  readonly layout: GatherOpenClawLayout;
  private readonly options: GatherOpenClawRuntimeOptions;
  private readonly deps: GatherRuntimeDeps;
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private process: RuntimeProcessLike | null = null;
  private connection: RuntimeConnectionLike | null = null;
  private mcpBoundary: RuntimeMcpBoundaryLike | null = null;
  private mcpRef: GatherMcpServerRef | null = null;
  private mcpToken: string | null = null;
  private provisioned = false;

  constructor(options: GatherOpenClawRuntimeOptions, deps: GatherRuntimeDeps = {}) {
    this.options = options;
    this.deps = deps;
    this.layout = resolveGatherOpenClawLayout({
      rootDir: options.rootDir,
      port: options.gatewayPort,
    });
  }

  get tasks(): GatherRuntimeTasks {
    if (!this.connection?.isReady) {
      throw new Error("runtime is not connected; call start() first");
    }
    return new GatherRuntimeTasks(this.connection);
  }

  get mcpUrl(): string | null {
    return this.mcpRef?.url ?? null;
  }

  /**
   * Configured-for-model gate for the live-model runner. Reports whether
   * an explicit supported model selection is configured — and labels it
   * exactly that: `configured`, with `verified` ALWAYS false. Configuration
   * alone never proves OAuth or model readiness; actual verification lives
   * in the separately managed live auth root, outside this lane. Absent
   * model reports `MODEL_NOT_CONFIGURED` while control-plane/demo use
   * stays valid; invalid selections report their reason instead of
   * throwing. Validation itself runs at config-write time and throws there.
   */
  modelStatus(): { configured: boolean; verified: false; model?: string; reason?: string } {
    const selection = this.options.model;
    if (selection === undefined) {
      return { configured: false, verified: false, reason: "MODEL_NOT_CONFIGURED: no explicit model selection was supplied; control-plane/demo use remains valid" };
    }
    try {
      const resolved = resolveModelConfig(selection);
      return { configured: true, verified: false, model: resolved.model };
    } catch (error) {
      return { configured: false, verified: false, reason: error instanceof Error ? `${error.name}(${("code" in error && typeof error.code === "string") ? error.code : "invalid"}): ${error.message}` : String(error) };
    }
  }

  /**
   * Throwing variant of the gate: returns the validated selection, or
   * throws MODEL_NOT_CONFIGURED (absent) / the validation error
   * (unsupported or unauthorized). For gating live-model runs.
   */
  requireModelSelection(): GatherModelSelection {
    const selection = this.options.model;
    if (selection === undefined) {
      throw new ModelConfigError("MODEL_NOT_CONFIGURED", "No explicit model selection was supplied; pass options.model to enable live-model runs");
    }
    resolveModelConfig(selection);
    return selection;
  }

  /** Single source for every config write so rewrites never drop the model. */
  private configOptions(): GatherGatewayConfigOptions {
    return {
      gatherMcp: this.mcpRef ?? undefined,
      ...(this.options.model === undefined ? {} : { model: this.options.model }),
    };
  }

  /** Creates Gather-owned directories and writes the isolated config. */
  provision(): { configPath: string } {
    ensureLayoutDirectories(this.layout);
    const configPath = writeGatewayConfig(this.layout, this.configOptions());
    this.provisioned = true;
    return { configPath };
  }

  /**
   * Lifecycle guard: concurrent start() calls share the one in-flight
   * startup, and a new startup is rejected whenever any previously owned
   * resource remains — a live or unexited child process, a WS connection
   * (ready OR disconnected), or an MCP boundary — or while a stop() is in
   * flight. Recovery is allowed only after an observed stop() has released
   * every owned reference.
   */
  async start(): Promise<void> {
    if (this.startPromise) {
      return this.startPromise;
    }
    this.assertStartAllowed();
    this.startPromise = this.startInternal();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private assertStartAllowed(): void {
    if (this.stopPromise) {
      throw new Error("runtime is stopping; wait for stop() to settle before starting");
    }
    if (this.process || this.connection || this.mcpBoundary) {
      throw new Error(
        "runtime still owns resources from a previous lifecycle " +
          `(process=${this.process ? this.process.currentState : "none"}, ` +
          `connection=${this.connection ? this.connection.currentState : "none"}, ` +
          `mcp=${this.mcpBoundary ? "listening" : "none"}); call stop() first`,
      );
    }
  }

  private async startInternal(): Promise<void> {
    if (!this.provisioned) this.provision();

    try {
      if (this.options.mcpTools && this.options.mcpTools.length > 0) {
        this.mcpToken = ensureMcpToken(this.layout);
        this.mcpBoundary = (this.deps.mcpBoundaryFactory ?? ((opts) => new GatherMcpBoundary(opts)))({
          tools: this.options.mcpTools,
          authToken: this.mcpToken,
        });
        const bound = await this.mcpBoundary.listen({
          host: "127.0.0.1",
          port: this.options.mcpPort ?? 0,
        });
        this.mcpRef = {
          url: bound.url,
          toolInclude: this.mcpBoundary.toolNames,
        };
        writeGatewayConfig(this.layout, this.configOptions());
      }

      const factory = this.deps.processFactory ?? ((opts) => new OpenClawGatewayProcess(opts));
      this.process = factory({
        layout: this.layout,
        executable: this.options.executable,
        mcpToken: this.mcpToken ?? undefined,
        log: this.options.log,
      });
      await this.process.start();

      const connectFactory =
        this.deps.connectionFactory ?? ((opts) => new GatherGatewayConnection(opts));
      this.connection = connectFactory({
        url: `ws://127.0.0.1:${this.layout.port}`,
        token: this.process.gatewayToken,
        onEvent: this.options.log
          ? (event) => this.options.log!(`[event] ${JSON.stringify(event).slice(0, 500)}`)
          : undefined,
      });
      await this.connection.connect({ timeoutMs: this.options.connectTimeoutMs ?? 30000 });
    } catch (error) {
      await this.rollbackOwnedResources();
      throw error;
    }
  }

  /**
   * Failed-start rollback: close the WS client if any, stop the child if
   * spawned (keeping the reference when its exit was not observed), and
   * tear down the MCP listener + rewrite config without the stale MCP
   * ref. A close that FAILS keeps ownership — the boundary reference (and
   * its token/config ref) is preserved so a later stop() can retry and
   * state never claims a released listener that is still bound.
   */
  private async rollbackOwnedResources(): Promise<void> {
    if (this.connection) {
      await this.connection.close().catch(() => {});
      this.connection = null;
    }
    if (this.process) {
      try {
        await this.process.stop(this.options.stopTimeoutMs ?? 10000);
        this.process = null;
      } catch {
        // Child exit uncertain — keep the reference so state() reports the
        // true lifecycle and a later stop() can retry.
      }
    }
    // Report, don't hide: a failed close keeps the boundary owned and the
    // error goes to the diagnostic log — the original start error still
    // propagates to the caller.
    const mcpError = await this.releaseMcpBoundary();
    if (mcpError) {
      this.options.log?.(`[runtime] MCP boundary close failed during rollback (ownership retained): ${mcpError.message}`);
    }
  }

  /**
   * Close the MCP boundary and release its references ONLY on observed
   * close success. On failure the boundary/token/ref stay owned (the
   * listener may still be bound) and the error is returned for the caller
   * to surface — ownership is never silently dropped.
   */
  private async releaseMcpBoundary(): Promise<Error | null> {
    if (!this.mcpBoundary) return null;
    try {
      await this.mcpBoundary.close();
      this.mcpBoundary = null;
      this.mcpRef = null;
      this.mcpToken = null;
      writeGatewayConfig(this.layout, this.configOptions());
      return null;
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  }

  /**
   * Single-flight shutdown: concurrent stop() calls share the one in-flight
   * teardown. Waits for any in-flight startup to settle first so start/stop
   * ordering is unambiguous.
   */
  async stop(): Promise<void> {
    if (this.stopPromise) {
      return this.stopPromise;
    }
    this.stopPromise = this.stopInternal();
    try {
      await this.stopPromise;
    } finally {
      this.stopPromise = null;
    }
  }

  private async stopInternal(): Promise<void> {
    const inFlightStart = this.startPromise;
    let stopError: unknown = null;
    // Prompt cancellation: reach the owned child/repair immediately instead
    // of waiting for an in-flight start() to settle on its own — a stop
    // requested during a doctor repair must abort the post-repair respawn,
    // not wait out the repair deadline.
    if (this.process) {
      try {
        await this.process.stop(this.options.stopTimeoutMs ?? 10000);
      } catch (error) {
        // Child exit was not observed: keep the reference, release nothing.
        stopError = error;
      }
    }
    if (inFlightStart) {
      await inFlightStart.catch(() => {});
    }
    // Second pass only when needed: after an in-flight start() settles (the
    // startup may have spawned — or begun a repair on — a child after the
    // first stop ran) or when the first stop could not observe the exit
    // (retry the reap). A clean stop with nothing in flight skips it, so
    // callers never see a spurious extra stop. The reference is released
    // only after an observed-clean stop; an earlier failure is still
    // reported even when the retry observes the exit.
    if (this.process && (inFlightStart !== null || stopError !== null)) {
      try {
        await this.process.stop(this.options.stopTimeoutMs ?? 10000);
        this.process = null;
      } catch (error) {
        stopError ??= error;
      }
    } else if (this.process) {
      this.process = null;
    }
    if (this.connection) {
      await this.connection.close().catch(() => {});
      this.connection = null;
    }
    // An MCP close failure is reported, not swallowed: the boundary stays
    // owned (listener may still be bound) and the error propagates.
    const mcpError = await this.releaseMcpBoundary();
    if (stopError) throw stopError;
    if (mcpError) throw mcpError;
  }

  get state(): { process: GatewayProcessState; connection: GatewayConnectionState } {
    return {
      process: this.process?.currentState ?? "stopped",
      connection: this.connection?.currentState ?? "disconnected",
    };
  }
}
