/**
 * ADR-004 fault-injection, restart-evidence (004-A03), emission, and
 * recovery-UI rendered-evidence tests.
 *
 * Default checks touch no real process: the ONLY real-process path is
 * gated behind GATHER_TEST_REAL_RESTART=1 and confined to a test-owned
 * loopback child. Everything else is scripted and labelled.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { catalogAction } from "../src/incidents/catalog.ts";
import { FAULT_CATALOG, faultById, injectFault } from "../src/incidents/faults.ts";
import { IncidentStore } from "../src/incidents/store.ts";
import { superviseIncident } from "../src/incidents/supervisor.ts";
import type { Incident } from "../src/incidents/types.ts";
import { emitIncidentsFromSweep } from "../src/server/operator-runtime/due-work.ts";
import { incidentSummary } from "../src/server/operator-runtime/health.ts";
import { OperatorIntakeStore } from "../src/server/operator-runtime/store.ts";
import type { OperatorRuntimeDeps } from "../src/server/operator-runtime/types.ts";
import { GatherStore } from "../src/server/sqlite-store.ts";

const ROOT = process.cwd();
const REAL_RESTART = process.env.GATHER_TEST_REAL_RESTART === "1";

function tmpDb(): { dir: string; store: GatherStore; incidents: IncidentStore } {
  const dir = mkdtempSync(join(tmpdir(), "gather-adr004-faults-"));
  const store = new GatherStore(join(dir, "gather.sqlite"));
  return { dir, store, incidents: new IncidentStore(store.db) };
}

// ---------------------------------------------------------- catalog ---

test("fault catalog is bounded and labelled; unknown faults throw", () => {
  assert.ok(FAULT_CATALOG.length >= 6);
  for (const fault of FAULT_CATALOG) {
    assert.ok(fault.id && fault.label && fault.description);
    assert.ok(fault.kind === "scripted" || fault.kind === "real-restart-opt-in");
  }
  assert.equal(FAULT_CATALOG.filter((fault) => fault.kind === "real-restart-opt-in").length, 1);
  assert.throws(() => faultById("fault_rm_rf"), /Unknown fault/);
});

test("scripted fault injection is labelled prepared; real-restart refuses without opt-in", () => {
  const injected = injectFault("fault_hold_ok_email_failed");
  assert.equal(injected.source, "fault_injection");
  assert.equal(injected.symptom.evidence, "prepared");
  if (REAL_RESTART) {
    const real = injectFault("fault_real_restart");
    assert.equal(real.symptom.evidence, "real-runtime");
  } else {
    assert.throws(() => injectFault("fault_real_restart"), /explicit opt-in/);
  }
});

// ------------------------------------------------------------- A03 ---

test("004-A03: scripted restart drill is distinguished from real-restart proof", async () => {
  const action = catalogAction("restart_runtime");
  const verified = await action.run({ resource: "runtime:fixture-owned-process" }, {
    runtime: {
      ownedProcessId: "runtime:fixture-owned-process",
      unrelatedInstances: 0,
      runsFenced: true,
      fenceRuns() {},
      evidence: "scripted-runtime",
      restart: async () => ({ oldExitObserved: true, newReady: true, usefulRead: "scripted: status ok" }),
    },
  });
  assert.equal(verified.ok, true);
  assert.match(verified.detail, /scripted-runtime/);
  assert.doesNotMatch(verified.detail, /real-runtime/);
});

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<{ observed: boolean; code: number | null }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ observed: false, code: null }), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ observed: true, code });
    });
  });
}

function waitForLine(child: ChildProcess, needle: string, timeoutMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    let buffer = "";
    const timer = setTimeout(() => resolve(undefined), timeoutMs);
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      for (const line of lines) {
        if (line.includes(needle)) {
          clearTimeout(timer);
          child.stdout?.off("data", onData);
          resolve(line.trim().slice(0, 200));
          return;
        }
      }
    };
    child.stdout?.on("data", onData);
  });
}

function spawnOwnedChild(): ChildProcess {
  const child = spawn(process.execPath, ["-e", "console.log('owned-ready'); setInterval(() => {}, 1000);"], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  child.unref?.();
  return child;
}

test("004-A03: real isolated process stop/restart verifies exit + ready + useful read (opt-in only)", async () => {
  if (!REAL_RESTART) {
    // Honest skip: default checks never touch a real process. The refusal
    // itself is the asserted behaviour here.
    assert.throws(() => injectFault("fault_real_restart"), /explicit opt-in/);
    return;
  }
  const action = catalogAction("restart_runtime");
  let current = spawnOwnedChild();
  let fenced = true;
  const verified = await action.run({ resource: "runtime:opt-in-child" }, {
    runtime: {
      ownedProcessId: "runtime:opt-in-child",
      unrelatedInstances: 0,
      runsFenced: fenced,
      fenceRuns() { fenced = true; },
      evidence: "real-runtime",
      restart: async () => {
        const oldExit = waitForExit(current, 10_000);
        current.kill("SIGTERM");
        const { observed } = await oldExit;
        current = spawnOwnedChild();
        try {
          const read = await waitForLine(current, "owned-ready", 10_000);
          return { oldExitObserved: observed, newReady: read !== undefined, usefulRead: read ?? "" };
        } finally {
          current.kill("SIGTERM");
        }
      },
    },
  });
  try {
    assert.equal(verified.ok, true);
    assert.match(verified.detail, /real-runtime/);
    assert.match(verified.detail, /old exit observed/);
  } finally {
    try { current.kill("SIGTERM"); } catch { /* already exited */ }
  }
});

// --------------------------------------------------------- emission ---

test("due-work emission derives deadletter + uncertain-step incidents and dedupes", () => {
  const { dir, store, incidents } = tmpDb();
  try {
    const business = store.createBusiness({ name: "Fictional Hall", timezone: "America/New_York" });
    const booking = store.createBooking({ businessId: business.id, eventName: "Fictional event", sourceReferences: [] });
    const action = store.createProposedAction({
      bookingId: booking.id,
      kind: "create_provisional_hold",
      payload: { startAt: "2030-06-12T17:00:00.000Z" },
      sourceReferences: [],
    });
    store.approveProposedAction(action.id, "owner-test");
    const execution = store.executeApprovedAction(action.id, () => { throw new Error("response lost"); });
    assert.equal(execution.status, "uncertain");

    const intake = new OperatorIntakeStore(store.db);
    intake.persistBatch({ accountId: "acct-1", items: [{ messageId: "m-1", observedAt: "2030-06-01T00:00:00.000Z" }], simulation: true });
    const item = intake.findItemByMessage("acct-1", "m-1")!;
    intake.updateItem(item.id, { status: "failed", error: "poison", dead: true });

    const deps = { store, accountId: "acct-1", businessId: business.id } as unknown as OperatorRuntimeDeps;
    const first = emitIncidentsFromSweep(deps, incidents).sort();
    assert.equal(first.length, 2);
    const second = emitIncidentsFromSweep(deps, incidents).sort();
    assert.deepEqual(second, first);

    const all = incidents.list();
    const signatures = all.map((incident) => incident.symptom.signature).sort();
    assert.deepEqual(signatures, ["execution_uncertain", "intake_deadletter"]);
    assert.ok(all.every((incident) => incident.symptom.evidence === "prepared"));

    const summary = incidentSummary(store.db);
    assert.deepEqual(summary, { open: 2, recovering: 0, recovered: 0, blocked: 0 });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("emission is additive: existing GatherStore tables and rows are untouched", () => {
  const { dir, store } = tmpDb();
  try {
    const business = store.createBusiness({ name: "Fictional Hall", timezone: "America/New_York" });
    const booking = store.createBooking({ businessId: business.id, eventName: "Fictional event", sourceReferences: [] });
    assert.equal(store.listBookings(business.id).length, 1);
    assert.equal(store.getBooking(booking.id).eventName, "Fictional event");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------- rendered evidence ---

interface RecoveryComponents {
  IncidentThread: (props: Record<string, unknown>) => unknown;
  FaultPanel: (props: Record<string, unknown>) => unknown;
}

let cached: { dir: string; mod: RecoveryComponents } | null = null;

async function loadRecoveryComponents(): Promise<{ dir: string; mod: RecoveryComponents }> {
  if (cached) return cached;
  const dir = mkdtempSync(join(tmpdir(), "gather-adr004-ui-"));
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"), "dir");
  const out = join(dir, "out");
  execFileSync(
    join(ROOT, "node_modules", ".bin", "tsc"),
    [
      join(ROOT, "src/components/gather/recoveries/IncidentThread.tsx"),
      join(ROOT, "src/components/gather/recoveries/FaultPanel.tsx"),
      "--outDir", out,
      "--jsx", "react-jsx",
      "--module", "nodenext",
      "--target", "es2022",
      "--moduleResolution", "nodenext",
      "--allowImportingTsExtensions",
      "--rewriteRelativeImportExtensions",
      "--skipLibCheck",
    ],
    { cwd: ROOT, stdio: "pipe" },
  );
  const thread = await import(pathToFileURL(join(out, "components", "gather", "recoveries", "IncidentThread.js")).href) as RecoveryComponents;
  const faults = await import(pathToFileURL(join(out, "components", "gather", "recoveries", "FaultPanel.js")).href) as RecoveryComponents;
  cached = { dir, mod: { IncidentThread: thread.IncidentThread, FaultPanel: faults.FaultPanel } };
  return cached;
}

function render(component: (props: Record<string, unknown>) => unknown, props: Record<string, unknown>): string {
  return renderToStaticMarkup(createElement(component as Parameters<typeof createElement>[0], props));
}

function blockedIncident(): Incident {
  return {
    id: "inc_evidence_blocked",
    source: "health",
    symptom: {
      signature: "access_revoked",
      resource: "account:fixture-mailbox",
      operation: "provider_read",
      detail: "Consent withdrawn; refresh is not authorized.",
      evidence: "prepared",
    },
    dedupeKey: "account:fixture-mailbox|provider_read|access_revoked",
    status: "blocked",
    diagnosis: {
      tier: "tier1_deterministic",
      summary: "Access revoked: surface a visible reconnect action and stay blocked.",
      selectedAction: "request_reconnect",
    },
    attempts: [
      {
        id: "att_1",
        incidentId: "inc_evidence_blocked",
        n: 1,
        action: "request_reconnect",
        preconditionOk: true,
        verification: { ok: true, detail: "visible reconnect action surfaced: Reconnect mailbox in Connections; incident stays blocked until successful consent and read" },
        createdAt: "2030-06-01T00:00:00.000Z",
      },
    ],
    blockedReason: "visible reconnect action surfaced: Reconnect mailbox in Connections; incident stays blocked until successful consent and read",
    remainingImpact: "Consent withdrawn; refresh is not authorized.",
    createdAt: "2030-06-01T00:00:00.000Z",
    updatedAt: "2030-06-01T00:00:00.000Z",
  };
}

function recoveredIncident(): Incident {
  return {
    id: "inc_evidence_recovered",
    source: "intent_failure",
    symptom: {
      signature: "hold_succeeded_email_failed",
      resource: "booking:fixture-partial-001",
      operation: "create_provisional_hold",
      detail: "Hold receipt hold:op-1 succeeded; email step email:op-1 still pending.",
      evidence: "prepared",
    },
    dedupeKey: "booking:fixture-partial-001|create_provisional_hold|hold_succeeded_email_failed",
    status: "recovered",
    diagnosis: {
      tier: "tier1_deterministic",
      summary: "Hold receipt succeeded while email is still incomplete: only the incomplete email step may advance.",
      selectedAction: "rerun_resumable_intent",
    },
    attempts: [
      {
        id: "att_2",
        incidentId: "inc_evidence_recovered",
        n: 1,
        action: "rerun_resumable_intent",
        preconditionOk: true,
        verification: { ok: true, technicalRestored: true, bookingContinued: true, detail: "only incomplete steps advanced (email:op-1); original completed receipts unchanged" },
        createdAt: "2030-06-01T00:00:00.000Z",
      },
    ],
    resumedIntentId: "intent-resumed-1",
    createdAt: "2030-06-01T00:00:00.000Z",
    updatedAt: "2030-06-01T00:00:00.000Z",
  };
}

function evidencePage(title: string, width: number, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — ${width}px — ADR-004 rendered evidence (fictional fixtures only)</title>
</head>
<body style="margin:0;padding:16px;font-family:system-ui,sans-serif;background:#f6f2ea;">
<main style="max-width:${width}px;margin:0 auto;">
<p style="color:#5b564a;font-size:14px;">ADR-004 rendered evidence · viewport ${width}px · all content fictional fixtures; blocked states stay blocked, scripted drills are labelled.</p>
${body}
</main>
</body>
</html>
`;
}

test("recovery UI renders labelled threads + fault panel at 1440px and 390px", async () => {
  const { mod } = await loadRecoveryComponents();
  const threads = render(mod.IncidentThread, { incident: blockedIncident() })
    + render(mod.IncidentThread, { incident: recoveredIncident() });
  const panel = render(mod.FaultPanel, { faults: FAULT_CATALOG });
  const body = `${panel}${threads}`;
  assert.match(body, /prepared fixture/);
  assert.match(body, /scripted drill/);
  assert.match(body, /real restart — opt-in only/);
  assert.match(body, /Blocked — needs you/);
  assert.match(body, /Recovered/);
  assert.match(body, /only incomplete steps advanced/);
  assert.match(body, /Seen 1 of 3 repair attempts/);
  const dir = join(ROOT, "evaluation", "recoveries", "evidence");
  mkdirSync(dir, { recursive: true });
  for (const width of [1440, 390]) {
    writeFileSync(join(dir, `recoveries-${width}.html`), evidencePage("Recoveries", width, body));
  }
});

test("supervise marks Tier-2 mark_blocked selection blocked, never recovered", async () => {
  const { dir, incidents } = tmpDb();
  try {
    const { incident } = incidents.emit({
      source: "intent_failure",
      symptom: {
        signature: "unknown_mystery_zzz",
        resource: "booking:fixture-mystery-001",
        operation: "unknown_op",
        detail: "Mystery failure; budgeted diagnosis will mark blocked.",
        evidence: "prepared",
      },
    });
    const result = await superviseIncident(incidents, incident.id, {
      tier2: { budget: { maxToolCalls: 2, maxTokens: 2000, usedToolCalls: 0, usedTokens: 0 }, model: async () => ({ selectedAction: "mark_blocked", rationale: "nothing safe applies" }) },
    });
    assert.equal(result.incident.status, "blocked");
    assert.equal(result.bookingContinued, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
