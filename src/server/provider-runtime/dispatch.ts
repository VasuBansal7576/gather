import type {
  CalendarConnector,
  CheckAvailabilityRequest,
  CheckAvailabilityResponse,
  ConnectorError,
  ConnectorErrorKind,
  ConnectorResult,
  CreateProvisionalHoldRequest,
  CreateProvisionalHoldResponse,
  DocumentRetriever,
  EmailSender,
  InquiryThreadReader,
  OperationRequest,
  SendEmailRequest,
  SendEmailResponse,
} from "../../connectors/contracts.ts";
import {
  createFetchTransport,
  createGoogleConnectors,
  liveMetadata,
  type GmailInboxPoller,
  type GoogleConnectorSet,
  type GoogleHttpTransport,
} from "../../connectors/google/index.ts";
import type { Booking, ProposedAction } from "../../domain/contracts.ts";
import { demoFixtureSlots } from "../demo-fixtures.ts";
import type { GatherStore } from "../sqlite-store.ts";
import type { ConnectionService } from "../connections/service.ts";
import type { ConnectedAccountDTO } from "../connections/types.ts";

/**
 * Per-booking provider dispatch. The booking service holds ONE calendar and
 * ONE email connector; the resolver below decides, per call, which actual
 * connector a booking belongs to:
 *
 * - A booking whose source references are all explicitly fictional fixture
 *   records stays on the demo adapters — simulation is never silent because
 *   fixture scope is declared on the booking itself.
 * - A real booking resolves its business's verified connection through the
 *   ConnectionService (the same shared instance the routes use). Only
 *   accounts durably bound by an owned, connected connection row qualify —
 *   an unbound account row (fixture or legacy) can never serve a real
 *   booking. Email work resolves the booking behind the durable operation
 *   key; calendar work resolves through `provider_calendar_bindings`, a
 *   durable host-validated calendar -> business+account record — tenant
 *   scope is never inferred from proposals or model payloads.
 * - Disconnected, revoked, ambiguous, or missing capability bindings produce
 *   typed connector failures — never a silent fall back to demo.
 *
 * Credentials stay lazy: the access-token supplier is only invoked inside an
 * authorized connector call, and tokens never appear in results, DTOs, or
 * errors.
 */

type CapabilityProvider = "google_calendar" | "gmail";

interface ActionContext {
  action: ProposedAction;
  booking: Booking;
}

export type Resolution =
  | { kind: "demo" }
  | { kind: "live"; businessId: string; account: ConnectedAccountDTO }
  | { kind: "fail"; error: ConnectorError };

function isFixtureBooking(booking: Booking): boolean {
  return booking.sourceReferences.length > 0 && booking.sourceReferences.every((ref) => ref.fictional === true);
}

function fail(kind: ConnectorErrorKind, message: string): { kind: "fail"; error: ConnectorError } {
  return { kind: "fail", error: { kind, message, retryable: false } };
}

function failure(operationKey: string, error: ConnectorError): ConnectorResult<never> {
  return { status: "failed", metadata: liveMetadata(operationKey, []), error };
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isConnectorError(error: unknown): error is ConnectorError {
  if (!error || typeof error !== "object") return false;
  const err = error as { kind?: unknown; message?: unknown; retryable?: unknown };
  return (
    typeof err.kind === "string" &&
    typeof err.message === "string" &&
    typeof err.retryable === "boolean" &&
    [
      "invalid_request",
      "not_found",
      "slot_unavailable",
      "conflict",
      "timeout_after_success",
      "authorization_denied",
      "access_revoked",
      "rate_limited",
      "transport_error",
      "unsupported",
    ].includes(err.kind)
  );
}

/** Bounded attempts for the binding write lock across SQLite handles. */
const MAX_BIND_ATTEMPTS = 10;

function bindBackoff(attempt: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(5 + attempt * 5, 50));
}

function sqliteCode(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const err = error as { errcode?: unknown; code?: unknown; message?: unknown };
  // node:sqlite numeric codes: 5 = SQLITE_BUSY, 19 = SQLITE_CONSTRAINT.
  if (err.errcode === 5) return "busy";
  if (err.errcode === 19) return "unique";
  const code = typeof err.code === "string" ? err.code : "";
  const message = typeof err.message === "string" ? err.message : "";
  if (/UNIQUE constraint failed/i.test(`${code} ${message}`)) return "unique";
  if (/database is locked|database table is locked/i.test(message)) return "busy";
  return "";
}

function isBusyError(error: unknown): boolean {
  return sqliteCode(error) === "busy";
}

function isUniqueViolation(error: unknown): boolean {
  return sqliteCode(error) === "unique";
}

export interface ProviderDispatchContext {
  store: GatherStore;
  ownerId: string;
  demo: { calendar: CalendarConnector; email: EmailSender };
  connectionService: ConnectionService;
  transport?: GoogleHttpTransport;
  userId?: string;
}

/** The Google read ports an intake/lifecycle assembly can be handed. */
export interface GoogleAccountPorts {
  /** The verified bound account these ports are scoped to. */
  account: ConnectedAccountDTO;
  /** Gmail inbox poller + thread reader — present for a "gmail" capability account. */
  inbox?: GmailInboxPoller;
  threads?: InquiryThreadReader;
  /** Explicit-id document retriever — present for a "google_drive" capability account. */
  documents?: DocumentRetriever;
}

export type ReadCapability = "gmail" | "google_drive";

export class ProviderResolver {
  private readonly store: GatherStore;
  private readonly ownerId: string;
  private readonly connectionService: ConnectionService;
  private readonly transport: GoogleHttpTransport;
  private readonly userId?: string;
  private readonly connectors = new Map<string, GoogleConnectorSet>();
  /** Fixture calendar ids from the durable demo world. */
  private readonly fixtureCalendars = new Set(demoFixtureSlots().map((slot) => slot.calendarId).filter(isNonEmpty));

  constructor(options: ProviderDispatchContext) {
    this.store = options.store;
    this.ownerId = options.ownerId;
    this.connectionService = options.connectionService;
    this.transport = options.transport ?? createFetchTransport();
    this.userId = options.userId;
    this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS provider_calendar_bindings (
        calendar_id TEXT PRIMARY KEY,
        business_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        connection_account_id TEXT NOT NULL,
        generation INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'bound',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_provider_calendar_bindings_business
        ON provider_calendar_bindings(business_id);
    `);
    // Migrate pre-generation databases in place: history rows keep their
    // original proof (created_at) and read back as generation 1 / bound.
    this.ensureBindingColumn("generation", "INTEGER NOT NULL DEFAULT 1");
    this.ensureBindingColumn("status", "TEXT NOT NULL DEFAULT 'bound'");
  }

  private ensureBindingColumn(column: string, type: string): void {
    const info = this.store.db.prepare("PRAGMA table_info(provider_calendar_bindings)").all() as Array<{ name: unknown }>;
    if (!info.some((entry) => String(entry.name) === column)) {
      this.store.db.exec(`ALTER TABLE provider_calendar_bindings ADD COLUMN ${column} ${type}`);
    }
  }

  /**
   * One immediately-committed write transaction with bounded lock-busy
   * retries across SQLite handles. UNIQUE violations (a concurrent handle
   * won the same calendar id) surface as typed conflicts, never raw
   * driver errors; exhausted contention surfaces as retryable
   * transport_error, never a silent partial write.
   */
  private transactBinding<T>(fn: () => T): T {
    let attempt = 0;
    for (;;) {
      try {
        this.store.db.exec("BEGIN IMMEDIATE");
      } catch (error) {
        if (isBusyError(error) && attempt < MAX_BIND_ATTEMPTS) {
          attempt += 1;
          bindBackoff(attempt);
          continue;
        }
        if (isBusyError(error)) {
          throw { kind: "transport_error", message: "calendar binding store is busy; retry the host action", retryable: true } as ConnectorError;
        }
        throw error;
      }
      try {
        const out = fn();
        this.store.db.exec("COMMIT");
        return out;
      } catch (error) {
        try {
          this.store.db.exec("ROLLBACK");
        } catch {
          // Nothing to roll back; surface the original failure.
        }
        if (isBusyError(error) && attempt < MAX_BIND_ATTEMPTS) {
          attempt += 1;
          bindBackoff(attempt);
          continue;
        }
        if (isBusyError(error)) {
          throw { kind: "transport_error", message: "calendar binding store is busy; retry the host action", retryable: true } as ConnectorError;
        }
        if (isUniqueViolation(error)) {
          throw { kind: "conflict", message: "calendar binding changed concurrently; re-read and retry the host action", retryable: false } as ConnectorError;
        }
        throw error;
      }
    }
  }

  /** The durable execution row binds every operation key to its exact action. */
  actionContextFor(operationKey: string): ActionContext | undefined {
    const execution = this.store.getExecutionByIdempotencyKey(operationKey);
    if (!execution) return undefined;
    try {
      const action = this.store.getProposedAction(execution.proposedActionId);
      return { action, booking: this.store.getBooking(action.bookingId) };
    } catch {
      return undefined;
    }
  }

  /**
   * Public connected_accounts ids durably bound by an OWNED connection row —
   * the verified-binding set in every status (revoked rows still surface as
   * revoked, never as "missing"). Unbound rows (fixtures, legacy data,
   * other owners' bindings) never qualify.
   */
  private boundAccountIds(businessId: string): Set<string> {
    const ids = new Set<string>();
    const rows = this.store.db
      .prepare(
        "SELECT connected_account_ids_json FROM connection_accounts WHERE business_id = $b AND owner_id = $o",
      )
      .all({ $b: businessId, $o: this.ownerId }) as Array<{ connected_account_ids_json: string }>;
    for (const row of rows) {
      for (const id of JSON.parse(String(row.connected_account_ids_json)) as string[]) ids.add(id);
    }
    return ids;
  }

  /**
   * One verified capability account for a business, resolved through the
   * shared connection service and filtered to durably bound rows. Missing,
   * revoked/errored, or ambiguous bindings fail closed.
   */
  resolveCapabilityAccount(businessId: string, capability: CapabilityProvider | ReadCapability): Resolution {
    let accounts: ConnectedAccountDTO[] | undefined;
    try {
      const google = this.connectionService.getConnections(businessId).providers.find((p) => p.provider === "google");
      if (!google) return fail("unsupported", "The Google provider is not available in this installation");
      if (google.status === "unavailable") return fail("unsupported", google.unavailableReason ?? "The Google connection is unavailable");
      accounts = google.accounts.filter((account) => account.provider === capability);
    } catch {
      return fail("not_found", `No connected ${capability} account for business ${businessId}`);
    }
    const bound = this.boundAccountIds(businessId);
    const eligible = accounts.filter((account) => bound.has(account.id));
    const connected = eligible.filter((account) => account.status === "connected");
    if (connected.length === 1) return { kind: "live", businessId, account: connected[0] };
    if (connected.length > 1) return fail("conflict", `Multiple connected ${capability} accounts for business ${businessId} — the binding is ambiguous`);
    if (eligible.length > 0) return fail("access_revoked", `The ${capability} account for business ${businessId} is ${eligible[0].status}, not connected`);
    return fail("not_found", `No connected ${capability} account for business ${businessId}`);
  }

  // ---------------------------------------------------- calendar bindings

  /**
   * A durable, host-validated calendar binding: exactly one business +
   * verified calendar-capability account owns a calendar id, and no other
   * business may claim it. Tenant scope for calendar work comes from THIS
   * record — never inferred from proposals, payloads, or model output.
   * Unbind keeps the row as an `unbound` tombstone (original proof
   * preserved); only `bound` rows authorize work, and every fresh bind
   * bumps `generation` so previously resolved ports go stale.
   */
  /** Owner-scoped binding row read for the port guard (public for BoundCalendarPort). */
  bindingRow(calendarId: string): {
    calendarId: string;
    businessId: string;
    accountId: string;
    generation: number;
    status: string;
  } | undefined {
    const row = this.store.db
      .prepare(
        "SELECT calendar_id, business_id, connection_account_id, generation, status FROM provider_calendar_bindings WHERE calendar_id = $c AND owner_id = $o",
      )
      .get({ $c: calendarId, $o: this.ownerId }) as
      | { calendar_id: unknown; business_id: unknown; connection_account_id: unknown; generation: unknown; status: unknown }
      | undefined;
    if (!row) return undefined;
    return {
      calendarId: String(row.calendar_id),
      businessId: String(row.business_id),
      accountId: String(row.connection_account_id),
      generation: Number(row.generation ?? 1),
      status: String(row.status ?? "bound"),
    };
  }

  private bindingFor(calendarId: string):
    | { calendarId: string; businessId: string; accountId: string; generation: number }
    | undefined {
    const row = this.bindingRow(calendarId);
    if (!row || row.status !== "bound") return undefined;
    return { calendarId: row.calendarId, businessId: row.businessId, accountId: row.accountId, generation: row.generation };
  }

  /** The DTO for a binding's pinned account, resolved owner-scoped (public for BoundCalendarPort). */
  boundAccountFor(businessId: string, accountId: string): ConnectedAccountDTO | undefined {
    let accounts: ConnectedAccountDTO[];
    try {
      const google = this.connectionService.getConnections(businessId).providers.find((p) => p.provider === "google");
      if (!google || google.status === "unavailable") return undefined;
      accounts = google.accounts;
    } catch {
      return undefined;
    }
    if (!this.boundAccountIds(businessId).has(accountId)) return undefined;
    return accounts.find((account) => account.id === accountId && account.provider === "google_calendar");
  }

  /**
   * Host action: durably bind a calendar id to this business's verified
   * calendar account. `accountId` may pin a specific connected account;
   * absent, the business must have exactly one connected calendar account.
   * A calendar bound to another business conflicts — a foreign scope can
   * never claim it. Check and write run atomically: a concurrent handle
   * that wins the calendar id surfaces as a typed conflict, never a raw
   * driver error. Every fresh bind (including same-account rebind after
   * unbind) bumps generation, invalidating previously resolved ports.
   */
  bindCalendar(input: { businessId: string; calendarId: string; accountId?: string }): { ok: true } | { ok: false; error: ConnectorError } {
    try {
      return this.transactBinding(() => {
        const existing = this.bindingRow(input.calendarId);
        if (existing && existing.status === "bound") {
          if (existing.businessId !== input.businessId || existing.accountId !== (input.accountId ?? existing.accountId)) {
            return { ok: false as const, error: { kind: "conflict", message: `Calendar ${input.calendarId} is already bound to another business or account`, retryable: false } as ConnectorError };
          }
          return { ok: true as const };
        }
        let accountId = input.accountId;
        if (accountId !== undefined) {
          const account = this.boundAccountFor(input.businessId, accountId);
          if (!account || account.status !== "connected") {
            return { ok: false as const, error: { kind: "access_revoked", message: `Account ${accountId} is not a connected calendar account for business ${input.businessId}`, retryable: false } as ConnectorError };
          }
        } else {
          const target = this.resolveCapabilityAccount(input.businessId, "google_calendar");
          if (target.kind !== "live") {
            return { ok: false as const, error: target.kind === "fail" ? target.error : { kind: "not_found", message: "No verified calendar account to bind", retryable: false } as ConnectorError };
          }
          accountId = target.account.id;
        }
        if (existing) {
          // Released scope rebinding: history row kept, generation bumped.
          this.store.db
            .prepare(
              "UPDATE provider_calendar_bindings SET business_id = $b, connection_account_id = $a, generation = generation + 1, status = 'bound' WHERE calendar_id = $c AND owner_id = $o",
            )
            .run({ $b: input.businessId, $a: accountId, $c: input.calendarId, $o: this.ownerId });
        } else {
          this.store.db
            .prepare(
              "INSERT INTO provider_calendar_bindings (calendar_id, business_id, owner_id, connection_account_id, generation, status, created_at) VALUES ($c, $b, $o, $a, 1, 'bound', $t)",
            )
            .run({ $c: input.calendarId, $b: input.businessId, $o: this.ownerId, $a: accountId, $t: new Date().toISOString() });
        }
        return { ok: true as const };
      });
    } catch (error) {
      if (isConnectorError(error)) return { ok: false, error };
      throw error;
    }
  }

  /**
   * Host action: release one of this business's calendar bindings. The row
   * is kept as an `unbound` tombstone (original proof preserved) and the
   * delete compares exact owner + business (+ account when pinned), so a
   * foreign scope can neither remove nor adopt the binding. Runs atomically;
   * concurrent races surface as typed conflicts.
   */
  unbindCalendar(input: { businessId: string; calendarId: string; accountId?: string }): { ok: true } | { ok: false; error: ConnectorError } {
    try {
      return this.transactBinding(() => {
        const existing = this.bindingRow(input.calendarId);
        if (!existing || existing.status !== "bound" || existing.businessId !== input.businessId) {
          return { ok: false as const, error: { kind: "not_found", message: `Calendar ${input.calendarId} is not bound to business ${input.businessId}`, retryable: false } as ConnectorError };
        }
        if (input.accountId !== undefined && existing.accountId !== input.accountId) {
          return { ok: false as const, error: { kind: "conflict", message: `Calendar ${input.calendarId} is bound to a different account; refusing to release another account's binding`, retryable: false } as ConnectorError };
        }
        const released = this.store.db
          .prepare(
            "UPDATE provider_calendar_bindings SET status = 'unbound' WHERE calendar_id = $c AND owner_id = $o AND business_id = $b AND status = 'bound'",
          )
          .run({ $c: input.calendarId, $o: this.ownerId, $b: input.businessId });
        if (released.changes !== 1) {
          return { ok: false as const, error: { kind: "conflict", message: `Calendar ${input.calendarId} changed concurrently; re-read and retry the host action`, retryable: false } as ConnectorError };
        }
        return { ok: true as const };
      });
    } catch (error) {
      if (isConnectorError(error)) return { ok: false, error };
      throw error;
    }
  }

  /** Owner-scoped listing of live bindings for setup/diagnostics (tombstones excluded). */
  listCalendarBindings(businessId: string): { calendarId: string; accountId: string }[] {
    const rows = this.store.db
      .prepare(
        "SELECT calendar_id, connection_account_id FROM provider_calendar_bindings WHERE business_id = $b AND owner_id = $o AND status = 'bound' ORDER BY calendar_id",
      )
      .all({ $b: businessId, $o: this.ownerId }) as Array<{ calendar_id: string; connection_account_id: string }>;
    return rows.map((row) => ({ calendarId: String(row.calendar_id), accountId: String(row.connection_account_id) }));
  }

  /**
   * The calendar connector for one bound calendar. Resolution order:
   * fixture calendar -> demo; durable binding -> the pinned verified
   * account (revocation stays visible); anything else -> not_found. The
   * proposal/action payload can never establish scope on its own.
   */
  /** Booking lookup shared by dispatchers (throws when unknown). */
  bookingFor(bookingId: string): Booking {
    return this.store.getBooking(bookingId);
  }

  resolveBoundCalendar(calendarId: string): Resolution {
    if (this.fixtureCalendars.has(calendarId)) return { kind: "demo" };
    const binding = this.bindingFor(calendarId);
    if (!binding) {
      return fail("not_found", `Calendar ${calendarId} is not bound to a verified account — bind it via the host before any live operation`);
    }
    const account = this.boundAccountFor(binding.businessId, binding.accountId);
    if (!account) return fail("not_found", `The account bound to calendar ${calendarId} no longer exists`);
    if (account.status !== "connected") {
      return fail("access_revoked", `The account bound to calendar ${calendarId} is ${account.status}, not connected`);
    }
    return { kind: "live", businessId: binding.businessId, account };
  }

  /** Availability scope: fixture -> demo; bound -> pinned account; otherwise fail. */
  resolveCalendarScope(calendarId: string): Resolution {
    return this.resolveBoundCalendar(calendarId);
  }

  /**
   * Server-scoped account resolution for the intake/operator assembly: after
   * owner/business/capability validation it hands back the existing Google
   * read ports bound to the verified account. No credentials are read while
   * deciding eligibility — token supply stays lazy inside the ports.
   */
  resolveAccountPorts(input: { businessId: string; capability: ReadCapability }): { ok: true; ports: GoogleAccountPorts } | { ok: false; error: ConnectorError } {
    const target = this.resolveCapabilityAccount(input.businessId, input.capability);
    if (target.kind !== "live") {
      return {
        ok: false,
        error: target.kind === "fail" ? target.error : { kind: "unsupported", message: "Fixture scope has no live provider ports", retryable: false },
      };
    }
    const set = this.googleFor(target.account);
    const ports: GoogleAccountPorts = { account: target.account };
    if (input.capability === "gmail") {
      ports.inbox = set.inbox;
      ports.threads = set.gmail;
    }
    if (input.capability === "google_drive") ports.documents = set.documents;
    return { ok: true, ports };
  }

  /**
   * The host-facing calendar port for offer/intake composition: resolves
   * one explicitly bound calendar (host-validated business + durable
   * binding + verified pinned account) into a GUARDED live calendar
   * connector. The returned port re-validates the exact binding
   * (business + account + generation) and the account's connected status
   * on EVERY operation: unbind, rebind (even same-account, via the
   * generation bump), account change, or revocation all fail retained
   * ports closed. A resolved port is a capability snapshot, never an
   * irrevocable handle — callers must re-resolve after any host change.
   * Unbound, foreign, or fixture calendars fail closed.
   */
  resolveCalendarPorts(input: { businessId: string; calendarId: string }): { ok: true; ports: { account: ConnectedAccountDTO; calendar: CalendarConnector } } | { ok: false; error: ConnectorError } {
    const target = this.resolveBoundCalendar(input.calendarId);
    if (target.kind !== "live") {
      return {
        ok: false,
        error: target.kind === "fail" ? target.error : { kind: "unsupported", message: "Fixture scope has no live calendar ports", retryable: false },
      };
    }
    if (target.businessId !== input.businessId) {
      return { ok: false, error: { kind: "conflict", message: `Calendar ${input.calendarId} is bound to a different business`, retryable: false } };
    }
    const binding = this.bindingFor(input.calendarId);
    if (!binding || binding.businessId !== input.businessId || binding.accountId !== target.account.id) {
      return { ok: false, error: { kind: "conflict", message: `Calendar ${input.calendarId} changed during resolution; re-resolve before use`, retryable: false } };
    }
    return {
      ok: true,
      ports: {
        account: target.account,
        calendar: new BoundCalendarPort(this, {
          businessId: input.businessId,
          calendarId: input.calendarId,
          accountId: target.account.id,
          generation: binding.generation,
        }),
      },
    };
  }

  /**
   * Lazily composed live connector set for one verified account (+ explicit
   * calendar binding for calendar work). Tokens resolve only when an
   * authorized call runs — never at construction.
   */
  googleFor(account: ConnectedAccountDTO, calendarId?: string): GoogleConnectorSet {
    const key = `${account.id}|${calendarId ?? ""}`;
    const existing = this.connectors.get(key);
    if (existing) return existing;
    const set = createGoogleConnectors({
      transport: this.transport,
      tokens: () => this.connectionService.accessToken({ accountId: account.id, businessId: account.businessId }),
      ...(this.userId === undefined ? {} : { userId: this.userId }),
      ...(calendarId === undefined ? {} : { calendarId }),
      resolveHoldScope: (operationKey) => Promise.resolve(this.holdScopeFor(operationKey)),
      resolveSentExpectation: (operationKey) => Promise.resolve(this.sentExpectationFor(operationKey)),
      accountId: account.id,
    });
    this.connectors.set(key, set);
    return set;
  }

  /** Durable hold scope for reconcile — from the action payload, never memory. */
  private holdScopeFor(operationKey: string) {
    const context = this.actionContextFor(operationKey);
    const payload = context?.action.payload;
    if (!context || !isNonEmpty(payload?.calendarId)) return undefined;
    return {
      calendarId: payload.calendarId,
      bookingId: context.booking.id,
      startAt: isNonEmpty(payload.startAt) ? payload.startAt : undefined,
      endAt: isNonEmpty(payload.endAt) ? payload.endAt : undefined,
      expiresAt: isNonEmpty(payload.expiresAt) ? payload.expiresAt : undefined,
    };
  }

  /** Durable approved-send expectation for full reconcile identity. */
  private sentExpectationFor(operationKey: string) {
    const context = this.actionContextFor(operationKey);
    const payload = context?.action.payload;
    if (
      !context ||
      !Array.isArray(payload?.emailTo) ||
      !payload.emailTo.every(isNonEmpty) ||
      !isNonEmpty(payload.emailSubject) ||
      !isNonEmpty(payload.emailBody)
    ) {
      return undefined;
    }
    return { to: payload.emailTo, subject: payload.emailSubject, body: payload.emailBody };
  }
}

/**
 * A resolved calendar port that guards the exact binding it was resolved
 * from. Every operation re-reads the durable binding row and the pinned
 * account's live status before delegating: a binding that was unbound,
 * rebound (generation bumped even for same-account rebinds), moved to
 * another account, or revoked since resolution fails closed with a typed
 * error instead of acting on stale authority. Tokens still resolve lazily
 * per authorized call against the pinned account, so a revocation landing
 * between the guard and the token fetch fails at the fetch — never
 * silently, never with another account's credentials.
 */
export class BoundCalendarPort implements CalendarConnector {
  private readonly resolver: ProviderResolver;
  private readonly scope: { businessId: string; calendarId: string; accountId: string; generation: number };

  constructor(
    resolver: ProviderResolver,
    scope: { businessId: string; calendarId: string; accountId: string; generation: number },
  ) {
    this.resolver = resolver;
    this.scope = scope;
  }

  private guard(operationKey: string): { ok: true; calendar: CalendarConnector } | { ok: false; result: ConnectorResult<never> } {
    const current = this.resolver.bindingRow(this.scope.calendarId);
    if (!current || current.status !== "bound") {
      return {
        ok: false,
        result: failure(operationKey, {
          kind: "not_found",
          message: `Calendar ${this.scope.calendarId} is no longer bound — re-resolve ports after the host change`,
          retryable: false,
        }),
      };
    }
    if (
      current.businessId !== this.scope.businessId ||
      current.accountId !== this.scope.accountId ||
      current.generation !== this.scope.generation
    ) {
      return {
        ok: false,
        result: failure(operationKey, {
          kind: "conflict",
          message: `Calendar ${this.scope.calendarId} binding changed since this port was resolved — re-resolve before use`,
          retryable: false,
        }),
      };
    }
    const account = this.resolver.boundAccountFor(current.businessId, current.accountId);
    if (!account) {
      return {
        ok: false,
        result: failure(operationKey, {
          kind: "not_found",
          message: `The account bound to calendar ${this.scope.calendarId} no longer exists`,
          retryable: false,
        }),
      };
    }
    if (account.status !== "connected") {
      return {
        ok: false,
        result: failure(operationKey, {
          kind: "access_revoked",
          message: `The account bound to calendar ${this.scope.calendarId} is ${account.status}, not connected`,
          retryable: false,
        }),
      };
    }
    return { ok: true, calendar: this.resolver.googleFor(account, this.scope.calendarId).calendar };
  }

  async checkAvailability(request: CheckAvailabilityRequest): Promise<ConnectorResult<CheckAvailabilityResponse>> {
    const guarded = this.guard(request.operationKey);
    if (!guarded.ok) return guarded.result;
    return guarded.calendar.checkAvailability(request);
  }

  async createProvisionalHold(request: CreateProvisionalHoldRequest): Promise<ConnectorResult<CreateProvisionalHoldResponse>> {
    const guarded = this.guard(request.operationKey);
    if (!guarded.ok) return guarded.result;
    return guarded.calendar.createProvisionalHold(request);
  }

  async reconcileProvisionalHold(request: OperationRequest): Promise<ConnectorResult<CreateProvisionalHoldResponse>> {
    const guarded = this.guard(request.operationKey);
    if (!guarded.ok) return guarded.result;
    return guarded.calendar.reconcileProvisionalHold(request);
  }
}

export class DispatchingCalendar implements CalendarConnector {
  private readonly resolver: ProviderResolver;
  private readonly demo: ProviderDispatchContext["demo"];

  constructor(resolver: ProviderResolver, demo: ProviderDispatchContext["demo"]) {
    this.resolver = resolver;
    this.demo = demo;
  }

  async checkAvailability(request: CheckAvailabilityRequest): Promise<ConnectorResult<CheckAvailabilityResponse>> {
    const target = this.resolver.resolveCalendarScope(request.calendarId);
    if (target.kind === "demo") return this.demo.calendar.checkAvailability(request);
    if (target.kind === "fail") return failure(request.operationKey, target.error);
    return this.resolver.googleFor(target.account, request.calendarId).calendar.checkAvailability(request);
  }

  async createProvisionalHold(request: CreateProvisionalHoldRequest): Promise<ConnectorResult<CreateProvisionalHoldResponse>> {
    let booking: Booking;
    try {
      booking = this.resolver.bookingFor(request.bookingId);
    } catch {
      return failure(request.operationKey, { kind: "not_found", message: `Unknown booking ${request.bookingId}`, retryable: false });
    }
    if (isFixtureBooking(booking)) return this.demo.calendar.createProvisionalHold(request);
    const target = this.resolver.resolveBoundCalendar(request.calendarId);
    if (target.kind === "demo") {
      return failure(request.operationKey, {
        kind: "conflict",
        message: `Booking ${request.bookingId} is a real booking but calendar ${request.calendarId} is a fixture scope`,
        retryable: false,
      });
    }
    if (target.kind === "fail") return failure(request.operationKey, target.error);
    if (target.businessId !== booking.businessId) {
      return failure(request.operationKey, {
        kind: "conflict",
        message: `Calendar ${request.calendarId} is bound to a different business — the approved payload cannot reroute scope`,
        retryable: false,
      });
    }
    return this.resolver.googleFor(target.account, request.calendarId).calendar.createProvisionalHold(request);
  }

  async reconcileProvisionalHold(request: OperationRequest): Promise<ConnectorResult<CreateProvisionalHoldResponse>> {
    const context = this.resolver.actionContextFor(request.operationKey);
    if (!context) {
      return failure(request.operationKey, { kind: "not_found", message: "No durable operation record for this hold key", retryable: false });
    }
    if (isFixtureBooking(context.booking)) return this.demo.calendar.reconcileProvisionalHold(request);
    const calendarId = isNonEmpty(context.action.payload.calendarId) ? context.action.payload.calendarId : undefined;
    if (calendarId === undefined) {
      return failure(request.operationKey, { kind: "not_found", message: "The durable action payload carries no calendar id", retryable: false });
    }
    const target = this.resolver.resolveBoundCalendar(calendarId);
    if (target.kind !== "live") {
      return failure(
        request.operationKey,
        target.kind === "fail"
          ? target.error
          : { kind: "conflict", message: `Hold scope ${calendarId} resolved to a fixture calendar for a real booking`, retryable: false },
      );
    }
    if (target.businessId !== context.booking.businessId) {
      return failure(request.operationKey, {
        kind: "conflict",
        message: `Calendar ${calendarId} is bound to a different business — refusing to reconcile in a foreign scope`,
        retryable: false,
      });
    }
    return this.resolver.googleFor(target.account, calendarId).calendar.reconcileProvisionalHold(request);
  }
}

export class DispatchingEmail implements EmailSender {
  private readonly resolver: ProviderResolver;
  private readonly demo: ProviderDispatchContext["demo"];

  constructor(resolver: ProviderResolver, demo: ProviderDispatchContext["demo"]) {
    this.resolver = resolver;
    this.demo = demo;
  }

  private resolveSend(operationKey: string): Resolution {
    const context = this.resolver.actionContextFor(operationKey);
    if (!context) {
      return { kind: "fail", error: { kind: "not_found", message: "No durable operation record for this send key", retryable: false } };
    }
    if (isFixtureBooking(context.booking)) return { kind: "demo" };
    return this.resolver.resolveCapabilityAccount(context.booking.businessId, "gmail");
  }

  async sendEmail(request: SendEmailRequest): Promise<ConnectorResult<SendEmailResponse>> {
    const target = this.resolveSend(request.operationKey);
    if (target.kind === "demo") return this.demo.email.sendEmail(request);
    if (target.kind === "fail") return failure(request.operationKey, target.error);
    return this.resolver.googleFor(target.account).gmail.sendEmail(request);
  }

  async reconcileSentEmail(request: OperationRequest): Promise<ConnectorResult<SendEmailResponse>> {
    const target = this.resolveSend(request.operationKey);
    if (target.kind === "demo") return this.demo.email.reconcileSentEmail(request);
    if (target.kind === "fail") return failure(request.operationKey, target.error);
    return this.resolver.googleFor(target.account).gmail.reconcileSentEmail(request);
  }
}

export interface ProviderConnectors {
  calendar: CalendarConnector;
  email: EmailSender;
  /** The shared connection service — the composition hook for later intake/operator assembly. */
  connectionService: ConnectionService;
  /** Server-scoped verified account → Google read ports (inbox/threads/documents). */
  resolveAccountPorts(input: { businessId: string; capability: ReadCapability }): { ok: true; ports: GoogleAccountPorts } | { ok: false; error: ConnectorError };
  /**
   * Explicit host-validated calendar port for offer/intake composition:
   * resolves one durably bound calendar into its verified connector. This is
   * the boundary offer preparation calls BEFORE any proposal exists.
   */
  resolveCalendarPorts(input: { businessId: string; calendarId: string }): { ok: true; ports: { account: ConnectedAccountDTO; calendar: CalendarConnector } } | { ok: false; error: ConnectorError };
  /** Host actions over the durable calendar-binding boundary. */
  bindCalendar(input: { businessId: string; calendarId: string; accountId?: string }): { ok: true } | { ok: false; error: ConnectorError };
  unbindCalendar(input: { businessId: string; calendarId: string; accountId?: string }): { ok: true } | { ok: false; error: ConnectorError };
  listCalendarBindings(businessId: string): { calendarId: string; accountId: string }[];
}

export interface ProviderRuntimeOptions {
  store: GatherStore;
  ownerId: string;
  /** Fixture-only connectors (durable demo wrappers) — used solely for explicitly fictional bookings. */
  demo: { calendar: CalendarConnector; email: EmailSender };
  /** Injected service in tests; production composes the shared env-configured instance. */
  connectionService?: ConnectionService;
  /** Scripted transport in tests; production uses the fetch transport. */
  transport?: GoogleHttpTransport;
  userId?: string;
  secretsNamespace?: string;
}
