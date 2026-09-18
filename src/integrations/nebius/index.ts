import type { IntegrationProfile } from "../contracts.ts";
import type { RuntimeControlPort, SubmittedRun } from "../../runtime/control.ts";

/** ADR-015's stable profile export. ADR-016 is responsible for registry wiring. */
export const NEBIUS_INTEGRATION_PROFILE: IntegrationProfile = {
  id: "nebius",
  label: "Nebius/NVIDIA model",
  description: "Booking reasoning routed through an operator-verified NVIDIA model on Nebius Token Factory.",
  requiredCapabilities: ["runtime", "knowledge", "google", "model"],
  credentialRequirements: [
    { key: "nebius-token-factory", description: "Nebius Token Factory key and credits supplied by the operator", configuredBy: "GATHER_NEBIUS_API_KEY" },
  ],
  intakeAdapter: "model-call",
  proofLabel: "live-provider",
  implementationStatus: "implemented",
};

export const NEBIUS_ENDPOINT = "https://api.tokenfactory.nebius.com/v1/chat/completions";
export const GATHER_BOOKING_TOOLS = Object.freeze([
  "gather.read_inquiry",
  "gather.read_venue_policy",
  "gather.check_availability",
  "gather.prepare_proposal",
]);

export interface NebiusModelIdentity {
  /** Exact provider model id copied from the operator's verified catalog evidence. */
  modelId: string;
  publisher: "NVIDIA";
  provenanceUrl: string;
  endpoint: string;
}

export interface NebiusVerification {
  identity: NebiusModelIdentity;
  verified: boolean;
  blockedBy: string[];
}

export class NebiusProfileError extends Error {
  readonly code: "IDENTITY_UNVERIFIED" | "ENDPOINT_UNQUALIFIED" | "CREDENTIAL_MISSING" | "PROFILE_DISABLED" | "PROVIDER_FAILED" | "BUDGET_DENIED";
  constructor(code: NebiusProfileError["code"], message: string) {
    super(message);
    this.name = "NebiusProfileError";
    this.code = code;
  }
}

function officialUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "nvidia.com" || url.hostname.endsWith(".nvidia.com"));
  } catch {
    return false;
  }
}

function qualifyingEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "api.tokenfactory.nebius.com" && url.pathname === "/v1/chat/completions";
  } catch {
    return false;
  }
}

/** Verify operator-supplied evidence; no model names are inferred or substituted. */
export function verifyNebiusModel(identity: NebiusModelIdentity): NebiusVerification {
  const blockedBy: string[] = [];
  if (!identity.modelId.trim()) blockedBy.push("exact NVIDIA model id is missing");
  if (identity.publisher !== "NVIDIA") blockedBy.push("model publisher is not NVIDIA");
  if (!officialUrl(identity.provenanceUrl)) blockedBy.push("NVIDIA provenance must be an official nvidia.com URL");
  if (!qualifyingEndpoint(identity.endpoint)) blockedBy.push(`endpoint is not the qualifying Nebius Token Factory chat endpoint (${NEBIUS_ENDPOINT})`);
  return { identity, verified: blockedBy.length === 0, blockedBy };
}

export interface NebiusProviderResponse {
  reasoning: string;
  content: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  receipt: { provider: "nebius"; requestId: string; modelId: string; endpoint: string; simulated: boolean };
}

export interface NebiusProviderTransport {
  call(input: { endpoint: string; modelId: string; apiKey: string; prompt: string; tools: readonly string[]; deadlineMs: number }): Promise<NebiusProviderResponse>;
}

export interface NebiusCallInput {
  businessId: string;
  bookingId: string;
  idempotencyKey: string;
  prompt: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  deadlineMs: number;
}

export interface NebiusCallResult extends NebiusProviderResponse {
  run: SubmittedRun;
}

export interface NebiusBookingModelOptions {
  identity: NebiusModelIdentity;
  apiKey?: string;
  enabled: boolean;
  control: RuntimeControlPort;
  transport: NebiusProviderTransport;
}

/**
 * One provider call behind RuntimeControl's trusted reservation boundary.
 * The provider transport is injected so scripted checks never contact Nebius.
 */
export async function callNebiusBookingModel(options: NebiusBookingModelOptions, input: NebiusCallInput): Promise<NebiusCallResult> {
  if (!options.enabled) throw new NebiusProfileError("PROFILE_DISABLED", "Nebius profile is disabled; no provider or runtime call was attempted");
  const verification = verifyNebiusModel(options.identity);
  if (!verification.verified) throw new NebiusProfileError("IDENTITY_UNVERIFIED", verification.blockedBy.join("; "));
  const apiKey = options.apiKey?.trim();
  if (!apiKey) throw new NebiusProfileError("CREDENTIAL_MISSING", "operator-supplied Nebius API key/credits are missing");
  let run: SubmittedRun;
  try {
    run = await options.control.submit({
      businessId: input.businessId,
      bookingId: input.bookingId,
      message: input.prompt,
      idempotencyKey: input.idempotencyKey,
      maxInputTokens: input.maxInputTokens,
      maxOutputTokens: input.maxOutputTokens,
      label: "nebius-nvidia-booking",
    });
  } catch (error) {
    throw new NebiusProfileError("BUDGET_DENIED", error instanceof Error ? error.message : String(error));
  }
  try {
    const result = await options.transport.call({ endpoint: options.identity.endpoint, modelId: options.identity.modelId, apiKey, prompt: input.prompt, tools: GATHER_BOOKING_TOOLS, deadlineMs: input.deadlineMs });
    return { ...result, run, receipt: { ...result.receipt, modelId: options.identity.modelId, endpoint: options.identity.endpoint } };
  } catch (error) {
    throw new NebiusProfileError("PROVIDER_FAILED", error instanceof Error ? error.message : String(error));
  }
}
