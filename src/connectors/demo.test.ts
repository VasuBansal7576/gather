import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createDemoConnectors,
  demoCreateHoldKey,
  demoSendEmailKey,
  stableOperationKey,
  type CalendarSlot,
  type DocumentRecord,
  type InquiryThread,
  type SourceReference,
} from "./index.ts";

const source: SourceReference = {
  kind: "fixture",
  locator: "demo://fixtures/event-001",
  label: "Demo event fixture",
  fictional: true,
};

const thread: InquiryThread = {
  threadId: "thread-001",
  subject: "June dinner inquiry",
  messages: [
    {
      id: "message-001",
      threadId: "thread-001",
      from: "guest@example.test",
      to: ["venue@example.test"],
      subject: "June dinner inquiry",
      body: "Could you host 40 guests on June 12?",
      receivedAt: "2026-01-01T09:00:00.000Z",
      sourceReferences: [source],
    },
  ],
  sourceReferences: [source],
};

const document: DocumentRecord = {
  documentId: "doc-venue-policy",
  title: "Venue policies",
  mimeType: "text/plain",
  text: "Outside catering is allowed with prior approval.",
  sourceReferences: [source],
};

const availableSlot: CalendarSlot = {
  slotId: "slot-available",
  calendarId: "calendar-001",
  startAt: "2026-06-12T17:00:00.000Z",
  endAt: "2026-06-12T23:00:00.000Z",
  available: true,
  sourceReferences: [source],
};

const unavailableSlot: CalendarSlot = {
  slotId: "slot-unavailable",
  calendarId: "calendar-001",
  startAt: "2026-06-13T17:00:00.000Z",
  endAt: "2026-06-13T23:00:00.000Z",
  available: false,
  reason: "Demo fixture marks this date as unavailable.",
  sourceReferences: [source],
};

test("stable operation keys ignore identity insertion order", () => {
  const left = stableOperationKey({
    connector: "calendar",
    operation: "create-provisional-hold",
    identity: { bookingId: "booking-001", startAt: "2026-06-12T17:00:00.000Z", endAt: "2026-06-12T23:00:00.000Z" },
  });
  const right = stableOperationKey({
    connector: "calendar",
    operation: "create-provisional-hold",
    identity: { endAt: "2026-06-12T23:00:00.000Z", startAt: "2026-06-12T17:00:00.000Z", bookingId: "booking-001" },
  });
  assert.equal(left, right);
  assert.match(left, /^gather:calendar:create-provisional-hold:[0-9a-f]{16}$/);
});

test("reads email and documents with explicit demo provenance", async () => {
  const connectors = createDemoConnectors({ emailThreads: [thread], documents: [document] });

  const email = await connectors.email.readInquiryThread({
    operationKey: "demo-read-thread-001",
    threadId: "thread-001",
  });
  assert.equal(email.status, "succeeded");
  if (email.status !== "succeeded") return;
  assert.equal(email.metadata.mode.label, "DEMO ONLY");
  assert.equal(email.metadata.mode.fictional, true);
  assert.equal(email.data.provenance[0]?.fictional, true);

  const retrieved = await connectors.documents.retrieveDocument({
    operationKey: "demo-retrieve-doc-001",
    documentId: "doc-venue-policy",
  });
  assert.equal(retrieved.status, "succeeded");
  if (retrieved.status !== "succeeded") return;
  assert.equal(retrieved.data.document.text.includes("Outside catering"), true);
  assert.equal(retrieved.data.provenance.some((item) => item.locator === source.locator), true);
});

test("returns unavailable slots and refuses a hold on them", async () => {
  const connectors = createDemoConnectors({ calendarSlots: [availableSlot, unavailableSlot] });
  const availability = await connectors.calendar.checkAvailability({
    operationKey: "demo-availability-001",
    calendarId: "calendar-001",
    startAt: "2026-06-13T17:00:00.000Z",
    endAt: "2026-06-13T23:00:00.000Z",
  });
  assert.equal(availability.status, "succeeded");
  if (availability.status !== "succeeded") return;
  assert.equal(availability.data.slots[0]?.available, false);

  // A different calendar sees none of calendar-001's slots: availability is
  // strictly scoped and cannot leak across calendars.
  const foreign = await connectors.calendar.checkAvailability({
    operationKey: "demo-availability-002",
    calendarId: "calendar-002",
    startAt: "2026-06-13T17:00:00.000Z",
    endAt: "2026-06-13T23:00:00.000Z",
  });
  assert.equal(foreign.status, "succeeded");
  if (foreign.status !== "succeeded") return;
  assert.equal(foreign.data.slots.length, 0);

  const hold = await connectors.calendar.createProvisionalHold({
    operationKey: "demo-hold-unavailable-001",
    bookingId: "booking-001",
    calendarId: "calendar-001",
    startAt: "2026-06-13T18:00:00.000Z",
    endAt: "2026-06-13T22:00:00.000Z",
    expiresAt: "2026-06-14T00:00:00.000Z",
  });
  assert.equal(hold.status, "failed");
  if (hold.status !== "failed") return;
  assert.equal(hold.error.kind, "slot_unavailable");
});

test("reconciles a send that timed out after success and remains idempotent", async () => {
  const operationKey = demoSendEmailKey("offer-booking-001-v1");
  const connectors = createDemoConnectors({
    timeoutAfterSuccessOperationKeys: [operationKey],
  });
  const request = {
    operationKey,
    threadId: "thread-001",
    to: ["guest@example.test"],
    subject: "Your event offer",
    body: "We can host your event.",
  };

  const first = await connectors.email.sendEmail(request);
  assert.equal(first.status, "uncertain");
  if (first.status !== "uncertain") return;
  assert.equal(first.reconciliationRequired, true);

  const reconciled = await connectors.email.reconcileSentEmail({ operationKey });
  assert.equal(reconciled.status, "succeeded");
  if (reconciled.status !== "succeeded") return;
  assert.match(reconciled.data.sentEmail.messageId, /^demo-message-[0-9a-f]{8}$/);

  const retry = await connectors.email.sendEmail(request);
  assert.equal(retry.status, "succeeded");
  if (retry.status !== "succeeded") return;
  assert.equal(retry.data.sentEmail.messageId, reconciled.data.sentEmail.messageId);
});

test("reconciles a provisional hold that timed out after success", async () => {
  const operationKey = demoCreateHoldKey("booking-002", availableSlot.startAt, availableSlot.endAt);
  const connectors = createDemoConnectors({
    calendarSlots: [availableSlot],
    timeoutAfterSuccessOperationKeys: [operationKey],
  });
  const request = {
    operationKey,
    bookingId: "booking-002",
    calendarId: "calendar-001",
    startAt: availableSlot.startAt,
    endAt: availableSlot.endAt,
    expiresAt: "2026-06-13T00:00:00.000Z",
  };

  const first = await connectors.calendar.createProvisionalHold(request);
  assert.equal(first.status, "uncertain");
  const reconciled = await connectors.calendar.reconcileProvisionalHold({ operationKey });
  assert.equal(reconciled.status, "succeeded");
  if (reconciled.status !== "succeeded") return;
  assert.equal(reconciled.data.hold.status, "provisional_hold");
  assert.equal(connectors.store.listProvisionalHolds().length, 1);
});
