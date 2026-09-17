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

export const GOLDEN_010_A05_LABEL =
  "GOLDEN 010-A05 (ADR-010): three fresh inquiries with zero initial proposals — qualification, deterministic pricing, identity, exact approval, hold/email, version invalidation, restart partial success. SCRIPTED over simulated providers; DEMO ONLY; no live provider is exercised.";

const A05_NOW = "2030-01-01T00:00:00.000Z";
const A05_OWNER = "golden-010-owner";
const A05_CAL = "demo-calendar-001";
const A05_SRC = (locator: string) => [{ kind: "document" as const, locator, label: locator, fictional: true as const }];
const A05_FIX = (locator: string) => [{ kind: "fixture" as const, locator, fictional: true as const }];

function a05CoverSlot() {
  return {
    slotId: "slot-cover",
    calendarId: A05_CAL,
    startAt: "2030-06-12T00:00:00.000Z",
    endAt: "2030-06-14T00:00:00.000Z",
    available: true as const,
    sourceReferences: [{ kind: "fixture" as const, locator: "demo://golden-010/slot", fictional: true as const }],
  };
}

test("010-A05: full prepared inquiry-to-offer-to-approved-hold/email golden path (scripted)", async (t) => {
  t.diagnostic(GOLDEN_010_A05_LABEL);
  const dir = mkdtempSync(join(tmpdir(), "gather-golden-010-"));
  const report: Array<{ stage: string; state: string; evidence: string }> = [];
  const path = join(dir, "gather.sqlite");
  try {
    const { prepareFreshInquiry } = await import("../src/server/business-operator/index.ts");
    const { approveAndExecute, reconcileExecution, retryFailedSteps } = await import("../src/server/booking-service.ts");
    const { KnowledgeService } = await import("../src/knowledge/index.ts");

    const openServices = (opts: { crashEmailOnce?: { crashed: boolean } } = {}) => {
      const store = new GatherStore(path);
      const demo = createDemoConnectors({ calendarSlots: [a05CoverSlot()], nowMs: () => Date.parse(A05_NOW) });
      const calendar = new DurableDemoCalendar(store, demo.calendar, () => Date.parse(A05_NOW));
      const innerEmail = new DurableDemoEmail(store, demo.email);
      let holdCalls = 0;
      const countingCalendar = {
        checkAvailability: (req: never) => calendar.checkAvailability(req as never) as never,
        createProvisionalHold: (async (req: CreateProvisionalHoldRequest) => {
          holdCalls += 1;
          return calendar.createProvisionalHold(req);
        }) as never,
        reconcileProvisionalHold: ((req: OperationRequest) => innerEmail && calendar.reconcileProvisionalHold(req)) as never,
      };
      const email = {
        sendEmail: (async (req: SendEmailRequest) => {
          if (opts.crashEmailOnce && !opts.crashEmailOnce.crashed) {
            opts.crashEmailOnce.crashed = true;
            await innerEmail.sendEmail(req); // provider accepted; the response is lost
            throw new Error("simulated process crash mid-dispatch");
          }
          return innerEmail.sendEmail(req);
        }) as never,
        reconcileSentEmail: ((req: OperationRequest) => innerEmail.reconcileSentEmail(req)) as never,
      };
      const bookingDeps = { store, calendar: countingCalendar, email, ownerId: A05_OWNER, now: () => A05_NOW } as never;
      const operatorDeps = {
        store, booking: bookingDeps, ownerId: A05_OWNER,
        availability: calendar as never,
      } as never;
      return { store, demo, bookingDeps, operatorDeps, holdCalls: () => holdCalls };
    };

    // -- Stage 0: reference business, zero bookings, zero proposals --------
    const w0 = openServices();
    const business = w0.store.createBusiness({ name: "Fictional Glasshouse", timezone: "America/New_York" });
    w0.store.upsertConnectedAccount({ id: "acct-1", businessId: business.id, provider: "other", displayName: "Test", status: "connected" });
    const svc = new KnowledgeService(w0.store);
    for (const fact of [
      { key: "space", subjectId: "hall", value: { spaceId: "hall", name: "Hall", capacityMin: 1, capacityMax: 100 } },
      { key: "price_line", subjectId: "package", value: { lineId: "package", label: "Event package", pricingBasis: "per_guest", unitCents: 5000 } },
      { key: "pricing_bounds", value: { currency: "USD", floorCents: 100000, costsComplete: false } },
      { key: "service", subjectId: "dinner", value: { serviceId: "dinner", label: "Dinner", available: true } },
    ]) {
      const candidate = svc.intakeCandidate({
        businessId: business.id, ...fact, confidence: "probable", sourceReferences: A05_SRC("demo://golden-010/kb/" + fact.key),
      });
      svc.confirmCandidate({ businessId: business.id, actor: { kind: "owner", id: A05_OWNER }, candidateId: candidate.id });
    }
    assert.equal(w0.store.listBookings(business.id).length, 0, "product scenario starts with zero bookings and zero prebuilt offers");
    report.push({ stage: "seed", state: "empty", evidence: "reference business + confirmed fixture facts; no bookings, no proposals" });

    const inquiryInput = (inquiryId: string, externalId: string, overrides: Record<string, unknown> = {}) => ({
      businessId: business.id,
      identity: {
        components: {
          provider: "email", accountId: "acct-1", businessId: business.id,
          sourceKind: "email", externalId, threadId: `thread-${externalId}`,
        },
      },
      inquiry: {
        inquiryId, businessId: business.id, eventType: "dinner",
        startAt: "2030-06-12T17:00:00.000Z", endAt: "2030-06-12T23:00:00.000Z",
        guestCount: 40, serviceRequirements: ["dinner"],
        sourceReferences: A05_SRC(`demo://golden-010/${inquiryId}`),
        ...overrides,
      },
      calendarId: A05_CAL,
      expiresAt: "2030-06-13T23:00:00.000Z",
      email: { to: ["guest@example.test"], subject: "DEMO ONLY fictional offer", body: "DEMO ONLY fictional hold." },
    });

    // -- Inquiry 1 (complete): qualify -> price -> exact approve -> hold+email
    const fresh1 = await prepareFreshInquiry(w0.operatorDeps, inquiryInput("inq-g1", "msg-g1"));
    assert.equal(fresh1.outcome, "prepared");
    if (fresh1.outcome !== "prepared") throw new Error("inquiry 1 did not prepare");
    assert.equal(fresh1.prepare.offer.primaryOffer?.totalCents, 200000, "40 guests @ $50 = $2,000, grounded in confirmed facts");
    assert.ok(fresh1.prepare.proposal, "feasible offer persists to an exact proposal");
    assert.equal(fresh1.lifecycle?.stage, "proposed", "owner-facing lifecycle tracks the fresh booking");
    const action1 = fresh1.prepare.proposal.action;
    // Wrong fingerprint is refused: approval binds the exact version.
    await assert.rejects(
      () => approveAndExecute(w0.bookingDeps, {
        bookingId: fresh1.bookingId, proposedActionId: action1.id,
        proposalVersion: action1.proposalVersion, proposalFingerprint: "deadbeef",
      }),
      /Stale proposal/,
      "exact-version approval refuses a forged fingerprint",
    );
    const done1 = await approveAndExecute(w0.bookingDeps, {
      bookingId: fresh1.bookingId, proposedActionId: action1.id,
      proposalVersion: action1.proposalVersion, proposalFingerprint: action1.proposalFingerprint,
    });
    assert.equal(done1.hold.execution.status, "succeeded");
    assert.equal(done1.email?.execution.status, "succeeded");
    assert.ok(isSimulatedStepProof(done1.hold.execution.result), "hold receipt carries simulated proof (DEMO ONLY)");
    report.push({ stage: "inquiry-1", state: "provisional_hold", evidence: "fresh inquiry -> $2,000 offer -> exact approval -> hold+email, all simulated" });

    // -- Inquiry 1 price-only v2: reuse + version invalidation --------------
    const fresh1v2 = await prepareFreshInquiry(w0.operatorDeps, {
      ...inquiryInput("inq-g1", "msg-g1"),
      email: { to: ["guest@example.test"], subject: "DEMO ONLY fictional offer v2", body: "DEMO ONLY fictional hold v2." },
    });
    assert.equal(fresh1v2.outcome, "prepared");
    if (fresh1v2.outcome !== "prepared") throw new Error("inquiry 1 v2 did not prepare");
    const action1v2 = fresh1v2.prepare.proposal!.action;
    const holdsBefore = w0.holdCalls();
    const done1v2 = await approveAndExecute(w0.bookingDeps, {
      bookingId: fresh1v2.bookingId, proposedActionId: action1v2.id,
      proposalVersion: action1v2.proposalVersion, proposalFingerprint: action1v2.proposalFingerprint,
    });
    assert.equal(w0.holdCalls(), holdsBefore, "price-only v2 creates no second hold");
    assert.equal(done1v2.email?.execution.status, "succeeded", "only the new email action is created");
    await assert.rejects(
      () => approveAndExecute(w0.bookingDeps, {
        bookingId: fresh1.bookingId, proposedActionId: action1.id,
        proposalVersion: action1.proposalVersion, proposalFingerprint: action1.proposalFingerprint,
      }),
      /Stale proposal|no longer current/,
      "the superseded v1 approval is invalidated by the v2 publish",
    );
    report.push({ stage: "inquiry-1-v2", state: "reused", evidence: "price-only revision reuses the hold; v1 approval invalidated" });

    // -- Inquiry 2: crash mid-email -> restart -> resume only the unsent step
    const crash = { crashed: false };
    w0.store.close();
    const w1 = openServices({ crashEmailOnce: crash });
    const fresh2 = await prepareFreshInquiry(w1.operatorDeps, inquiryInput("inq-g2", "msg-g2", {
      startAt: "2030-06-13T17:00:00.000Z", endAt: "2030-06-13T23:00:00.000Z",
    }));
    assert.equal(fresh2.outcome, "prepared");
    if (fresh2.outcome !== "prepared") throw new Error("inquiry 2 did not prepare");
    const action2 = fresh2.prepare.proposal!.action;
    const partial = await approveAndExecute(w1.bookingDeps, {
      bookingId: fresh2.bookingId, proposedActionId: action2.id,
      proposalVersion: action2.proposalVersion, proposalFingerprint: action2.proposalFingerprint,
    });
    assert.equal(partial.hold.execution.status, "succeeded", "hold landed before the crash");
    assert.equal(partial.email?.execution.status, "uncertain", "lost send stays uncertain, never assumed");
    const holdsAtCrash = w1.holdCalls();
    w1.store.close();
    // Restart under a fresh world: the lost send reconciles against the
    // durable provider receipt (timeout-after-success heals); the hold is
    // preserved by receipt and never re-dispatched.
    const w2 = openServices();
    const crashedEmail = w2.store.getExecutionByIdempotencyKey(emailOperationKey(action2.id, action2.proposalVersion));
    assert.equal(crashedEmail?.status, "uncertain", "restart finds the lost send honestly uncertain");
    const healed = await reconcileExecution(w2.bookingDeps, crashedEmail!.id);
    assert.equal(healed.execution.status, "succeeded", "durable provider evidence heals the send on reconcile");
    const resumed = await retryFailedSteps(w2.bookingDeps, action2.id);
    assert.equal(w2.holdCalls(), 0, "the pre-crash hold is preserved by receipt, never re-dispatched");
    assert.equal(resumed.email?.execution.status, "succeeded", "only the unsent email step re-runs");
    assert.equal(w2.store.getBooking(fresh2.bookingId).status, "provisional_hold");
    void holdsAtCrash;
    report.push({ stage: "inquiry-2-restart", state: "provisional_hold", evidence: "crashed send reconciles to uncertainty; restart resumes only the email" });

    // -- Inquiry 3 (conflicting date): grounded block, no proposal ---------
    const w3store = w2.store;
    void w3store;
    const fresh3 = await prepareFreshInquiry(w2.operatorDeps, inquiryInput("inq-g3", "msg-g3", {
      startAt: "2030-06-20T17:00:00.000Z", endAt: "2030-06-20T23:00:00.000Z",
    }));
    assert.equal(fresh3.outcome, "prepared");
    if (fresh3.outcome !== "prepared") throw new Error("inquiry 3 did not prepare");
    assert.equal(fresh3.prepare.proposal, null, "a conflicting date persists no executable proposal");
    assert.ok(fresh3.prepare.missingForProposal.length > 0, "the block is itemized, never silent");
    const availabilityGap = [
      ...fresh3.prepare.offer.conflicts.map((conflict) => conflict.code),
      ...fresh3.prepare.offer.missingInformation.map((item) => item.code),
      ...fresh3.prepare.missingForProposal.map((item) => item.code),
    ];
    assert.ok(
      availabilityGap.some((code) => /availability|conflict/.test(code)),
      `the uncovered window is explicit evidence (${availabilityGap.join(",")})`,
    );
    report.push({ stage: "inquiry-3", state: "blocked", evidence: "uncovered date grounded to an explicit availability gap; nothing approvable" });

    w2.store.close();
    for (const entry of report) t.diagnostic(`golden-010[${entry.stage}] -> ${entry.state} :: ${entry.evidence}`);
    assert.match(GOLDEN_010_A05_LABEL, /010-A05/);
  } finally {
    try {
      const reopen = new GatherStore(path);
      reopen.close();
    } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true });
  }
});
