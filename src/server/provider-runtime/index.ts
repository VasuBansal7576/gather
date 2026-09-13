import {
  DispatchingCalendar,
  DispatchingEmail,
  ProviderResolver,
  type ProviderConnectors,
  type ProviderRuntimeOptions,
} from "./dispatch.ts";
import { connectionServiceFor } from "./service.ts";

/**
 * Provider runtime composition: the single place where per-business,
 * server-controlled connector selection is assembled. `createProviderConnectors`
 * returns the dispatching calendar/email connectors the booking service
 * consumes, the shared ConnectionService, and `resolveAccountPorts` — the
 * composition hooks intake and operator assembly reuse later instead of
 * building a parallel registry.
 *
 * Boundaries: no credentials are read here; token supply is lazy per
 * authorized call, transports are injected (fetch in production, scripted in
 * tests), and disconnected/revoked/ambiguous bindings fail closed rather
 * than falling back to demo.
 */
export function createProviderConnectors(options: ProviderRuntimeOptions): ProviderConnectors {
  const connectionService =
    options.connectionService ??
    connectionServiceFor(options.store, { ownerId: options.ownerId, secretsNamespace: options.secretsNamespace });
  const resolver = new ProviderResolver({
    store: options.store,
    ownerId: options.ownerId,
    demo: options.demo,
    connectionService,
    ...(options.transport === undefined ? {} : { transport: options.transport }),
    ...(options.userId === undefined ? {} : { userId: options.userId }),
  });
  return {
    calendar: new DispatchingCalendar(resolver, options.demo),
    email: new DispatchingEmail(resolver, options.demo),
    connectionService,
    resolveAccountPorts: (input) => resolver.resolveAccountPorts(input),
  };
}

export {
  DispatchingCalendar,
  DispatchingEmail,
  ProviderResolver,
  type GoogleAccountPorts,
  type ProviderConnectors,
  type ProviderRuntimeOptions,
  type ReadCapability,
  type Resolution,
} from "./dispatch.ts";
export { connectionServiceFor, resetConnectionServicesForTests, type ConnectionServiceOptions } from "./service.ts";
