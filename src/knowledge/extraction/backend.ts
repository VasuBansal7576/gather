import type { SourceKind } from "../../domain/contracts.ts";

/**
 * Injected typed extraction-backend port.
 *
 * Reuses the OpenClaw task-port concepts (`GatherRuntimeTasks.submitTask` /
 * `waitForRun`): the host submits one bounded extraction task with a
 * caller-persisted idempotency key and then awaits its terminal result. The
 * backend returns UNKNOWN untrusted data — every byte of the payload is
 * validated by the host before it can touch intake. Task/result identity
 * (`backendId`, `taskId`, `simulated`) travels in the trusted envelope
 * built by the backend host object itself, never parsed out of model JSON:
 * a model that asserts its own provenance, run id, or live status changes
 * nothing. Connecting an actual model backend (e.g. via the gateway task
 * API) is an explicit separate gate; this port only defines the shape that
 * future wiring must satisfy. Injected fake backends are the only backends
 * exercised here — no live model or provider is ever contacted.
 */

export interface ExtractionBackendIdentity {
  /** Stable id of the backend implementation (e.g. "fake", "openclaw-tasks"). */
  backendId: string;
  /** Host-minted task id for this submission. */
  taskId: string;
  /** True when no live provider was involved; part of trusted identity. */
  simulated: boolean;
}

export interface SubmittedExtraction {
  taskId: string;
  acceptedAt: number;
  idempotencyKey: string;
}

export type BackendRunStatus = "ok" | "error" | "timeout" | "unknown";

export interface AwaitedExtraction {
  status: BackendRunStatus;
  /**
   * Raw untrusted model output. Unknown by contract: the host validates it
   * from scratch and never trusts its shape, even when the backend is local.
   */
  payload: unknown;
  /** Backend-side error detail, if any. Treated as diagnostic text only. */
  error?: string;
}

/** The bounded instruction the host submits. Text is pinned by digest. */
export interface ExtractionSubmission {
  idempotencyKey: string;
  /** sha256 hex of the exact source bytes the model must extract from. */
  sourceDigest: string;
  /** Bounded source text (host-enforced byte cap, never silently cut). */
  text: string;
  /** Upper bound the host will accept; the backend may return fewer. */
  maxCandidates: number;
}

/** Thrown when no extraction result can be obtained (transport / timeout). */
export class BackendUnavailableError extends Error {
  readonly code = "backend_unavailable" as const;
  constructor(message = "extraction backend unavailable") {
    super(message);
    this.name = "BackendUnavailableError";
  }
}

export interface ExtractionBackend {
  readonly backendId: string;
  readonly simulated: boolean;
  submitExtraction(submission: ExtractionSubmission): Promise<SubmittedExtraction>;
  awaitExtraction(taskId: string, timeoutMs: number): Promise<AwaitedExtraction>;
}

/** Trusted host-side source pinning. Every field is host-supplied. */
export interface PinnedSource {
  businessId: string;
  accountId: string;
  kind: SourceKind;
  /** Exact provider locator the resulting candidates are attributed to. */
  locator: string;
  label?: string;
  /** True only for local fictional fixtures; never a verified integration. */
  fictional?: boolean;
  /** Version/fingerprint of the source record, when known. */
  sourceRevision?: string;
}
