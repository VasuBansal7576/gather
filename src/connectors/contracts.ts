import { createHash } from "node:crypto";

/**
 * The connector package deliberately exposes only the provider-neutral shape
 * needed by Gather. Provider SDK and transport types must stay behind a real
 * adapter boundary.
 */
export type ConnectorKind = "email" | "document" | "calendar";

export type ConnectorMode = "demo" | "live";

export type ConnectorModeLabel =
  | {
      mode: "demo";
      label: "DEMO ONLY";
      fictional: true;
    }
  | {
      mode: "live";
      label: "LIVE";
      fictional: false;
    };

export const DEMO_MODE: ConnectorModeLabel = {
  mode: "demo",
  label: "DEMO ONLY",
  fictional: true,
};

export type SourceKind =
  | "connected_account"
  | "document"
  | "email"
  | "calendar"
  | "manual"
  | "fixture";

/** Structurally compatible with the foundation SourceReference contract. */
export interface SourceReference {
  kind: SourceKind;
  locator: string;
  label?: string;
  fictional?: boolean;
}

export interface DemoSourceReference extends SourceReference {
  kind: "fixture";
  fictional: true;
}

export interface ConnectorMetadata {
  operationKey: string;
  mode: ConnectorModeLabel;
  simulated: true;
  sourceReferences: SourceReference[];
}

export type ConnectorErrorKind =
  | "invalid_request"
  | "not_found"
  | "slot_unavailable"
  | "conflict"
  | "timeout_after_success"
  | "authorization_denied"
  | "access_revoked"
  | "rate_limited"
  | "transport_error"
  | "unsupported";

export interface ConnectorError {
  kind: ConnectorErrorKind;
  message: string;
  retryable: boolean;
}

export interface ConnectorSuccess<T> {
  status: "succeeded";
  metadata: ConnectorMetadata;
  data: T;
}

export interface ConnectorFailure {
  status: "failed";
  metadata: ConnectorMetadata;
  error: ConnectorError;
}

/**
 * A timeout-after-success is intentionally not represented as failure. The
 * remote side may have completed the operation, so callers must reconcile
 * this result before retrying.
 */
export interface ConnectorUncertain {
  status: "uncertain";
  metadata: ConnectorMetadata;
  error: ConnectorError & { kind: "timeout_after_success" };
  reconciliationRequired: true;
}

export type ConnectorResult<T> =
  | ConnectorSuccess<T>
  | ConnectorFailure
  | ConnectorUncertain;

export interface OperationRequest {
  /** Stable across retries and process restarts for the same logical action. */
  operationKey: string;
}

export interface InquiryMessage {
  id: string;
  threadId: string;
  from: string;
  to: string[];
  subject: string;
  body: string;
  receivedAt: string;
  sourceReferences: SourceReference[];
}

export interface InquiryThread {
  threadId: string;
  subject: string;
  messages: InquiryMessage[];
  sourceReferences: SourceReference[];
}

export interface ReadInquiryThreadRequest extends OperationRequest {
  threadId: string;
}

export interface ReadInquiryThreadResponse {
  thread: InquiryThread;
  provenance: SourceReference[];
}

export interface InquiryThreadReader {
  readInquiryThread(
    request: ReadInquiryThreadRequest,
  ): Promise<ConnectorResult<ReadInquiryThreadResponse>>;
}

export interface SendEmailRequest extends OperationRequest {
  threadId?: string;
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  sourceReferences?: SourceReference[];
}

export interface SentEmail {
  messageId: string;
  operationKey: string;
  threadId?: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  sentAt: string;
  sourceReferences: SourceReference[];
}

export interface SendEmailResponse {
  sentEmail: SentEmail;
  provenance: SourceReference[];
}

export interface EmailSender {
  sendEmail(
    request: SendEmailRequest,
  ): Promise<ConnectorResult<SendEmailResponse>>;
  reconcileSentEmail(
    request: OperationRequest,
  ): Promise<ConnectorResult<SendEmailResponse>>;
}

export interface DocumentRecord {
  documentId: string;
  title: string;
  mimeType: string;
  text: string;
  sourceReferences: SourceReference[];
}

export interface RetrieveDocumentRequest extends OperationRequest {
  documentId: string;
}

export interface RetrieveDocumentResponse {
  document: DocumentRecord;
  /** Provenance is repeated at the response boundary for downstream evidence. */
  provenance: SourceReference[];
}

export interface DocumentRetriever {
  retrieveDocument(
    request: RetrieveDocumentRequest,
  ): Promise<ConnectorResult<RetrieveDocumentResponse>>;
}

export interface CalendarSlot {
  slotId: string;
  /** Owning calendar. Slots without one match no scoped availability query. */
  calendarId?: string;
  startAt: string;
  endAt: string;
  available: boolean;
  reason?: string;
  sourceReferences: SourceReference[];
}

export interface CheckAvailabilityRequest extends OperationRequest {
  /** Required scope: availability is always evaluated for one calendar. */
  calendarId: string;
  startAt: string;
  endAt: string;
}

export interface CheckAvailabilityResponse {
  slots: CalendarSlot[];
  provenance: SourceReference[];
}

export interface CalendarAvailabilityReader {
  checkAvailability(
    request: CheckAvailabilityRequest,
  ): Promise<ConnectorResult<CheckAvailabilityResponse>>;
}

export interface CreateProvisionalHoldRequest extends OperationRequest {
  bookingId: string;
  calendarId: string;
  startAt: string;
  endAt: string;
  expiresAt: string;
  sourceReferences?: SourceReference[];
}

export interface ProvisionalHold {
  holdId: string;
  operationKey: string;
  bookingId: string;
  calendarId: string;
  startAt: string;
  endAt: string;
  expiresAt: string;
  status: "provisional_hold";
  createdAt: string;
  sourceReferences: SourceReference[];
}

export interface CreateProvisionalHoldResponse {
  hold: ProvisionalHold;
  provenance: SourceReference[];
}

export interface ProvisionalHoldWriter {
  createProvisionalHold(
    request: CreateProvisionalHoldRequest,
  ): Promise<ConnectorResult<CreateProvisionalHoldResponse>>;
  reconcileProvisionalHold(
    request: OperationRequest,
  ): Promise<ConnectorResult<CreateProvisionalHoldResponse>>;
}

export type CalendarConnector =
  CalendarAvailabilityReader & ProvisionalHoldWriter;

/**
 * Create a deterministic operation key from semantic identity, independent
 * of object insertion order. Callers should persist this value with the
 * proposed action and reuse it for retries and reconciliation.
 */
export function availabilityOperationKey(input: { calendarId: string; startAt: string; endAt: string }): string {
  return stableOperationKey({
    connector: "calendar",
    operation: "availability",
    identity: { calendarId: input.calendarId, endAt: input.endAt, startAt: input.startAt },
  });
}

export function stableOperationKey(input: {
  connector: ConnectorKind;
  operation: string;
  identity: Record<string, string | number>;
}): string {
  const canonicalIdentity = Object.fromEntries(
    Object.entries(input.identity)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => [key, value]),
  );

  const material = JSON.stringify({
    connector: input.connector,
    operation: input.operation,
    identity: canonicalIdentity,
  });
  const digest = createHash("sha256").update(material).digest("hex").slice(0, 16);

  return `gather:${input.connector}:${input.operation}:${digest}`;
}
