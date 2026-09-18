import type { AttemptVerification, CatalogActionId } from "./types.ts";

/**
 * ADR-004 C09 repair catalog.
 *
 * Eight bounded actions, each with explicit preconditions and required
 * verification. The catalog performs NO arbitrary shell, provider, or
 * authority operations: every effect goes through the injected
 * CatalogPorts (scripted in prepared mode, RuntimeControl-backed when the
 * owner explicitly opts into real-restart proof). Unknown action ids throw;
 * wrong-resource operations are denied at the precondition gate.
 */

export interface RuntimePort {
  /** This control owns the named process (never an unrelated instance). */
  ownedProcessId: string | undefined;
  unrelatedInstances: number;
  runsFenced: boolean;
  fenceRuns(): void;
  restart(): Promise<{ oldExitObserved: boolean; newReady: boolean; usefulRead: string }>;
  /** "scripted" fixture evidence vs "real" observed process evidence. */
  evidence: "scripted-runtime" | "real-runtime";
}

export interface SyncPort {
  checkpoint: { cursor: string; valid: boolean } | undefined;
  authorized: boolean;
  concurrentScanLease: boolean;
  resumeFromCursor(cursor: string): Promise<{ progressed: boolean; dedupeStable: boolean; coverage: string }>;
}

export interface ExecutionPort {
  operationIdentity: { operationKey: string; bookingId: string } | undefined;
  authorizedRead: boolean;
  reconcileByExternalId(operationKey: string): Promise<
    { matched: true; providerResult: string; bookingId: string } | { matched: false; reason: string }
  >;
}

export interface AccessPort {
  refreshCredentialExists: boolean;
  consentRevoked: boolean;
  refresh(): Promise<{ harmlessReadOk: boolean; logSample: string; tokenLeaked: boolean }>;
}

export interface ReconnectPort {
  repairableWithExistingAuthority: boolean;
  surfaceReconnect(): { visibleAction: string };
}

export interface ConfigPort {
  compatibleBackup: { path: string; validated: boolean } | undefined;
  runsFenced: boolean;
  rollback(path: string): Promise<{ schemaOk: boolean; runtimeOk: boolean; usefulRead: string; externallyReconciled: boolean; policyRolledBack: boolean }>;
}

export interface IntentPort {
  predecessorEffectKnown: boolean;
  authorityValid: boolean;
  leaseHeld: boolean;
  completedReceiptDigests: string[];
  rerunIncomplete(): Promise<{ advancedSteps: string[]; completedReceiptDigests: string[]; completedChanged: boolean }>;
}

export interface CatalogPorts {
  runtime?: RuntimePort;
  sync?: SyncPort;
  execution?: ExecutionPort;
  access?: AccessPort;
  reconnect?: ReconnectPort;
  config?: ConfigPort;
  intent?: IntentPort;
}

export interface CatalogInput {
  /** Resource under repair — must match the owned scope or be denied. */
  resource: string;
  operationKey?: string;
  cursor?: string;
  reason?: string;
  evidence?: string;
}

export interface Precondition {
  ok: boolean;
  reason: string;
}

export interface CatalogAction {
  id: CatalogActionId;
  check(input: CatalogInput, ports: CatalogPorts): Precondition;
  run(input: CatalogInput, ports: CatalogPorts): Promise<AttemptVerification>;
}

function need(port: unknown, name: string): Precondition | undefined {
  if (!port) return { ok: false, reason: `${name} port is not wired; cannot verify preconditions, refusing` };
  return undefined;
}

const restartRuntime: CatalogAction = {
  id: "restart_runtime",
  check(input, ports) {
    const missing = need(ports.runtime, "runtime");
    if (missing) return missing;
    const runtime = ports.runtime!;
    if (!runtime.ownedProcessId) return { ok: false, reason: "no owned process identified; refusing to restart an unknown process" };
    if (input.resource !== runtime.ownedProcessId) {
      return { ok: false, reason: `denied: ${input.resource} is not the owned process ${runtime.ownedProcessId}; unrelated instances are never touched` };
    }
    if (runtime.unrelatedInstances > 0) {
      return { ok: false, reason: `denied: ${runtime.unrelatedInstances} unrelated instance(s) present; fence them out first` };
    }
    if (!runtime.runsFenced) return { ok: false, reason: "affected runs are not fenced; fence before restart" };
    return { ok: true, reason: `owned process ${runtime.ownedProcessId} identified, no unrelated instances, runs fenced` };
  },
  async run(input, ports) {
    const runtime = ports.runtime!;
    runtime.fenceRuns();
    const result = await runtime.restart();
    const label = runtime.evidence === "real-runtime" ? "real-runtime" : "scripted-runtime";
    if (!result.oldExitObserved) {
      return { ok: false, detail: `(${label}) old process exit was not observed for ${input.resource}; stays blocked/unknown` };
    }
    if (!result.newReady || !result.usefulRead) {
      return { ok: false, detail: `(${label}) new process not protocol-ready or useful read empty; stays blocked` };
    }
    return {
      ok: true,
      technicalRestored: true,
      detail: `(${label}) old exit observed, new handshake ready, useful bounded read: ${result.usefulRead}; reconcile pending effects before resuming`,
    };
  },
};

const resumeSync: CatalogAction = {
  id: "resume_sync_from_cursor",
  check(input, ports) {
    const missing = need(ports.sync, "sync");
    if (missing) return missing;
    const sync = ports.sync!;
    const cursor = input.cursor ?? sync.checkpoint?.cursor;
    if (!cursor || sync.checkpoint?.valid !== true) return { ok: false, reason: "no valid durable checkpoint; refusing to scan from an unknown position" };
    if (!sync.authorized) return { ok: false, reason: "account not authorized for this scope; refusing" };
    if (sync.concurrentScanLease) return { ok: false, reason: "a concurrent scan lease is held; refusing a duplicate scan" };
    return { ok: true, reason: `valid checkpoint ${cursor}, authorized account, no concurrent lease` };
  },
  async run(input, ports) {
    const sync = ports.sync!;
    const cursor = input.cursor ?? sync.checkpoint!.cursor!;
    const result = await sync.resumeFromCursor(cursor);
    if (!result.progressed || !result.dedupeStable) {
      return { ok: false, detail: `no progress beyond checkpoint ${cursor} or unstable dedupe; stays blocked` };
    }
    return { ok: true, technicalRestored: true, detail: `progressed beyond ${cursor} with stable-key dedupe; coverage: ${result.coverage}` };
  },
};

const reconcileExecution: CatalogAction = {
  id: "reconcile_execution_by_external_id",
  check(input, ports) {
    const missing = need(ports.execution, "execution");
    if (missing) return missing;
    const execution = ports.execution!;
    const key = input.operationKey ?? execution.operationIdentity?.operationKey;
    if (!key || !execution.operationIdentity) return { ok: false, reason: "no persisted operation identity; refusing to reconcile an unknown effect" };
    if (input.operationKey && input.operationKey !== execution.operationIdentity.operationKey) {
      return { ok: false, reason: `denied: ${input.operationKey} is not the persisted operation ${execution.operationIdentity.operationKey}` };
    }
    if (!execution.authorizedRead) return { ok: false, reason: "no authorized provider read; refusing" };
    return { ok: true, reason: `persisted identity ${execution.operationIdentity.operationKey}, authorized read available` };
  },
  async run(input, ports) {
    const execution = ports.execution!;
    const key = input.operationKey ?? execution.operationIdentity!.operationKey;
    const result = await execution.reconcileByExternalId(key);
    if (!result.matched) {
      return { ok: false, detail: `no matching scoped provider result for ${key} (${result.reason}); unknown remains blocked` };
    }
    if (result.bookingId !== execution.operationIdentity!.bookingId) {
      return { ok: false, detail: `provider result for ${key} belongs to booking ${result.bookingId}, not ${execution.operationIdentity!.bookingId}; cross-booking link refused` };
    }
    return { ok: true, technicalRestored: true, bookingContinued: true, detail: `scoped provider result ${result.providerResult} linked to the original action` };
  },
};

const refreshAccess: CatalogAction = {
  id: "refresh_access",
  check(_input, ports) {
    const missing = need(ports.access, "access");
    if (missing) return missing;
    const access = ports.access!;
    if (!access.refreshCredentialExists) return { ok: false, reason: "no refresh credential exists; use request_reconnect instead" };
    if (access.consentRevoked) return { ok: false, reason: "consent is revoked; refresh is not authorized, use request_reconnect" };
    return { ok: true, reason: "refresh credential exists and consent is intact" };
  },
  async run(_input, ports) {
    const result = await ports.access!.refresh();
    if (!result.harmlessReadOk) return { ok: false, detail: "authorized harmless read failed after refresh; stays blocked" };
    if (result.tokenLeaked || /bearer|secret|token\s*[:=]\s*\S{8,}/i.test(result.logSample)) {
      return { ok: false, detail: "token material detected in logs; refusing to claim success" };
    }
    return { ok: true, technicalRestored: true, detail: "authorized harmless read works; no token in logs" };
  },
};

const requestReconnect: CatalogAction = {
  id: "request_reconnect",
  check(_input, ports) {
    const missing = need(ports.reconnect, "reconnect");
    if (missing) return missing;
    if (ports.reconnect!.repairableWithExistingAuthority) {
      return { ok: false, reason: "existing authority can repair this; use refresh_access instead" };
    }
    return { ok: true, reason: "revoked/expired access is not repairable with existing authority" };
  },
  async run(_input, ports) {
    const surfaced = ports.reconnect!.surfaceReconnect();
    // The action succeeds by surfacing the owner step; the incident itself
    // stays blocked until consent + read succeed (supervisor enforces this).
    return { ok: true, detail: `visible reconnect action surfaced: ${surfaced.visibleAction}; incident stays blocked until successful consent and read` };
  },
};

const rollbackConfig: CatalogAction = {
  id: "rollback_config_known_good",
  check(_input, ports) {
    const missing = need(ports.config, "config");
    if (missing) return missing;
    const config = ports.config!;
    if (!config.compatibleBackup?.validated) return { ok: false, reason: "no validated compatible backup; refusing rollback to an unknown state" };
    if (!config.runsFenced) return { ok: false, reason: "affected runs are not fenced; fence before rollback" };
    return { ok: true, reason: `validated compatible backup ${config.compatibleBackup.path}, runs fenced` };
  },
  async run(_input, ports) {
    const config = ports.config!;
    const result = await config.rollback(config.compatibleBackup!.path);
    if (result.policyRolledBack) return { ok: false, detail: "rollback touched business policy/approvals; refusing — only runtime/config state may roll back" };
    if (!result.schemaOk || !result.runtimeOk || !result.usefulRead) {
      return { ok: false, detail: "restored state failed schema/runtime/useful-read checks; stays blocked" };
    }
    if (!result.externallyReconciled) {
      return { ok: false, detail: "restored locally but external reconciliation is still required; stays blocked" };
    }
    return { ok: true, technicalRestored: true, detail: `matching schema/runtime/config restored with useful read; external effects reconciled` };
  },
};

const rerunIntent: CatalogAction = {
  id: "rerun_resumable_intent",
  check(_input, ports) {
    const missing = need(ports.intent, "intent");
    if (missing) return missing;
    const intent = ports.intent!;
    if (!intent.predecessorEffectKnown) return { ok: false, reason: "predecessor effect unknown; reconcile first, never blindly retry" };
    if (!intent.authorityValid) return { ok: false, reason: "current authority is not valid (stale approval or revoked scope); refusing" };
    if (!intent.leaseHeld) return { ok: false, reason: "no lease held on this intent; refusing concurrent progression" };
    return { ok: true, reason: "predecessor effect known, authority valid, lease held" };
  },
  async run(_input, ports) {
    const intent = ports.intent!;
    const before = [...intent.completedReceiptDigests].sort();
    const result = await intent.rerunIncomplete();
    if (result.completedChanged) return { ok: false, detail: "completed receipts changed during rerun; refusing to claim a safe resume" };
    const after = [...result.completedReceiptDigests].sort();
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      return { ok: false, detail: "original completed receipts are not unchanged; refusing" };
    }
    if (result.advancedSteps.length === 0) return { ok: false, detail: "no incomplete step advanced; stays blocked" };
    return { ok: true, bookingContinued: true, detail: `only incomplete steps advanced (${result.advancedSteps.join(", ")}); original completed receipts unchanged` };
  },
};

const markBlocked: CatalogAction = {
  id: "mark_blocked",
  check(input, _ports) {
    if (!input.reason) return { ok: false, reason: "mark_blocked requires a persisted reason; refusing a reasonless block" };
    return { ok: true, reason: "unsafe/unknown outcome or exhausted bounded attempts with a persisted reason" };
  },
  async run(input, _ports) {
    return { ok: true, detail: `blocked with persisted reason: ${input.reason}; evidence and attempts retained, no false recovery` };
  },
};

const CATALOG: Record<CatalogActionId, CatalogAction> = {
  restart_runtime: restartRuntime,
  resume_sync_from_cursor: resumeSync,
  reconcile_execution_by_external_id: reconcileExecution,
  refresh_access: refreshAccess,
  request_reconnect: requestReconnect,
  rollback_config_known_good: rollbackConfig,
  rerun_resumable_intent: rerunIntent,
  mark_blocked: markBlocked,
};

export function catalogIds(): CatalogActionId[] {
  return Object.keys(CATALOG) as CatalogActionId[];
}

/** Unknown action ids throw — the catalog is bounded, never open-ended. */
export function catalogAction(id: string): CatalogAction {
  const action = (CATALOG as Record<string, CatalogAction>)[id];
  if (!action) throw new Error(`Unknown repair action ${JSON.stringify(id)}; catalog is bounded to ${catalogIds().join(", ")}`);
  return action;
}
