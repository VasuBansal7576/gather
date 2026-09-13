import {
  DEMO_MODE,
  stableOperationKey,
  type CalendarSlot,
  type CheckAvailabilityRequest,
  type CheckAvailabilityResponse,
  type ConnectorFailure,
  type ConnectorMetadata,
  type ConnectorResult,
  type ConnectorSuccess,
  type ConnectorUncertain,
  type CreateProvisionalHoldRequest,
  type CreateProvisionalHoldResponse,
  type DemoSourceReference,
  type DocumentRecord,
  type InquiryMessage,
  type InquiryThread,
  type ReadInquiryThreadRequest,
  type ReadInquiryThreadResponse,
  type RetrieveDocumentRequest,
  type RetrieveDocumentResponse,
  type SendEmailRequest,
  type SendEmailResponse,
  type SentEmail,
  type SourceReference,
  type ProvisionalHold,
} from "./contracts.ts";
import type {
  CalendarAvailabilityReader,
  DocumentRetriever,
  EmailSender,
  InquiryThreadReader,
  ProvisionalHoldWriter,
} from "./contracts.ts";

const DEMO_CATALOG_SOURCE: DemoSourceReference = {
  kind: "fixture",
  locator: "demo://gather/connectors",
  label: "Gather connector demo fixture",
  fictional: true,
};

export interface DemoConnectorSeed {
  emailThreads?: readonly InquiryThread[];
  documents?: readonly DocumentRecord[];
  calendarSlots?: readonly CalendarSlot[];
  now?: string;
  /**
   * Mutable clock (epoch millis) shared with the service and durable
   * wrappers so simulated expiry advances consistently in-process and
   * across restarts. When absent, the fixed `now` seed time is used.
   */
  nowMs?: () => number;
  /**
   * These keys complete their write in memory, then report an uncertain
   * timeout once. Reconciliation discovers the completed write.
   */
  timeoutAfterSuccessOperationKeys?: readonly string[];
}

function copySource(source: SourceReference): SourceReference {
  return { ...source, fictional: true };
}

function copySources(
  sources: SourceReference[] | undefined,
  include: SourceReference = DEMO_CATALOG_SOURCE,
): SourceReference[] {
  const copied = (sources ?? []).map(copySource);
  const all = [...copied, copySource(include)];
  const seen = new Set<string>();
  return all.filter((source) => {
    if (seen.has(source.locator)) return false;
    seen.add(source.locator);
    return true;
  });
}

function copyMessage(message: InquiryMessage): InquiryMessage {
  return {
    ...message,
    to: [...message.to],
    sourceReferences: copySources(message.sourceReferences),
  };
}

function copyThread(thread: InquiryThread): InquiryThread {
  return {
    ...thread,
    messages: thread.messages.map(copyMessage),
    sourceReferences: copySources(thread.sourceReferences),
  };
}

function copyDocument(document: DocumentRecord): DocumentRecord {
  return {
    ...document,
    sourceReferences: copySources(document.sourceReferences),
  };
}

function copySlot(slot: CalendarSlot): CalendarSlot {
  return {
    ...slot,
    ...(slot.calendarId === undefined ? {} : { calendarId: slot.calendarId }),
    sourceReferences: copySources(slot.sourceReferences),
  };
}

function copySentEmail(email: SentEmail): SentEmail {
  return {
    ...email,
    to: [...email.to],
    cc: [...email.cc],
    sourceReferences: copySources(email.sourceReferences),
  };
}

function copyHold(hold: ProvisionalHold): ProvisionalHold {
  return {
    ...hold,
    sourceReferences: copySources(hold.sourceReferences),
  };
}

function assertUnique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`Duplicate demo ${label}: ${value}`);
    seen.add(value);
  }
}

/**
 * Explicitly injected state. Constructing this class never reads credentials,
 * environment variables, files, or a personal OpenClaw installation.
 */
export class InMemoryDemoConnectorStore {
  private readonly emailThreads = new Map<string, InquiryThread>();
  private readonly documents = new Map<string, DocumentRecord>();
  private readonly calendarSlots = new Map<string, CalendarSlot>();
  private readonly sentEmails = new Map<string, SentEmail>();
  private readonly provisionalHolds = new Map<string, ProvisionalHold>();
  private readonly timeoutAfterSuccess: Set<string>;
  private readonly consumedTimeouts = new Set<string>();
  private readonly fixedTime: string;
  private readonly clockMs?: () => number;

  public constructor(seed: DemoConnectorSeed = {}) {
    const emailThreads = seed.emailThreads ?? [];
    const documents = seed.documents ?? [];
    const calendarSlots = seed.calendarSlots ?? [];
    assertUnique(emailThreads.map((thread) => thread.threadId), "thread id");
    assertUnique(documents.map((document) => document.documentId), "document id");
    assertUnique(calendarSlots.map((slot) => slot.slotId), "slot id");

    for (const thread of emailThreads) {
      this.emailThreads.set(thread.threadId, copyThread(thread));
    }
    for (const document of documents) {
      this.documents.set(document.documentId, copyDocument(document));
    }
    for (const slot of calendarSlots) {
      this.calendarSlots.set(slot.slotId, copySlot(slot));
    }

    this.fixedTime = seed.now ?? "2026-01-01T00:00:00.000Z";
    this.clockMs = seed.nowMs;
    this.timeoutAfterSuccess = new Set(seed.timeoutAfterSuccessOperationKeys ?? []);
  }

  public now(): string {
    return this.clockMs === undefined ? this.fixedTime : new Date(this.clockMs()).toISOString();
  }

  public getEmailThread(threadId: string): InquiryThread | undefined {
    const thread = this.emailThreads.get(threadId);
    return thread === undefined ? undefined : copyThread(thread);
  }

  public getDocument(documentId: string): DocumentRecord | undefined {
    const document = this.documents.get(documentId);
    return document === undefined ? undefined : copyDocument(document);
  }

  public listCalendarSlots(): CalendarSlot[] {
    return [...this.calendarSlots.values()]
      .sort((left, right) => left.startAt.localeCompare(right.startAt))
      .map(copySlot);
  }

  public getSentEmail(operationKey: string): SentEmail | undefined {
    const email = this.sentEmails.get(operationKey);
    return email === undefined ? undefined : copySentEmail(email);
  }

  public saveSentEmail(email: SentEmail): void {
    this.sentEmails.set(email.operationKey, copySentEmail(email));
  }

  public getProvisionalHold(operationKey: string): ProvisionalHold | undefined {
    const hold = this.provisionalHolds.get(operationKey);
    return hold === undefined ? undefined : copyHold(hold);
  }

  public listProvisionalHolds(): ProvisionalHold[] {
    return [...this.provisionalHolds.values()].map(copyHold);
  }

  public saveProvisionalHold(hold: ProvisionalHold): void {
    this.provisionalHolds.set(hold.operationKey, copyHold(hold));
  }

  public consumeTimeoutAfterSuccess(operationKey: string): boolean {
    if (
      !this.timeoutAfterSuccess.has(operationKey) ||
      this.consumedTimeouts.has(operationKey)
    ) {
      return false;
    }
    this.consumedTimeouts.add(operationKey);
    return true;
  }
}

function metadata(
  operationKey: string,
  sourceReferences: SourceReference[] | undefined,
): ConnectorMetadata {
  return {
    operationKey,
    mode: DEMO_MODE,
    simulated: true,
    sourceReferences: copySources(sourceReferences),
  };
}

function failure(
  operationKey: string,
  sourceReferences: SourceReference[] | undefined,
  kind: ConnectorFailure["error"]["kind"],
  message: string,
  retryable = false,
): ConnectorFailure {
  return {
    status: "failed",
    metadata: metadata(operationKey, sourceReferences),
    error: { kind, message, retryable },
  };
}

function success<T>(
  operationKey: string,
  sourceReferences: SourceReference[] | undefined,
  data: T,
): ConnectorSuccess<T> {
  return {
    status: "succeeded",
    metadata: metadata(operationKey, sourceReferences),
    data,
  };
}

function uncertain(
  operationKey: string,
  sourceReferences: SourceReference[] | undefined,
): ConnectorUncertain {
  return {
    status: "uncertain",
    metadata: metadata(operationKey, sourceReferences),
    error: {
      kind: "timeout_after_success",
      message:
        "The demo write completed, but its response timed out. Reconcile before retrying.",
      retryable: false,
    },
    reconciliationRequired: true,
  };
}

function validNonEmpty(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

function validTimeRange(startAt: string, endAt: string): boolean {
  const start = Date.parse(startAt);
  const end = Date.parse(endAt);
  return Number.isFinite(start) && Number.isFinite(end) && start < end;
}

function overlaps(
  leftStart: string,
  leftEnd: string,
  rightStart: string,
  rightEnd: string,
): boolean {
  return Date.parse(leftStart) < Date.parse(rightEnd) && Date.parse(leftEnd) > Date.parse(rightStart);
}

function covers(
  containerStart: string,
  containerEnd: string,
  requestedStart: string,
  requestedEnd: string,
): boolean {
  return Date.parse(containerStart) <= Date.parse(requestedStart) && Date.parse(containerEnd) >= Date.parse(requestedEnd);
}

function digest(value: string): string {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export class DemoEmailConnector implements InquiryThreadReader, EmailSender {
  private readonly store: InMemoryDemoConnectorStore;

  public constructor(store: InMemoryDemoConnectorStore) {
    this.store = store;
  }

  public async readInquiryThread(
    request: ReadInquiryThreadRequest,
  ): Promise<ConnectorResult<ReadInquiryThreadResponse>> {
    if (!validNonEmpty(request.operationKey) || !validNonEmpty(request.threadId)) {
      return failure(request.operationKey, undefined, "invalid_request", "operationKey and threadId are required");
    }

    const thread = this.store.getEmailThread(request.threadId);
    if (thread === undefined) {
      return failure(request.operationKey, undefined, "not_found", `Demo email thread not found: ${request.threadId}`);
    }

    const provenance = copySources(thread.sourceReferences);
    return success(request.operationKey, provenance, {
      thread,
      provenance,
    });
  }

  public async sendEmail(
    request: SendEmailRequest,
  ): Promise<ConnectorResult<SendEmailResponse>> {
    if (
      !validNonEmpty(request.operationKey) ||
      request.to.length === 0 ||
      !validNonEmpty(request.subject) ||
      !validNonEmpty(request.body)
    ) {
      return failure(
        request.operationKey,
        request.sourceReferences,
        "invalid_request",
        "operationKey, at least one recipient, subject, and body are required",
      );
    }

    const existing = this.store.getSentEmail(request.operationKey);
    if (existing !== undefined) {
      if (!sameEmail(existing, request)) {
        return failure(
          request.operationKey,
          request.sourceReferences,
          "conflict",
          "The operation key is already associated with a different email payload",
        );
      }
      return success(request.operationKey, existing.sourceReferences, {
        sentEmail: existing,
        provenance: existing.sourceReferences,
      });
    }

    const sourceReferences = copySources(request.sourceReferences);
    const sentEmail: SentEmail = {
      messageId: `demo-message-${digest(request.operationKey)}`,
      operationKey: request.operationKey,
      ...(request.threadId === undefined ? {} : { threadId: request.threadId }),
      to: [...request.to],
      cc: [...(request.cc ?? [])],
      subject: request.subject,
      body: request.body,
      sentAt: this.store.now(),
      sourceReferences,
    };
    this.store.saveSentEmail(sentEmail);

    if (this.store.consumeTimeoutAfterSuccess(request.operationKey)) {
      return uncertain(request.operationKey, sourceReferences);
    }

    return success(request.operationKey, sourceReferences, {
      sentEmail,
      provenance: sourceReferences,
    });
  }

  public async reconcileSentEmail(
    request: { operationKey: string },
  ): Promise<ConnectorResult<SendEmailResponse>> {
    const existing = this.store.getSentEmail(request.operationKey);
    if (existing === undefined) {
      return failure(
        request.operationKey,
        undefined,
        "not_found",
        "No completed demo email was found for reconciliation",
      );
    }
    return success(request.operationKey, existing.sourceReferences, {
      sentEmail: existing,
      provenance: existing.sourceReferences,
    });
  }
}

function sameEmail(existing: SentEmail, request: SendEmailRequest): boolean {
  return (
    existing.threadId === request.threadId &&
    existing.subject === request.subject &&
    existing.body === request.body &&
    JSON.stringify(existing.to) === JSON.stringify(request.to) &&
    JSON.stringify(existing.cc) === JSON.stringify(request.cc ?? [])
  );
}

export class DemoDocumentConnector implements DocumentRetriever {
  private readonly store: InMemoryDemoConnectorStore;

  public constructor(store: InMemoryDemoConnectorStore) {
    this.store = store;
  }

  public async retrieveDocument(
    request: RetrieveDocumentRequest,
  ): Promise<ConnectorResult<RetrieveDocumentResponse>> {
    if (!validNonEmpty(request.operationKey) || !validNonEmpty(request.documentId)) {
      return failure(request.operationKey, undefined, "invalid_request", "operationKey and documentId are required");
    }

    const document = this.store.getDocument(request.documentId);
    if (document === undefined) {
      return failure(request.operationKey, undefined, "not_found", `Demo document not found: ${request.documentId}`);
    }

    const provenance = copySources(document.sourceReferences);
    return success(request.operationKey, provenance, {
      document,
      provenance,
    });
  }
}

export class DemoCalendarConnector implements CalendarAvailabilityReader, ProvisionalHoldWriter {
  private readonly store: InMemoryDemoConnectorStore;

  public constructor(store: InMemoryDemoConnectorStore) {
    this.store = store;
  }

  public async checkAvailability(
    request: CheckAvailabilityRequest,
  ): Promise<ConnectorResult<CheckAvailabilityResponse>> {
    if (
      !validNonEmpty(request.operationKey) ||
      !validNonEmpty(request.calendarId) ||
      !validTimeRange(request.startAt, request.endAt)
    ) {
      return failure(
        request.operationKey,
        undefined,
        "invalid_request",
        "operationKey, calendarId, and a valid startAt/endAt range are required",
      );
    }

    // Strictly scoped: only slots attributed to the requested calendar are
    // visible. Unattributed slots match nothing, so one calendar's openings
    // can never authorize another calendar's hold.
    const slots = this.store
      .listCalendarSlots()
      .filter((slot) => slot.calendarId === request.calendarId)
      .filter((slot) => overlaps(slot.startAt, slot.endAt, request.startAt, request.endAt));
    const provenance = copySources(slots.flatMap((slot) => slot.sourceReferences));
    return success(request.operationKey, provenance, {
      slots,
      provenance,
    });
  }

  public async createProvisionalHold(
    request: CreateProvisionalHoldRequest,
  ): Promise<ConnectorResult<CreateProvisionalHoldResponse>> {
    if (
      !validNonEmpty(request.operationKey) ||
      !validNonEmpty(request.bookingId) ||
      !validNonEmpty(request.calendarId) ||
      !validTimeRange(request.startAt, request.endAt) ||
      !validNonEmpty(request.expiresAt) ||
      !Number.isFinite(Date.parse(request.expiresAt)) ||
      Date.parse(request.expiresAt) <= Date.parse(this.store.now())
    ) {
      return failure(
        request.operationKey,
        request.sourceReferences,
        "invalid_request",
        "operationKey, bookingId, calendarId, a valid range, and an unexpired expiresAt (after the connector's current time) are required",
      );
    }

    const existing = this.store.getProvisionalHold(request.operationKey);
    if (existing !== undefined) {
      if (!sameHold(existing, request)) {
        return failure(
          request.operationKey,
          request.sourceReferences,
          "conflict",
          "The operation key is already associated with a different hold payload",
        );
      }
      return success(request.operationKey, existing.sourceReferences, {
        hold: existing,
        provenance: existing.sourceReferences,
      });
    }

    const slots = this.store.listCalendarSlots();
    const unavailableSlot = slots.find(
      (slot) =>
        !slot.available &&
        slot.calendarId === request.calendarId &&
        overlaps(slot.startAt, slot.endAt, request.startAt, request.endAt),
    );
    if (unavailableSlot !== undefined) {
      return failure(
        request.operationKey,
        unavailableSlot.sourceReferences,
        "slot_unavailable",
        unavailableSlot.reason ?? `Demo slot is unavailable: ${unavailableSlot.slotId}`,
      );
    }

    const coveringSlot = slots.find(
      (slot) =>
        slot.available &&
        slot.calendarId === request.calendarId &&
        covers(slot.startAt, slot.endAt, request.startAt, request.endAt),
    );
    if (coveringSlot === undefined) {
      return failure(
        request.operationKey,
        undefined,
        "slot_unavailable",
        "No available demo slot covers the requested range",
      );
    }

    // Expired holds no longer deny their window, mirroring the durable
    // receipt rule; holds without a readable expiry stay fail-closed.
    const nowMs = Date.parse(this.store.now());
    const conflictingHold = this.store.listProvisionalHolds().find(
      (hold) =>
        hold.calendarId === request.calendarId &&
        overlaps(hold.startAt, hold.endAt, request.startAt, request.endAt) &&
        (!Number.isFinite(Date.parse(hold.expiresAt)) || Date.parse(hold.expiresAt) > nowMs),
    );
    if (conflictingHold !== undefined) {
      return failure(
        request.operationKey,
        conflictingHold.sourceReferences,
        "conflict",
        `Demo slot is already held by ${conflictingHold.holdId}`,
      );
    }

    const sourceReferences = copySources([
      ...(request.sourceReferences ?? []),
      ...coveringSlot.sourceReferences,
    ]);
    const hold: ProvisionalHold = {
      holdId: `demo-hold-${digest(request.operationKey)}`,
      operationKey: request.operationKey,
      bookingId: request.bookingId,
      calendarId: request.calendarId,
      startAt: request.startAt,
      endAt: request.endAt,
      expiresAt: request.expiresAt,
      status: "provisional_hold",
      createdAt: this.store.now(),
      sourceReferences,
    };
    this.store.saveProvisionalHold(hold);

    if (this.store.consumeTimeoutAfterSuccess(request.operationKey)) {
      return uncertain(request.operationKey, sourceReferences);
    }

    return success(request.operationKey, sourceReferences, {
      hold,
      provenance: sourceReferences,
    });
  }

  public async reconcileProvisionalHold(
    request: { operationKey: string },
  ): Promise<ConnectorResult<CreateProvisionalHoldResponse>> {
    const existing = this.store.getProvisionalHold(request.operationKey);
    if (existing === undefined) {
      return failure(
        request.operationKey,
        undefined,
        "not_found",
        "No completed demo provisional hold was found for reconciliation",
      );
    }
    return success(request.operationKey, existing.sourceReferences, {
      hold: existing,
      provenance: existing.sourceReferences,
    });
  }
}

function sameHold(
  existing: ProvisionalHold,
  request: CreateProvisionalHoldRequest,
): boolean {
  return (
    existing.bookingId === request.bookingId &&
    existing.calendarId === request.calendarId &&
    existing.startAt === request.startAt &&
    existing.endAt === request.endAt &&
    existing.expiresAt === request.expiresAt
  );
}

export interface DemoConnectorSet {
  store: InMemoryDemoConnectorStore;
  email: DemoEmailConnector;
  documents: DemoDocumentConnector;
  calendar: DemoCalendarConnector;
}

/**
 * Composition helper used by demos and tests. The caller owns the seed and
 * can inject the same store into all adapters to observe one deterministic
 * in-memory world.
 */
export function createDemoConnectors(seed: DemoConnectorSeed = {}): DemoConnectorSet {
  const store = new InMemoryDemoConnectorStore(seed);
  return {
    store,
    email: new DemoEmailConnector(store),
    documents: new DemoDocumentConnector(store),
    calendar: new DemoCalendarConnector(store),
  };
}

/** Example deterministic key builders for callers and fixtures. */
export function demoReadThreadKey(threadId: string): string {
  return stableOperationKey({ connector: "email", operation: "read-thread", identity: { threadId } });
}

export function demoSendEmailKey(messageIdentity: string): string {
  return stableOperationKey({ connector: "email", operation: "send", identity: { messageIdentity } });
}

export function demoRetrieveDocumentKey(documentId: string): string {
  return stableOperationKey({ connector: "document", operation: "retrieve", identity: { documentId } });
}

export function demoCheckAvailabilityKey(startAt: string, endAt: string): string {
  return stableOperationKey({ connector: "calendar", operation: "availability", identity: { endAt, startAt } });
}

export function demoCreateHoldKey(bookingId: string, startAt: string, endAt: string): string {
  return stableOperationKey({ connector: "calendar", operation: "create-provisional-hold", identity: { bookingId, endAt, startAt } });
}
