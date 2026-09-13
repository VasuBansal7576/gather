import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { ZodRawShape } from "zod";

/**
 * Gather-owned MCP tool boundary.
 *
 * OpenClaw is an MCP client: server definitions live under `mcp.servers` in
 * the isolated instance's config and discovered tools pass through the normal
 * tool-profile/policy layer (https://docs.openclaw.ai/tools/mcp). This module
 * hosts that `gather` server on loopback using the official
 * @modelcontextprotocol/sdk Streamable HTTP transport in stateless mode.
 *
 * Authority model (hard rule): this boundary NEVER mints booking receipts.
 * Handlers are narrowly typed injected functions; the dependent integration
 * wires them to the verified Gather backend. Every result is stamped
 * `authority: "advisory"` — durable ActionExecution records are created only
 * by Gather's own store via approved-action execution, never by model prose
 * or by an arbitrary tool call reaching this boundary. OpenClaw's own tool
 * approval system is a separate mechanism and does not confer Gather booking
 * authority.
 */

export type GatherToolExecution = "live" | "simulated";

export interface GatherToolContext {
  toolName: string;
  /** Declared at registration; there is no silent default. */
  execution: GatherToolExecution;
  simulated: boolean;
}

export interface GatherToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export type GatherToolHandler<TArgs> = (
  args: TArgs,
  context: GatherToolContext,
) => Promise<GatherToolResult>;

export interface GatherToolDefinition<TArgs = Record<string, unknown>> {
  name: string;
  description: string;
  /** Zod raw shape for the tool's input schema. */
  inputSchema: ZodRawShape;
  /**
   * Required: every tool must declare whether it executes against the real
   * backend ("live") or a stand-in ("simulated"). Simulated tools have every
   * result labeled and any `verified: true` claim stripped.
   */
  execution: GatherToolExecution;
  handler: GatherToolHandler<TArgs>;
}

/** Covariant alias for heterogeneous tool lists (args are validated by zod). */
export type AnyGatherToolDefinition = GatherToolDefinition<any>;

const SIMULATED_LABEL = "SIMULATED — not a verified integration";

function wrapResult(
  tool: AnyGatherToolDefinition,
  result: GatherToolResult,
): GatherToolResult {
  const simulated = tool.execution === "simulated";
  const structuredContent: Record<string, unknown> = {
    ...(result.structuredContent ?? {}),
    "gather:authority": "advisory",
    "gather:simulated": simulated,
  };
  if (simulated) {
    delete structuredContent.verified;
  }
  const content = [...result.content];
  if (simulated) {
    content.unshift({ type: "text", text: `[${SIMULATED_LABEL}]` });
  }
  return { ...result, content, structuredContent };
}

function buildMcpServer(
  serverName: string,
  tools: readonly AnyGatherToolDefinition[],
): McpServer {
  const server = new McpServer({ name: serverName, version: "0.1.0" });
  for (const tool of tools) {
    const simulated = tool.execution === "simulated";
    server.registerTool(
      tool.name,
      {
        description: simulated ? `[${SIMULATED_LABEL}] ${tool.description}` : tool.description,
        inputSchema: tool.inputSchema,
      },
      async (args) => {
        const context: GatherToolContext = {
          toolName: tool.name,
          execution: tool.execution,
          simulated,
        };
        const result = await tool.handler(args as Record<string, unknown>, context);
        return wrapResult(tool, result);
      },
    );
  }
  return server;
}

export interface GatherMcpBoundaryOptions {
  /** MCP server identity; default "gather". */
  serverName?: string;
  tools: readonly AnyGatherToolDefinition[];
  /** URL path; default "/mcp". */
  path?: string;
}

export class GatherMcpBoundary {
  private readonly serverName: string;
  private readonly tools: readonly AnyGatherToolDefinition[];
  private readonly path: string;
  private httpServer: Server | null = null;
  private mcpServer: McpServer | null = null;
  private transport: StreamableHTTPServerTransport | null = null;

  constructor(options: GatherMcpBoundaryOptions) {
    this.serverName = options.serverName ?? "gather";
    this.tools = options.tools;
    this.path = options.path ?? "/mcp";
  }

  get toolNames(): string[] {
    return this.tools.map((tool) => tool.name);
  }

  /**
   * Starts a loopback-only HTTP server with a stateful Streamable HTTP
   * transport (the SDK's sessionIdGenerator contract), so the OpenClaw MCP
   * client can initialize once and then call tools on its session. Returns
   * the bound URL that belongs in `mcp.servers.gather.url` of the isolated
   * instance config.
   */
  async listen(input: { host?: string; port: number }): Promise<{ url: string; port: number }> {
    if (this.httpServer) throw new Error("MCP boundary already listening");
    const host = input.host ?? "127.0.0.1";
    if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
      throw new Error(`MCP boundary must bind loopback, got ${host}`);
    }

    this.mcpServer = buildMcpServer(this.serverName, this.tools);
    this.transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });
    await this.mcpServer.connect(this.transport);

    this.httpServer = createServer((req, res) => {
      void this.handleRequest(req, res).catch((error: unknown) => {
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
        }
        res.end(JSON.stringify({ error: String(error) }));
      });
    });

    await new Promise<void>((resolvePromise, rejectPromise) => {
      this.httpServer!.once("error", rejectPromise);
      this.httpServer!.listen(input.port, host, () => resolvePromise());
    });

    const address = this.httpServer.address();
    const port = typeof address === "object" && address ? address.port : input.port;
    return { url: `http://${host}:${port}${this.path}`, port };
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== this.path) {
      res.writeHead(404).end();
      return;
    }
    let parsedBody: unknown;
    if (req.method === "POST") {
      const body = await this.readBody(req);
      try {
        parsedBody = body.length > 0 ? JSON.parse(body.toString("utf8")) : undefined;
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid JSON body" }));
        return;
      }
    }

    await this.transport!.handleRequest(req, res, parsedBody);
  }

  private readBody(req: IncomingMessage): Promise<Buffer> {
    return new Promise((resolvePromise, rejectPromise) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => resolvePromise(Buffer.concat(chunks)));
      req.on("error", rejectPromise);
    });
  }

  async close(): Promise<void> {
    const server = this.httpServer;
    this.httpServer = null;
    if (this.transport) {
      await this.transport.close().catch(() => {});
      this.transport = null;
    }
    if (this.mcpServer) {
      await this.mcpServer.close().catch(() => {});
      this.mcpServer = null;
    }
    if (server) {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    }
  }
}
