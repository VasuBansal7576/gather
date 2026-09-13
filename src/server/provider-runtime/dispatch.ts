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
 *   booking. Calendar work is bound to the request's explicit calendar id;
 *   email work resolves the booking behind the durable operation key.
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

  /** Fixture or live dispatch for a booking scoped operation. */
  resolveBooking(bookingId: string, capability: CapabilityProvider): Resolution {
    let booking: Booking;
    try {
      booking = this.store.getBooking(bookingId);
    } catch {
      return fail("not_found", `Unknown booking ${bookingId}`);
    }
    if (isFixtureBooking(booking)) return { kind: "demo" };
    return this.resolveCapabilityAccount(booking.businessId, capability);
  }

  /** The businesses whose approved proposal payloads name this calendar. */
  private calendarReferents(calendarId: string): { businessIds: Set<string>; allFixture: boolean } {
    const businessIds = new Set<string>();
    let allFixture = true;
    const rows = this.store.db
      .prepare("SELECT booking_id, payload_json FROM proposed_actions")
      .all() as Array<{ booking_id: string; payload_json: string }>;
    for (const row of rows) {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(String(row.payload_json)) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (payload.calendarId !== calendarId) continue;
      try {
        const booking = this.store.getBooking(String(row.booking_id));
        businessIds.add(booking.businessId);
        if (!isFixtureBooking(booking)) allFixture = false;
      } catch {
        allFixture = false;
      }
    }
    return { businessIds, allFixture };
  }

  /** Availability scope: fixture calendar -> demo, otherwise exactly one live business must reference it. */
  resolveCalendarScope(calendarId: string): Resolution {
    const { businessIds, allFixture } = this.calendarReferents(calendarId);
    if (businessIds.size === 0) {
      return this.fixtureCalendars.has(calendarId)
        ? { kind: "demo" }
        : fail("not_found", `Calendar ${calendarId} is not bound to any verified connection`);
    }
    if (businessIds.size > 1) {
      return fail("conflict", `Calendar ${calendarId} is referenced by proposals in ${businessIds.size} businesses — scope is ambiguous`);
    }
    if (allFixture) return { kind: "demo" };
    return this.resolveCapabilityAccount([...businessIds][0], "google_calendar");
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
    const target = this.resolver.resolveBooking(request.bookingId, "google_calendar");
    if (target.kind === "demo") return this.demo.calendar.createProvisionalHold(request);
    if (target.kind === "fail") return failure(request.operationKey, target.error);
    return this.resolver.googleFor(target.account, request.calendarId).calendar.createProvisionalHold(request);
  }

  async reconcileProvisionalHold(request: OperationRequest): Promise<ConnectorResult<CreateProvisionalHoldResponse>> {
    const context = this.resolver.actionContextFor(request.operationKey);
    if (!context) {
      return failure(request.operationKey, { kind: "not_found", message: "No durable operation record for this hold key", retryable: false });
    }
    if (isFixtureBooking(context.booking)) return this.demo.calendar.reconcileProvisionalHold(request);
    const target = this.resolver.resolveCapabilityAccount(context.booking.businessId, "google_calendar");
    if (target.kind !== "live") return failure(request.operationKey, target.kind === "fail" ? target.error : { kind: "unsupported", message: "unreachable", retryable: false });
    const calendarId = isNonEmpty(context.action.payload.calendarId) ? context.action.payload.calendarId : undefined;
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
