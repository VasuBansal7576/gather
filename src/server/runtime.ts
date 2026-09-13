import { createDemoConnectors, type DemoConnectorSet } from "../connectors/demo.ts";
import type { BookingServiceDeps } from "./booking-service.ts";
import { demoFixtureSlots } from "./demo-fixtures.ts";
import { DurableDemoCalendar, DurableDemoEmail } from "./durable-demo-connectors.ts";
import { GatherStore } from "./sqlite-store.ts";

/**
 * Server runtime wiring. Durable claims (businesses, bookings, proposals,
 * approvals, step executions with stable keys and provider receipts) live in
 * SQLite. The demo connector's in-memory world is volatile by design and is
 * never the source of truth for durable claims; execution result receipts
 * persisted in SQLite survive restarts while demo memory does not.
 */
export interface ServerRuntime {
  store: GatherStore;
  connectors: DemoConnectorSet;
  deps: BookingServiceDeps;
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
  const connectors = createDemoConnectors({ calendarSlots: demoFixtureSlots(), nowMs: clockMs });
  const deps: BookingServiceDeps = {
    store,
    calendar: new DurableDemoCalendar(store, connectors.calendar, clockMs),
    email: new DurableDemoEmail(store, connectors.email),
    ownerId: ownerId(),
    now: () => new Date(clockMs()).toISOString(),
  };
  cached = { store, connectors, deps };
  return cached;
}

/** Test-only escape hatch to reset the cached runtime between cases. */
export function resetRuntimeForTests(): void {
  cached = null;
}
