import {
  describeNativeCapabilities,
  type NativeCapabilityReport,
} from "../runtime/knowledge.ts";
import { loadRuntimeManifest } from "../runtime/manifest.ts";
import type {
  AddScopedExceptionInput,
  ConfirmCandidateInput,
  CorrectFactInput,
  KnowledgePort,
  KnowledgePortHealth,
  KnowledgeQueryRequirements,
  KnowledgeQueryScope,
  ProposeCandidatesInput,
} from "./port.ts";
import { KnowledgePortError } from "./port.ts";
import type { SourceEventKind, SourceRecordEnvelope } from "../server/sources/types.ts";

/**
 * ADR-008 native recall/wiki adapter (C04 live authority candidate).
 *
 * Selection rule: the adapter binds ONLY to documented OpenClaw
 * recall/wiki extension points (agent tools `memory_search`/`memory_get`,
 * `wiki_search`/`wiki_get`/`wiki_apply`, gateway `wiki.overview`/
 * `wiki.get`, CLI ingest/compile flows) verified against the exact ADR-009
 * pinned manifest plus a live method-table probe. No ingest/delete RPC is
 * invented, and private runtime databases are never inspected (the
 * embedding contract forbids it).
 *
 * Current status: BLOCKED. The pinned manifest's gateway method table
 * carries none of the required wiki/memory surfaces and no live probe has
 * run, so every operation throws `blocked_native_unavailable` naming the
 * exact missing evidence. Live stays disabled; there is no second vendor
 * and no silent fallback to prepared data.
 */

export type { NativeCapabilityReport };

/** Proof bundle required before the native port authorizes anything. */
export interface NativeProofInput {
  manifestPath?: string;
  /** Observed gateway method list from a real runtime, or null when no probe ran. */
  liveMethods?: readonly string[] | null;
}

/**
 * Runs the capability probe: pinned manifest + optional live method table.
 * Pure function of its inputs so tests never depend on a host runtime.
 */
export function verifyNativeCapability(input: NativeProofInput = {}): NativeCapabilityReport {
  const { manifest, path } = loadRuntimeManifest(input.manifestPath);
  return describeNativeCapabilities(manifest, path, input.liveMethods ?? null);
}

/** Exact blocked evidence for the cutover record (008-A04). */
export function nativeBlockedDetail(report: NativeCapabilityReport): string {
  const lines = [
    `native knowledge unavailable: 0/${report.mapping.length} required surfaces live-verified`,
    `manifest: ${report.manifestPath} (pinned methods: [${report.pinnedMethods.join(", ")}])`,
    report.liveMethods === null
      ? "live method-table probe: none ran (no GATHER_TEST_OPENCLAW_BIN harness, no observed wiki.*/memory_* methods)"
      : `live method table: [${report.liveMethods.join(", ")}]`,
    ...report.missing.map((entry) => `missing: ${entry}`),
  ];
  return lines.join("; ");
}

function blocked(report: NativeCapabilityReport, operation: string): KnowledgePortError {
  return new KnowledgePortError(
    "blocked_native_unavailable",
    `${operation} blocked: ${nativeBlockedDetail(report)} — live knowledge stays disabled; no fallback vendor, no destructive migration`,
  );
}

export class NativeKnowledgePort implements KnowledgePort {
  readonly kind = "native-live" as const;
  private readonly report: NativeCapabilityReport;

  constructor(report: NativeCapabilityReport) {
    this.report = report;
  }

  /** Convenience: probe from the pinned manifest, then bind (still blocked until verified). */
  static fromManifest(input: NativeProofInput = {}): NativeKnowledgePort {
    return new NativeKnowledgePort(verifyNativeCapability(input));
  }

  /** The capability evidence this instance was bound with. */
  capabilityReport(): NativeCapabilityReport {
    return this.report;
  }

  /** True only when every required surface is live-verified. Today: false. */
  get verified(): boolean {
    return this.report.available;
  }

  ingestSource(_record: SourceRecordEnvelope): void {
    void _record;
    throw blocked(this.report, "ingestSource");
  }

  invalidateSource(_sourceKey: string, _reason: SourceEventKind): void {
    void _sourceKey;
    void _reason;
    throw blocked(this.report, "invalidateSource");
  }

  proposeCandidates(_input: ProposeCandidatesInput): never {
    void _input;
    throw blocked(this.report, "proposeCandidates");
  }

  confirmCandidate(_input: ConfirmCandidateInput): never {
    void _input;
    throw blocked(this.report, "confirmCandidate");
  }

  correctFact(_input: CorrectFactInput): never {
    void _input;
    throw blocked(this.report, "correctFact");
  }

  addScopedException(_input: AddScopedExceptionInput): never {
    void _input;
    throw blocked(this.report, "addScopedException");
  }

  query(_scope: KnowledgeQueryScope, _requirements?: KnowledgeQueryRequirements): never {
    void _scope;
    void _requirements;
    throw blocked(this.report, "query");
  }

  snapshotForOffer(_scope: KnowledgeQueryScope): never {
    void _scope;
    throw blocked(this.report, "snapshotForOffer");
  }

  /**
   * Unavailable native recall is unavailable, never an empty result.
   * Callers must treat available:false as "block dependent work", not as
   * "no facts exist". The blocked verdict itself is local probe evidence
   * (provenance `prepared`): no live runtime was contacted to produce it.
   */
  health(): KnowledgePortHealth {
    return {
      kind: "native-live",
      available: this.report.available,
      detail: this.report.available
        ? "native knowledge capability live-verified against the pinned manifest"
        : `${nativeBlockedDetail(this.report)} (probe ran locally; no live runtime contacted)`,
      provenance: this.report.available ? "live-provider" : "prepared",
      capability: nativeBlockedDetail(this.report),
    };
  }
}
