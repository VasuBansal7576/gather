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

export class GatherGatewayConnection {
  private readonly options: GatherGatewayClientOptions;
  private readonly factory: GatewayTransportFactory;
  private transport: GatewayTransport | null = null;
  private hello: HelloOk | null = null;
  private state: GatewayConnectionState = "disconnected";
  private readyResolve: ((hello: HelloOk) => void) | null = null;

  constructor(
    options: GatherGatewayClientOptions,
    deps: { transportFactory?: GatewayTransportFactory } = {},
  ) {
    this.options = options;
    this.factory = deps.transportFactory ?? defaultFactory;
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
   * Connects and waits for `hello-ok` — the documented application-readiness
   * signal. Rejects if not ready within timeoutMs. The underlying client owns
   * socket reconnect/backoff; this deadline covers the whole handshake.
   */
  async connect(opts: { timeoutMs?: number } = {}): Promise<HelloOk> {
    if (this.transport) throw new Error("connection already started");
    const timeoutMs = opts.timeoutMs ?? 30000;
    this.setState("connecting");

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
      }, timeoutMs);
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
