import { KnowledgeService } from "./service.ts";
import type { ConfirmedFact } from "./types.ts";
import type { KnowledgePort } from "./port.ts";
import { KnowledgePortError } from "./port.ts";
import type { PreparedKnowledgePort } from "./prepared.ts";
import type { NativeKnowledgePort } from "./native.ts";

/**
 * ADR-008 step 4: migration export/compare with atomic activation only
 * after the gate passes.
 *
 * Flow: export existing confirmed facts through the public prepared
 * service -> import with provenance into the native side -> compare the
 * gate cases -> switch the active port only after verification. The old
 * prepared store is preserved read-only for rollback. There is no
 * dual-writer policy store: exactly one port authorizes at a time, and a
 * failed gate leaves live knowledge visibly unavailable (never a silent
 * fallback that re-authorizes stale facts).
 */

/** C04 native gate cases (contracts C04: changed price, customer-only
 * exception, deleted source, conflicting claims, unconfirmed injected
 * instruction, restart recall, cross-mode/business denial). */
export const NATIVE_GATE_CASES = Object.freeze([
  "changed-price",
  "customer-exception",
  "deleted-source",
  "conflicting-claims",
  "injected-instruction",
  "restart-recall",
  "cross-mode-denial",
] as const);

export type NativeGateCase = (typeof NATIVE_GATE_CASES)[number];

export interface GateCaseEvidence {
  passed: boolean;
  detail: string;
  /** Evidence label: prepared | scripted-runtime | real-runtime | live-provider. */
  provenance: "prepared" | "scripted-runtime" | "real-runtime" | "live-provider";
}

export type GateEvidence = Record<NativeGateCase, GateCaseEvidence>;

export function evaluateGate(evidence: Partial<GateEvidence>): { passed: boolean; failures: string[] } {
  const failures: string[] = [];
  for (const gateCase of NATIVE_GATE_CASES) {
    const entry = evidence[gateCase];
    if (!entry) failures.push(`${gateCase}: no evidence recorded`);
    else if (!entry.passed) failures.push(`${gateCase}: FAILED — ${entry.detail}`);
  }
  return { passed: failures.length === 0, failures };
}

export interface MigrationExport {
  exportedAt: string;
  businessId: string;
  /** Confirmed facts read through the public service (listFacts). */
  facts: ConfirmedFact[];
  provenance: "prepared";
}

/** Export existing confirmed facts through their public service. */
export function exportConfirmedFacts(service: KnowledgeService, businessId: string): MigrationExport {
  return {
    exportedAt: new Date().toISOString(),
    businessId,
    facts: service.listFacts(businessId),
    provenance: "prepared",
  };
}

function canonicalFact(fact: ConfirmedFact): string {
  return JSON.stringify({
    key: fact.key,
    subjectId: fact.subjectId,
    scope: fact.scope,
    scopeId: fact.scopeId ?? null,
    accountId: fact.accountId,
    value: fact.value,
    revision: fact.revision,
  });
}

export interface MigrationComparison {
  matched: number;
  mismatched: Array<{ key: string; subjectId: string; reason: string }>;
  missingInTarget: string[];
  clean: boolean;
}

/** Compare migration output: every exported fact must survive with identical provenance. */
export function compareMigration(exported: MigrationExport, targetFacts: ConfirmedFact[]): MigrationComparison {
  const targetById = new Map(targetFacts.map((fact) => [fact.id, fact]));
  const mismatched: MigrationComparison["mismatched"] = [];
  const missingInTarget: string[] = [];
  for (const fact of exported.facts) {
    const other = targetById.get(fact.id);
    if (!other) {
      missingInTarget.push(`${fact.key}/${fact.subjectId || "(global)"} (${fact.id})`);
      continue;
    }
    if (canonicalFact(other) !== canonicalFact(fact)) {
      mismatched.push({ key: fact.key, subjectId: fact.subjectId, reason: `fact ${fact.id} differs after migration (value/scope/revision/provenance changed)` });
    }
  }
  return { matched: exported.facts.length - missingInTarget.length - mismatched.length, mismatched, missingInTarget, clean: missingInTarget.length === 0 && mismatched.length === 0 };
}

export interface ActiveKnowledgeAuthority {
  /** The single authorizing port. Exactly one — never two writers. */
  active: KnowledgePort;
  /** Preserved read-only rollback handle (the prepared port). */
  rollback: PreparedKnowledgePort;
  activatedAt: string;
  gateEvidence: GateEvidence;
  comparison: MigrationComparison;
}

export interface ActivateLivePortInput {
  prepared: PreparedKnowledgePort;
  native: NativeKnowledgePort;
  /** Complete gate evidence: every C04 case must pass. */
  gateEvidence: Partial<GateEvidence>;
  /** Migration comparison of the exported facts against the native import. */
  comparison: MigrationComparison;
}

/**
 * Atomically switch the active port to native-live. Fails closed unless
 * ALL of: native capability verified, every gate case passed, migration
 * comparison clean. On failure live stays disabled and prepared remains
 * the sole authority — the error names exactly what is missing.
 */
export function activateLivePort(input: ActivateLivePortInput): ActiveKnowledgeAuthority {
  const capability = input.native.capabilityReport();
  if (!capability.available) {
    throw new KnowledgePortError(
      "blocked_native_unavailable",
      `cutover refused: native capability not verified (${capability.missing.length} missing surfaces; first: ${capability.missing[0] ?? "none recorded"}); live stays disabled on the prepared port`,
    );
  }
  const gate = evaluateGate(input.gateEvidence);
  if (!gate.passed) {
    throw new KnowledgePortError(
      "stale",
      `cutover refused: native gate failed — ${gate.failures.join("; ")}; live stays disabled on the prepared port`,
    );
  }
  if (!input.comparison.clean) {
    const detail = [...input.comparison.missingInTarget, ...input.comparison.mismatched.map((entry) => entry.reason)].join("; ");
    throw new KnowledgePortError(
      "stale",
      `cutover refused: migration comparison is not clean — ${detail}; live stays disabled on the prepared port`,
    );
  }
  return {
    active: input.native,
    rollback: input.prepared,
    activatedAt: new Date().toISOString(),
    gateEvidence: input.gateEvidence as GateEvidence,
    comparison: input.comparison,
  };
}

/** Roll back to the preserved prepared authority (no business policy/approval rollback). */
export function rollbackToPrepared(activation: ActiveKnowledgeAuthority): { active: PreparedKnowledgePort; rolledBackAt: string } {
  return { active: activation.rollback, rolledBackAt: new Date().toISOString() };
}
