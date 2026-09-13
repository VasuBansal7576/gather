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
 * - Query scope is exact, never heuristic: absent (unfiltered — the whole
 *   mailbox, spam and trash included) or a single system-label filter,
 *   enforced server-side (`labelId` on history calls; `labelIds` with
 *   `includeSpamTrash` on the messages.list snapshot so both paths observe
 *   the same population). `users.history.list` documents no `q` parameter,
 *   so arbitrary queries are rejected as `invalid_request` before any HTTP
 *   call instead of being silently broadened.
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
   * Optional scope narrowing both paths. `users.history.list` (the delta
   * path) documents `labelId` but no `q`, so an arbitrary Gmail search
   * string has no exact history equivalent. The accepted boundary is
   * therefore exact: absent (unfiltered — the whole mailbox, including
   * spam and trash) or a single system-label filter (e.g. `in:inbox`,
   * `in:sent`, `in:trash`, `in:spam`, `in:draft(s)`, `label:<system>`,
   * `is:unread|starred|important`), enforced server-side via `labelId` on
   * history calls and via `labelIds` + `includeSpamTrash` on the
   * `messages.list` snapshot. Any other query is rejected as
   * `invalid_request` before any HTTP call — never silently broadened,
   * and never filtered by a local semantic heuristic. The value is a
   * scope token matched exactly against the allowlist, not free search
   * text: untrusted input must equal an allowlisted token, never be
   * interpolated.
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

/**
 * Exact query-scope boundary for inbox polling.
 *
 * `users.history.list` has no `q` parameter, so only scopes with an exact
 * server-side equivalent are accepted: absent (unfiltered) or a single
 * system-label filter, returned as the `labelId` to send on history calls.
 * Returns `undefined` for unfiltered, the label id for a label scope, or
 * `null` when the query has no exact history-list equivalent and must be
 * rejected rather than silently broadened. Matching is case-insensitive on
 * the trimmed single token; anything compound (whitespace, extra operators,
 * negation, quoting) is unsupported — local re-evaluation of full Gmail
 * search syntax is not exact (stemming, indexing lag), so a semantic or
 * heuristic filter must never stand in for server scoping.
 */
export function resolveHistoryLabelScope(query: string | undefined): string | undefined | null {
  if (query === undefined) return undefined;
  const token = query.trim().toLowerCase();
  if (token.length === 0 || /\s/.test(token)) return null;
  // Map (not a plain-object index): inherited properties such as
  // `__proto__` or `constructor` must resolve to null, never to a
  // non-string that could escape as an invalid label scope on the wire.
  const table = new Map<string, string>([
    ["in:inbox", "INBOX"],
    ["in:sent", "SENT"],
    ["in:trash", "TRASH"],
    ["in:spam", "SPAM"],
    ["in:draft", "DRAFT"],
    ["in:drafts", "DRAFT"],
    ["label:inbox", "INBOX"],
    ["label:sent", "SENT"],
    ["label:trash", "TRASH"],
    ["label:spam", "SPAM"],
    ["label:draft", "DRAFT"],
    ["label:drafts", "DRAFT"],
    ["label:unread", "UNREAD"],
    ["label:starred", "STARRED"],
    ["label:important", "IMPORTANT"],
    ["is:unread", "UNREAD"],
    ["is:starred", "STARRED"],
    ["is:important", "IMPORTANT"],
  ]);
  return table.get(token) ?? null;
}

/**
 * Full poll scope derived from one accepted query, covering both the
 * history path (`labelId`) and the `messages.list` snapshot (`labelIds`
 * plus `includeSpamTrash`).
 *
 * `messages.list` excludes SPAM and TRASH results unless
 * `includeSpamTrash` is set, while `history.list` has no such exclusion —
 * so a snapshot without the flag would lose existing spam/trash messages
 * that the delta path observes (and an unfiltered snapshot would miss
 * part of the mailbox the unfiltered delta reports). Snapshots therefore
 * always set `includeSpamTrash: true`, making the snapshot population
 * exactly the population the history delta observes: unfiltered means
 * all mailbox messages, and a label scope means all messages carrying
 * that label. Returns `null` when the query is outside the accepted
 * boundary (see `resolveHistoryLabelScope`).
 */
export interface PollScope {
  labelId?: string;
  includeSpamTrash: boolean;
}

export function resolvePollScope(query: string | undefined): PollScope | null {
  const labelId = resolveHistoryLabelScope(query);
  if (labelId === null) return null;
  if (labelId === undefined) return { includeSpamTrash: true };
  return { labelId, includeSpamTrash: true };
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

export interface GmailInboxPollerOptions extends GoogleAdapterOptions {
  /**
   * Stable account scope identity bound into every minted cursor and
   * enforced on every presented cursor. Must identify the actual
   * configured account — never the `userId` alias (`"me"`), which is
   * identical across accounts and cannot separate their cursors.
   */
  accountId: string;
}

export class GmailInboxPoller {
  private readonly options: GmailInboxPollerOptions;

  constructor(options: GmailInboxPollerOptions) {
    if (options.accountId.trim().length === 0) {
      throw new Error("GmailInboxPoller requires a non-empty stable accountId scope");
    }
    this.options = options;
  }

  private accountId(): string {
    return this.options.accountId;
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
    // Scope check before any HTTP on either path: history.list documents
    // no `q`, so a query without an exact label equivalent cannot be
    // enforced and is rejected instead of silently returning out-of-scope
    // changes.
    const scope = resolvePollScope(options.query);
    if (scope === null) {
      return { status: "failed", metadata: liveMetadata(operationKey, []), error: invalidRequest("Query has no exact Gmail history scope (supported: unfiltered or a single system-label filter such as in:inbox); refusing to poll unscoped rather than silently broadening") };
    }
    if (options.cursor === undefined) {
      return this.fullSync(operationKey, options.query, scope, maxPages, maxMessages);
    }
    const decoded = decodeCursor(options.cursor);
    if (decoded === undefined) {
      return { status: "failed", metadata: liveMetadata(operationKey, []), error: invalidRequest("Cursor is not a recognized inbox cursor; reset with a cursor-less full sync") };
    }
    // Binding check before any HTTP: a cursor minted for another account or
    // query must never poll this mailbox.
    if (decoded.account !== this.accountId() || (decoded.query ?? undefined) !== (options.query ?? undefined)) {
      return { status: "failed", metadata: liveMetadata(operationKey, []), error: invalidRequest("Cursor is bound to a different account or query; reset with a cursor-less full sync") };
    }
    return this.deltaSync(operationKey, decoded, options.query, scope.labelId, maxPages, maxMessages);
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
    labelId: string | undefined,
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
          // The only documented server scoping for history: `labelId`.
          // This endpoint documents no `q`, so none is ever sent here.
          ...(labelId === undefined ? {} : { labelId }),
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
          ? encodeCursor(latestHistoryId, { account: this.accountId(), ...(query === undefined ? {} : { query }) })
          : this.continuationCursor(cursor.base, this.accountId(), query, resumeToken, seen),
        truncated,
        provenance,
      },
    };
  }

  private async fullSync(
    operationKey: string,
    query: string | undefined,
    scope: PollScope,
    maxPages: number,
    maxMessages: number,
  ): Promise<ConnectorResult<InboxDelta>> {
    const provenance = this.provenance();
    const seen = new Set<string>();
    const changes: InboxChange[] = [];
    let truncated = false;
    let latestHistoryId: string | undefined;
    let pagesLeft = maxPages;
    const account = this.accountId();
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
      // Phase 1: bounded id snapshot. Scoping uses the exact provider
      // label parameters — `labelIds`, with `includeSpamTrash` always set
      // so the snapshot covers the same population the history delta
      // observes (messages.list excludes SPAM/TRASH by default; history
      // has no such exclusion, so omitting the flag would lose existing
      // spam/trash messages and split unfiltered snapshot/delta
      // membership). No `q` alias is relied on for scope here.
      let pageToken: string | undefined;
      while (pagesLeft > 0) {
        pagesLeft -= 1;
        const url = withQuery(`${GMAIL_BASE_URL}/users/${encodeURIComponent(this.userId())}/messages`, {
          ...(scope.labelId === undefined ? {} : { labelIds: scope.labelId }),
          includeSpamTrash: scope.includeSpamTrash ? "true" : "false",
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
        const caught = await this.catchUp(operationKey, watermark, scope.labelId, pagesLeft, maxMessages, seen, changes);
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
    labelId: string | undefined,
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
        // Same contract as deltaSync: labelId only, never q.
        ...(labelId === undefined ? {} : { labelId }),
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
