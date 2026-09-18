import type { RuntimeManifest } from "./manifest.ts";

/**
 * ADR-008 step 1: native knowledge capability mapping on the exact ADR-009
 * pinned manifest.
 *
 * This is the ONLY place that translates supported upstream capability
 * schemas into Gather knowledge terms. It invents no RPCs: every required
 * surface below is named by public OpenClaw documentation, and every
 * availability verdict is computed from the pinned manifest's
 * `gatewayProtocol.methods` table plus an optional live method-table probe.
 *
 * Documented upstream surfaces (fetched 2026-09-18):
 * - Embedding control plane (`https://docs.openclaw.ai/gateway/embedding`):
 *   `agent`, `agent.wait`, `chat.history`, `sessions.list`,
 *   `sessions.patch`, `sessions.delete`, `usage.cost`, `sessions.usage`,
 *   `models.authStatus`, `config.get`, `config.patch`. The same document
 *   forbids reading/mutating files, SQLite tables, transcripts, or caches
 *   under the runtime state dir — Gather never inspects private runtime
 *   databases.
 * - `memory-wiki` plugin (`https://docs.openclaw.ai/plugins/memory-wiki`):
 *   agent tools `wiki_status`, `wiki_search`, `wiki_get`, `wiki_apply`,
 *   `wiki_lint`; Control-UI gateway methods `wiki.overview`, `wiki.get`,
 *   `wiki.importInsights`; CLI `openclaw wiki ingest/compile/search/get/
 *   apply/lint`; recall/promotion/dreaming owned by the active memory
 *   plugin (`memory_search` / `memory_get` corpus supplement).
 */

export const NATIVE_KNOWLEDGE_DOCS = Object.freeze({
  embedding: "https://docs.openclaw.ai/gateway/embedding",
  memoryWiki: "https://docs.openclaw.ai/plugins/memory-wiki",
});

export interface RequiredNativeSurface {
  /** Documented surface name (tool, gateway method, or CLI flow). */
  surface: string;
  /** Gather C04 need it serves. */
  need:
    | "recall"
    | "import"
    | "compile"
    | "search"
    | "get"
    | "apply"
    | "invalidate"
    | "isolate";
  /** Where it is documented. */
  documentedAt: string;
  /** Gateway RPC method that would carry it, when it is an RPC surface. */
  gatewayMethod?: string;
}

/**
 * Required native surfaces for the C04 KnowledgePort, each traceable to
 * the public docs above — never an invented Gather RPC name.
 */
export const REQUIRED_NATIVE_SURFACES: readonly RequiredNativeSurface[] = Object.freeze([
  { surface: "memory_search", need: "recall", documentedAt: NATIVE_KNOWLEDGE_DOCS.memoryWiki },
  { surface: "memory_get", need: "recall", documentedAt: NATIVE_KNOWLEDGE_DOCS.memoryWiki },
  { surface: "wiki_search", need: "search", documentedAt: NATIVE_KNOWLEDGE_DOCS.memoryWiki },
  { surface: "wiki_get", need: "get", documentedAt: NATIVE_KNOWLEDGE_DOCS.memoryWiki },
  { surface: "wiki.overview", need: "search", documentedAt: NATIVE_KNOWLEDGE_DOCS.memoryWiki, gatewayMethod: "wiki.overview" },
  { surface: "wiki.get", need: "get", documentedAt: NATIVE_KNOWLEDGE_DOCS.memoryWiki, gatewayMethod: "wiki.get" },
  { surface: "wiki_apply", need: "apply", documentedAt: NATIVE_KNOWLEDGE_DOCS.memoryWiki },
  { surface: "wiki ingest + compile", need: "import", documentedAt: NATIVE_KNOWLEDGE_DOCS.memoryWiki },
  { surface: "wiki compile after source change", need: "compile", documentedAt: NATIVE_KNOWLEDGE_DOCS.memoryWiki },
  { surface: "source-deletion recompile/purge", need: "invalidate", documentedAt: NATIVE_KNOWLEDGE_DOCS.memoryWiki },
  { surface: "agent-scoped vaults (per-business isolation)", need: "isolate", documentedAt: NATIVE_KNOWLEDGE_DOCS.memoryWiki },
]);

export interface SurfaceMapping {
  surface: string;
  need: RequiredNativeSurface["need"];
  /** True when the pinned manifest's gateway method table carries it. */
  inPinnedMethods: boolean;
  /** True when a live method-table probe observed it (absent without a probe). */
  inLiveMethods: boolean;
  supported: boolean;
}

export interface NativeCapabilityReport {
  manifestPath: string;
  pinnedMethods: string[];
  liveMethods: string[] | null;
  mapping: SurfaceMapping[];
  /** True only when every required surface is live-verified. */
  available: boolean;
  /** Exact missing evidence for the blocked cutover record. */
  missing: string[];
}

/**
 * Maps required native surfaces against the pinned manifest's gateway
 * method table, optionally augmented by a live method-table probe.
 *
 * `liveMethods` is the observed gateway method list from a real runtime
 * (e.g. via `status`/method-table introspection on an explicitly provided
 * harness). It is never guessed: null means no probe ran, and pinned-only
 * support never counts as verified — availability requires live evidence.
 */
export function describeNativeCapabilities(
  manifest: RuntimeManifest,
  manifestPath: string,
  liveMethods: readonly string[] | null = null,
): NativeCapabilityReport {
  const pinnedMethods = [...(manifest.gatewayProtocol?.methods ?? [])];
  const pinned = new Set(pinnedMethods);
  const live = liveMethods === null ? null : new Set(liveMethods);
  const mapping: SurfaceMapping[] = REQUIRED_NATIVE_SURFACES.map((required) => {
    const inPinnedMethods = required.gatewayMethod !== undefined && pinned.has(required.gatewayMethod);
    const inLiveMethods = required.gatewayMethod !== undefined && (live?.has(required.gatewayMethod) ?? false);
    return {
      surface: required.surface,
      need: required.need,
      inPinnedMethods,
      inLiveMethods,
      supported: inLiveMethods,
    };
  });
  const missing = mapping.filter((entry) => !entry.supported).map((entry) =>
    entry.inPinnedMethods
      ? `${entry.surface} (${entry.need}): pinned but not live-verified — no probe evidence`
      : `${entry.surface} (${entry.need}): absent from pinned gateway methods [${pinnedMethods.join(", ")}]${live === null ? "; no live method-table probe ran" : "; not in live method table either"}`,
  );
  return {
    manifestPath,
    pinnedMethods,
    liveMethods: liveMethods === null ? null : [...liveMethods],
    mapping,
    available: missing.length === 0,
    missing,
  };
}

/**
 * Translates the pinned manifest's supported upstream schemas into the
 * Gather knowledge capability vocabulary. Only methods present in the
 * manifest are ever claimed; anything else is reported missing, never
 * synthesized. This is the single translation point C04 permits.
 */
export function translateUpstreamCapabilities(manifest: RuntimeManifest): {
  transport: string[];
  knowledge: string[];
  missing: string[];
} {
  const methods = new Set(manifest.gatewayProtocol?.methods ?? []);
  const transport = [...methods].filter((method) =>
    ["agent", "agent.wait", "chat.history", "sessions.list", "status", "config.get"].includes(method),
  );
  const knowledgeMethods = ["wiki.overview", "wiki.get", "wiki.importInsights"];
  const knowledge = [...methods].filter((method) => knowledgeMethods.includes(method));
  const missing = REQUIRED_NATIVE_SURFACES.filter(
    (required) => required.gatewayMethod !== undefined && !methods.has(required.gatewayMethod),
  ).map((required) => required.surface);
  return { transport, knowledge, missing };
}
