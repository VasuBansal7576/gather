import { writeFileSync } from "node:fs";
import type { GatherOpenClawLayout } from "./layout.ts";

/**
 * Materializes the isolated instance's openclaw.json.
 *
 * The file deliberately contains no secrets: the shared gateway token is
 * referenced through the documented "${VAR}" substitution contract and
 * supplied via the child process environment (OPENCLAW_GATEWAY_TOKEN).
 * See https://docs.openclaw.ai/gateway/config-secrets-env and
 * https://docs.openclaw.ai/gateway/config-gateway for the gateway.* keys.
 */
export interface GatherMcpServerRef {
  /** Loopback URL of the Gather-owned MCP endpoint, e.g. http://127.0.0.1:PORT/mcp */
  url: string;
  /** Optional allowlist applied to discovered MCP tools (mcp.servers.*.toolFilter). */
  toolInclude?: string[];
}

export interface GatherGatewayConfigOptions {
  /** Register the Gather-owned MCP server under mcp.servers.gather. */
  gatherMcp?: GatherMcpServerRef;
}

export function buildGatewayConfig(
  layout: GatherOpenClawLayout,
  options: GatherGatewayConfigOptions = {},
): Record<string, unknown> {
  const config: Record<string, unknown> = {
    gateway: {
      mode: "local",
      port: layout.port,
      bind: "loopback",
      auth: {
        mode: "token",
        token: "${OPENCLAW_GATEWAY_TOKEN}",
      },
    },
    agents: {
      defaults: {
        workspace: layout.workspaceDir,
      },
    },
  };

  if (options.gatherMcp) {
    const server: Record<string, unknown> = {
      url: options.gatherMcp.url,
      transport: "streamable-http",
      enabled: true,
      connectionTimeoutMs: 5000,
      requestTimeoutMs: 20000,
    };
    if (options.gatherMcp.toolInclude && options.gatherMcp.toolInclude.length > 0) {
      server.toolFilter = { include: [...options.gatherMcp.toolInclude] };
    }
    config.mcp = { servers: { gather: server } };
  }

  return config;
}

/**
 * Writes the config file. Returns the written path. The file is valid JSON5
 * (JSON is a subset) and contains no credential material.
 */
export function writeGatewayConfig(
  layout: GatherOpenClawLayout,
  options: GatherGatewayConfigOptions = {},
): string {
  const config = buildGatewayConfig(layout, options);
  writeFileSync(layout.configPath, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  return layout.configPath;
}
