import { CoordinationLedger } from "../../coordination/ledger.ts";
import type { InquiryThread } from "../../connectors/contracts.ts";
import type { BookingServiceDeps } from "../booking-service.ts";
import type { ConnectionService } from "../connections/service.ts";
import type { ProviderConnectors } from "../provider-runtime/index.ts";
import type { GatherStore } from "../sqlite-store.ts";
import {
  getOperatorDepsFor,
  listOperatorAccounts,
  removeOperatorDeps,
  setOperatorDeps,
} from "../operator-runtime/host.ts";
import {
  getProactiveBinding,
  noteProactiveRevocation,
  removeProactiveBinding,
  startProactiveAccount,
  stopProactiveBinding,
  type OperatorRuntimeDeps,
  type ProactiveBindingState,
} from "../operator-runtime/index.ts";
import type { IntakeDeps } from "../operator-runtime/intake.ts";

/**
 * Production host bootstrap for durable inquiry capture (proactive
 * waiting). This module is the D-side assembly the proactive docs describe:
 * after setup/connection and on app (re)start it automatically registers
 * every eligible account — verified owner/business, active business, live
 * connected Gmail account with inbox+threads ports resolved by the
 * provider runtime — without the owner typing a prompt. It owns no
 * scheduler, agent graph, or database of its own: scheduling stays in
 * operator-runtime/automation.ts, durability in the shared SQLite store
 * and CoordinationLedger, provider composition in provider-runtime.
 *
 * Capture-only boundary: the registered sweep runs the guarded intake
 * sweep + due-work drain, which CAPTURE inquiries into durable rows. No
 * model generates offers anywhere on this path; offer generation belongs
 * to a later extraction/operator assembly, for which
 * `setExtractionAssemblyHook` is the explicit composition seam (pending
 * trigger wiring from that assembly).
 *
 * Truthfulness: nothing here claims watching/scheduled before a real
 * registration AND a first successful sweep (`watching` in status).
 * Unconfigured providers, account-less businesses, and demo-only setups
 * register nothing and trigger zero external calls — eligibility is
 * decided from durable rows only; token supply stays lazy inside the
 * resolved ports.
 */

export interface ProactiveHostOptions {
  store: GatherStore;
  ownerId: string;
  providers: ProviderConnectors;
  booking: BookingServiceDeps;
  connectionService: ConnectionService;
  intervalMs?: number;
  maxConsecutiveErrors?: number;
  clock?: () => number;
  now?: () => string;
  /**
   * Inbox provenance for the wired poller. Production default declares the
   * live Google source; scripted verification passes an explicit
   * simulated provenance so fixtures are never mistaken for live mail.
   */
  provenance?: { simulated: boolean; label: string };
  /**
   * Kill-switch: GATHER_PROACTIVE_DISABLE=1 (or true here) registers nothing
   * and drains already-managed bindings on every ensure/refresh. Durable
   * state and operator wiring survive so re-enable resumes cleanly.
   */
  disabled?: boolean;
}

/**
 * Composition seam for the later extraction/operator assembly: subscribers
 * are handed durable capture pointers (account/business/batch) once that
 * assembly wires its trigger. The sweep path itself stays capture-only —
 * registering a hook never enables model offer generation.
 */
export interface ProactiveCapturePointer {
  accountId: string;
  businessId: string;
  batchId?: string;
  at: string;
}

export type ExtractionAssemblyHook = (pointer: ProactiveCapturePointer) => void;

export interface ManagedAccountReport {
  businessId: string;
  accountId: string;
  connectionStatus: string;
  operatorWired: boolean;
  binding?: ProactiveBindingState;
  /** True only for a running binding whose latest sweep succeeded. */
  watching: boolean;
  paused: boolean;
}

export interface ProactiveHostReport {
  started: boolean;
  startedAt?: string;
  refreshedAt?: string;
  /** False when the provider app is not configured in this installation. */
  providerConfigured: boolean;
  accounts: ManagedAccountReport[];
  errors: Array<{ scope: string; message: string }>;
}

const DEFAULT_PROVENANCE = { simulated: false, label: "google-gmail" } as const;

let context: ProactiveHostOptions | undefined;
let bootstrapped = false;
let startedAt: string | undefined;
let refreshedAt: string | undefined;
const managed = new Map<string, { businessId: string }>();
const refreshErrors: Array<{ scope: string; message: string }> = [];
let extractionHook: ExtractionAssemblyHook | undefined;

/** Later extraction/operator assembly subscribes here; capture stays model-free. */
export function setExtractionAssemblyHook(hook: ExtractionAssemblyHook | undefined): void {
  extractionHook = hook;
}

export function getExtractionAssemblyHook(): ExtractionAssemblyHook | undefined {
  return extractionHook;
}

export function isWatching(binding: ProactiveBindingState | undefined): boolean {
  return binding !== undefined && binding.status === "running" && binding.lastOk === true;
}

/**
 * Emergency pause, honored on EVERY ensure/refresh — not just the first
 * bootstrap. `options.disabled` is refreshed by the caller's latest ensure;
 * the env kill-switch is re-read per call so `GATHER_PROACTIVE_DISABLE=1`
 * set after bootstrap still takes effect.
 */
function isDisabled(): boolean {
  return context?.disabled === true || process.env.GATHER_PROACTIVE_DISABLE === "1";
}

/** Stop every managed timer while keeping durable state and operator wiring. */
async function pauseAllManaged(drainTimeoutMs: number): Promise<void> {
  for (const accountId of [...managed.keys()]) {
    await stopManaged(accountId, "paused", drainTimeoutMs);
  }
}

function nowIso(): string {
  return context?.now ? context.now() : new Date().toISOString();
}

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function directoryFor(service: ConnectionService): OperatorRuntimeDeps["connections"] {
  return {
    getConnection(accountId: string) {
      try {
        for (const business of context?.store.listBusinesses() ?? []) {
          const summary = service.getConnections(business.id);
          for (const provider of summary.providers) {
            const found = provider.accounts.find((account) => account.id === accountId);
            if (found) return { provider: found.provider, status: found.status, businessId: business.id };
          }
        }
      } catch {
        return undefined;
      }
      return undefined;
    },
  };
}

async function stopManaged(accountId: string, reason: "paused" | "removed", drainTimeoutMs: number): Promise<void> {
  if (reason === "removed") {
    removeProactiveBinding(accountId);
    removeOperatorDeps(accountId);
    managed.delete(accountId);
    return;
  }
  await stopProactiveBinding(accountId, drainTimeoutMs).catch(() => undefined);
}

function revokeManaged(accountId: string, message: string): void {
  noteProactiveRevocation(accountId, message);
  removeOperatorDeps(accountId);
  managed.delete(accountId);
}

/**
 * Reconcile every business against live eligibility. One failing business
 * never blocks the others; failures are collected on the report. Idempotent:
 * re-running replaces timers and refreshes bindings without duplicating
 * sweeps or losing overlap protection.
 */
export async function refreshProactiveHost(drainTimeoutMs = 5000): Promise<ProactiveHostReport> {
  const errors: Array<{ scope: string; message: string }> = [];
  if (!context) {
    return { started: false, providerConfigured: false, accounts: [], errors };
  }
  const { store, ownerId, providers, booking, connectionService } = context;
  void ownerId;
  let providerConfigured = true;
  try {
    providerConfigured = connectionService
      .providerReadiness()
      .some((entry) => entry.provider === "google" && entry.status === "available");
  } catch (error) {
    providerConfigured = false;
    errors.push({ scope: "provider-readiness", message: errMessage(error) });
  }
  const eligible = new Set<string>();
  let businesses: Array<{ id: string; status: string }> = [];
  if (isDisabled()) {
    // Disabled before any registration: drain managed timers, keep durable
    // rows and operator deps so re-enable resumes without re-onboarding.
    await pauseAllManaged(drainTimeoutMs);
    refreshErrors.length = 0;
    refreshErrors.push(...errors);
    refreshedAt = nowIso();
    return buildReport(providerConfigured);
  }
  try {
    businesses = store.listBusinesses().map((business) => ({ id: business.id, status: business.status }));
  } catch (error) {
    errors.push({ scope: "list-businesses", message: errMessage(error) });
  }
  for (const business of businesses) {
    // A pause/unconfigure/ineligible branch above awaits per account; a
    // disable landing inside any of those awaits must stop this refresh
    // from reaching the next business's registration — the registration
    // itself performs a fresh token read. The post-loop drain then stops
    // anything already managed.
    if (isDisabled()) break;
    try {
      if (business.status !== "active") {
        for (const [accountId, meta] of managed) {
          if (meta.businessId === business.id) await stopManaged(accountId, "paused", drainTimeoutMs);
        }
        continue;
      }
      if (!providerConfigured) {
        await unconfigureBusiness(business.id);
        continue;
      }
      const resolved = providers.resolveAccountPorts({ businessId: business.id, capability: "gmail" });
      if (!resolved.ok || !resolved.ports.inbox || !resolved.ports.threads) {
        await handleIneligible(business.id, resolved.ok ? "gmail inbox/threads ports missing" : resolved.error.message);
        continue;
      }
      const account = resolved.ports.account;
      if (account.businessId !== business.id || account.status !== "connected") {
        await handleIneligible(business.id, `resolved account ${account.id} is not a connected account of this business`);
        continue;
      }
      const inbox = resolved.ports.inbox;
      const threads = resolved.ports.threads;
      const provenance = context.provenance ?? { ...DEFAULT_PROVENANCE };
      const threadAccount = account.id;
      const deps: IntakeDeps = {
        store,
        ledger: new CoordinationLedger(store.db),
        inbox: { pollInbox: inbox.pollInbox.bind(inbox), provenance },
        booking,
        accountId: account.id,
        businessId: business.id,
        ...(context.now === undefined ? {} : { now: context.now }),
        connections: directoryFor(connectionService),
        threads: {
          provenance,
          readThread: async (threadId: string): Promise<InquiryThread | undefined> => {
            const result = await threads.readInquiryThread({
              operationKey: `proactive-intake:${threadAccount}:thread:${threadId}`,
              threadId,
            });
            return result.status === "succeeded" ? result.data.thread : undefined;
          },
        },
      };
      setOperatorDeps(deps);
      startProactiveAccount({
        runtime: deps,
        ...(context.intervalMs === undefined ? {} : { intervalMs: context.intervalMs }),
        ...(context.maxConsecutiveErrors === undefined ? {} : { maxConsecutiveErrors: context.maxConsecutiveErrors }),
        ...(context.clock === undefined ? {} : { clock: context.clock }),
      });
      managed.set(account.id, { businessId: business.id });
      eligible.add(account.id);
    } catch (error) {
      errors.push({ scope: `business:${business.id}`, message: errMessage(error) });
    }
  }
  for (const [accountId, meta] of [...managed]) {
    if (eligible.has(accountId)) continue;
    try {
      const known = businesses.some((business) => business.id === meta.businessId);
      if (known) continue; // handled above (paused/unconfigured paths manage it)
      await stopManaged(accountId, "removed", drainTimeoutMs);
    } catch (error) {
      errors.push({ scope: `account:${accountId}`, message: errMessage(error) });
    }
  }
  // A disable that landed while this refresh was in flight must not leave
  // freshly registered timers running: drain again before reporting.
  if (isDisabled()) {
    await pauseAllManaged(drainTimeoutMs);
  }
  refreshErrors.length = 0;
  refreshErrors.push(...errors);
  refreshedAt = nowIso();
  return buildReport(providerConfigured);
}

async function unconfigureBusiness(businessId: string): Promise<void> {
  for (const [accountId, meta] of [...managed]) {
    if (meta.businessId === businessId) await stopManaged(accountId, "removed", 0);
  }
}

async function handleIneligible(businessId: string, message: string): Promise<void> {
  if (!context) return;
  let revoked: string[] = [];
  try {
    const summary = context.connectionService.getConnections(businessId);
    for (const provider of summary.providers) {
      for (const account of provider.accounts) {
        if (account.provider === "gmail" && (account.status === "revoked" || account.status === "error")) {
          revoked.push(account.id);
        }
      }
    }
  } catch {
    revoked = [];
  }
  for (const accountId of revoked) {
    if (managed.has(accountId) || getProactiveBinding(accountId) !== undefined) {
      revokeManaged(accountId, `gmail connection revoked for this business: ${message}`);
    }
  }
  for (const [accountId, meta] of [...managed]) {
    if (meta.businessId === businessId && !revoked.includes(accountId)) {
      await stopManaged(accountId, "removed", 0);
    }
  }
}

function buildReport(providerConfigured: boolean): ProactiveHostReport {
  const accounts: ManagedAccountReport[] = [];
  for (const accountId of listOperatorAccounts()) {
    const deps = getOperatorDepsFor(accountId);
    if (!deps) continue;
    const binding = getProactiveBinding(accountId);
    const paused = (() => {
      try {
        return context?.store.getBusiness(deps.businessId).status === "paused";
      } catch {
        return false;
      }
    })();
    accounts.push({
      businessId: deps.businessId,
      accountId,
      connectionStatus: deps.connections?.getConnection(accountId)?.status ?? "unknown",
      operatorWired: true,
      ...(binding === undefined ? {} : { binding }),
      watching: isWatching(binding),
      paused,
    });
  }
  for (const [accountId, meta] of managed) {
    if (accounts.some((entry) => entry.accountId === accountId)) continue;
    const binding = getProactiveBinding(accountId);
    accounts.push({
      businessId: meta.businessId,
      accountId,
      connectionStatus: "unknown",
      operatorWired: false,
      ...(binding === undefined ? {} : { binding }),
      watching: false,
      paused: false,
    });
  }
  accounts.sort((left, right) => left.accountId.localeCompare(right.accountId));
  return {
    started: bootstrapped,
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(refreshedAt === undefined ? {} : { refreshedAt }),
    providerConfigured,
    accounts,
    errors: [...refreshErrors],
  };
}

/** Current host truth without side effects. */
export function proactiveHostStatus(): ProactiveHostReport {
  if (!context) return { started: false, providerConfigured: false, accounts: [], errors: [] };
  let providerConfigured = false;
  try {
    providerConfigured = context.connectionService
      .providerReadiness()
      .some((entry) => entry.provider === "google" && entry.status === "available");
  } catch {
    providerConfigured = false;
  }
  return buildReport(providerConfigured);
}

/**
 * Lazy host entry: call once per process (server boot). Guards everything —
 * a failed bootstrap never breaks boot — and honors the disable kill-switch.
 * Connection-callback, disconnect, and setup routes call
 * `refreshProactiveHost()` afterwards so bindings track lifecycle without
 * any owner-typed prompt.
 */
export function ensureProactiveHost(options: ProactiveHostOptions): void {
  context = options;
  if (!bootstrapped) {
    bootstrapped = true;
    startedAt = options.now ? options.now() : new Date().toISOString();
  }
  // refreshProactiveHost gates on the disable switch itself, so every call
  // — initial bootstrap, later ensures, and route-triggered refreshes —
  // honors the emergency pause uniformly.
  void refreshProactiveHost().catch(() => undefined);
}

/** Bounded shutdown: stop every managed timer with a real-time drain bound. No orphaned timers. */
export async function stopProactiveHost(drainTimeoutMs = 5000): Promise<ProactiveHostReport> {
  for (const accountId of [...managed.keys()]) {
    await stopProactiveBinding(accountId, drainTimeoutMs).catch(() => undefined);
  }
  bootstrapped = false;
  if (!context) return { started: false, providerConfigured: false, accounts: [], errors: [] };
  return buildReport(false);
}

/** Test-only reset of host state (registries reset separately by callers). */
export function resetProactiveHostForTests(): void {
  context = undefined;
  bootstrapped = false;
  startedAt = undefined;
  refreshedAt = undefined;
  managed.clear();
  refreshErrors.length = 0;
  extractionHook = undefined;
}
