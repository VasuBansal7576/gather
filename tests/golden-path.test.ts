/**
 * GOLDEN-PATH SCAFFOLD (ADR-002 step 4 / 002-A04).
 *
 * This is an explicitly labelled SCAFFOLD, not the finished product journey:
 * it drives the durable intent lane end to end against SIMULATED demo
 * providers using a prebuilt regression proposal — the exact approve →
 * provisional hold → email pipeline the approved-action services already
 * own. ADR-010 adds the fresh inquiry-to-offer generation in front of this
 * lane; ADR-016 closes release coverage. Everything here stays fictional
 * and DEMO ONLY; no live provider or credential is ever touched.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { createDemoConnectors, type DemoConnectorSet } from "../src/connectors/demo.ts";
import type { ConnectorResult, CreateProvisionalHoldRequest, CreateProvisionalHoldResponse, OperationRequest, SendEmailRequest } from "../src/connectors/contracts.ts";
import { IntentService } from "../src/intents/index.ts";
import { emailOperationKey, holdOperationKey, isSimulatedStepProof, type BookingServiceDeps } from "../src/server/booking-service.ts";
import { DurableDemoCalendar, DurableDemoEmail } from "../src/server/durable-demo-connectors.ts";
import { GatherStore } from "../src/server/sqlite-store.ts";

export const GOLDEN_SCAFFOLD_LABEL =
  "GOLDEN-PATH SCAFFOLD (ADR-002): durable intent lane over simulated providers with prebuilt regression proposals — awaiting ADR-010 (fresh inquiry-to-offer) and ADR-016 (release coverage). DEMO ONLY; no live provider is exercised.";

const NOW = "2030-06-01T00:00:00.000Z";
const START = "2030-06-12T17:00:00.000Z";
const END = "2030-06-12T23:00:00.000Z";
const EXPIRES = "2030-06-13T23:00:00.000Z";
const CALENDAR = "demo-calendar-001";

function regressionPayload(startAt: string = START, endAt: string = END) {
  return {
    startAt,
    endAt,
    expiresAt: EXPIRES,
    calendarId: CALENDAR,
    emailTo: ["guest@example.test"],
    emailSubject: "DEMO ONLY fictional offer",
    emailBody: "DEMO ONLY fictional hold for the test event.",
  };
}

function coveringSlot() {
  return {
    slotId: "slot-cover",
    calendarId: CALENDAR,
    startAt: "2030-06-12T00:00:00.000Z",
    endAt: "2030-06-14T00:00:00.000Z",
    available: true as const,
    sourceReferences: [{ kind: "fixture" as const, locator: "demo://golden/slot", fictional: true as const }],
  };
}

interface GoldenWorld {
  dir: string;
  path: string;
  store: GatherStore;
  demo: DemoConnectorSet;
  deps: BookingServiceDeps;
  intents: IntentService;
  businessId: string;
}

function openWorld(
  dir: string,
  opts: {
    wrapCalendar?: (inner: DurableDemoCalendar) => BookingServiceDeps["calendar"];
    wrapEmail?: (inner: DurableDemoEmail) => BookingServiceDeps["email"];
    now?: () => string;
  } = {},
): GoldenWorld {
  const path = join(dir, "gather.sqlite");
  const store = new GatherStore(path);
  const now = opts.now ?? (() => NOW);
  const demo = createDemoConnectors({ calendarSlots: [coveringSlot()], nowMs: () => Date.parse(now()) });
  const calendar = new DurableDemoCalendar(store, demo.calendar, () => Date.parse(now()));
  const email = new DurableDemoEmail(store, demo.email);
  const deps: BookingServiceDeps = {
    store,
    calendar: opts.wrapCalendar === undefined ? calendar : opts.wrapCalendar(calendar),
    email: opts.wrapEmail === undefined ? email : opts.wrapEmail(email),
    ownerId: "golden-owner",
    now,
  };
  return { dir, path, store, demo, deps, intents: new IntentService({ booking: deps, mode: "prepared", now }), businessId: "" };
}

test("002-A04: golden-path scaffold — durable approve intent over simulated providers, restart, dedupe, cancel", async (t) => {
  t.diagnostic(GOLDEN_SCAFFOLD_LABEL);
  const dir = mkdtempSync(join(tmpdir(), "gather-golden-"));
  const report: Array<{ stage: string; state: string; evidence: string }> = [];
  try {
    // -- Stage 1: prebuilt regression proposal on a fictional business ------
    const w = openWorld(dir);
    const business = w.store.createBusiness({ name: "Fictional Golden Hall", timezone: "UTC" });
    w.businessId = business.id;
    const booking = w.store.createBooking({
      businessId: business.id,
      eventName: "Fictional golden event",
      status: "pending_approval",
      startAt: START,
      endAt: END,
      sourceReferences: [{ kind: "fixture", locator: "demo://golden/booking", fictional: true }],
    });
    const action = w.store.createProposedAction({
      bookingId: booking.id,
      kind: "create_provisional_hold",
      payload: regressionPayload(),
      sourceReferences: [{ kind: "fixture", locator: "demo://golden/proposal", fictional: true }],
    });
    report.push({ stage: "seed", state: "pending_approval", evidence: "prebuilt fictional proposal (regression fixture)" });

    // -- Stage 2: enqueue is durable before it executes; dedupe is canonical -
    const command = {
      kind: "approve_booking_proposal" as const,
      bookingId: booking.id,
      proposedActionId: action.id,
      proposalVersion: action.proposalVersion,
      proposalFingerprint: action.proposalFingerprint,
    };
    const submitted = w.intents.enqueue({ command, commandKey: "golden-approve-1" });
    assert.equal(submitted.intent.state, "queued");
    const replayed = w.intents.enqueue({ command, commandKey: "golden-approve-1" });
    assert.equal(replayed.intent.id, submitted.intent.id, "canonical replay returns the same durable intent");
    assert.equal(replayed.duplicate, true);
    report.push({ stage: "enqueue", state: submitted.intent.state, evidence: `durable row ${submitted.intent.id} before execution; replay deduped` });

    // -- Stage 3: progression owner drives approve → hold → email -----------
    const settled = await w.intents.drive(submitted.intent.id, "golden-sweep");
    assert.equal(settled.state, "completed");
    const holdKey = holdOperationKey(action.id, action.proposalVersion);
    const emailKey = emailOperationKey(action.id, action.proposalVersion);
    const holdExec = w.store.getExecutionByIdempotencyKey(holdKey);
    const emailExec = w.store.getExecutionByIdempotencyKey(emailKey);
    assert.equal(holdExec?.status, "succeeded");
    assert.equal(emailExec?.status, "succeeded");
    assert.ok(isSimulatedStepProof(holdExec?.result), "hold receipt must carry simulated proof");
    assert.ok(isSimulatedStepProof(emailExec?.result), "email receipt must carry simulated proof");
    assert.equal(w.store.getBooking(booking.id).status, "provisional_hold");
    assert.ok(w.demo.store.getSentEmail(emailKey), "simulated email landed in the demo world");
    report.push({ stage: "drive", state: settled.state, evidence: "approve+hold+email completed; receipts carry simulated proof (DEMO ONLY)" });

    // -- Stage 4: restart recovery — the hold is preserved, never re-sent ---
    // Simulate a crash: abandon a second intent mid-run with its claim live,
    // then reopen the same database under a fresh service + fresh demo world.
    const booking2 = w.store.createBooking({
      businessId: business.id,
      eventName: "Fictional golden event II",
      status: "pending_approval",
      startAt: "2030-06-13T17:00:00.000Z",
      endAt: "2030-06-13T23:00:00.000Z",
      sourceReferences: [{ kind: "fixture", locator: "demo://golden/booking2", fictional: true }],
    });
    const action2 = w.store.createProposedAction({
      bookingId: booking2.id,
      kind: "create_provisional_hold",
      payload: regressionPayload("2030-06-13T17:00:00.000Z", "2030-06-13T23:00:00.000Z"),
      sourceReferences: [{ kind: "fixture", locator: "demo://golden/proposal2", fictional: true }],
    });
    let holdCalls = 0;
    let sends = 0;
    const crashing = new IntentService({
      booking: {
        ...w.deps,
        email: {
          sendEmail: async (_req: SendEmailRequest): Promise<never> => {
            sends += 1;
            w.store.close(); // process dies mid-dispatch: outcome never recorded
            throw new Error("simulated process crash mid-dispatch");
          },
          reconcileSentEmail: (req: OperationRequest) => w.demo.email.reconcileSentEmail(req),
        },
      },
      mode: "prepared",
      now: () => NOW,
    });
    const crashed = crashing.enqueue({
      command: {
        kind: "approve_booking_proposal",
        bookingId: booking2.id,
        proposedActionId: action2.id,
        proposalVersion: action2.proposalVersion,
        proposalFingerprint: action2.proposalFingerprint,
      },
      commandKey: "golden-approve-2",
    });
    await assert.rejects(() => crashing.drive(crashed.intent.id, "golden-sweep"));

    const w2 = openWorld(dir, {
      // Past the dead claim's lease so the crashed email row can be reclaimed.
      now: () => "2030-06-01T00:05:00.000Z",
      wrapCalendar: (inner) => ({
        checkAvailability: (req) => inner.checkAvailability(req),
        createProvisionalHold: async (req: CreateProvisionalHoldRequest): Promise<ConnectorResult<CreateProvisionalHoldResponse>> => {
          holdCalls += 1;
          throw new Error("a succeeded hold must never re-dispatch");
        },
        reconcileProvisionalHold: (req: OperationRequest) => inner.reconcileProvisionalHold(req),
      }),
    });
    const recovery = await w2.intents.recoverInterrupted();
    assert.deepEqual(recovery.recovered, [crashed.intent.id]);
    assert.equal(w2.intents.get(crashed.intent.id).state, "retryable");
    report.push({ stage: "restart", state: "retryable", evidence: "crashed intent recovered by evidence check, never blind-replayed" });

    // -- Stage 5: resume — only the eligible (unsent) step re-runs ----------
    const resumed = await w2.intents.drive(crashed.intent.id, "golden-sweep");
    assert.equal(holdCalls, 0, "the pre-crash hold was preserved by receipt");
    assert.equal(resumed.state, "uncertain", "the crashed send stays honestly uncertain (no provider evidence)");
    report.push({ stage: "resume", state: resumed.state, evidence: "hold preserved; crashed email reconciles to honest uncertainty" });

    // -- Stage 6: cancellation fences progression; terminals retain state ---
    const cancel = w2.intents.cancel(crashed.intent.id, "golden-owner");
    assert.equal(cancel.applied, true);
    const afterCancel = await w2.intents.drive(crashed.intent.id, "golden-sweep");
    assert.equal(afterCancel.state, "cancelled");
    const completedCancel = w2.intents.cancel(submitted.intent.id, "golden-owner");
    assert.equal(completedCancel.applied, false, "a completed intent cannot be cancelled");
    assert.equal(w2.store.getBooking(booking.id).status, "provisional_hold");
    report.push({ stage: "cancel", state: "cancelled", evidence: "cancel fences the live claim; completed intents keep their state" });

    w2.store.close();

    for (const entry of report) t.diagnostic(`golden[${entry.stage}] -> ${entry.state} :: ${entry.evidence}`);
    assert.match(GOLDEN_SCAFFOLD_LABEL, /SCAFFOLD/);
    assert.equal(sends, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
