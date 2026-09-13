import type { CalendarAvailabilityReader } from "../../connectors/contracts.ts";
import type {
  AcceptanceRecord,
  AvailabilityAttestation,
  ConfirmationPolicy,
  DepositReceipt,
  OwnerWaiver,
  ResourceCommitment,
} from "../../delivery/contracts.ts";
import { assertConditionConfig } from "../../delivery/contracts.ts";
import type {
  AcceptanceQuery,
  AvailabilityQuery,
  DeliveryVerifiers,
  DepositQuery,
  PolicyQuery,
  ResourceQuery,
  WaiverQuery,
} from "../../delivery/verifiers.ts";
import { DeliveryStore } from "./store.ts";

/**
 * Host-side trusted resolver boundary over persisted, attributable
 * evidence. Raw request payloads never reach the evaluator: proofs are
 * fetched here, scoped to the exact business/booking/version binding.
 * Availability additionally delegates to the injected calendar provider
 * reader so attestations carry real (or fixture) provider provenance —
 * a fixture adapter yields fictional refs and can never produce
 * live-ready evidence.
 *
 * Store-backed fetches expose synchronous twins (`*Sync`) so the atomic
 * confirm transaction can re-run them inside the transaction without an
 * await; the async methods are thin wrappers over the same reads.
 */
export class StoreDeliveryVerifiers implements DeliveryVerifiers {
  private readonly delivery: DeliveryStore;
  private readonly calendar?: CalendarAvailabilityReader;
  private readonly now: () => string;

  constructor(delivery: DeliveryStore, calendar?: CalendarAvailabilityReader, now: () => string = () => new Date().toISOString()) {
    this.delivery = delivery;
    this.calendar = calendar;
    this.now = now;
  }

  loadPolicySync(query: PolicyQuery): ConfirmationPolicy {
    const policy = this.delivery.getPolicy(query.businessId);
    if (!policy) {
      throw new Error(`No confirmation policy persisted for business ${query.businessId}; confirmation readiness is unavailable until one is configured`);
    }
    policy.conditions.forEach(assertConditionConfig);
    return policy;
  }

  async loadPolicy(query: PolicyQuery): Promise<ConfirmationPolicy> {
    return this.loadPolicySync(query);
  }

  fetchAcceptanceSync(query: AcceptanceQuery): AcceptanceRecord[] {
    // Business/booking scoped only — version binding stays with the
    // evaluator, which must see records for other versions to report a
    // cross-version conflict instead of a bare "missing".
    return this.delivery.listAcceptance(query.businessId, query.bookingId);
  }

  async fetchAcceptance(query: AcceptanceQuery): Promise<AcceptanceRecord[]> {
    return this.fetchAcceptanceSync(query);
  }

  fetchDepositReceiptsSync(query: DepositQuery): DepositReceipt[] {
    return this.delivery.listDepositReceipts(query.businessId, query.bookingId);
  }

  async fetchDepositReceipts(query: DepositQuery): Promise<DepositReceipt[]> {
    return this.fetchDepositReceiptsSync(query);
  }

  fetchResourceCommitmentsSync(query: ResourceQuery): ResourceCommitment[] {
    return this.delivery.listResourceCommitments(query.businessId, query.bookingId, query.resourceIds);
  }

  async fetchResourceCommitments(query: ResourceQuery): Promise<ResourceCommitment[]> {
    return this.fetchResourceCommitmentsSync(query);
  }

  fetchWaiversSync(query: WaiverQuery): OwnerWaiver[] {
    return this.delivery.listWaivers(query.businessId, query.bookingId);
  }

  async fetchWaivers(query: WaiverQuery): Promise<OwnerWaiver[]> {
    return this.fetchWaiversSync(query);
  }

  async fetchAvailability(query: AvailabilityQuery): Promise<AvailabilityAttestation[]> {
    if (!this.calendar) {
      throw new Error("No availability provider is configured; availability cannot be verified");
    }
    const result = await this.calendar.checkAvailability({
      operationKey: `delivery-availability:${query.calendarId}:${query.startAt}:${query.endAt}`,
      calendarId: query.calendarId,
      startAt: query.startAt,
      endAt: query.endAt,
    });
    if (result.status !== "succeeded") {
      throw new Error(`Availability provider could not verify the window: ${result.error.message}`);
    }
    const observedAt = this.now();
    // One attestation per observed slot; provenance travels with the
    // provider response — fixture slots carry fictional refs.
    return result.data.slots.map((slot, index) => ({
      resolver: "calendar_provider" as const,
      calendarId: slot.calendarId ?? query.calendarId,
      startAt: slot.startAt,
      endAt: slot.endAt,
      available: slot.available,
      observedAt,
      sourceRefs: [
        ...(slot.sourceReferences ?? []),
        ...result.data.provenance,
        {
          kind: "calendar" as const,
          locator: `availability:${query.calendarId}:${index}`,
          // The read locator inherits the provider's declared provenance:
          // a simulated adapter can never mint a live-looking reference.
          ...(result.metadata.simulated ? { fictional: true as const } : {}),
        },
      ],
    }));
  }
}

/**
 * Records every verified fetch result during evaluation. Inside the
 * atomic confirm transaction the same store-backed queries are re-run
 * synchronously and compared verbatim — evidence that drifted while
 * provider calls were in flight fails closed instead of confirming on a
 * stale snapshot.
 */
export class CollectingVerifiers implements DeliveryVerifiers {
  readonly fetched = new Map<string, unknown>();
  readonly queries = new Map<string, unknown>();
  private readonly inner: StoreDeliveryVerifiers;

  constructor(inner: StoreDeliveryVerifiers) {
    this.inner = inner;
  }

  private async record<T>(name: string, query: unknown, run: () => Promise<T[]>): Promise<T[]> {
    const result = await run();
    this.fetched.set(name, result);
    this.queries.set(name, query);
    return result;
  }

  async loadPolicy(query: PolicyQuery): Promise<ConfirmationPolicy> {
    const policy = await this.inner.loadPolicy(query);
    this.fetched.set("loadPolicy", policy);
    this.queries.set("loadPolicy", query);
    return policy;
  }

  fetchAcceptance(query: AcceptanceQuery): Promise<AcceptanceRecord[]> {
    return this.record("fetchAcceptance", query, () => this.inner.fetchAcceptance(query));
  }

  fetchDepositReceipts(query: DepositQuery): Promise<DepositReceipt[]> {
    return this.record("fetchDepositReceipts", query, () => this.inner.fetchDepositReceipts(query));
  }

  fetchAvailability(query: AvailabilityQuery): Promise<AvailabilityAttestation[]> {
    return this.record("fetchAvailability", query, () => this.inner.fetchAvailability(query));
  }

  fetchResourceCommitments(query: ResourceQuery): Promise<ResourceCommitment[]> {
    return this.record("fetchResourceCommitments", query, () => this.inner.fetchResourceCommitments(query));
  }

  fetchWaivers(query: WaiverQuery): Promise<OwnerWaiver[]> {
    return this.record("fetchWaivers", query, () => this.inner.fetchWaivers(query));
  }

  /**
   * Re-run every store-backed fetch synchronously inside the confirm
   * transaction. Availability is a provider call — it is not re-fetched
   * here; the durable hold-conflict check guards it instead. Returns the
   * names whose stored evidence changed since evaluation.
   */
  driftedStoreFetches(): string[] {
    const drifted: string[] = [];
    const compare = (name: string, current: unknown): void => {
      if (!this.fetched.has(name)) return;
      if (JSON.stringify(this.fetched.get(name)) !== JSON.stringify(current)) drifted.push(name);
    };
    try {
      const acceptance = this.queries.get("fetchAcceptance") as AcceptanceQuery | undefined;
      if (acceptance) compare("fetchAcceptance", this.inner.fetchAcceptanceSync(acceptance));
      const deposits = this.queries.get("fetchDepositReceipts") as DepositQuery | undefined;
      if (deposits) compare("fetchDepositReceipts", this.inner.fetchDepositReceiptsSync(deposits));
      const resources = this.queries.get("fetchResourceCommitments") as ResourceQuery | undefined;
      if (resources) compare("fetchResourceCommitments", this.inner.fetchResourceCommitmentsSync(resources));
      const waivers = this.queries.get("fetchWaivers") as WaiverQuery | undefined;
      if (waivers) compare("fetchWaivers", this.inner.fetchWaiversSync(waivers));
      const policy = this.queries.get("loadPolicy") as PolicyQuery | undefined;
      if (policy) compare("loadPolicy", this.inner.loadPolicySync(policy));
    } catch (error) {
      drifted.push(`revalidation read failed: ${error instanceof Error ? error.message : "unknown"}`);
    }
    return drifted;
  }
}
