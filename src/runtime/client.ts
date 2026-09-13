import { connect as connectTcp } from "node:net";
import {
  GatewayClient,
  GatewayClientRequestError,
  GatewayClientRequestTimeoutError,
  type GatewayClientOptions,
  type GatewayReconnectPausedInfo,
} from "@openclaw/gateway-client";
import type { EventFrame, HelloOk } from "@openclaw/gateway-protocol";

/**
 * Thin operator client over the published @openclaw/gateway-client package.
 * Implements the supported external-app path:
 * https://docs.openclaw.ai/gateway/external-apps — connect over the Gateway
 * protocol and call documented RPC methods.
 *
 * Authentication uses the gateway's shared token (gateway.auth.mode "token")
 * with role "operator" and least-privilege scopes
 * (https://docs.openclaw.ai/gateway/operator-scopes). Readiness is
 * protocol-level: the connect promise resolves on `hello-ok`, which is the
 * documented application-readiness signal; the library's built-in startup
 * policy retries `startup-sidecars` UNAVAILABLE closes.
 */

export type GatewayConnectionState =
  | "disconnected"
  | "connecting"
  | "ready"
  | "reconnecting"
  | "closed";

export interface GatherGatewayClientOptions {
  /** ws:// URL of the isolated gateway, e.g. ws://127.0.0.1:PORT */
  url: string;
  /** Shared gateway token (OPENCLAW_GATEWAY_TOKEN on the child env). */
  token: string;
  /** Operator scopes; defaults to read+write (sufficient for agent/sessions). */
  scopes?: string[];
  /** Per-request deadline; default mirrors the library's 30s default. */
  requestTimeoutMs?: number;
  clientVersion?: string;
  onEvent?: (event: EventFrame) => void;
  onStateChange?: (state: GatewayConnectionState) => void;
  onReconnectPaused?: (info: GatewayReconnectPausedInfo) => void;
}

/** Minimal transport surface so tests can substitute a mock protocol client. */
export interface GatewayTransport {
  start(): void;
  stop(): void;
  stopAndWait(opts?: { timeoutMs?: number }): Promise<void>;
  request<T>(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<T>;
  readonly connected: boolean;
}

export type GatewayTransportFactory = (
  options: GatewayClientOptions,
) => GatewayTransport;

const defaultFactory: GatewayTransportFactory = (options) =>
  new GatewayClient(options) as GatewayTransport;

/** Narrow request surface the task layer and tests rely on. */
export interface GatewayRequestChannel {
  readonly isReady: boolean;
  request<T>(
    method: string,
    params?: unknown,
    opts?: { timeoutMs?: number },
  ): Promise<T>;
}

export class GatewayRequestFailed extends Error {
  readonly code?: string;
  constructor(method: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`gateway request ${method} failed: ${detail}`);
    this.name = "GatewayRequestFailed";
    if (cause instanceof GatewayClientRequestError) {
      this.code = (cause as { code?: string }).code;
    }
  }
}

/**
 * One bounded TCP probe of the gateway's loopback listener. Resolves true on
 * accept, false on refusal/timeout — never throws on an absent listener.
 */
function probeTcpAccept(url: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const target = new URL(url);
    const socket = connectTcp({ host: target.hostname, port: Number(target.port) });
    const done = (accepted: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolvePromise(accepted);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

export class GatherGatewayConnection {
  private readonly options: GatherGatewayClientOptions;
  private readonly factory: GatewayTransportFactory;
  private readonly probeListener: (url: string, timeoutMs: number) => Promise<boolean>;
  private transport: GatewayTransport | null = null;
  private hello: HelloOk | null = null;
  private state: GatewayConnectionState = "disconnected";
  private readyResolve: ((hello: HelloOk) => void) | null = null;

  constructor(
    options: GatherGatewayClientOptions,
    deps: {
      transportFactory?: GatewayTransportFactory;
      probeListener?: (url: string, timeoutMs: number) => Promise<boolean>;
    } = {},
  ) {
    this.options = options;
    this.factory = deps.transportFactory ?? defaultFactory;
    this.probeListener = deps.probeListener ?? probeTcpAccept;
  }

  get currentState(): GatewayConnectionState {
    return this.state;
  }

  get helloOk(): HelloOk | null {
    return this.hello;
  }

  get isReady(): boolean {
    return this.state === "ready" && this.hello !== null;
  }

  private setState(state: GatewayConnectionState): void {
    this.state = state;
    this.options.onStateChange?.(state);
  }

  /**
   * Waits for the gateway's loopback listener to accept TCP. The child binds
   * its port only after config/plugin load (~10-15 s cold); starting the WS
   * transport before the listener exists feeds it refused sockets whose
   * exponential backoff can overshoot the whole readiness deadline. The probe
   * shares the connect deadline — elapsed probe time is subtracted from the
   * handshake budget, never added to it.
   */
  private async waitForListener(deadlineMs: number): Promise<void> {
    for (;;) {
      if (this.state === "closed") {
        throw new Error("connection closed while waiting for the gateway listener");
      }
      const remaining = deadlineMs - Date.now();
      if (remaining <= 0) {
        throw new Error(`gateway listener did not accept connections before the readiness deadline`);
      }
      // One refused probe is instant on loopback; cap each attempt so a
      // hung SYN can't stall past the deadline or delay cancellation.
      if (await this.probeListener(this.options.url, Math.min(1500, remaining))) return;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(250, Math.max(1, deadlineMs - Date.now()))));
    }
  }

  /**
   * Connects and waits for `hello-ok` — the documented application-readiness
   * signal. Rejects if not ready within timeoutMs, a deadline covering BOTH
   * the listener probe and the authenticated handshake. The underlying client
   * owns socket reconnect/backoff once the transport starts.
   */
  async connect(opts: { timeoutMs?: number } = {}): Promise<HelloOk> {
    if (this.transport) throw new Error("connection already started");
    const timeoutMs = opts.timeoutMs ?? 30000;
    const deadlineMs = Date.now() + timeoutMs;
    this.setState("connecting");

    // Gate the real transport on the assigned listener accepting — TCP
    // accept is liveness only, NOT readiness; hello-ok below stays the
    // authoritative readiness proof.
    try {
      await this.waitForListener(deadlineMs);
    } catch (error) {
      this.setState("closed");
      throw error;
    }

    this.transport = this.factory({
      url: this.options.url,
      token: this.options.token,
      role: "operator",
      scopes: this.options.scopes ?? ["operator.read", "operator.write"],
      mode: "backend",
      clientName: "gateway-client",
      clientDisplayName: "gather-runtime-adapter",
      clientVersion: this.options.clientVersion ?? "0.1.0",
      platform: process.platform,
      requestTimeoutMs: this.options.requestTimeoutMs,
      onEvent: (event) => this.options.onEvent?.(event),
      onHelloOk: (hello) => {
        this.hello = hello;
        this.setState("ready");
        this.readyResolve?.(hello);
        this.readyResolve = null;
      },
      onConnectError: () => {},
      onReconnectPaused: (info) => {
        this.setState("reconnecting");
        this.options.onReconnectPaused?.(info);
      },
      onClose: () => {
        if (this.state !== "closed") this.setState("reconnecting");
      },
    });

    const ready = new Promise<HelloOk>((resolvePromise, rejectPromise) => {
      const deadline = setTimeout(() => {
        this.readyResolve = null;
        rejectPromise(
          new Error(`gateway hello-ok not received within ${timeoutMs}ms`),
        );
      }, Math.max(1, deadlineMs - Date.now()));
      this.readyResolve = (hello) => {
        clearTimeout(deadline);
        resolvePromise(hello);
      };
    });

    this.transport.start();
    try {
      return await ready;
    } catch (error) {
      await this.close().catch(() => {});
      throw error;
    }
  }

  /** Calls a documented Gateway RPC method. Never invent method names. */
  async request<T = Record<string, unknown>>(
    method: string,
    params?: unknown,
    opts: { timeoutMs?: number } = {},
  ): Promise<T> {
    if (!this.transport || !this.isReady) {
      throw new Error(`gateway connection not ready (state=${this.state})`);
    }
    try {
      return await this.transport.request<T>(method, params, {
        timeoutMs: opts.timeoutMs ?? this.options.requestTimeoutMs,
      });
    } catch (error) {
      if (error instanceof GatewayClientRequestTimeoutError) {
        throw error;
      }
      throw new GatewayRequestFailed(method, error);
    }
  }

  async close(opts: { timeoutMs?: number } = {}): Promise<void> {
    this.setState("closed");
    const transport = this.transport;
    this.transport = null;
    this.hello = null;
    if (transport) {
      await transport.stopAndWait({ timeoutMs: opts.timeoutMs ?? 5000 });
    }
  }
}
