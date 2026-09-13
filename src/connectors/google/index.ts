/**
 * Live Google adapters (Calendar + Gmail). Contract-level only: every call
 * goes through the injected {@link GoogleHttpTransport} against scripted
 * responses in tests. The live gate is BLOCKED — no approved account assets
 * exist, these adapters are never registered as connected by default, and no
 * live account verification has been performed.
 */
import { GoogleCalendarConnector, type GoogleCalendarOptions, type HoldScopeResolver } from "./calendar.ts";
import { GoogleGmailConnector, type GoogleGmailOptions, type SentExpectationResolver } from "./gmail.ts";
import { GoogleDocumentRetriever, type GoogleDocumentsOptions } from "./documents.ts";
import { GmailInboxPoller } from "./incremental.ts";
import type { GoogleAdapterOptions } from "./transport.ts";

export * from "./transport.ts";
export * from "./errors.ts";
export { GoogleCalendarConnector, googleEventIdFor, type GoogleCalendarOptions, type HoldScope, type HoldScopeResolver } from "./calendar.ts";
export { GoogleGmailConnector, gmailMessageIdFor, escapeGmailQuery, type GoogleGmailOptions, type SentExpectation, type SentExpectationResolver } from "./gmail.ts";
export { GoogleDocumentRetriever, DEFAULT_DOCUMENT_BYTE_CAP, type GoogleDocumentsOptions } from "./documents.ts";
export { GmailInboxPoller, encodeCursor, resolveHistoryLabelScope, resolvePollScope, type GmailInboxPollerOptions, type InboxChange, type InboxDelta, type PollScope, type PollInboxOptions } from "./incremental.ts";
export { GoogleCalendarHoldReleaseConnector, type GoogleHoldReleaseOptions } from "./hold-release.ts";

export interface GoogleConnectorSet {
  calendar: GoogleCalendarConnector;
  gmail: GoogleGmailConnector;
  documents: GoogleDocumentRetriever;
  inbox: GmailInboxPoller;
}

export interface GoogleConnectorFactoryOptions extends GoogleAdapterOptions {
  /**
   * Explicit calendar binding for holds and hold reconciliation. When set,
   * availability/holds/reconcile are scoped to this calendar without any
   * additional lookup.
   */
  calendarId?: string;
  /**
   * Durable operationKey → scope resolver (backed by caller-owned durable
   * storage) used for hold reconciliation when no explicit binding exists.
   */
  resolveHoldScope?: HoldScopeResolver;
  /**
   * Durable operationKey → approved-send resolver used for full send
   * reconcile identity (recipients, subject, body, thread).
   */
  resolveSentExpectation?: SentExpectationResolver;
  /**
   * Stable account scope identity for inbox cursors. Must identify the
   * actual configured account — defaults to `userId ?? "me"` only for
   * single-account use; deployments serving several accounts through the
   * `"me"` alias must pass distinct values or cursors will not separate.
   */
  accountId?: string;
}

/**
 * Compose the live adapters. Tokens, transport, and (for calendar writes)
 * scope resolution are all injected — this factory reads no credentials,
 * performs no I/O, and registers nothing as connected.
 */
export function createGoogleConnectors(options: GoogleConnectorFactoryOptions): GoogleConnectorSet {
  const calendarOptions: GoogleCalendarOptions = {
    transport: options.transport,
    tokens: options.tokens,
    ...(options.userId === undefined ? {} : { userId: options.userId }),
    ...(options.calendarId === undefined ? {} : { calendarId: options.calendarId }),
    ...(options.resolveHoldScope === undefined ? {} : { resolveHoldScope: options.resolveHoldScope }),
  };
  const gmailOptions: GoogleGmailOptions = {
    transport: options.transport,
    tokens: options.tokens,
    ...(options.userId === undefined ? {} : { userId: options.userId }),
    ...(options.resolveSentExpectation === undefined ? {} : { resolveSentExpectation: options.resolveSentExpectation }),
  };
  const shared = {
    transport: options.transport,
    tokens: options.tokens,
    ...(options.userId === undefined ? {} : { userId: options.userId }),
  };
  return {
    calendar: new GoogleCalendarConnector(calendarOptions),
    gmail: new GoogleGmailConnector(gmailOptions),
    documents: new GoogleDocumentRetriever(shared),
    inbox: new GmailInboxPoller({ ...shared, accountId: options.accountId ?? options.userId ?? "me" }),
  };
}
