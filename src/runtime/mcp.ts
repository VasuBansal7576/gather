import { randomUUID, timingSafeEqual } from "node:crypto";
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
 * @modelcontextprotocol/sdk Streamable HTTP transport.
 *
 * Security model — loopback is not authorization:
 * - Every request needs `Authorization: Bearer <token>` where the token is a
 *   locally generated Gather-only secret, delivered to the gateway through
 *   the supported `mcp.servers.gather.headers` config field (marked sensitive
 *   in the OpenClaw config schema, so it resolves via env substitution and is
 *   redacted from config snapshots and logs).
 * - The Host header must match the bound loopback address; a present Origin
 *   header must match the bound origin — DNS-rebinding protection done in
 *   this middleware, as the SDK recommends external middleware over its
 *   deprecated allowedHosts/allowedOrigins options.
 *
 * Session lifecycle: one transport per MCP session (the SDK's stateful
 * transport serves exactly one initialization). A fresh `initialize` — e.g.
 * after the OpenClaw MCP client reconnects — creates a new session entry;
 * DELETE closes and removes it. Sessions are reaped on boundary close.
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

export interface GatherToolDefinition<TArgs> {
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

/**
 * Erased tool shape stored by the boundary. `defineGatherTool` keeps the
 * caller's typed handler while the boundary invokes it through `unknown` —
 * the SDK validates arguments against the zod inputSchema before dispatch,
 * so the contained cast is safe. No `any`.
 */
export interface GatherTool {
  name: string;
  description: string;
  inputSchema: ZodRawShape;
  execution: GatherToolExecution;
  call(args: unknown, context: GatherToolContext): Promise<GatherToolResult>;
}

export function defineGatherTool<TArgs>(
  definition: GatherToolDefinition<TArgs>,
): GatherTool {
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema,
    execution: definition.execution,
    call: (args, context) => definition.handler(args as TArgs, context),
  };
}

const SIMULATED_LABEL = "SIMULATED — not a verified integration";

function wrapResult(tool: GatherTool, result: GatherToolResult): GatherToolResult {
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

function buildMcpServer(serverName: string, tools: readonly GatherTool[]): McpServer {
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
        const result = await tool.call(args, context);
        return wrapResult(tool, result);
      },
    );
  }
  return server;
}

interface McpSession {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  createdAt: number;
}

export interface GatherMcpBoundaryOptions {
  /** MCP server identity; default "gather". */
  serverName?: string;
  tools: readonly GatherTool[];
  /** URL path; default "/mcp". */
  path?: string;
  /**
   * Bearer token required on every request. Loopback is not authorization;
   * this is the same secret delivered to the gateway via the sensitive
   * `mcp.servers.gather.headers.authorization` config field.
   */
  authToken: string;
  /** Extra Host header values beyond the bound loopback address. */
  allowedHosts?: string[];
  /** Extra Origin header values beyond the bound loopback origin. */
  allowedOrigins?: string[];
}

function jsonRpcMethod(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  if (Array.isArray(body)) {
    const first = body[0];
    return typeof first === "object" && first !== null
      ? (first as { method?: string }).method
      : undefined;
  }
  return (body as { method?: string }).method;
}

function isInitializeRequest(body: unknown): boolean {
  if (Array.isArray(body)) {
    return body.some((entry) => jsonRpcMethod(entry) === "initialize");
  }
  return jsonRpcMethod(body) === "initialize";
}

export class GatherMcpBoundary {
  private readonly serverName: string;
  private readonly tools: readonly GatherTool[];
  private readonly path: string;
  private readonly authToken: string;
  private readonly extraHosts: string[];
  private readonly extraOrigins: string[];
  private httpServer: Server | null = null;
  private sessions = new Map<string, McpSession>();
  private boundHost = "127.0.0.1";
  private boundPort = 0;

  constructor(options: GatherMcpBoundaryOptions) {
    if (!options.authToken || options.authToken.length < 16) {
      throw new Error("MCP boundary requires an authToken of at least 16 characters");
    }
    this.serverName = options.serverName ?? "gather";
    this.tools = options.tools;
    this.path = options.path ?? "/mcp";
    this.authToken = options.authToken;
    this.extraHosts = options.allowedHosts ?? [];
    this.extraOrigins = options.allowedOrigins ?? [];
  }

  get toolNames(): string[] {
    return this.tools.map((tool) => tool.name);
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Starts a loopback-only HTTP server. Returns the bound URL that belongs in
   * `mcp.servers.gather.url` of the isolated instance config.
   */
  async listen(input: { host?: string; port: number }): Promise<{ url: string; port: number }> {
    if (this.httpServer) throw new Error("MCP boundary already listening");
    const host = input.host ?? "127.0.0.1";
    if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
      throw new Error(`MCP boundary must bind loopback, got ${host}`);
    }
    this.boundHost = host;

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
    this.boundPort = typeof address === "object" && address ? address.port : input.port;
    return { url: `http://${host}:${this.boundPort}${this.path}`, port: this.boundPort };
  }

  private expectedHosts(): Set<string> {
    const hosts = new Set<string>([
      `${this.boundHost}:${this.boundPort}`,
      `127.0.0.1:${this.boundPort}`,
      `localhost:${this.boundPort}`,
      `[::1]:${this.boundPort}`,
      ...this.extraHosts,
    ]);
    return hosts;
  }

  private allowedOrigins(): Set<string> {
    return new Set<string>([
      `http://127.0.0.1:${this.boundPort}`,
      `http://localhost:${this.boundPort}`,
      `http://[::1]:${this.boundPort}`,
      ...this.extraOrigins,
    ]);
  }

  private checkAuth(req: IncomingMessage): "ok" | "unauthorized" | "forbidden" {
    const auth = req.headers.authorization;
    const expected = `Bearer ${this.authToken}`;
    const valid =
      typeof auth === "string" &&
      auth.length === expected.length &&
      timingSafeEqual(Buffer.from(auth), Buffer.from(expected));
    if (!valid) return "unauthorized";

    const host = req.headers.host;
    if (!host || !this.expectedHosts().has(host)) return "forbidden";

    const origin = req.headers.origin;
    if (origin && !this.allowedOrigins().has(origin)) return "forbidden";

    return "ok";
  }

  private async openSession(res: ServerResponse, req: IncomingMessage, body: unknown): Promise<void> {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        this.sessions.set(sessionId, session);
      },
      onsessionclosed: (sessionId) => {
        void this.closeSession(sessionId);
      },
    });
    const server = buildMcpServer(this.serverName, this.tools);
    const session: McpSession = { transport, server, createdAt: Date.now() };
    transport.onclose = () => {
      if (transport.sessionId) void this.closeSession(transport.sessionId);
    };
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      await transport.close().catch(() => {});
      await server.close().catch(() => {});
      throw error;
    }
  }

  private async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    await session.transport.close().catch(() => {});
    await session.server.close().catch(() => {});
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== this.path) {
      res.writeHead(404).end();
      return;
    }

    const auth = this.checkAuth(req);
    if (auth === "unauthorized") {
      res.writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (auth === "forbidden") {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "forbidden host or origin" }));
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

    // A fresh initialize always opens a new session — this is the reconnect
    // path after an MCP client restart or dropped connection.
    if (req.method === "POST" && isInitializeRequest(parsedBody)) {
      await this.openSession(res, req, parsedBody);
      return;
    }

    const sessionId = req.headers["mcp-session-id"];
    const session = typeof sessionId === "string" ? this.sessions.get(sessionId) : undefined;
    if (!session) {
      // Per the MCP spec: invalid or missing session on a non-initialize
      // request is rejected.
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unknown or missing MCP session" }));
      return;
    }

    await session.transport.handleRequest(req, res, parsedBody);
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
    for (const sessionId of [...this.sessions.keys()]) {
      await this.closeSession(sessionId);
    }
    if (server) {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    }
  }
}
