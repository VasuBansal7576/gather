/**
 * ADR-006 integration contracts (C12): the IntegrationProfile port.
 *
 * One engine, explicit profiles. A profile declares the provider
 * capabilities a run needs, the credentials that must be supplied outside
 * Git, the intake adapter it uses, and the proof label its receipts carry.
 * Disabled adapters perform no network activity and receive no data; Gather
 * never silently falls back from a required sponsor provider to another.
 *
 * This file is types plus a pure gate evaluator. Server evidence collection
 * lives in `src/server/live-model/live-status.ts` (composition of existing
 * ports); the registry lives in `./registry.ts` for ADR-016 to consume.
 */

export type IntegrationProfileId = "base" | "assemblyai" | "amazon" | "nebius";

/** Capability a profile may require before live behaviour is allowed. */
export type ProfileCapability =
  | "runtime"
  | "knowledge"
  | "google"
  | "model"
  | "voice"
  | "owner-mcp";

export interface CredentialRequirement {
  /** Stable key, e.g. "google-oauth". Never a secret value. */
  key: string;
  /** Owner-readable description of what must be supplied outside Git. */
  description: string;
  /** Environment/config knob that carries it, e.g. "GATHER_TEST_RECIPIENT". */
  configuredBy: string;
}

export interface IntegrationProfile {
  id: IntegrationProfileId;
  label: string;
  description: string;
  /** Capabilities that must gate-pass before this profile runs live. */
  requiredCapabilities: ProfileCapability[];
  /** Credentials the operator supplies outside Git. Names only, never values. */
  credentialRequirements: CredentialRequirement[];
  /** Intake adapter id this profile uses (C02 envelope stays shared). */
  intakeAdapter: "gmail" | "voice" | "owner-mcp" | "model-call";
  /** Label carried on this profile's receipts. */
  proofLabel: "live-provider" | "prepared" | "scripted-runtime" | "real-runtime";
  /** Event profiles stay inert until their owning ADR wires them. */
  implementationStatus: "implemented" | "specified";
}

export type CapabilityGateStatus = "pass" | "blocked";

export interface CapabilityGateResult {
  capability: ProfileCapability;
  status: CapabilityGateStatus;
  /**
   * Named missing evidence when blocked — the exact account, credential,
   * registration, or proof that is absent. Never a fabricated pass.
   */
  missingEvidence?: string;
}

/** Observed evidence the evaluator reads. All fields are presence-level. */
export interface LiveGateEvidence {
  /** Pinned runtime provisioned under .runtime/ (never ~/.openclaw). */
  runtimeProvisioned: boolean;
  /** Native knowledge port verified (ADR-008 gate), not the simulator. */
  knowledgeNative: boolean;
  /** Google provider app configured in this installation. */
  googleConfigured: boolean;
  /** At least one connected + authorized Google account for the business. */
  googleAccountConnected: boolean;
  /** Supported model access authorized (subscription login or API key). */
  modelAuthorized: boolean;
  /** Operator-restricted live test recipient configured. */
  testRecipientConfigured: boolean;
  /** Acceptance signing key configured for live tokens. */
  acceptanceKeyConfigured: boolean;
}

export interface LiveGateReport {
  profile: IntegrationProfileId;
  /** True only when every required capability passes. */
  liveReady: boolean;
  gates: CapabilityGateResult[];
  /**
   * Exact missing evidence names blocking live verification. Empty only
   * when liveReady. Absent accounts/credentials stay BLOCKED here — never
   * passed, never papered over with fixture injection.
   */
  blockedBy: string[];
  notice: string;
}

const CAPABILITY_EVIDENCE: Record<ProfileCapability, (evidence: LiveGateEvidence) => string | undefined> = {
  runtime: (evidence) =>
    evidence.runtimeProvisioned ? undefined : "pinned OpenClaw runtime is not provisioned under .runtime/ (GATHER_TEST_OPENCLAW_BIN unset; personal ~/.openclaw is never used)",
  knowledge: (evidence) =>
    evidence.knowledgeNative ? undefined : "native knowledge port is not verified (prepared simulator does not authorize live facts)",
  google: (evidence) => {
    if (!evidence.googleConfigured) return "Google provider app is not configured in this installation";
    if (!evidence.googleAccountConnected) return "no connected authorized Google account for this business (consent not completed)";
    return undefined;
  },
  model: (evidence) =>
    evidence.modelAuthorized ? undefined : "no supported model access authorized (subscription login or API key required)",
  voice: () =>
    "AssemblyAI voice adapter is specified-only (ADR-013); no authorized recording path is wired",
  "owner-mcp": () =>
    "Amazon owner MCP adapter is specified-only (ADR-014); no authorized deployment is supplied",
};

/**
 * Pure gate evaluator: every required capability of the profile must pass.
 * Missing evidence is named per capability; nothing is inferred, and a
 * blocked gate never blocks scripted/prepared development — it only blocks
 * the live proof claim.
 */
export function evaluateLiveGate(profile: IntegrationProfile, evidence: LiveGateEvidence): LiveGateReport {
  const gates: CapabilityGateResult[] = profile.requiredCapabilities.map((capability) => {
    const missing = CAPABILITY_EVIDENCE[capability](evidence);
    return missing === undefined
      ? { capability, status: "pass" as const }
      : { capability, status: "blocked" as const, missingEvidence: missing };
  });
  // Extra live-safety requirements that apply to every profile attempting
  // real effects: a restricted test recipient and acceptance signing.
  // These gate the *live proof*, not profile selection itself.
  const liveSafety: CapabilityGateResult[] = [];
  if (!evidence.testRecipientConfigured) {
    liveSafety.push({
      capability: "model",
      status: "blocked",
      missingEvidence: "GATHER_TEST_RECIPIENT is not set: live sends are restricted to an explicitly authorized test recipient",
    });
  }
  if (!evidence.acceptanceKeyConfigured) {
    liveSafety.push({
      capability: "model",
      status: "blocked",
      missingEvidence: "GATHER_ACCEPTANCE_KEY is not set: live acceptance tokens cannot be signed",
    });
  }
  const all = [...gates, ...liveSafety];
  const blockedBy = all.filter((gate) => gate.status === "blocked").map((gate) => gate.missingEvidence ?? gate.capability);
  return {
    profile: profile.id,
    liveReady: blockedBy.length === 0,
    gates: all,
    blockedBy,
    notice:
      blockedBy.length === 0
        ? `Profile "${profile.id}" gates pass: live verification may proceed on explicitly authorized test accounts only.`
        : `Live verification for profile "${profile.id}" is BLOCKED: ${blockedBy.join("; ")}. Prepared mode remains usable; no fixture evidence counts as live proof.`,
  };
}
