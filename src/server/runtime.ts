import { createDemoConnectors, type DemoConnectorSet } from "../connectors/demo.ts";
import type { BookingServiceDeps } from "./booking-service.ts";
import { demoFixtureSlots } from "./demo-fixtures.ts";
import { DurableDemoCalendar, DurableDemoEmail } from "./durable-demo-connectors.ts";
import { createProviderConnectors, type ProviderConnectors } from "./provider-runtime/index.ts";
import { ensureProactiveHost, resetProactiveHostForTests } from "./proactive/index.ts";
import { GatherStore } from "./sqlite-store.ts";

/**
 * Server runtime wiring. Durable claims (businesses, bookings, proposals,
 * approvals, step executions with stable keys and provider receipts) live in
 * SQLite. The demo connector's in-memory world is volatile by design and is
 * never the source of truth for durable claims; execution result receipts
 * persisted in SQLite survive restarts while demo memory does not.
 *
 * The booking deps are dispatching connectors: explicitly fictional fixture
 * bookings stay on the durable demo adapters, while real bookings resolve
 * their business's verified connection per call — disconnected, revoked, or
 * ambiguous bindings fail closed instead of silently simulating.
 */
export interface ServerRuntime {
  store: GatherStore;
  connectors: DemoConnectorSet;
  deps: BookingServiceDeps;
  /** Composition hook for later intake/operator assembly. */
  providers: ProviderConnectors;
}

let cached: ServerRuntime | null = null;

export function databasePath(): string {
  return process.env.GATHER_DATABASE_PATH ?? "data/gather.sqlite";
}

export function ownerId(): string {
  const value = process.env.GATHER_OWNER_ID ?? "local-owner";
  return value.trim().length > 0 ? value : "local-owner";
}

export function getRuntime(): ServerRuntime {
  if (cached) return cached;
  // One shared wall-clock source for the demo store, the durable wrappers,
  // and the service clock, so simulated expiry agrees everywhere.
  const clockMs = (): number => Date.now();
  const store = new GatherStore(databasePath());
  // GATHER_DEMO_TIMEOUT_KEYS (comma-separated stable operation keys) marks
  // writes that complete in the demo world but report an uncertain timeout,
  // so uncertain/partial recovery can be exercised end-to-end over HTTP.
  const timeoutKeys = (process.env.GATHER_DEMO_TIMEOUT_KEYS ?? "")
    .split(",")
    .map((key) => key.trim())
    .filter((key) => key.length > 0);
  const connectors = createDemoConnectors({
    calendarSlots: demoFixtureSlots(),
    nowMs: clockMs,
    timeoutAfterSuccessOperationKeys: timeoutKeys,
  });
  const providers = createProviderConnectors({
    store,
    ownerId: ownerId(),
    demo: {
      calendar: new DurableDemoCalendar(store, connectors.calendar, clockMs),
      email: new DurableDemoEmail(store, connectors.email),
    },
    secretsNamespace: databasePath(),
  });
  const deps: BookingServiceDeps = {
    store,
    calendar: providers.calendar,
    email: providers.email,
    ownerId: ownerId(),
    now: () => new Date(clockMs()).toISOString(),
  };
  cached = { store, connectors, deps, providers };
  // Lazy host entry: on first boot in this process, automatically register
  // every eligible connected Gmail account for durable inquiry capture.
  // Best-effort by design — a failed bootstrap never breaks boot — and a
  // no-op for unconfigured, account-less, or demo-only setups (no external
  // calls). Connection/setup lifecycle routes refresh explicitly afterwards.
  try {
    ensureProactiveHost({
      store,
      ownerId: ownerId(),
      providers,
      booking: deps,
      connectionService: providers.connectionService,
    });
  } catch {
    // Boot proceeds; the automation status route reports the truth.
  }
  return cached;
}

/** Test-only escape hatch to reset the cached runtime between cases. */
export function resetRuntimeForTests(): void {
  cached = null;
  resetProactiveHostForTests();
}
