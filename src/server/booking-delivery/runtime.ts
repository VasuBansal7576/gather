import { getRuntime } from "../runtime.ts";
import type { BookingDeliveryDeps } from "./service.ts";
import { DeliveryStore } from "./store.ts";

/**
 * Delivery runtime wiring: the shared GatherStore database handle plus a
 * DeliveryStore holding its own tables on the same file. The availability
 * boundary is the configured connector (demo adapter here — its
 * attestations carry fictional provenance and can never produce
 * live-ready confirmation).
 */
let cached: { delivery: DeliveryStore; deps: BookingDeliveryDeps } | null = null;

export function getDeliveryRuntime(): { delivery: DeliveryStore; deps: BookingDeliveryDeps } {
  if (cached) return cached;
  const runtime = getRuntime();
  const delivery = new DeliveryStore(runtime.store.db);
  cached = {
    delivery,
    deps: {
      store: runtime.store,
      delivery,
      calendar: runtime.deps.calendar,
      ownerId: runtime.deps.ownerId,
      now: runtime.deps.now,
    },
  };
  return cached;
}

/** Test-only escape hatch to reset the cached runtime between cases. */
export function resetDeliveryRuntimeForTests(): void {
  cached = null;
}
