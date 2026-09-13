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
 * Cursor contract (durable, consumer-owned, at-least-once):
 * - Cursors are opaque (`ghi.` + base64url JSON, version 2). They bind the
 *   stable account identity, the query filter, the base watermark, and —
 *   for an uncompleted page — its continuation token plus the ids already
 *   emitted from it. A cursor presented for another account or query, or a
 *   legacy v1 cursor, is rejected before any HTTP call.
 * - `nextCursor` NEVER advances the base watermark past unvisited pages or
 *   un-emitted messages: a capped result resumes the exact page (replayed
 *   server-side, de-duplicated by message id, so repeats are possible but
 *   silent loss is not). Only a fully consumed result set advances the base
 *   to the provider's latest `historyId`.
 * - `resetRequired: true` means the cursor is dead: run a cursor-less full
 *   sync and adopt its fresh cursor. No change is reported alongside it.
 * - `truncated: true` means provider bounds cut the result short; the
 *   returned cursor names the exact resume point, so a truncated poll must
 *   be followed by another poll, never treated as a complete view.
 * - Consumers persist `nextCursor` ONLY after durably ingesting the returned
 *   changes (acknowledgement) and de-duplicate replays by message id; this
 *   adapter keeps no second store.
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
const CURSOR_VERSION = 2;
const DEFAULT_MAX_PAGES = 5;
const DEFAULT_MAX_MESSAGES = 50;
/** Cap on remembered emitted ids per cursor: overflow repeats (safe), never loss. */
const MAX_CURSOR_SEEN = 2000;

export interface InboxCursorScope {
  /** Stable account identity the cursor is bound to (the poller's userId). */
  account?: string;
  /** Query filter the cursor was minted under (absent = unfiltered). */
  query?: string;
  /** Continuation token for the uncompleted page, if any. */
  pageToken?: string;
  /** Message ids already emitted from the uncompleted page. */
  seen?: string[];
}

export function encodeCursor(historyId: string, scope: InboxCursorScope = {}): string {
  const payload: Record<string, unknown> = { v: CURSOR_VERSION, base: historyId };
  if (scope.account !== undefined) payload.account = scope.account;
  if (scope.query !== undefined) payload.q = scope.query;
  if (scope.pageToken !== undefined) payload.pageToken = scope.pageToken;
  if (scope.seen !== undefined && scope.seen.length > 0) payload.seen = scope.seen.slice(-MAX_CURSOR_SEEN);
  return `${CURSOR_PREFIX}${Buffer.from(JSON.stringify(payload), "utf-8").toString("base64url")}`;
}

interface DecodedCursor {
  base: string;
  account?: string;
  query?: string;
  pageToken?: string;
  seen: string[];
}

function decodeCursor(cursor: string): DecodedCursor | undefined {
  if (!cursor.startsWith(CURSOR_PREFIX)) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor.slice(CURSOR_PREFIX.length), "base64url").toString("utf-8"));
    if (!isRecord(parsed) || parsed.v !== CURSOR_VERSION) return undefined;
    const base = asString(parsed.base);
    if (base === undefined || base.length === 0) return undefined;
    const out: DecodedCursor = { base, seen: [] };
    const account = asString(parsed.account);
    const query = asString(parsed.q);
    const pageToken = asString(parsed.pageToken);
    if (account !== undefined) {
      if (account.length === 0) return undefined;
      out.account = account;
    }
    if (query !== undefined) out.query = query;
    if (pageToken !== undefined) {
      if (pageToken.length === 0) return undefined;
      out.pageToken = pageToken;
    }
    if (parsed.seen !== undefined) {
      if (!Array.isArray(parsed.seen)) return undefined;
      for (const entry of parsed.seen) {
        if (typeof entry !== "string") return undefined;
        out.seen.push(entry);
      }
      out.seen = out.seen.slice(-MAX_CURSOR_SEEN);
    }
    return out;
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

/** Catch-up phase failure: surfaced as a failed poll, never partial progress. */
class CatchUpFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatchUpFailedError";
  }
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
    const decoded = decodeCursor(options.cursor);
    if (decoded === undefined) {
      return { status: "failed", metadata: liveMetadata(operationKey, []), error: invalidRequest("Cursor is not a recognized inbox cursor; reset with a cursor-less full sync") };
    }
    // Binding check before any HTTP: a cursor minted for another account or
    // query must never poll this mailbox.
    if (decoded.account !== this.userId() || (decoded.query ?? undefined) !== (options.query ?? undefined)) {
      return { status: "failed", metadata: liveMetadata(operationKey, []), error: invalidRequest("Cursor is bound to a different account or query; reset with a cursor-less full sync") };
    }
    return this.deltaSync(operationKey, decoded, options.query, maxPages, maxMessages);
  }

  /**
   * Drain one history page into the shared change set. Returns the page's
   * next token (undefined when the result set is exhausted here). Items
   * already emitted from this page in an earlier poll are skipped; items
   * beyond the message cap set truncated without being marked seen, so a
   * resume replays them instead of losing them.
   */
  private drainHistoryPage(
    parsed: HistoryPage,
    seen: Set<string>,
    changes: InboxChange[],
    maxMessages: number,
  ): { nextPageToken: string | undefined; truncated: boolean } {
    let truncated = false;
    for (const change of parsed.added) {
      if (seen.has(change.messageId)) continue;
      if (changes.length >= maxMessages) {
        truncated = true;
        continue;
      }
      seen.add(change.messageId);
      changes.push(change);
    }
    if (seen.size > MAX_CURSOR_SEEN * 2) {
      // Bound memory: drop the oldest remembered ids. Replays may repeat
      // (the consumer de-duplicates by id); nothing is ever skipped blind.
      const kept = [...seen].slice(-MAX_CURSOR_SEEN);
      seen.clear();
      for (const id of kept) seen.add(id);
    }
    return { nextPageToken: parsed.nextPageToken, truncated };
  }

  private continuationCursor(
    base: string,
    account: string,
    query: string | undefined,
    pageToken: string | undefined,
    seen: Set<string>,
  ): string {
    return encodeCursor(base, {
      account,
      ...(query === undefined ? {} : { query }),
      ...(pageToken === undefined ? {} : { pageToken }),
      seen: [...seen].slice(-MAX_CURSOR_SEEN),
    });
  }

  private async deltaSync(
    operationKey: string,
    cursor: DecodedCursor,
    query: string | undefined,
    maxPages: number,
    maxMessages: number,
  ): Promise<ConnectorResult<InboxDelta>> {
    const provenance = this.provenance();
    const seen = new Set<string>(cursor.seen);
    const changes: InboxChange[] = [];
    let truncated = false;
    let latestHistoryId: string | undefined;
    let pageToken = cursor.pageToken;
    let resumeToken = cursor.pageToken;
    try {
      for (let page = 0; page < maxPages; page += 1) {
        const url = withQuery(`${GMAIL_BASE_URL}/users/${encodeURIComponent(this.userId())}/history`, {
          startHistoryId: cursor.base,
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
        const drained = this.drainHistoryPage(parsed, seen, changes, maxMessages);
        if (drained.truncated) {
          // Resume the exact page that still holds un-emitted messages.
          truncated = true;
          resumeToken = pageToken;
          break;
        }
        pageToken = drained.nextPageToken;
        resumeToken = pageToken;
        if (pageToken === undefined) break;
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
    const advanced = !truncated;
    return {
      status: "succeeded",
      metadata: liveMetadata(operationKey, provenance),
      data: {
        resetRequired: false,
        changes,
        nextCursor: advanced
          ? encodeCursor(latestHistoryId, { account: this.userId(), ...(query === undefined ? {} : { query }) })
          : this.continuationCursor(cursor.base, this.userId(), query, resumeToken, seen),
        truncated,
        provenance,
      },
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
    let pagesLeft = maxPages;
    const account = this.userId();
    // Phase 0: pre-list watermark. Arrivals during the snapshot below are
    // caught by the catch-up delta instead of being skipped by a
    // post-list-only cursor.
    let watermark: string | undefined;
    try {
      const profile = await authorized(this.options, {
        method: "GET",
        url: `${GMAIL_BASE_URL}/users/${encodeURIComponent(this.userId())}/profile`,
      });
      if (profile.status === 200) {
        const parsed = safeParseJson(profile.text);
        if (isRecord(parsed)) {
          const historyId = asString(parsed.historyId);
          if (historyId !== undefined) watermark = historyId;
        }
      }
    } catch {
      watermark = undefined;
    }
    const finish = (cursor: string | undefined): ConnectorResult<InboxDelta> => ({
      status: "succeeded",
      metadata: liveMetadata(operationKey, provenance),
      data: { resetRequired: false, changes, nextCursor: cursor, truncated, provenance },
    });
    try {
      // Phase 1: bounded id snapshot.
      let pageToken: string | undefined;
      while (pagesLeft > 0) {
        pagesLeft -= 1;
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
          if (changes.length >= maxMessages) {
            truncated = true;
            continue;
          }
          seen.add(item.id);
          changes.push(item.threadId === undefined ? { messageId: item.id } : { messageId: item.id, threadId: item.threadId });
        }
        pageToken = parsed.nextPageToken;
        if (pageToken === undefined) break;
      }
      if (pageToken !== undefined) truncated = true;
      // Phase 2: catch-up delta from the pre-list watermark, merging with
      // the snapshot (already-seen ids dedupe). This closes the
      // list-then-observe race: arrivals during phase 1 are returned here
      // instead of being skipped by a post-list cursor.
      let catchupResume: string | undefined;
      if (watermark !== undefined && pagesLeft > 0) {
        const caught = await this.catchUp(operationKey, watermark, query, pagesLeft, maxMessages, seen, changes);
        if (caught.resetRequired) {
          return { status: "succeeded", metadata: liveMetadata(operationKey, provenance), data: { resetRequired: true, changes: [], truncated: false, provenance } };
        }
        if (caught.latestHistoryId !== undefined) latestHistoryId = caught.latestHistoryId;
        if (caught.truncated) truncated = true;
        pagesLeft = caught.pagesLeft;
        catchupResume = caught.resumePageToken;
      }
      if (truncated && watermark !== undefined) {
        // Resume from the watermark (replaying already-seen ids, which
        // dedupe) with the catch-up page when known: nothing is committed
        // past unobserved mail.
        return finish(encodeCursor(watermark, {
          account,
          ...(query === undefined ? {} : { query }),
          ...(catchupResume === undefined ? {} : { pageToken: catchupResume }),
          seen: [...seen].slice(-MAX_CURSOR_SEEN),
        }));
      }
    } catch (error) {
      if (error instanceof TokenUnavailableError) return tokenFailure(operationKey);
      if (error instanceof TransportTimeoutError || error instanceof TransportNetworkError) {
        return { status: "failed", metadata: liveMetadata(operationKey, []), error: transportError("Gmail full sync timed out; no cursor was advanced so retry is safe") };
      }
      if (error instanceof CatchUpFailedError) {
        return { status: "failed", metadata: liveMetadata(operationKey, []), error: transportError(error.message) };
      }
      throw error;
    }
    if (latestHistoryId === undefined) {
      // No watermark anywhere (profile unreadable and list silent): report
      // the changes with no cursor and truncated set — the consumer must
      // re-poll rather than commit progress it cannot name.
      return finish(undefined);
    }
    return finish(encodeCursor(latestHistoryId, { account, ...(query === undefined ? {} : { query }) }));
  }

  /**
   * Bounded history delta merged into an in-progress snapshot. Shares the
   * caller's change cap and page budget; a 404 here means even the fresh
   * watermark is unusable, so the whole bootstrap must reset rather than
   * drop data.
   */
  private async catchUp(
    operationKey: string,
    watermark: string,
    query: string | undefined,
    pagesLeft: number,
    maxMessages: number,
    seen: Set<string>,
    changes: InboxChange[],
  ): Promise<{ resetRequired: boolean; latestHistoryId?: string; truncated: boolean; pagesLeft: number; resumePageToken?: string }> {
    void operationKey;
    let truncated = false;
    let latestHistoryId: string | undefined;
    let pageToken: string | undefined;
    while (pagesLeft > 0) {
      pagesLeft -= 1;
      const url = withQuery(`${GMAIL_BASE_URL}/users/${encodeURIComponent(this.userId())}/history`, {
        startHistoryId: watermark,
        historyTypes: "messageAdded",
        ...(query === undefined ? {} : { q: query }),
        maxResults: "500",
        pageToken,
      });
      const response = await authorized(this.options, { method: "GET", url });
      if (response.status === 404) return { resetRequired: true, truncated: false, pagesLeft };
      if (response.status !== 200) {
        const error = mapGoogleHttpError(response.status, safeParseJson(response.text), "pollInbox");
        throw new CatchUpFailedError(error.message);
      }
      const parsed = parseHistoryPage(safeParseJson(response.text));
      if (parsed === undefined) {
        throw new CatchUpFailedError("Gmail history.list returned an unrecognized JSON shape");
      }
      if (parsed.historyId !== undefined) latestHistoryId = parsed.historyId;
      const drained = this.drainHistoryPage(parsed, seen, changes, maxMessages);
      if (drained.truncated) {
        truncated = true;
        break;
      }
      pageToken = drained.nextPageToken;
      if (pageToken === undefined) break;
    }
    if (pageToken !== undefined) truncated = true;
    return { resetRequired: false, latestHistoryId, truncated, pagesLeft, ...(pageToken === undefined ? {} : { resumePageToken: pageToken }) };
  }
}
