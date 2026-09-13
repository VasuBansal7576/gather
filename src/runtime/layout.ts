import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Filesystem layout for the Gather-owned OpenClaw instance.
 *
 * Every path lives under a single Gather-controlled root so the isolated
 * runtime can never fall back to a personal ~/.openclaw install. The mapping
 * to official OpenClaw environment variables is done in process.ts:
 *   homeDir      -> OPENCLAW_HOME   (replaces $HOME for OpenClaw path defaults)
 *   stateDir     -> OPENCLAW_STATE_DIR
 *   configPath   -> OPENCLAW_CONFIG_PATH
 *   workspaceDir -> OPENCLAW_WORKSPACE_DIR
 *   port         -> OPENCLAW_GATEWAY_PORT / gateway.port
 * See https://docs.openclaw.ai/help/environment and
 * https://docs.openclaw.ai/gateway/multiple-gateways (per-instance isolation
 * checklist: unique config path, state dir, workspace and port).
 */
export interface GatherOpenClawLayout {
  /** Gather-owned root that contains every runtime artifact. */
  rootDir: string;
  /** Substitute HOME for OpenClaw path defaults (OPENCLAW_HOME). */
  homeDir: string;
  /** Mutable state: sessions, credentials, caches (OPENCLAW_STATE_DIR). */
  stateDir: string;
  /** The instance's own openclaw.json (OPENCLAW_CONFIG_PATH). */
  configPath: string;
  /** Default agent workspace (OPENCLAW_WORKSPACE_DIR). */
  workspaceDir: string;
  /** Gather-owned secrets, e.g. the generated gateway token (mode 0600). */
  secretsDir: string;
  /** Gather-owned TMPDIR so gateway scratch never lands in the OS temp dir. */
  tmpDir: string;
  /** Gather-owned gateway file logs (config `logging.file`). */
  logsDir: string;
  /** Loopback port dedicated to this instance. */
  port: number;
}

export function resolveGatherOpenClawLayout(input: {
  rootDir: string;
  port: number;
}): GatherOpenClawLayout {
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
    throw new Error(`invalid gateway port: ${input.port}`);
  }
  const rootDir = resolve(input.rootDir);
  return {
    rootDir,
    homeDir: join(rootDir, "home"),
    stateDir: join(rootDir, "state"),
    configPath: join(rootDir, "openclaw.json"),
    workspaceDir: join(rootDir, "workspace"),
    secretsDir: join(rootDir, "secrets"),
    tmpDir: join(rootDir, "tmp"),
    logsDir: join(rootDir, "logs"),
    port: input.port,
  };
}

export function ensureLayoutDirectories(layout: GatherOpenClawLayout): void {
  for (const dir of [
    layout.rootDir,
    layout.homeDir,
    layout.stateDir,
    layout.workspaceDir,
    layout.secretsDir,
    layout.tmpDir,
    layout.logsDir,
  ]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}
