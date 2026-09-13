import { join } from "node:path";
import { writeFileSync } from "node:fs";
import type { GatherOpenClawLayout } from "./layout.ts";

/**
 * Materializes the isolated instance's openclaw.json.
 *
 * The file deliberately contains no secrets: the shared gateway token and the
 * MCP boundary bearer token are referenced through the documented "${VAR}"
 * substitution contract and supplied via the child process environment.
 * See https://docs.openclaw.ai/gateway/config-secrets-env and
 * https://docs.openclaw.ai/gateway/config-gateway for the gateway.* keys.
 *
 * Tool policy (https://docs.openclaw.ai/gateway/config-tools/tool-policy):
 * the agent may only reach the Gather MCP boundary plus session messaging
 * tools. `tools.profile: "messaging"` exposes MCP tools without the
 * fs/runtime/web groups (the `minimal` profile hides MCP entirely), and
 * `tools.deny` is the hard stop for every mutating/arbitrary surface —
 * profile includes are overridden by denies.
 */
export interface GatherMcpServerRef {
  /** Loopback URL of the Gather-owned MCP endpoint, e.g. http://127.0.0.1:PORT/mcp */
  url: string;
  /** Allowlist applied to discovered MCP tools (mcp.servers.*.toolFilter). */
  toolInclude: string[];
}

export interface GatherGatewayConfigOptions {
  /** Register the Gather-owned MCP server under mcp.servers.gather. */
  gatherMcp?: GatherMcpServerRef;
}

/** Mutating/arbitrary tools denied on top of the messaging profile. */
export const GATHER_TOOL_DENY = Object.freeze([
  "group:runtime", // exec, process, code_execution
  "group:fs", // read, write, edit, apply_patch
  "group:web", // web fetch/search surface
  "browser",
  "cron",
  "subagents",
  "sessions_spawn",
  "image_generate",
  "music_generate",
  "video_generate",
]);

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
    tools: {
      profile: "messaging",
      deny: [...GATHER_TOOL_DENY],
    },
    logging: {
      file: join(layout.logsDir, "gateway.log"),
    },
  };

  if (options.gatherMcp) {
    const server: Record<string, unknown> = {
      url: options.gatherMcp.url,
      transport: "streamable-http",
      enabled: true,
      headers: {
        // Sensitive header surface: value resolves from the child env at
        // runtime and is redacted from config snapshots — never a literal.
        authorization: "Bearer ${GATHER_MCP_TOKEN}",
      },
      connectionTimeoutMs: 5000,
      requestTimeoutMs: 20000,
      toolFilter: { include: [...options.gatherMcp.toolInclude] },
    };
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
