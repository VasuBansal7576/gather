import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { createDemoConnectors, type DemoConnectorSet } from "../connectors/demo.ts";
import { IntentService } from "../intents/index.ts";
import type { BookingServiceDeps } from "./booking-service.ts";
import { demoFixtureSlots, preparedFixtureSlots } from "./demo-fixtures.ts";
import { DurableDemoCalendar, DurableDemoEmail } from "./durable-demo-connectors.ts";
import { createLiveAcceptanceValidator, liveAcceptanceWired } from "./live-model/acceptance-callback.ts";
import { liveGateReport } from "./live-model/live-status.ts";
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
  /**
   * The one durable-intent progression owner (ADR-002 / C06). Composes the
   * existing operator drain, CoordinationLedger, and action-execution
   * claims; it owns no scheduler of its own — process lifecycle stays in
   * this host and periodic drain rides the proactive binding's tick.
   */
  intents: IntentService;
}

let cached: ServerRuntime | null = null;

/* --------------------------------------------------------------------
 * Mode and path selection (ADR-001 / C01). Managed installs set
 * GATHER_INSTALL_ROOT (the writable directory the packaged CLI resolved
 * from the invocation directory); every Gather state path then lives under
 * <root>/.runtime/<mode>/. An explicit GATHER_DATABASE_PATH is still an
 * honoured developer override — but inside a managed install it may never
 * reach into the other mode's state directory, and reset tooling refuses
 * to touch it. With neither variable set the historical developer default
 * data/gather.sqlite is preserved, unmigrated.
 * ------------------------------------------------------------------ */

export type GatherMode = "prepared" | "live";

export class ModePathError extends Error {
  readonly code = "MODE_PATH_DENIED" as const;
}

function isInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/** The writable installation root, or undefined for unmanaged source-tree runs. */
export function installationRoot(): string | undefined {
  const raw = process.env.GATHER_INSTALL_ROOT;
  return raw !== undefined && raw.trim().length > 0 ? resolve(raw) : undefined;
}

export function isManagedInstall(): boolean {
  return installationRoot() !== undefined;
}

/** Selected mode; managed installs default to prepared. Invalid values fail loudly. */
export function gatherMode(): GatherMode {
  const raw = (process.env.GATHER_MODE ?? "").trim().toLowerCase();
  if (raw === "live") return "live";
  if (raw === "" || raw === "prepared") return "prepared";
  throw new ModePathError(`Unsupported GATHER_MODE "${raw}"; expected "prepared" or "live".`);
}

/**
 * The mode's state directory beneath the installation root. Refuses a
 * symlinked .runtime or mode directory so state can never escape the root.
 */
export function modeStateDir(root: string, mode: GatherMode): string {
  const runtimeDir = join(root, ".runtime");
  for (const candidate of [runtimeDir, join(runtimeDir, mode)]) {
    try {
      if (lstatSync(candidate).isSymbolicLink()) {
        throw new ModePathError(`Refusing symlinked state path: ${candidate}`);
      }
    } catch (error) {
      if (error instanceof ModePathError) throw error;
      // Missing directories are created below.
    }
  }
  const modeDir = join(runtimeDir, mode);
  mkdirSync(modeDir, { recursive: true });
  const realRuntime = realpathSync(runtimeDir);
  const realMode = realpathSync(modeDir);
  if (!isInside(realMode, realRuntime)) {
    throw new ModePathError(`Mode state directory escapes its runtime root: ${modeDir}`);
  }
  return modeDir;
}

export function databasePath(): string {
  const custom = process.env.GATHER_DATABASE_PATH;
  const root = installationRoot();
  if (custom !== undefined && custom.trim().length > 0) {
    const resolved = resolve(custom);
    if (root !== undefined) {
      const other: GatherMode = gatherMode() === "prepared" ? "live" : "prepared";
      const otherDir = join(root, ".runtime", other);
      if (isInside(resolved, otherDir)) {
        throw new ModePathError(
          `GATHER_DATABASE_PATH points into the ${other} mode's state; the two mode roots cannot access each other.`,
        );
      }
    }
    return custom;
  }
  if (root !== undefined) return join(modeStateDir(root, gatherMode()), "gather.sqlite");
  return "data/gather.sqlite";
}

export interface RuntimeModeInfo {
  managed: boolean;
  mode: GatherMode;
  installRoot?: string;
  stateDir?: string;
  databasePath: string;
  customDatabasePath: boolean;
  /** Live onboarding stays disabled until ADR-006 passes; never flip here. */
  liveEnabled: false;
}

export function runtimeModeInfo(): RuntimeModeInfo {
  const root = installationRoot();
  const mode = gatherMode();
  const custom = process.env.GATHER_DATABASE_PATH;
  const hasCustom = custom !== undefined && custom.trim().length > 0;
  const info: RuntimeModeInfo = {
    managed: root !== undefined,
    mode,
    databasePath: databasePath(),
    customDatabasePath: hasCustom,
    liveEnabled: false,
  };
  if (root !== undefined) {
    info.installRoot = root;
    info.stateDir = modeStateDir(root, mode);
  }
  return info;
}

/**
 * Managed installs hold exactly one business per mode. Returns an owner-
 * readable denial when a second, distinct business would be created; the
 * existing idempotent same-name/timezone retry stays allowed.
 */
export function secondBusinessDenial(store: GatherStore, name: string, timezone: string): string | undefined {
  if (!isManagedInstall()) return undefined;
  const existing = store.listBusinesses();
  if (existing.length === 0) return undefined;
  const same = existing.some((business) => business.name === name && business.timezone === timezone);
  if (same) return undefined;
  return "This installation runs one venue per mode. Reset the prepared state or switch modes instead of adding a second venue.";
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
  const managedPrepared = isManagedInstall() && gatherMode() === "prepared";
  const connectors = createDemoConnectors({
    // Managed prepared installs hydrate the demo calendar world from the
    // durably seeded scenario (busy blocks and open windows survive
    // restarts); unmanaged runs keep the legacy static fixture slots.
    calendarSlots: managedPrepared ? preparedFixtureSlots(store) : demoFixtureSlots(),
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
  const intents = new IntentService({
    booking: deps,
    mode: gatherMode(),
    now: () => new Date(clockMs()).toISOString(),
  });
  cached = { store, connectors, deps, providers, intents };
  // Lazy host entry: on first boot in this process, automatically register
  // every eligible connected Gmail account for durable inquiry capture.
  // Best-effort by design — a failed bootstrap never breaks boot — and a
  // no-op for unconfigured, account-less, or demo-only setups (no external
  // calls). Connection/setup lifecycle routes refresh explicitly afterwards.
  //
  // ADR-006 composition: the deferred ADR-011 live inbound mailbox callback
  // (acceptance-reply validator) rides the same bootstrap behind the same
  // live gate. Prepared installs wire nothing — token-looking fixtures stay
  // inert and the sweep keeps capture-only behavior. The gate read itself
  // performs no provider calls; a failed read wires nothing and never
  // breaks boot.
  let liveAcceptance: Parameters<typeof ensureProactiveHost>[0]["acceptance"] | undefined;
  try {
    const gate = liveGateReport(
      {
        store,
        providerReadiness: () => {
          try {
            return providers.connectionService.providerReadiness();
          } catch {
            return [];
          }
        },
      },
      "base",
    );
    if (liveAcceptanceWired({ mode: gatherMode(), liveGatePasses: gate.liveReady })) {
      liveAcceptance = createLiveAcceptanceValidator({ store, liveTransport: true });
    }
  } catch {
    liveAcceptance = undefined;
  }
  try {
    ensureProactiveHost({
      store,
      ownerId: ownerId(),
      providers,
      booking: deps,
      connectionService: providers.connectionService,
      // A managed prepared install is fully simulated; anything the host
      // wires there must never be labelled as live provider mail.
      ...(managedPrepared ? { provenance: { simulated: true, label: "prepared-fixture" } } : {}),
      ...(liveAcceptance === undefined ? {} : { acceptance: liveAcceptance }),
      // The intent progression owner drains inside the binding's existing
      // guarded tick — one scheduler per account, never a second timer.
      drainIntents: async (businessId) => intents.drainDue({ owner: "proactive-sweep", businessId }),
    });
  } catch {
    // Boot proceeds; the automation status route reports the truth.
  }
  // Restart reconciliation for the intent lane (ADR-002 step 1): every
  // `running` intent's prior claim owner is dead at process start. Effects
  // are checked read-only before the row is reclaimed — never blind-retried.
  // Best-effort: a recovery failure never blocks boot, and the next sweep
  // (or explicit advance) re-derives the same evidence-driven states.
  void intents.recoverInterrupted().catch(() => undefined);
  return cached;
}

/** Test-only escape hatch to reset the cached runtime between cases. */
export function resetRuntimeForTests(): void {
  cached = null;
  resetProactiveHostForTests();
}
