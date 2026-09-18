import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import {
  GatherMcpBoundary,
  defineGatherTool,
  type GatherToolResult,
} from "../../runtime/mcp.ts";
import type { IntegrationProfile } from "../contracts.ts";

/** ADR-014's profile. ADR-016 owns adding it to the shared registry. */
export const AMAZON_OWNER_MCP_PROFILE: IntegrationProfile = {
  id: "amazon",
  label: "Amazon owner interface",
  description: "Authenticated owner-facing Gather controls over Streamable HTTP MCP.",
  requiredCapabilities: ["runtime", "knowledge", "google", "model", "owner-mcp"],
  credentialRequirements: [
    {
      key: "mcp-deployment",
      description: "Loopback/self-hosted MCP surface or separately authorized secure deployment",
      configuredBy: "event configuration",
    },
  ],
  intakeAdapter: "owner-mcp",
  proofLabel: "live-provider",
  implementationStatus: "implemented",
};

export interface OwnerSession {
  ownerId: string;
  businessId: string;
}

export interface AttentionItem {
  id: string;
  kind: "inquiry" | "approval" | "recovery";
  summary: string;
  offerId?: string;
  offerVersion?: number;
}

export interface OfferReference {
  offerId?: string;
  name?: string;
}

export interface ExactOffer {
  offerId: string;
  version: number;
  fingerprint: string;
  actionSummary: string;
  /** Customer text is deliberately not part of the approval surface. */
  customerId: string;
}

export interface AmbiguousOffer {
  candidates: Array<Pick<ExactOffer, "offerId" | "version" | "actionSummary">>;
}

export interface AmazonOwnerBackend {
  whatNeedsAttention(session: OwnerSession): Promise<AttentionItem[]>;
  resolveOffer(session: OwnerSession, reference: OfferReference): Promise<ExactOffer | AmbiguousOffer>;
  approveExact(session: OwnerSession, offer: ExactOffer): Promise<Record<string, unknown>>;
}

export interface ApprovalContextStore {
  read(key: string): Promise<PendingApproval | undefined>;
  write(key: string, value: PendingApproval): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface PendingApproval {
  ownerId: string;
  businessId: string;
  offer: ExactOffer;
  /** Name/voice resolution always requires a second explicit confirmation. */
  requiresSecondConfirmation: boolean;
  createdAt: string;
}

export class MemoryApprovalContextStore implements ApprovalContextStore {
  private readonly values = new Map<string, PendingApproval>();
  read(key: string): Promise<PendingApproval | undefined> { return Promise.resolve(this.values.get(key)); }
  write(key: string, value: PendingApproval): Promise<void> { this.values.set(key, value); return Promise.resolve(); }
  delete(key: string): Promise<void> { this.values.delete(key); return Promise.resolve(); }
}

function result(text: string, structuredContent: Record<string, unknown> = {}): GatherToolResult {
  return { content: [{ type: "text", text }], structuredContent };
}

function contextKey(owner: OwnerSession, token: string): string {
  return `${owner.ownerId}:${owner.businessId}:${token}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

const attentionTool = defineGatherTool({
  name: "what_needs_attention",
  description: "List owner-scoped pending work without exposing customer inquiry text.",
  inputSchema: {},
  execution: "live",
  handler: async (_args: unknown, context) => {
    const deps = currentDependencies;
    if (!deps) throw new Error("Amazon MCP adapter is not configured");
    const items = await deps.backend.whatNeedsAttention(deps.session);
    return result("Owner attention items retrieved.", {
      items,
      "gather:tool": context.toolName,
      "gather:customer-content": "excluded",
    });
  },
});

const prepareTool = defineGatherTool({
  name: "prepare_exact_offer_approval",
  description: "Resolve an exact offer version and create durable owner confirmation context.",
  inputSchema: {
    offerId: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
  },
  execution: "live",
  handler: async (args: unknown) => {
    const deps = currentDependencies;
    if (!deps) throw new Error("Amazon MCP adapter is not configured");
    const input = args as OfferReference;
    if (!input.offerId && !input.name) return result("An exact offerId is required; a name alone is ambiguous.", { code: "AMBIGUOUS_REFERENCE" });
    const resolved = await deps.backend.resolveOffer(deps.session, input);
    if ("candidates" in resolved) {
      return result("Reference is ambiguous. Select one exact offer, then confirm it separately.", {
        code: "AMBIGUOUS_REFERENCE",
        candidates: resolved.candidates,
        requiresSecondConfirmation: true,
      });
    }
    const token = randomBytes(24).toString("base64url");
    await deps.contexts.write(contextKey(deps.session, token), {
      ownerId: deps.session.ownerId,
      businessId: deps.session.businessId,
      offer: resolved,
      requiresSecondConfirmation: Boolean(input.name && !input.offerId),
      createdAt: new Date().toISOString(),
    });
    return result("Exact offer is ready for explicit confirmation.", {
      confirmationToken: token,
      offerId: resolved.offerId,
      version: resolved.version,
      fingerprint: resolved.fingerprint,
      actionSummary: resolved.actionSummary,
      requiresSecondConfirmation: Boolean(input.name && !input.offerId),
      "gather:customer-content": "excluded",
    });
  },
});

const confirmTool = defineGatherTool({
  name: "confirm_exact_offer",
  description: "Approve only the exact offer version and action summary shown in the confirmation context.",
  inputSchema: {
    confirmationToken: z.string().min(16),
    offerId: z.string().min(1),
    version: z.number().int().nonnegative(),
    fingerprint: z.string().length(64),
    actionSummary: z.string().min(1),
    confirmation: z.literal("CONFIRM"),
  },
  execution: "live",
  handler: async (args: unknown) => {
    const deps = currentDependencies;
    if (!deps) throw new Error("Amazon MCP adapter is not configured");
    const input = args as { confirmationToken: string; offerId: string; version: number; fingerprint: string; actionSummary: string; confirmation: "CONFIRM" };
    const key = contextKey(deps.session, input.confirmationToken);
    const pending = await deps.contexts.read(key);
    if (!pending) return result("Confirmation context is missing or expired; prepare the exact offer again.", { code: "CONTEXT_MISSING" });
    if (pending.ownerId !== deps.session.ownerId || pending.businessId !== deps.session.businessId) {
      return result("Confirmation context belongs to another owner or business.", { code: "SESSION_OWNERSHIP_DENIED" });
    }
    const expected = pending.offer;
    if (digest({ offerId: input.offerId, version: input.version, fingerprint: input.fingerprint, actionSummary: input.actionSummary }) !== digest({ offerId: expected.offerId, version: expected.version, fingerprint: expected.fingerprint, actionSummary: expected.actionSummary })) {
      return result("Exact offer, version, fingerprint, and action summary do not match the prepared context.", { code: "STALE_OR_MISMATCHED_OFFER" });
    }
    const approval = await deps.backend.approveExact(deps.session, expected);
    await deps.contexts.delete(key);
    return result("Exact offer approval submitted to Gather authority.", { approval, offerId: expected.offerId, version: expected.version });
  },
});

interface ActiveDependencies { backend: AmazonOwnerBackend; contexts: ApprovalContextStore; session: OwnerSession }
let currentDependencies: ActiveDependencies | undefined;

/**
 * Construct the owner MCP surface. The dependency slot is scoped to this
 * adapter's single owner session; concurrent adapters must be constructed and
 * used serially by their host process. The HTTP boundary still enforces token,
 * Host, Origin, and MCP session validity before any tool runs.
 */
export function createAmazonOwnerMcp(options: {
  authToken: string;
  session: OwnerSession;
  backend: AmazonOwnerBackend;
  contexts?: ApprovalContextStore;
  allowedHosts?: string[];
  allowedOrigins?: string[];
}): { boundary: GatherMcpBoundary; profile: IntegrationProfile } {
  if (!options.session.ownerId || !options.session.businessId) throw new Error("owner and business session identity are required");
  const contexts = options.contexts ?? new MemoryApprovalContextStore();
  currentDependencies = { backend: options.backend, contexts, session: options.session };
  return {
    profile: AMAZON_OWNER_MCP_PROFILE,
    boundary: new GatherMcpBoundary({
      serverName: "gather-amazon-owner",
      tools: [attentionTool, prepareTool, confirmTool],
      authToken: options.authToken,
      allowedHosts: options.allowedHosts,
      allowedOrigins: options.allowedOrigins,
    }),
  };
}
