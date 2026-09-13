import type {
  CalendarAvailabilityReader,
  CheckAvailabilityRequest,
  CheckAvailabilityResponse,
  ConnectorResult,
  CreateProvisionalHoldRequest,
  CreateProvisionalHoldResponse,
  EmailSender,
  OperationRequest,
  ProvisionalHoldWriter,
  SendEmailRequest,
  SendEmailResponse,
} from "../connectors/contracts.ts";
import type {
  DemoCalendarConnector,
  DemoEmailConnector,
} from "../connectors/demo.ts";
import { GatherStore } from "./sqlite-store.ts";

function holdMatches(receipt: Record<string, unknown>, request: CreateProvisionalHoldRequest): boolean {
  const hold = (receipt.hold ?? receipt) as Record<string, unknown>;
  return (
    hold.bookingId === request.bookingId &&
    hold.calendarId === request.calendarId &&
    hold.startAt === request.startAt &&
    hold.endAt === request.endAt &&
    hold.expiresAt === request.expiresAt
  );
}

function emailMatches(receipt: Record<string, unknown>, request: SendEmailRequest): boolean {
  const sent = (receipt.sentEmail ?? receipt) as Record<string, unknown>;
  return (
    JSON.stringify(sent.to ?? null) === JSON.stringify(request.to) &&
    (sent.threadId ?? undefined) === request.threadId &&
    sent.subject === request.subject &&
    sent.body === request.body
  );
}

/**
 * Durable wrappers around the volatile in-memory demo adapters. Every
 * completed provider write is persisted to SQLite (first write wins per
 * stable operation key), including writes whose response was lost, so
 * reconciliation after a restart or adapter rebuild reads durable receipts
 * instead of relying on the same in-memory adapter instance.
 *
 * This proves SQLite durability of the simulation; it is not a claim about
 * real external provider restart behavior.
 */
export class DurableDemoCalendar implements CalendarAvailabilityReader, ProvisionalHoldWriter {
  private readonly store: GatherStore;
  private readonly demo: DemoCalendarConnector;
  private readonly clockMs: () => number;

  constructor(store: GatherStore, demo: DemoCalendarConnector, clockMs: () => number = Date.now) {
    this.store = store;
    this.demo = demo;
    this.clockMs = clockMs;
  }

  checkAvailability(request: CheckAvailabilityRequest): Promise<ConnectorResult<CheckAvailabilityResponse>> {
    return this.demo.checkAvailability(request);
  }

  async createProvisionalHold(
    request: CreateProvisionalHoldRequest,
  ): Promise<ConnectorResult<CreateProvisionalHoldResponse>> {
    const prior = this.store.getProviderReceipt(request.operationKey);
    if (prior?.kind === "hold") {
      if (holdMatches(prior.receipt, request)) {
        const data = prior.receipt as unknown as CreateProvisionalHoldResponse;
        return {
          status: "succeeded",
          metadata: { operationKey: request.operationKey, mode: { mode: "demo", label: "DEMO ONLY", fictional: true }, simulated: true, sourceReferences: data.provenance ?? [] },
          data,
        };
      }
      return {
        status: "failed",
        metadata: { operationKey: request.operationKey, mode: { mode: "demo", label: "DEMO ONLY", fictional: true }, simulated: true, sourceReferences: [] },
        error: { kind: "conflict", message: "The operation key is already associated with a different hold payload", retryable: false },
      };
    }
    // Durable conflict gate (C4): a fresh volatile world may admit a window
    // that SQLite already gave to another booking — refuse before any write.
    // The injected clock keeps this consistent with the service availability
    // pre-check in the same process and across restarts.
    const claim = this.store.claimHoldSlot(request.operationKey, request.calendarId, request.startAt, request.endAt, { nowMs: this.clockMs() });
    if (!claim.ok) {
      return {
        status: "failed",
        metadata: { operationKey: request.operationKey, mode: { mode: "demo", label: "DEMO ONLY", fictional: true }, simulated: true, sourceReferences: [] },
        error: { kind: "conflict", message: `Demo calendar window is already held (durable record ${claim.conflictingKey})`, retryable: false },
      };
    }
    let result: ConnectorResult<CreateProvisionalHoldResponse>;
    try {
      result = await this.demo.createProvisionalHold(request);
    } catch (error) {
      this.store.releaseHoldSlot(request.operationKey);
      throw error;
    }
    if (result.status === "succeeded") {
      this.store.saveProviderReceipt("hold", request.operationKey, result.data as unknown as Record<string, unknown>);
      // The durable receipt now carries the evidence; the provisional intent
      // is no longer needed and is released so history stays compact.
      this.store.releaseHoldSlot(request.operationKey);
      return result;
    }
    if (result.status === "uncertain") {
      // The demo write completed in volatile memory but its response was
      // lost: capture the durable copy now so a later rebuild can reconcile.
      const found = await this.demo.reconcileProvisionalHold({ operationKey: request.operationKey });
      if (found.status === "succeeded") {
        this.store.saveProviderReceipt("hold", request.operationKey, found.data as unknown as Record<string, unknown>);
      }
      return result;
    }
    // Definitive failure: no provider effect, so release the durable intent
    // and let a later retry re-evaluate the window honestly.
    this.store.releaseHoldSlot(request.operationKey);
    return result;
  }

  async reconcileProvisionalHold(
    request: OperationRequest,
  ): Promise<ConnectorResult<CreateProvisionalHoldResponse>> {
    const prior = this.store.getProviderReceipt(request.operationKey);
    if (prior?.kind === "hold") {
      const data = prior.receipt as unknown as CreateProvisionalHoldResponse;
      return {
        status: "succeeded",
        metadata: { operationKey: request.operationKey, mode: { mode: "demo", label: "DEMO ONLY", fictional: true }, simulated: true, sourceReferences: data.provenance ?? [] },
        data,
      };
    }
    return this.demo.reconcileProvisionalHold(request);
  }
}

export class DurableDemoEmail implements EmailSender {
  private readonly store: GatherStore;
  private readonly demo: DemoEmailConnector;

  constructor(store: GatherStore, demo: DemoEmailConnector) {
    this.store = store;
    this.demo = demo;
  }

  async sendEmail(request: SendEmailRequest): Promise<ConnectorResult<SendEmailResponse>> {
    const prior = this.store.getProviderReceipt(request.operationKey);
    if (prior?.kind === "email") {
      if (emailMatches(prior.receipt, request)) {
        const data = prior.receipt as unknown as SendEmailResponse;
        return {
          status: "succeeded",
          metadata: { operationKey: request.operationKey, mode: { mode: "demo", label: "DEMO ONLY", fictional: true }, simulated: true, sourceReferences: data.provenance ?? [] },
          data,
        };
      }
      return {
        status: "failed",
        metadata: { operationKey: request.operationKey, mode: { mode: "demo", label: "DEMO ONLY", fictional: true }, simulated: true, sourceReferences: [] },
        error: { kind: "conflict", message: "The operation key is already associated with a different email payload", retryable: false },
      };
    }
    const result = await this.demo.sendEmail(request);
    if (result.status === "succeeded") {
      this.store.saveProviderReceipt("email", request.operationKey, result.data as unknown as Record<string, unknown>);
      return result;
    }
    if (result.status === "uncertain") {
      const found = await this.demo.reconcileSentEmail({ operationKey: request.operationKey });
      if (found.status === "succeeded") {
        this.store.saveProviderReceipt("email", request.operationKey, found.data as unknown as Record<string, unknown>);
      }
      return result;
    }
    return result;
  }

  async reconcileSentEmail(request: OperationRequest): Promise<ConnectorResult<SendEmailResponse>> {
    const prior = this.store.getProviderReceipt(request.operationKey);
    if (prior?.kind === "email") {
      const data = prior.receipt as unknown as SendEmailResponse;
      return {
        status: "succeeded",
        metadata: { operationKey: request.operationKey, mode: { mode: "demo", label: "DEMO ONLY", fictional: true }, simulated: true, sourceReferences: data.provenance ?? [] },
        data,
      };
    }
    return this.demo.reconcileSentEmail(request);
  }
}
