/**
 * ADR-004 incident tests: catalog preconditions/verification (004-A01),
 * bounded recovery loop (004-A02), and Tier-2/Tier-3 boundaries (004-A04).
 *
 * All fixtures are fictional and local-only: no providers, models,
 * credentials, or personal runtime state are touched.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogAction, catalogIds, type CatalogPorts } from "../src/incidents/catalog.ts";
import { diagnoseTier2, type Tier2Budget } from "../src/incidents/diagnose.ts";
import { proposeCodePatch } from "../src/incidents/patch.ts";
import { IncidentStore } from "../src/incidents/store.ts";
import { superviseIncident } from "../src/incidents/supervisor.ts";
import { MAX_INCIDENT_ATTEMPTS } from "../src/incidents/types.ts";
import { GatherStore } from "../src/server/sqlite-store.ts";

function tmpDb(): { dir: string; store: GatherStore; incidents: IncidentStore } {
  const dir = mkdtempSync(join(tmpdir(), "gather-adr004-"));
  const store = new GatherStore(join(dir, "gather.sqlite"));
  return { dir, store, incidents: new IncidentStore(store.db) };
}

function budget(overrides: Partial<Tier2Budget> = {}): Tier2Budget {
  return { maxToolCalls: 2, maxTokens: 2000, usedToolCalls: 0, usedTokens: 0, ...overrides };
}

// ---------------------------------------------------------------- A01 ---

test("004-A01: catalog holds exactly the 8 bounded C09 actions; unknown ids throw", () => {
  assert.deepEqual([...catalogIds()].sort(), [
    "mark_blocked",
    "reconcile_execution_by_external_id",
    "refresh_access",
    "request_reconnect",
    "rerun_resumable_intent",
    "restart_runtime",
    "resume_sync_from_cursor",
    "rollback_config_known_good",
  ]);
  assert.throws(() => catalogAction("restart_via_shell"), /Unknown repair action/);
  assert.throws(() => catalogAction(""), /Unknown repair action/);
});

test("004-A01: restart_runtime denies wrong-resource/unrelated/unfenced, verifies observed exit + ready + read", async () => {
  const owned = "runtime:owned-1";
  const ports: CatalogPorts = {
    runtime: {
      ownedProcessId: owned,
      unrelatedInstances: 0,
      runsFenced: true,
      fenceRuns() {},
      evidence: "scripted-runtime",
      restart: async () => ({ oldExitObserved: true, newReady: true, usefulRead: "scripted: status ok, 0 active runs" }),
    },
  };
  const action = catalogAction("restart_runtime");
  assert.equal(action.check({ resource: "runtime:someone-else" }, ports).ok, false);
  assert.match(action.check({ resource: "runtime:someone-else" }, ports).reason, /not the owned process/);
  assert.equal(action.check({ resource: owned }, { runtime: { ...ports.runtime!, unrelatedInstances: 2 } }).ok, false);
  assert.equal(action.check({ resource: owned }, { runtime: { ...ports.runtime!, runsFenced: false } }).ok, false);
  assert.equal(action.check({ resource: owned }, {}).ok, false);
  assert.equal(action.check({ resource: owned }, ports).ok, true);
  const verified = await action.run({ resource: owned }, ports);
  assert.equal(verified.ok, true);
  assert.equal(verified.technicalRestored, true);
  assert.match(verified.detail, /scripted-runtime/);
  const unobserved = await action.run({ resource: owned }, {
    runtime: { ...ports.runtime!, restart: async () => ({ oldExitObserved: false, newReady: true, usefulRead: "x" }) },
  });
  assert.equal(unobserved.ok, false);
  assert.match(unobserved.detail, /not observed/);
});

test("004-A01: resume_sync_from_cursor requires checkpoint + authority + no lease; verifies progress + dedupe", async () => {
  const action = catalogAction("resume_sync_from_cursor");
  const good: CatalogPorts = {
    sync: {
      checkpoint: { cursor: "cursor-42", valid: true },
      authorized: true,
      concurrentScanLease: false,
      resumeFromCursor: async () => ({ progressed: true, dedupeStable: true, coverage: "inbox 30d complete" }),
    },
  };
  assert.equal(action.check({ resource: "account:a" }, {}).ok, false);
  assert.equal(action.check({ resource: "account:a" }, { sync: { ...good.sync!, checkpoint: undefined } }).ok, false);
  assert.equal(action.check({ resource: "account:a" }, { sync: { ...good.sync!, authorized: false } }).ok, false);
  assert.equal(action.check({ resource: "account:a" }, { sync: { ...good.sync!, concurrentScanLease: true } }).ok, false);
  assert.equal(action.check({ resource: "account:a" }, good).ok, true);
  assert.equal((await action.run({ resource: "account:a" }, good)).ok, true);
  const stalled = await action.run({ resource: "account:a" }, {
    sync: { ...good.sync!, resumeFromCursor: async () => ({ progressed: false, dedupeStable: true, coverage: "stalled" }) },
  });
  assert.equal(stalled.ok, false);
});

test("004-A01: reconcile_execution_by_external_id denies cross-operation scope; unknown stays blocked", async () => {
  const action = catalogAction("reconcile_execution_by_external_id");
  const ports: CatalogPorts = {
    execution: {
      operationIdentity: { operationKey: "op-1", bookingId: "booking-1" },
      authorizedRead: true,
      reconcileByExternalId: async (key) => key === "op-1"
        ? { matched: true, providerResult: "hold:confirmed", bookingId: "booking-1" }
        : { matched: false, reason: "no such provider record" },
    },
  };
  assert.equal(action.check({ resource: "booking:booking-1", operationKey: "op-9" }, ports).ok, false);
  assert.match(action.check({ resource: "booking:booking-1", operationKey: "op-9" }, ports).reason, /not the persisted operation/);
  assert.equal(action.check({ resource: "booking:booking-1", operationKey: "op-1" }, {}).ok, false);
  assert.equal(action.check({ resource: "booking:booking-1", operationKey: "op-1" }, ports).ok, true);
  const ok = await action.run({ resource: "booking:booking-1", operationKey: "op-1" }, ports);
  assert.equal(ok.ok, true);
  assert.equal(ok.bookingContinued, true);
  const unknown = await action.run({ resource: "booking:booking-1", operationKey: "op-1" }, {
    execution: { ...ports.execution!, reconcileByExternalId: async () => ({ matched: false, reason: "provider unreachable" }) },
  });
  assert.equal(unknown.ok, false);
  assert.match(unknown.detail, /remains blocked/);
  const crossBooking = await action.run({ resource: "booking:booking-1", operationKey: "op-1" }, {
    execution: { ...ports.execution!, reconcileByExternalId: async () => ({ matched: true, providerResult: "hold:x", bookingId: "booking-2" }) },
  });
  assert.equal(crossBooking.ok, false);
  assert.match(crossBooking.detail, /cross-booking link refused/);
});

test("004-A01: refresh_access requires credential + intact consent; refuses token leaks", async () => {
  const action = catalogAction("refresh_access");
  assert.equal(action.check({ resource: "account:a" }, {}).ok, false);
  const noCred: CatalogPorts = { access: { refreshCredentialExists: false, consentRevoked: false, refresh: async () => ({ harmlessReadOk: true, logSample: "ok", tokenLeaked: false }) } };
  assert.equal(action.check({ resource: "account:a" }, noCred).ok, false);
  const revoked: CatalogPorts = { access: { refreshCredentialExists: true, consentRevoked: true, refresh: async () => ({ harmlessReadOk: true, logSample: "ok", tokenLeaked: false }) } };
  const revokedCheck = action.check({ resource: "account:a" }, revoked);
  assert.equal(revokedCheck.ok, false);
  assert.match(revokedCheck.reason, /consent is revoked/);
  const good: CatalogPorts = { access: { refreshCredentialExists: true, consentRevoked: false, refresh: async () => ({ harmlessReadOk: true, logSample: "read 200 ok", tokenLeaked: false }) } };
  assert.equal((await action.run({ resource: "account:a" }, good)).ok, true);
  const leaky: CatalogPorts = { access: { refreshCredentialExists: true, consentRevoked: false, refresh: async () => ({ harmlessReadOk: true, logSample: "Authorization: Bearer abcdefgh1234", tokenLeaked: false }) } };
  assert.equal((await action.run({ resource: "account:a" }, leaky)).ok, false);
});

test("004-A01: request_reconnect refuses when existing authority suffices; records visible owner step", async () => {
  const action = catalogAction("request_reconnect");
  assert.equal(action.check({ resource: "account:a" }, {}).ok, false);
  assert.equal(action.check({ resource: "account:a" }, { reconnect: { repairableWithExistingAuthority: true, surfaceReconnect: () => ({ visibleAction: "x" }) } }).ok, false);
  const ports: CatalogPorts = { reconnect: { repairableWithExistingAuthority: false, surfaceReconnect: () => ({ visibleAction: "Reconnect mailbox in Connections" }) } };
  assert.equal(action.check({ resource: "account:a" }, ports).ok, true);
  const run = await action.run({ resource: "account:a" }, ports);
  assert.equal(run.ok, true);
  assert.match(run.detail, /stays blocked until successful consent/);
});

test("004-A01: rollback_config_known_good requires validated backup + fence + reconciliation; never policy", async () => {
  const action = catalogAction("rollback_config_known_good");
  assert.equal(action.check({ resource: "runtime:r" }, {}).ok, false);
  const good: CatalogPorts = {
    config: {
      compatibleBackup: { path: ".runtime/backups/good.json", validated: true },
      runsFenced: true,
      rollback: async () => ({ schemaOk: true, runtimeOk: true, usefulRead: "read ok", externallyReconciled: true, policyRolledBack: false }),
    },
  };
  assert.equal(action.check({ resource: "runtime:r" }, good).ok, true);
  assert.equal((await action.run({ resource: "runtime:r" }, good)).ok, true);
  const policyTouch = await action.run({ resource: "runtime:r" }, {
    config: { ...good.config!, rollback: async () => ({ schemaOk: true, runtimeOk: true, usefulRead: "x", externallyReconciled: true, policyRolledBack: true }) },
  });
  assert.equal(policyTouch.ok, false);
  const noReconcile = await action.run({ resource: "runtime:r" }, {
    config: { ...good.config!, rollback: async () => ({ schemaOk: true, runtimeOk: true, usefulRead: "x", externallyReconciled: false, policyRolledBack: false }) },
  });
  assert.equal(noReconcile.ok, false);
});

test("004-A01: rerun_resumable_intent requires known effect + authority + lease; receipts stay unchanged", async () => {
  const action = catalogAction("rerun_resumable_intent");
  assert.equal(action.check({ resource: "booking:b" }, {}).ok, false);
  const base = { predecessorEffectKnown: true, authorityValid: true, leaseHeld: true, completedReceiptDigests: ["hold-digest"], rerunIncomplete: async () => ({ advancedSteps: ["email-step"], completedReceiptDigests: ["hold-digest"], completedChanged: false }) };
  assert.equal(action.check({ resource: "booking:b" }, { intent: { ...base, predecessorEffectKnown: false } }).ok, false);
  assert.equal(action.check({ resource: "booking:b" }, { intent: { ...base, authorityValid: false } }).ok, false);
  assert.equal(action.check({ resource: "booking:b" }, { intent: { ...base, leaseHeld: false } }).ok, false);
  assert.equal(action.check({ resource: "booking:b" }, { intent: base }).ok, true);
  const ok = await action.run({ resource: "booking:b" }, { intent: base });
  assert.equal(ok.ok, true);
  assert.equal(ok.bookingContinued, true);
  const changed = await action.run({ resource: "booking:b" }, {
    intent: { ...base, rerunIncomplete: async () => ({ advancedSteps: ["email-step"], completedReceiptDigests: ["other"], completedChanged: true }) },
  });
  assert.equal(changed.ok, false);
});

test("004-A01: mark_blocked requires a persisted reason", async () => {
  const action = catalogAction("mark_blocked");
  assert.equal(action.check({ resource: "x" }, {}).ok, false);
  assert.equal(action.check({ resource: "x", reason: "unsafe outcome" }, {}).ok, true);
  assert.equal((await action.run({ resource: "x", reason: "unsafe outcome" }, {})).ok, true);
});

// ---------------------------------------------------------------- A02 ---

test("004-A02: hold-success/email-failure recovers with one hold; receipts unchanged; intent resumed", async () => {
  const { dir, incidents } = tmpDb();
  try {
    const { incident } = incidents.emit({
      source: "intent_failure",
      symptom: {
        signature: "hold_succeeded_email_failed",
        resource: "booking:fixture-partial-001",
        operation: "create_provisional_hold",
        detail: "Hold receipt hold:op-1 succeeded; email step email:op-1 still pending.",
        evidence: "prepared",
      },
    });
    const result = await superviseIncident(incidents, incident.id, {
      intent: {
        predecessorEffectKnown: true,
        authorityValid: true,
        leaseHeld: true,
        completedReceiptDigests: ["hold-digest-op-1"],
        rerunIncomplete: async () => ({
          advancedSteps: ["email:op-1"],
          completedReceiptDigests: ["hold-digest-op-1"],
          completedChanged: false,
        }),
      },
      resumeIntent: async () => ({ resumedIntentId: "intent-resumed-1" }),
    });
    assert.equal(result.incident.status, "recovered");
    assert.equal(result.incident.attempts.length, 1);
    assert.equal(result.incident.attempts[0]?.action, "rerun_resumable_intent");
    assert.equal(result.bookingContinued, true);
    assert.equal(result.incident.resumedIntentId, "intent-resumed-1");
    assert.equal(result.incident.diagnosis?.tier, "tier1_deterministic");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("004-A02: repeated transient failure exhausts exactly three attempts, then honestly blocked", async () => {
  assert.equal(MAX_INCIDENT_ATTEMPTS, 3);
  const { dir, incidents } = tmpDb();
  try {
    const { incident } = incidents.emit({
      source: "health",
      symptom: {
        signature: "sync_cursor_stalled",
        resource: "account:fixture-mailbox",
        operation: "source_scan",
        detail: "Scan stalled at cursor-42.",
        evidence: "prepared",
      },
    });
    let runs = 0;
    const result = await superviseIncident(incidents, incident.id, {
      sync: {
        checkpoint: { cursor: "cursor-42", valid: true },
        authorized: true,
        concurrentScanLease: false,
        resumeFromCursor: async () => {
          runs += 1;
          return { progressed: false, dedupeStable: true, coverage: `attempt ${runs}: still stalled` };
        },
      },
      // Fresh transient evidence keeps arriving, so the loop spends its full budget.
      newEvidenceAvailable: () => runs < 3,
    });
    assert.equal(runs, 3);
    assert.equal(result.incident.status, "blocked");
    assert.equal(result.incident.attempts.length, 3);
    assert.match(result.incident.blockedReason ?? "", /exhausted 3 bounded attempt\(s\)/);
    assert.equal(result.bookingContinued, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("004-A02: unchanged repeat is never retried — one failed attempt blocks", async () => {
  const { dir, incidents } = tmpDb();
  try {
    const { incident } = incidents.emit({
      source: "health",
      symptom: {
        signature: "sync_cursor_stalled",
        resource: "account:fixture-mailbox",
        operation: "source_scan",
        detail: "Scan stalled; no new evidence.",
        evidence: "prepared",
      },
    });
    let runs = 0;
    const result = await superviseIncident(incidents, incident.id, {
      sync: {
        checkpoint: { cursor: "cursor-42", valid: true },
        authorized: true,
        concurrentScanLease: false,
        resumeFromCursor: async () => {
          runs += 1;
          return { progressed: false, dedupeStable: true, coverage: "stalled" };
        },
      },
    });
    assert.equal(runs, 1);
    assert.equal(result.incident.attempts.length, 1);
    assert.equal(result.incident.status, "blocked");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("004-A02: permanent rejection (no authorized read) blocks with zero attempts burned", async () => {
  const { dir, incidents } = tmpDb();
  try {
    const { incident } = incidents.emit({
      source: "intent_failure",
      symptom: {
        signature: "execution_uncertain",
        resource: "booking:fixture-uncertain-001",
        operation: "exec:op-uncertain-1",
        detail: "Step outcome unknown; provider read unauthorized.",
        evidence: "prepared",
      },
    });
    const result = await superviseIncident(incidents, incident.id, {
      execution: {
        operationIdentity: { operationKey: "exec:op-uncertain-1", bookingId: "fixture-uncertain-001" },
        authorizedRead: false,
        reconcileByExternalId: async () => { throw new Error("must never be called without an authorized read"); },
      },
    });
    assert.equal(result.incident.status, "blocked");
    assert.equal(result.incident.attempts.length, 0);
    assert.match(result.incident.blockedReason ?? "", /no authorized provider read/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("004-A02: revoked consent stays honestly blocked with the reconnect step surfaced", async () => {
  const { dir, incidents } = tmpDb();
  try {
    const { incident } = incidents.emit({
      source: "health",
      symptom: {
        signature: "access_revoked",
        resource: "account:fixture-mailbox",
        operation: "provider_read",
        detail: "Consent withdrawn; refresh is not authorized.",
        evidence: "prepared",
      },
    });
    const result = await superviseIncident(incidents, incident.id, {
      reconnect: {
        repairableWithExistingAuthority: false,
        surfaceReconnect: () => ({ visibleAction: "Reconnect mailbox in Connections" }),
      },
    });
    assert.equal(result.incident.status, "blocked");
    assert.equal(result.incident.attempts.length, 1);
    assert.match(result.incident.blockedReason ?? "", /stays blocked until successful consent/);
    assert.equal(result.bookingContinued, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- A04 ---

test("004-A04: unknown diagnosis with invalid model output blocks; no action runs", async () => {
  const { dir, incidents } = tmpDb();
  try {
    const { incident } = incidents.emit({
      source: "intent_failure",
      symptom: {
        signature: "unknown_mystery_zzz",
        resource: "booking:fixture-mystery-001",
        operation: "unknown_op",
        detail: "No Tier-1 entry for this signature.",
        evidence: "prepared",
      },
    });
    const result = await superviseIncident(incidents, incident.id, {
      tier2: { budget: budget(), model: async () => undefined },
    });
    assert.equal(result.incident.status, "blocked");
    assert.equal(result.incident.attempts.length, 0);
    assert.match(result.incident.blockedReason ?? "", /invalid output/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("004-A04: Tier-2 rejects arbitrary actions and never exceeds budget", async () => {
  let calls = 0;
  const seen: unknown[] = [];
  const evil = await diagnoseTier2(
    { summary: "mystery", signature: "unknown_mystery_zzz", resource: "booking:x" },
    budget(),
    async (evidence) => {
      calls += 1;
      seen.push(evidence);
      return { selectedAction: "restart_via_shell" as never, rationale: "trust me" };
    },
  );
  assert.equal(calls, 1);
  assert.equal(evil.result, undefined);
  assert.match(evil.blocked ?? "", /unknown action/);
  // Evidence handed to the model is redacted summary only — no credentials, no provider bodies.
  assert.deepEqual(Object.keys(seen[0] as Record<string, unknown>).sort(), ["resource", "signature", "summary"]);

  const spent = budget({ usedToolCalls: 2, maxToolCalls: 2 });
  let neverCalled = 0;
  const exhausted = await diagnoseTier2(
    { summary: "mystery", signature: "s", resource: "r" },
    spent,
    async () => { neverCalled += 1; return { selectedAction: "mark_blocked", rationale: "x" }; },
  );
  assert.equal(neverCalled, 0);
  assert.match(exhausted.blocked ?? "", /budget exhausted/);

  const unavailable = await diagnoseTier2(
    { summary: "mystery", signature: "s", resource: "r" },
    budget(),
    async () => { throw new Error("model endpoint down"); },
  );
  assert.match(unavailable.blocked ?? "", /unavailable/);
});

test("004-A04: code patch proposal writes artifacts but never changes running source", () => {
  const dir = mkdtempSync(join(tmpdir(), "gather-adr004-repairs-"));
  try {
    const sourcePath = join(process.cwd(), "src", "incidents", "catalog.ts");
    const before = readFileSync(sourcePath, "utf8");
    const result = proposeCodePatch({
      incidentId: "inc_code_1",
      suspectFile: "src/incidents/catalog.ts",
      reproduction: "Isolated: rerun_resumable_intent accepts a changed receipt set.",
      proposedDiff: "--- a/src/incidents/catalog.ts\n+++ b/src/incidents/catalog.ts\n@@\n-allow\n+deny\n",
      regressionTest: "import test from 'node:test';\ntest('receipts unchanged', () => {});\n",
      repairsRoot: join(dir, ".runtime", "repairs"),
    });
    assert.equal(result.applied, false);
    assert.equal(result.complete, true);
    assert.equal(result.files.length, 3);
    assert.equal(readFileSync(sourcePath, "utf8"), before);

    const incomplete = proposeCodePatch({
      incidentId: "inc_code_2",
      suspectFile: "src/incidents/catalog.ts",
      reproduction: "No isolated reproduction found.",
      repairsRoot: join(dir, ".runtime", "repairs"),
    });
    assert.equal(incomplete.applied, false);
    assert.equal(incomplete.complete, false);
    assert.match(incomplete.note, /stays blocked/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------ store ---

test("incident store dedupes by resource+operation+signature, isolates resources, and caps attempts", () => {
  const { dir, incidents } = tmpDb();
  try {
    const symptom = {
      signature: "execution_uncertain",
      resource: "booking:b1",
      operation: "op-1",
      detail: "uncertain",
      evidence: "prepared" as const,
    };
    const first = incidents.emit({ source: "intent_failure", symptom });
    assert.equal(first.duplicate, false);
    const second = incidents.emit({ source: "intent_failure", symptom });
    assert.equal(second.duplicate, true);
    assert.equal(second.incident.id, first.incident.id);
    const otherResource = incidents.emit({ source: "intent_failure", symptom: { ...symptom, resource: "booking:b2" } });
    assert.equal(otherResource.duplicate, false);
    // Unknown catalog action in a diagnosis is rejected, not persisted.
    assert.throws(() => incidents.setDiagnosis(first.incident.id, { tier: "tier1_deterministic", summary: "x", selectedAction: "rm_rf" as never }), /Unknown catalog action/);
    const diagnosed = incidents.setDiagnosis(first.incident.id, { tier: "tier1_deterministic", summary: "x", selectedAction: "mark_blocked" });
    assert.equal(diagnosed.status, "recovering");
    for (let n = 1; n <= 3; n += 1) {
      incidents.recordAttempt(first.incident.id, { action: "mark_blocked", preconditionOk: true, verification: { ok: false, detail: `try ${n}` } });
    }
    assert.throws(
      () => incidents.recordAttempt(first.incident.id, { action: "mark_blocked", preconditionOk: true, verification: { ok: false, detail: "try 4" } }),
      /exhausted its 3 bounded attempts/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
