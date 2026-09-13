import { createHash } from "node:crypto";
import type {
  ConnectorResult,
  EmailSender,
  InquiryMessage,
  InquiryThread,
  InquiryThreadReader,
  ReadInquiryThreadRequest,
  ReadInquiryThreadResponse,
  SendEmailRequest,
  SendEmailResponse,
  SentEmail,
  SourceReference,
} from "../contracts.ts";
import {
  asString,
  asStringArray,
  invalidRequest,
  isRecord,
  mapGoogleHttpError,
  safeParseJson,
  transportError,
} from "./errors.ts";
import {
  GMAIL_BASE_URL,
  TokenUnavailableError,
  TransportNetworkError,
  TransportTimeoutError,
  liveMetadata,
  withQuery,
  type GoogleAdapterOptions,
  type GoogleHttpResponse,
  authorized,
} from "./transport.ts";

/**
 * Correlate our send with the provider record. Gmail offers no idempotency
 * key and no exactly-once send guarantee, so this adapter never claims
 * either: every send carries a deterministic RFC 2822 Message-ID derived
 * from the stable operation key, and reconciliation searches the mailbox
 * for that Message-ID as sent-folder evidence. Absence in search results is
 * reported as not_found (retryable: Gmail indexing delays mean a missing
 * record proves nothing), never as proof of non-delivery.
 */
export function gmailMessageIdFor(operationKey: string): string {
  return `<${createHash("sha256").update(operationKey).digest("hex")}@gather-booking.local>`;
}

function base64UrlEncodeText(text: string): string {
  return Buffer.from(text, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecodeText(data: string): string | undefined {
  try {
    const padded = data.replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(padded, "base64").toString("utf-8");
  } catch {
    return undefined;
  }
}

/** Reject CR/LF header injection at the boundary. */
function cleanHeader(value: string, field: string): string {
  if (/[\r\n]/.test(value)) {
    throw new Error(`${field} must not contain CR or LF characters`);
  }
  return value;
}

function cleanAddress(value: string, field: string): string {
  cleanHeader(value, field);
  if (!/^[\x21-\x7E]+$/.test(value) || !value.includes("@")) {
    throw new Error(`${field} must be a plain ASCII email address`);
  }
  return value;
}

/** RFC 2047 encoded-word for non-ASCII subjects; ASCII passes through. */
function encodeSubject(subject: string): string {
  cleanHeader(subject, "subject");
  if (/^[\x20-\x7E]*$/.test(subject)) return subject;
  return `=?UTF-8?B?${Buffer.from(subject, "utf-8").toString("base64")}?=`;
}

function buildRfc2822(request: SendEmailRequest, messageId: string): string {
  const to = request.to.map((item) => cleanAddress(item, "to"));
  if (to.length === 0) throw new Error("At least one recipient is required");
  const cc = (request.cc ?? []).map((item) => cleanAddress(item, "cc"));
  // The body follows the blank header/body separator, so newlines are
  // legitimate content and must be preserved; injection validation applies
  // to headers and addresses only.
  const lines = [
    `To: ${to.join(", ")}`,
    ...(cc.length > 0 ? [`Cc: ${cc.join(", ")}`] : []),
    `Subject: ${encodeSubject(request.subject)}`,
    `Message-ID: ${messageId}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    request.body,
  ];
  return lines.join("\r\n");
}

/** Escape a search term for Gmail's `q` syntax (quoted phrase, injection-safe). */
export function escapeGmailQuery(term: string): string {
  return `"${term.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

interface GmailHeader {
  name: string;
  value: string;
}

interface GmailPayload {
  headers: GmailHeader[];
  textBody?: string;
}

function parseHeaders(value: unknown): GmailHeader[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const headers: GmailHeader[] = [];
  for (const item of value) {
    if (!isRecord(item)) return undefined;
    const name = asString(item.name);
    const headerValue = asString(item.value);
    if (name === undefined || headerValue === undefined) return undefined;
    headers.push({ name, value: headerValue });
  }
  return headers;
}

function findHeader(headers: GmailHeader[], name: string): string | undefined {
  const found = headers.find((header) => header.name.toLowerCase() === name.toLowerCase());
  return found?.value;
}

function extractTextBody(part: unknown): string | undefined {
  if (!isRecord(part)) return undefined;
  const mimeType = asString(part.mimeType);
  const body = isRecord(part.body) ? asString(part.body.data) : undefined;
  if ((mimeType === "text/plain" || mimeType?.startsWith("text/")) && body !== undefined) {
    return base64UrlDecodeText(body);
  }
  const parts = part.parts;
  if (Array.isArray(parts)) {
    for (const child of parts) {
      const text = extractTextBody(child);
      if (text !== undefined) return text;
    }
  }
  return undefined;
}

function parsePayload(value: unknown): GmailPayload | undefined {
  if (!isRecord(value)) return undefined;
  const headers = parseHeaders(value.headers);
  if (headers === undefined) return undefined;
  const text = extractTextBody(value);
  return text === undefined ? { headers } : { headers, textBody: text };
}

interface ParsedGmailMessage {
  id: string;
  threadId?: string;
  labelIds: string[];
  internalDate?: string;
  snippet?: string;
  headers: GmailHeader[];
  textBody?: string;
}

function parseGmailMessage(value: unknown): ParsedGmailMessage | undefined {
  if (!isRecord(value)) return undefined;
  const id = asString(value.id);
  if (id === undefined) return undefined;
  const message: ParsedGmailMessage = { id, labelIds: [], headers: [] };
  const threadId = asString(value.threadId);
  const internalDate = asString(value.internalDate);
  const snippet = asString(value.snippet);
  if (threadId !== undefined) message.threadId = threadId;
  if (internalDate !== undefined) message.internalDate = internalDate;
  if (snippet !== undefined) message.snippet = snippet;
  const labelIds = asStringArray(value.labelIds);
  if (labelIds !== undefined) message.labelIds = labelIds;
  if (value.payload !== undefined) {
    const payload = parsePayload(value.payload);
    if (payload === undefined) return undefined;
    message.headers = payload.headers;
    if (payload.textBody !== undefined) message.textBody = payload.textBody;
  }
  return message;
}

function parseMessageList(body: unknown): { ids: Array<{ id: string; threadId?: string }>; nextPageToken?: string } | undefined {
  if (!isRecord(body)) return undefined;
  const messages = body.messages;
  if (messages !== undefined && !Array.isArray(messages)) return undefined;
  const ids: Array<{ id: string; threadId?: string }> = [];
  for (const item of messages ?? []) {
    if (!isRecord(item)) return undefined;
    const id = asString(item.id);
    if (id === undefined) return undefined;
    const threadId = asString(item.threadId);
    ids.push(threadId === undefined ? { id } : { id, threadId });
  }
  const token = asString(body.nextPageToken);
  return token === undefined ? { ids } : { ids, nextPageToken: token };
}

function splitAddresses(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
}

/**
 * Durable approved-send expectation, owned by the caller (e.g. the booking
 * service's SQLite receipts). Reconciliation verifies the provider record
 * against this payload — Message-ID discoverability alone is not identity.
 */
export interface SentExpectation {
  to: string[];
  cc?: string[];
  subject: string;
  body?: string;
  threadId?: string;
}

export type SentExpectationResolver = (operationKey: string) => Promise<SentExpectation | undefined>;

export interface GoogleGmailOptions extends GoogleAdapterOptions {
  /** Durable operationKey → approved-send lookup required for full reconcile identity. */
  resolveSentExpectation?: SentExpectationResolver;
}

function tokenFailure(operationKey: string): ConnectorResult<never> {
  return {
    status: "failed",
    metadata: liveMetadata(operationKey, []),
    error: { kind: "access_revoked", message: "No approved Google access token is available (live gate BLOCKED until onboarding provides account assets)", retryable: false },
  };
}

export class GoogleGmailConnector implements InquiryThreadReader, EmailSender {
  private readonly options: GoogleGmailOptions;

  constructor(options: GoogleGmailOptions) {
    this.options = options;
  }

  private userId(): string {
    return this.options.userId ?? "me";
  }

  private gmailSource(threadId: string): SourceReference {
    return {
      kind: "email",
      locator: `gmail://thread/${threadId}`,
      label: "LIVE Gmail",
      fictional: false,
    };
  }

  async readInquiryThread(request: ReadInquiryThreadRequest): Promise<ConnectorResult<ReadInquiryThreadResponse>> {
    if (request.operationKey.trim().length === 0 || request.threadId.trim().length === 0) {
      return {
        status: "failed",
        metadata: liveMetadata(request.operationKey, []),
        error: invalidRequest("operationKey and threadId are required"),
      };
    }
    let response: GoogleHttpResponse;
    try {
      response = await authorized(this.options, {
        method: "GET",
        url: withQuery(`${GMAIL_BASE_URL}/users/${encodeURIComponent(this.userId())}/threads/${encodeURIComponent(request.threadId)}`, { format: "full" }),
      });
    } catch (error) {
      if (error instanceof TokenUnavailableError) return tokenFailure(request.operationKey);
      if (error instanceof TransportTimeoutError || error instanceof TransportNetworkError) {
        return { status: "failed", metadata: liveMetadata(request.operationKey, []), error: transportError("Gmail thread read timed out; no write was attempted so retry is safe") };
      }
      throw error;
    }
    if (response.status !== 200) {
      const error = mapGoogleHttpError(response.status, safeParseJson(response.text), "readInquiryThread");
      return { status: "failed", metadata: liveMetadata(request.operationKey, []), error };
    }
    const body = safeParseJson(response.text);
    if (!isRecord(body)) {
      return { status: "failed", metadata: liveMetadata(request.operationKey, []), error: transportError("Gmail threads.get returned an unrecognized JSON shape") };
    }
    const threadId = asString(body.id) ?? request.threadId;
    const rawMessages = body.messages;
    if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
      return { status: "failed", metadata: liveMetadata(request.operationKey, []), error: { kind: "not_found", message: "Gmail thread has no messages", retryable: false } };
    }
    const messages: InquiryMessage[] = [];
    for (const raw of rawMessages) {
      const parsed = parseGmailMessage(raw);
      if (parsed === undefined) {
        return { status: "failed", metadata: liveMetadata(request.operationKey, []), error: transportError("Gmail thread message had an unrecognized shape") };
      }
      const subject = findHeader(parsed.headers, "Subject") ?? "(no subject)";
      const from = findHeader(parsed.headers, "From") ?? "(unknown sender)";
      const date = findHeader(parsed.headers, "Date");
      const receivedMs = date !== undefined ? Date.parse(date) : Number.NaN;
      messages.push({
        id: parsed.id,
        threadId,
        from,
        to: splitAddresses(findHeader(parsed.headers, "To")),
        subject,
        body: parsed.textBody ?? parsed.snippet ?? "",
        receivedAt: Number.isFinite(receivedMs) && date !== undefined ? new Date(receivedMs).toISOString() : date ?? "",
        sourceReferences: [this.gmailSource(threadId)],
      });
    }
    const provenance = [this.gmailSource(threadId)];
    const firstSubject = messages[0]?.subject ?? "(no subject)";
    return {
      status: "succeeded",
      metadata: liveMetadata(request.operationKey, provenance),
      data: { thread: { threadId, subject: firstSubject, messages, sourceReferences: provenance }, provenance },
    };
  }

  async sendEmail(request: SendEmailRequest): Promise<ConnectorResult<SendEmailResponse>> {
    if (request.operationKey.trim().length === 0 || request.to.length === 0 || request.subject.trim().length === 0) {
      return {
        status: "failed",
        metadata: liveMetadata(request.operationKey, []),
        error: invalidRequest("operationKey, at least one recipient, and a subject are required"),
      };
    }
    const messageId = gmailMessageIdFor(request.operationKey);
    let raw: string;
    try {
      raw = base64UrlEncodeText(buildRfc2822(request, messageId));
    } catch (error) {
      return {
        status: "failed",
        metadata: liveMetadata(request.operationKey, []),
        error: invalidRequest(error instanceof Error ? error.message : "Email content failed boundary validation"),
      };
    }
    let response: GoogleHttpResponse;
    try {
      response = await authorized(this.options, {
        method: "POST",
        url: `${GMAIL_BASE_URL}/users/${encodeURIComponent(this.userId())}/messages/send`,
        body: JSON.stringify({ raw, ...(request.threadId === undefined ? {} : { threadId: request.threadId }) }),
      });
    } catch (error) {
      if (error instanceof TokenUnavailableError) return tokenFailure(request.operationKey);
      // Gmail documents no idempotent send: any dispatch-time ambiguity
      // must reconcile by Message-ID, never blind-retry.
      if (error instanceof TransportTimeoutError || error instanceof TransportNetworkError) {
        return this.uncertainSend(request.operationKey, "Gmail send response was lost after dispatch");
      }
      throw error;
    }
    if (response.status === 200) {
      const sent = parseGmailMessage(safeParseJson(response.text));
      if (sent === undefined) {
        // HTTP 200 after a send may follow server-side acceptance: a
        // malformed success body is ambiguous, so report uncertain (reconcile
        // by Message-ID) rather than a retryable failure that could duplicate
        // the send on blind retry.
        return this.uncertainSend(request.operationKey, "Gmail send returned HTTP 200 with an unrecognized body");
      }
      return this.sentEmail(request, messageId, sent);
    }
    if (response.status >= 500 || response.status === 408 || response.status === 425) {
      // The server may have accepted the send: reconcile, do not blind-retry.
      return this.uncertainSend(request.operationKey, `Gmail send returned HTTP ${response.status}, which may follow server-side acceptance`);
    }
    const error = mapGoogleHttpError(response.status, safeParseJson(response.text), "sendEmail");
    return { status: "failed", metadata: liveMetadata(request.operationKey, []), error };
  }

  async reconcileSentEmail(request: { operationKey: string }): Promise<ConnectorResult<SendEmailResponse>> {
    // Full reconcile identity requires the durable approved payload: the
    // record must carry the SENT label and match expected recipients,
    // subject, thread, and (when recorded) body — not merely a discoverable
    // Message-ID.
    const expected = this.options.resolveSentExpectation !== undefined
      ? await this.options.resolveSentExpectation(request.operationKey)
      : undefined;
    if (this.options.resolveSentExpectation !== undefined && expected === undefined) {
      return {
        status: "failed",
        metadata: liveMetadata(request.operationKey, []),
        error: { kind: "conflict", message: "Cannot verify the sent record: no durable approved payload exists for this operation key", retryable: false },
      };
    }
    const messageId = gmailMessageIdFor(request.operationKey);
    // Correlate by our Message-ID in sent mail. Gmail search indexing lags
    // behind acceptance, so an empty result proves nothing yet.
    const query = `rfc822msgid:${escapeGmailQuery(messageId)} in:sent`;
    let pageToken: string | undefined;
    try {
      for (let page = 0; page < 5; page += 1) {
        const listUrl = withQuery(`${GMAIL_BASE_URL}/users/${encodeURIComponent(this.userId())}/messages`, {
          q: query,
          maxResults: "100",
          pageToken,
        });
        const list = await authorized(this.options, { method: "GET", url: listUrl });
        if (list.status !== 200) {
          const error = mapGoogleHttpError(list.status, safeParseJson(list.text), "reconcileSentEmail");
          return { status: "failed", metadata: liveMetadata(request.operationKey, []), error };
        }
        const found = parseMessageList(safeParseJson(list.text));
        if (found === undefined) {
          return {
            status: "failed",
            metadata: liveMetadata(request.operationKey, []),
            error: transportError("Gmail messages.list returned an unrecognized JSON shape"),
          };
        }
        for (const candidate of found.ids) {
          const got = await authorized(this.options, {
            method: "GET",
            url: withQuery(`${GMAIL_BASE_URL}/users/${encodeURIComponent(this.userId())}/messages/${encodeURIComponent(candidate.id)}`, { format: "full" }),
          });
          if (got.status !== 200) continue;
          const parsed = parseGmailMessage(safeParseJson(got.text));
          if (parsed === undefined) continue;
          const headerId = findHeader(parsed.headers, "Message-ID");
          if (headerId !== messageId) continue;
          if (!parsed.labelIds.includes("SENT")) {
            return {
              status: "failed",
              metadata: liveMetadata(request.operationKey, []),
              error: { kind: "conflict", message: "The correlated record lacks the SENT label; it is not verifiable sent evidence", retryable: false },
            };
          }
          const verified = this.verifyExpectation(request.operationKey, expected, parsed);
          if (verified !== undefined) return verified;
          return this.sentEmail(
            {
              operationKey: request.operationKey,
              to: splitAddresses(findHeader(parsed.headers, "To")),
              cc: splitAddresses(findHeader(parsed.headers, "Cc")),
              subject: findHeader(parsed.headers, "Subject") ?? expected?.subject ?? "",
              body: parsed.textBody ?? expected?.body ?? "",
              threadId: parsed.threadId,
            },
            messageId,
            parsed,
          );
        }
        pageToken = found.nextPageToken;
        if (pageToken === undefined) break;
      }
    } catch (error) {
      if (error instanceof TokenUnavailableError) return tokenFailure(request.operationKey);
      if (error instanceof TransportTimeoutError || error instanceof TransportNetworkError) {
        return {
          status: "failed",
          metadata: liveMetadata(request.operationKey, []),
          error: transportError("Gmail reconcile search timed out; the sent record may appear on retry (indexing delay)"),
        };
      }
      throw error;
    }
    return {
      status: "failed",
      metadata: liveMetadata(request.operationKey, []),
      // Retryable: indexing delay, not proof of non-delivery.
      error: { kind: "not_found", message: "No sent message with this Message-ID was found yet; Gmail indexing lags acceptance", retryable: true },
    };
  }

  /**
   * Verify a Message-ID-correlated record against the durable approved
   * payload. Returns a conflict failure when anything disagrees, or
   * undefined when the record is fully verified (or no expectation exists,
   * in which case Message-ID + SENT is the documented minimum).
   */
  private verifyExpectation(
    operationKey: string,
    expected: SentExpectation | undefined,
    parsed: ParsedGmailMessage,
  ): ConnectorResult<SendEmailResponse> | undefined {
    if (expected === undefined) return undefined;
    const fail = (message: string): ConnectorResult<SendEmailResponse> => ({
      status: "failed",
      metadata: liveMetadata(operationKey, []),
      error: { kind: "conflict", message, retryable: false },
    });
    const sameSet = (left: string[], right: string[]): boolean => {
      const a = [...left].sort();
      const b = [...right].sort();
      return a.length === b.length && a.every((value, index) => value === b[index]);
    };
    if (!sameSet(splitAddresses(findHeader(parsed.headers, "To")), expected.to)) {
      return fail("The correlated record was sent to different recipients than approved");
    }
    if (expected.cc !== undefined && !sameSet(splitAddresses(findHeader(parsed.headers, "Cc")), expected.cc)) {
      return fail("The correlated record carries different Cc recipients than approved");
    }
    if (findHeader(parsed.headers, "Subject") !== expected.subject) {
      return fail("The correlated record carries a different subject than approved");
    }
    if (expected.threadId !== undefined && parsed.threadId !== expected.threadId) {
      return fail("The correlated record belongs to a different thread than approved");
    }
    if (expected.body !== undefined && (parsed.textBody ?? "") !== expected.body) {
      return fail("The correlated record carries a different body than approved");
    }
    return undefined;
  }

  private uncertainSend(operationKey: string, detail: string): ConnectorResult<never> {
    return {
      status: "uncertain",
      metadata: liveMetadata(operationKey, []),
      error: { kind: "timeout_after_success", message: `${detail}; reconcile by Message-ID before retrying`, retryable: false },
      reconciliationRequired: true,
    };
  }

  /**
   * Build the sent receipt. The Gmail immutable id proves the message was
   * accepted for sending — it proves sent, not delivery.
   */
  private sentEmail(
    request: { operationKey: string; to: string[]; cc?: string[]; threadId?: string; subject: string; body?: string },
    messageId: string,
    sent: ParsedGmailMessage,
  ): ConnectorResult<SendEmailResponse> {
    const sentAt = sent.internalDate !== undefined && /^\d+$/.test(sent.internalDate)
      ? new Date(Number(sent.internalDate)).toISOString()
      : new Date().toISOString();
    const provenance: SourceReference[] = [{
      kind: "email",
      locator: `gmail://message/${sent.id}`,
      label: "LIVE Gmail sent receipt (proves sent, not delivery)",
      fictional: false,
    }];
    const threadId = request.threadId ?? sent.threadId;
    const email: SentEmail = {
      messageId: sent.id,
      operationKey: request.operationKey,
      ...(threadId === undefined ? {} : { threadId }),
      to: request.to,
      cc: request.cc ?? [],
      subject: request.subject,
      body: request.body ?? `LIVE Gmail message ${sent.id} correlated by Message-ID ${messageId}`,
      sentAt,
      sourceReferences: provenance,
    };
    return { status: "succeeded", metadata: liveMetadata(request.operationKey, provenance), data: { sentEmail: email, provenance } };
  }
}
