import type {
  ConnectorResult,
  SourceReference,
} from "../contracts.ts";
import {
  asString,
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
 * Bounded incremental Gmail inbox polling with a durable opaque cursor.
 *
 * Verified against the primary docs (`users.history.list` reference):
 * history records arrive chronologically, `historyId` values are monotonic
 * but non-contiguous, an invalid or expired `startHistoryId` returns HTTP
 * 404 (history is valid for at least a week, sometimes only hours), and on
 * 404 the client must perform a full sync. There is no 410 contract here —
 * expiry surfaces as 404 and is verified by test, not assumed.
 *
 * Cursor contract (durable, consumer-owned):
 * - Cursors are opaque (`ghi.` + base64url JSON). Consumers persist the
 *   `nextCursor` ONLY after durably ingesting the returned changes
 *   (acknowledgement); this adapter keeps no second store.
 * - `nextCursor` always comes from the provider's latest `historyId`, so
 *   cursors advance monotonically even when pages repeat or duplicate.
 * - `resetRequired: true` means the cursor is dead: run a cursor-less full
 *   sync and adopt its fresh cursor. No change is reported alongside it.
 * - `truncated: true` means provider bounds cut the result short; the
 *   cursor still advances past what was returned, so a truncated poll must
 *   be followed by another poll, never treated as a complete view.
 */

export interface InboxChange {
  messageId: string;
  threadId?: string;
  historyId?: string;
}

export interface InboxDelta {
  /** True when the cursor expired: full-sync, then adopt the fresh cursor. */
  resetRequired: boolean;
  changes: InboxChange[];
  /** Present unless resetRequired; commit only after durable ingestion ack. */
  nextCursor?: string;
  truncated: boolean;
  provenance: SourceReference[];
}

export interface PollInboxOptions {
  /** Opaque cursor from a previous poll. Absent = bounded full sync. */
  cursor?: string;
  /**
   * Optional Gmail search query narrowing both paths. Passed through as
   * search syntax (operators allowed); fragments built from untrusted input
   * must first pass through `escapeGmailQuery` (see gmail.ts) — never
   * interpolate raw inquiry text into `q`.
   */
  query?: string;
  /** Maximum history/list pages per poll (default 5). */
  maxPages?: number;
  /** Maximum change entries returned per poll (default 50). */
  maxMessages?: number;
}

const CURSOR_PREFIX = "ghi.";
const DEFAULT_MAX_PAGES = 5;
const DEFAULT_MAX_MESSAGES = 50;

export function encodeCursor(historyId: string): string {
  return `${CURSOR_PREFIX}${Buffer.from(JSON.stringify({ v: 1, historyId }), "utf-8").toString("base64url")}`;
}

function decodeCursor(cursor: string): string | undefined {
  if (!cursor.startsWith(CURSOR_PREFIX)) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor.slice(CURSOR_PREFIX.length), "base64url").toString("utf-8"));
    if (!isRecord(parsed) || parsed.v !== 1) return undefined;
    const historyId = asString(parsed.historyId);
    return historyId !== undefined && historyId.length > 0 ? historyId : undefined;
  } catch {
    return undefined;
  }
}

function tokenFailure(operationKey: string): ConnectorResult<never> {
  return {
    status: "failed",
    metadata: liveMetadata(operationKey, []),
    error: { kind: "access_revoked", message: "No approved Google access token is available (live gate BLOCKED until onboarding provides account assets)", retryable: false },
  };
}

interface HistoryPage {
  historyId?: string;
  nextPageToken?: string;
  added: InboxChange[];
}

function parseHistoryPage(body: unknown): HistoryPage | undefined {
  if (!isRecord(body)) return undefined;
  const page: HistoryPage = { added: [] };
  const historyId = asString(body.historyId);
  if (historyId !== undefined) page.historyId = historyId;
  const token = asString(body.nextPageToken);
  if (token !== undefined) page.nextPageToken = token;
  const history = body.history;
  if (history !== undefined) {
    if (!Array.isArray(history)) return undefined;
    for (const record of history) {
      if (!isRecord(record)) return undefined;
      const recordId = asString(record.id);
      const buckets = [record.messagesAdded, record.messages];
      for (const bucket of buckets) {
        if (bucket === undefined) continue;
        if (!Array.isArray(bucket)) return undefined;
        for (const item of bucket) {
          if (!isRecord(item)) return undefined;
          const message = isRecord(item.message) ? item.message : item;
          if (!isRecord(message)) return undefined;
          const id = asString(message.id);
          if (id === undefined) return undefined;
          const threadId = asString(message.threadId);
          const historyIdValue = asString(message.historyId) ?? recordId;
          page.added.push(
            threadId === undefined ? { messageId: id } : { messageId: id, threadId },
          );
          const last = page.added[page.added.length - 1];
          if (last !== undefined && historyIdValue !== undefined) last.historyId = historyIdValue;
        }
      }
    }
  }
  return page;
}

function parseIdList(body: unknown): { ids: Array<{ id: string; threadId?: string }>; nextPageToken?: string; historyId?: string } | undefined {
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
  const out: { ids: Array<{ id: string; threadId?: string }>; nextPageToken?: string; historyId?: string } = { ids };
  const token = asString(body.nextPageToken);
  const historyId = asString(body.historyId);
  if (token !== undefined) out.nextPageToken = token;
  if (historyId !== undefined) out.historyId = historyId;
  return out;
}

export class GmailInboxPoller {
  private readonly options: GoogleAdapterOptions;

  constructor(options: GoogleAdapterOptions) {
    this.options = options;
  }

  private userId(): string {
    return this.options.userId ?? "me";
  }

  private provenance(): SourceReference[] {
    return [{ kind: "email", locator: `gmail://mailbox/${this.userId()}/history`, label: "LIVE Gmail", fictional: false }];
  }

  async pollInbox(operationKey: string, options: PollInboxOptions = {}): Promise<ConnectorResult<InboxDelta>> {
    if (operationKey.trim().length === 0) {
      return { status: "failed", metadata: liveMetadata(operationKey, []), error: invalidRequest("operationKey is required") };
    }
    const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
    const maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES;
    if (!Number.isInteger(maxPages) || maxPages < 1 || !Number.isInteger(maxMessages) || maxMessages < 1) {
      return { status: "failed", metadata: liveMetadata(operationKey, []), error: invalidRequest("maxPages and maxMessages must be positive integers") };
    }
    if (options.cursor === undefined) {
      return this.fullSync(operationKey, options.query, maxPages, maxMessages);
    }
    const startHistoryId = decodeCursor(options.cursor);
    if (startHistoryId === undefined) {
      return { status: "failed", metadata: liveMetadata(operationKey, []), error: invalidRequest("Cursor is not a recognized inbox cursor; reset with a cursor-less full sync") };
    }
    return this.deltaSync(operationKey, startHistoryId, options.query, maxPages, maxMessages);
  }

  private async deltaSync(
    operationKey: string,
    startHistoryId: string,
    query: string | undefined,
    maxPages: number,
    maxMessages: number,
  ): Promise<ConnectorResult<InboxDelta>> {
    const provenance = this.provenance();
    const seen = new Set<string>();
    const changes: InboxChange[] = [];
    let truncated = false;
    let latestHistoryId: string | undefined;
    let pageToken: string | undefined;
    try {
      for (let page = 0; page < maxPages; page += 1) {
        const url = withQuery(`${GMAIL_BASE_URL}/users/${encodeURIComponent(this.userId())}/history`, {
          startHistoryId,
          historyTypes: "messageAdded",
          ...(query === undefined ? {} : { q: query }),
          maxResults: "500",
          pageToken,
        });
        const response = await authorized(this.options, { method: "GET", url });
        if (response.status === 404) {
          // Documented expiry signal: the cursor is dead; full-sync instead.
          return { status: "succeeded", metadata: liveMetadata(operationKey, provenance), data: { resetRequired: true, changes: [], truncated: false, provenance } };
        }
        if (response.status !== 200) {
          const error = mapGoogleHttpError(response.status, safeParseJson(response.text), "pollInbox");
          return { status: "failed", metadata: liveMetadata(operationKey, []), error };
        }
        const parsed = parseHistoryPage(safeParseJson(response.text));
        if (parsed === undefined) {
          return { status: "failed", metadata: liveMetadata(operationKey, []), error: transportError("Gmail history.list returned an unrecognized JSON shape") };
        }
        if (parsed.historyId !== undefined) latestHistoryId = parsed.historyId;
        for (const change of parsed.added) {
          if (seen.has(change.messageId)) continue;
          seen.add(change.messageId);
          if (changes.length >= maxMessages) {
            truncated = true;
            break;
          }
          changes.push(change);
        }
        pageToken = parsed.nextPageToken;
        if (pageToken === undefined || truncated) break;
      }
      if (pageToken !== undefined) truncated = true;
    } catch (error) {
      if (error instanceof TokenUnavailableError) return tokenFailure(operationKey);
      if (error instanceof TransportTimeoutError || error instanceof TransportNetworkError) {
        return { status: "failed", metadata: liveMetadata(operationKey, []), error: transportError("Gmail history poll timed out; no cursor was advanced so retry is safe") };
      }
      throw error;
    }
    if (latestHistoryId === undefined) {
      return { status: "failed", metadata: liveMetadata(operationKey, []), error: transportError("Gmail history.list omitted the mailbox historyId; no cursor can be committed") };
    }
    return {
      status: "succeeded",
      metadata: liveMetadata(operationKey, provenance),
      data: { resetRequired: false, changes, nextCursor: encodeCursor(latestHistoryId), truncated, provenance },
    };
  }

  private async fullSync(
    operationKey: string,
    query: string | undefined,
    maxPages: number,
    maxMessages: number,
  ): Promise<ConnectorResult<InboxDelta>> {
    const provenance = this.provenance();
    const seen = new Set<string>();
    const changes: InboxChange[] = [];
    let truncated = false;
    let latestHistoryId: string | undefined;
    let pageToken: string | undefined;
    try {
      for (let page = 0; page < maxPages; page += 1) {
        const url = withQuery(`${GMAIL_BASE_URL}/users/${encodeURIComponent(this.userId())}/messages`, {
          ...(query === undefined ? {} : { q: query }),
          maxResults: "100",
          pageToken,
        });
        const response = await authorized(this.options, { method: "GET", url });
        if (response.status !== 200) {
          const error = mapGoogleHttpError(response.status, safeParseJson(response.text), "pollInbox");
          return { status: "failed", metadata: liveMetadata(operationKey, []), error };
        }
        const parsed = parseIdList(safeParseJson(response.text));
        if (parsed === undefined) {
          return { status: "failed", metadata: liveMetadata(operationKey, []), error: transportError("Gmail messages.list returned an unrecognized JSON shape") };
        }
        if (parsed.historyId !== undefined) latestHistoryId = parsed.historyId;
        for (const item of parsed.ids) {
          if (seen.has(item.id)) continue;
          seen.add(item.id);
          if (changes.length >= maxMessages) {
            truncated = true;
            break;
          }
          changes.push(item.threadId === undefined ? { messageId: item.id } : { messageId: item.id, threadId: item.threadId });
        }
        pageToken = parsed.nextPageToken;
        if (pageToken === undefined || truncated) break;
      }
      if (pageToken !== undefined) truncated = true;
    } catch (error) {
      if (error instanceof TokenUnavailableError) return tokenFailure(operationKey);
      if (error instanceof TransportTimeoutError || error instanceof TransportNetworkError) {
        return { status: "failed", metadata: liveMetadata(operationKey, []), error: transportError("Gmail full sync timed out; no cursor was advanced so retry is safe") };
      }
      throw error;
    }
    // messages.list carries no cursor: bootstrap it from the mailbox
    // profile's historyId (documented on users.getProfile). If that fails,
    // report the changes with no cursor and truncated set — the consumer
    // must re-poll rather than commit progress it cannot name.
    if (latestHistoryId === undefined) {
      try {
        const profile = await authorized(this.options, {
          method: "GET",
          url: `${GMAIL_BASE_URL}/users/${encodeURIComponent(this.userId())}/profile`,
        });
        if (profile.status === 200) {
          const parsed = safeParseJson(profile.text);
          if (isRecord(parsed)) {
            const historyId = asString(parsed.historyId);
            if (historyId !== undefined) latestHistoryId = historyId;
          }
        }
      } catch {
        latestHistoryId = undefined;
      }
    }
    if (latestHistoryId === undefined) {
      return {
        status: "succeeded",
        metadata: liveMetadata(operationKey, provenance),
        data: { resetRequired: false, changes, truncated: true, provenance },
      };
    }
    return {
      status: "succeeded",
      metadata: liveMetadata(operationKey, provenance),
      data: { resetRequired: false, changes, nextCursor: encodeCursor(latestHistoryId), truncated, provenance },
    };
  }
}
