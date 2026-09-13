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
 *
 * Model selection (installed OpenClaw schema: `agents.defaults.model` as a
 * plain `provider/model` string, top-level `auth.profiles`/`auth.order`):
 * the model is always emitted as a bare string — never the
 * primary+fallbacks object, so no alternate-model fallback exists — and
 * the auth section carries profile selection/order metadata only
 * (ids + oauth route + display fields). Credentials live in the
 * separately-managed auth store created by explicit OAuth login; they are
 * never written here, never logged, and never accepted by these options.
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
  /**
   * Explicit model selection for the isolated agent. Optional: when
   * absent, no model/auth keys are emitted and the existing
   * control-plane/demo behavior is unchanged. When present, the caller
   * must supply the validated explicit model plus authorized profile
   * metadata (ids only — never credentials).
   */
  model?: GatherModelSelection;
}

/**
 * Owner-authorized models, exact `provider/model` refs. Only these refs
 * are ever emitted into a gateway config — anything else fails closed.
 * Today: gpt-5.6-luna via the Codex subscription ONLY.
 */
export const GATHER_SUPPORTED_MODELS: readonly string[] = Object.freeze([
  "openai-codex/gpt-5.6-luna",
]);

/**
 * Authorized auth-profile metadata (selection/order only). Mirrors the
 * installed OpenClaw schema (`auth.profiles[{provider, mode, email?,
 * displayName?}]`, `auth.order[provider] = [profileIds...]`) with the
 * subscription-only restriction enforced by the `mode: "oauth"` literal:
 * an API-key route is unrepresentable here, so no fallback to key auth
 * can be configured through this surface. Profile ids name credentials
 * created by an explicit OAuth login elsewhere — this file, the gateway
 * config, and logs never carry the credentials themselves.
 */
export interface GatherModelAuthProfile {
  /** Authorized profile id (metadata only, never a secret). */
  profileId: string;
  /** Provider id the profile satisfies (must equal the model ref provider). */
  provider: string;
  /** Subscription-only route. Literal type: api_key is not expressible. */
  mode: "oauth";
  /** Account email shown in profile selection/status surfaces. */
  email?: string;
  /** Human-readable label shown in profile selection/status surfaces. */
  displayName?: string;
}

export interface GatherModelSelection {
  /** Exact supported `provider/model` ref (never a primary+fallback chain). */
  model: string;
  /** Authorized subscription profile metadata for the model's provider. */
  auth: GatherModelAuthProfile;
}

export type ModelConfigErrorCode =
  | "MODEL_NOT_CONFIGURED"
  | "INVALID_MODEL"
  | "UNSUPPORTED_MODEL"
  | "INVALID_AUTH";

export class ModelConfigError extends Error {
  readonly code: ModelConfigErrorCode;
  constructor(code: ModelConfigErrorCode, message: string) {
    super(message);
    this.name = "ModelConfigError";
    this.code = code;
  }
}

/**
 * Validate a caller-supplied model selection against the exact installed
 * schema fields and the owner-authorized list. Throws ModelConfigError —
 * never fabricates provider keys, fallbacks, or credentials.
 */
export function resolveModelConfig(selection: GatherModelSelection): {
  model: string;
  profileId: string;
  provider: string;
  email: string | undefined;
  displayName: string | undefined;
} {
  const model = selection.model?.trim() ?? "";
  const slash = model.indexOf("/");
  const provider = slash > 0 ? model.slice(0, slash) : "";
  const modelId = slash > 0 ? model.slice(slash + 1) : "";
  if (provider.length === 0 || modelId.length === 0 || modelId.includes("/")) {
    throw new ModelConfigError("INVALID_MODEL", `Model must be an exact "provider/model" ref, got ${JSON.stringify(selection.model)}`);
  }
  if (!GATHER_SUPPORTED_MODELS.includes(model)) {
    throw new ModelConfigError(
      "UNSUPPORTED_MODEL",
      `Model ${JSON.stringify(model)} is not owner-authorized; supported: ${GATHER_SUPPORTED_MODELS.join(", ")} (no alternate model or API-key fallback exists on this surface)`,
    );
  }
  const auth = selection.auth;
  if (!auth || typeof auth.profileId !== "string" || auth.profileId.trim().length === 0) {
    throw new ModelConfigError("INVALID_AUTH", "An authorized auth profileId (metadata) is required; profiles are created by explicit OAuth login, never here");
  }
  // Runtime guard behind the `mode: "oauth"` literal: data crossing as
  // JSON could carry api_key, and subscription-only must reject it loudly.
  if ((auth.mode as string) !== "oauth") {
    throw new ModelConfigError("INVALID_AUTH", `Auth mode must be "oauth" (subscription-only); got ${JSON.stringify((auth as { mode?: unknown }).mode)} — API-key auth is not supported`);
  }
  if (auth.provider !== provider) {
    throw new ModelConfigError("INVALID_AUTH", `Auth profile provider ${JSON.stringify(auth.provider)} does not satisfy model provider ${JSON.stringify(provider)}`);
  }
  return {
    model,
    profileId: auth.profileId.trim(),
    provider,
    email: auth.email,
    displayName: auth.displayName,
  };
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

  if (options.model !== undefined) {
    const resolved = resolveModelConfig(options.model);
    // Bare string only: the primary+fallbacks object form is never
    // emitted, so the agent has exactly one authorized model and no
    // alternate-model fallback.
    (config.agents as Record<string, unknown>).defaults = {
      ...((config.agents as Record<string, unknown>).defaults as Record<string, unknown>),
      model: resolved.model,
    };
    // Selection/order metadata only — profile ids plus the oauth route.
    // No credentials, keys, or tokens exist on this surface by construction.
    config.auth = {
      profiles: {
        [resolved.profileId]: {
          provider: resolved.provider,
          mode: "oauth",
          ...(resolved.email === undefined ? {} : { email: resolved.email }),
          ...(resolved.displayName === undefined ? {} : { displayName: resolved.displayName }),
        },
      },
      order: {
        [resolved.provider]: [resolved.profileId],
      },
    };
  }

  if (options.gatherMcp) {    const server: Record<string, unknown> = {
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
