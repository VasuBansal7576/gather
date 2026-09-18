/**
 * ADR-013 AssemblyAI HTTP client (C12).
 *
 * Maintained provider HTTP API via fetch: bounded binary upload, transcript
 * creation, and bounded polling — with timeout, cancellation, and no
 * automatic unrelated uploads (every call is an explicit method invocation
 * carrying caller-supplied bytes).
 *
 * A disabled config refuses before any fetch exists: zero requests, zero
 * audio data leaves the machine. The fetch implementation is injected so
 * tests prove the zero-network property with a spy.
 */

import {
  ASSEMBLYAI_API_BASE,
  ASSEMBLYAI_POLL_INTERVAL_MS,
  ASSEMBLYAI_POLL_TIMEOUT_MS,
  ASSEMBLYAI_REQUEST_TIMEOUT_MS,
  type AssemblyAIConfig,
} from "./config.ts";
import {
  assemblyAIDisabledError,
  assemblyAIStatusError,
  assemblyAITransportError,
} from "./errors.ts";

export type FetchLike = typeof fetch;

export interface AssemblyAITranscriptResponse {
  id: string;
  status: "queued" | "processing" | "completed" | "error";
  text?: string | null;
  confidence?: number | null;
  error?: string | null;
  audio_duration?: number | null;
}

export interface AssemblyAIClientOptions {
  config: AssemblyAIConfig;
  /** Injected fetch (tests pass a spy; production passes global fetch). */
  fetchImpl?: FetchLike;
  apiBase?: string;
  requestTimeoutMs?: number;
  pollTimeoutMs?: number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Truncate provider text for local error detail; full bodies never surface. */
function safeDetail(value: unknown): string {
  try {
    return JSON.stringify(value)?.slice(0, 300) ?? "provider error";
  } catch {
    return "provider error";
  }
}

export class AssemblyAIClient {
  private readonly config: AssemblyAIConfig;
  private readonly fetchImpl: FetchLike;
  private readonly apiBase: string;
  private readonly requestTimeoutMs: number;
  private readonly pollTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: AssemblyAIClientOptions) {
    this.config = options.config;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.apiBase = options.apiBase ?? ASSEMBLYAI_API_BASE;
    this.requestTimeoutMs = options.requestTimeoutMs ?? ASSEMBLYAI_REQUEST_TIMEOUT_MS;
    this.pollTimeoutMs = options.pollTimeoutMs ?? ASSEMBLYAI_POLL_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? ASSEMBLYAI_POLL_INTERVAL_MS;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** API key or throw before any network when the profile is disabled. Never sends data. */
  private apiKey(): string {
    if (!this.config.enabled || !this.config.apiKey) {
      throw assemblyAIDisabledError(
        this.config.missingEvidence ?? "AssemblyAI voice profile is not enabled",
      );
    }
    return this.config.apiKey;
  }

  private async request(
    path: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<{ status: number; json: unknown }> {
    const key = this.apiKey();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("timeout")), this.requestTimeoutMs);
    const link = (reason: unknown): void => controller.abort(reason);
    signal?.addEventListener("abort", link, { once: true });
    try {
      const response = await this.fetchImpl(`${this.apiBase}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          authorization: key,
          ...(init.headers as Record<string, string> | undefined),
        },
      });
      const json = await response.json().catch(() => undefined);
      return { status: response.status, json };
    } catch (error) {
      throw assemblyAITransportError(error);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", link);
    }
  }

  /**
   * Upload raw audio bytes. The caller already validated size/duration;
   * this method performs exactly one explicit upload request.
   */
  async uploadAudio(
    audio: Uint8Array,
    contentType: string,
    signal?: AbortSignal,
  ): Promise<string> {
    this.apiKey();
    const { status, json } = await this.request(
      "/v2/upload",
      {
        method: "POST",
        headers: { "content-type": contentType },
        // Body must be a Buffer-backed view the fetch accepts; copy once.
        body: Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength) as unknown as BodyInit,
      },
      signal,
    );
    if (status < 200 || status >= 300) {
      throw assemblyAIStatusError(status, safeDetail(json));
    }
    const url =
      typeof json === "object" && json !== null
        ? (json as Record<string, unknown>).upload_url
        : undefined;
    if (typeof url !== "string" || url.length === 0) {
      throw assemblyAIStatusError(status, "upload response carried no upload_url");
    }
    return url;
  }

  /** Create a transcription job for an already-uploaded audio URL. */
  async createTranscript(audioUrl: string, signal?: AbortSignal): Promise<string> {
    this.apiKey();
    const { status, json } = await this.request(
      "/v2/transcript",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ audio_url: audioUrl }),
      },
      signal,
    );
    if (status < 200 || status >= 300) {
      throw assemblyAIStatusError(status, safeDetail(json));
    }
    const id =
      typeof json === "object" && json !== null
        ? (json as Record<string, unknown>).id
        : undefined;
    if (typeof id !== "string" || id.length === 0) {
      throw assemblyAIStatusError(status, "transcript response carried no id");
    }
    return id;
  }

  /** Read one transcript job (used by bounded polling and status checks). */
  async getTranscript(id: string, signal?: AbortSignal): Promise<AssemblyAITranscriptResponse> {
    this.apiKey();
    const { status, json } = await this.request(
      `/v2/transcript/${encodeURIComponent(id)}`,
      { method: "GET" },
      signal,
    );
    if (status < 200 || status >= 300) {
      throw assemblyAIStatusError(status, safeDetail(json));
    }
    return json as AssemblyAITranscriptResponse;
  }

  /**
   * Poll a transcript job until completed/error or the poll budget expires.
   * Expiry is UNCERTAIN (effect unknown until reconciled), never success.
   */
  async waitForTranscript(id: string, signal?: AbortSignal): Promise<AssemblyAITranscriptResponse> {
    this.apiKey();
    const deadline = Date.now() + this.pollTimeoutMs;
    for (;;) {
      const job = await this.getTranscript(id, signal);
      if (job.status === "completed") return job;
      if (job.status === "error") {
        throw assemblyAIStatusError(502, `transcription failed: ${(job.error ?? "unknown").slice(0, 200)}`);
      }
      if (Date.now() >= deadline) {
        throw assemblyAITransportError(new Error(`timed out waiting for transcript ${id}`));
      }
      await this.sleep(this.pollIntervalMs);
    }
  }
}
