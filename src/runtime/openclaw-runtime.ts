import { writeGatewayConfig, type GatherMcpServerRef } from "./config.ts";
import { GatherGatewayConnection, type GatewayConnectionState } from "./client.ts";
import { ensureLayoutDirectories, resolveGatherOpenClawLayout, type GatherOpenClawLayout } from "./layout.ts";
import { GatherMcpBoundary, type AnyGatherToolDefinition } from "./mcp.ts";
import { OpenClawGatewayProcess, type OpenClawExecutable, type GatewayProcessState } from "./process.ts";
import { GatherRuntimeTasks } from "./tasks.ts";

/**
 * Top-level facade: provision -> boot -> protocol readiness -> RPC -> shutdown
 * for the Gather-owned isolated OpenClaw gateway.
 *
 * Lifecycle is explicit at every step:
 *   provision()  — create Gather-owned dirs, generate token, write config
 *   start()      — spawn `openclaw gateway`, connect WS, resolve on hello-ok
 *   tasks        — submitTask / waitForRun / sessionHistory / listSessions
 *   stop()       — close WS client, then SIGTERM (SIGKILL after grace)
 */

export interface GatherOpenClawRuntimeOptions {
  /** Gather-owned root, e.g. <repo>/.runtime/openclaw. */
  rootDir: string;
  /** Dedicated loopback port for the gateway WS/HTTP listener. */
  gatewayPort: number;
  /** Optional Gather-owned MCP tools to expose to the isolated agent. */
  mcpTools?: readonly AnyGatherToolDefinition[];
  /** Port for the MCP boundary; 0 = ephemeral (recommended). */
  mcpPort?: number;
  /** Executable override for the openclaw package entry. */
  executable?: OpenClawExecutable;
  connectTimeoutMs?: number;
  stopTimeoutMs?: number;
  log?: (line: string) => void;
}

export type GatherRuntimeState = GatewayProcessState | GatewayConnectionState;

export class GatherOpenClawRuntime {
  readonly layout: GatherOpenClawLayout;
  private readonly options: GatherOpenClawRuntimeOptions;
  private process: OpenClawGatewayProcess | null = null;
  private connection: GatherGatewayConnection | null = null;
  private mcpBoundary: GatherMcpBoundary | null = null;
  private mcpRef: GatherMcpServerRef | null = null;
  private provisioned = false;

  constructor(options: GatherOpenClawRuntimeOptions) {
    this.options = options;
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

  /** Creates Gather-owned directories and writes the isolated config. */
  provision(): { configPath: string } {
    ensureLayoutDirectories(this.layout);
    if (this.options.mcpTools) {
      this.mcpBoundary = new GatherMcpBoundary({ tools: this.options.mcpTools });
    }
    const configPath = writeGatewayConfig(this.layout, {
      gatherMcp: this.mcpRef ?? undefined,
    });
    this.provisioned = true;
    return { configPath };
  }

  /**
   * Starts the MCP boundary (if configured), rewrites config with its bound
   * URL, spawns the gateway, and resolves after protocol hello-ok.
   */
  async start(): Promise<void> {
    if (!this.provisioned) this.provision();

    if (this.mcpBoundary) {
      const bound = await this.mcpBoundary.listen({
        host: "127.0.0.1",
        port: this.options.mcpPort ?? 0,
      });
      this.mcpRef = {
        url: bound.url,
        toolInclude: this.mcpBoundary.toolNames,
      };
      writeGatewayConfig(this.layout, { gatherMcp: this.mcpRef });
    }

    this.process = new OpenClawGatewayProcess({
      layout: this.layout,
      executable: this.options.executable,
      log: this.options.log,
    });
    await this.process.start();

    this.connection = new GatherGatewayConnection({
      url: `ws://127.0.0.1:${this.layout.port}`,
      token: this.process.gatewayToken,
      onEvent: this.options.log
        ? (event) => this.options.log!(`[event] ${JSON.stringify(event).slice(0, 500)}`)
        : undefined,
    });
    await this.connection.connect({ timeoutMs: this.options.connectTimeoutMs ?? 30000 });
  }

  /** Closes the WS client, then stops the child process and MCP boundary. */
  async stop(): Promise<void> {
    if (this.connection) {
      await this.connection.close().catch(() => {});
      this.connection = null;
    }
    if (this.process) {
      await this.process.stop(this.options.stopTimeoutMs ?? 10000).catch(() => {});
      this.process = null;
    }
    if (this.mcpBoundary) {
      await this.mcpBoundary.close().catch(() => {});
      this.mcpBoundary = null;
      this.mcpRef = null;
    }
  }

  get state(): { process: GatewayProcessState; connection: GatewayConnectionState } {
    return {
      process: this.process?.currentState ?? "stopped",
      connection: this.connection?.currentState ?? "disconnected",
    };
  }
}
