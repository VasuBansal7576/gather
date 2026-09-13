import { createHash } from "node:crypto";
import type { SourceReference } from "../../domain/contracts.ts";
import type { KnowledgeCandidate, CandidateConfidence } from "../types.ts";
import type { KnowledgeService } from "../service.ts";
import {
  BackendUnavailableError,
  type AwaitedExtraction,
  type ExtractionBackend,
  type PinnedSource,
} from "./backend.ts";
import {
  createExtractionLedger,
  ExtractionScopeConflictError,
  recordExtractionCandidate,
  recordExtractionRun,
  type ExtractionLedger,
} from "./ledger.ts";

/**
 * Bounded source-to-candidate extraction boundary (host side).
 *
 * Trust flow: the trusted host pins business/account/source
 * locator/revision/content digest and hands the backend bounded text. The
 * backend's payload is UNKNOWN untrusted data. Every candidate is validated
 * here — vocabulary, probable/uncertain only, finite JSON object, bounded
 * length/count/depth, evidence spans that actually occur in the supplied
 * source text — before it may reach `KnowledgeService.intakeCandidate`,
 * which re-validates as the final fence. Accepted candidates enter as
 * pending content, never confirmed: this module has no path to
 * confirm/correct/exception, identity links, payments, or provider actions,
 * so failed extraction can never mint verified facts or partial silent
 * authority. Confidence categories are uncalibrated labels, never invented
 * probabilities. This is an executable boundary, not a keyword heuristic
 * pretending at model reasoning: no text classification happens here at
 * all — structure and containment checks only.
 */

/** Hard bounds. Oversize input fails closed; nothing is silently truncated. */
export const MAX_SOURCE_BYTES = 32_768;
export const MAX_CANDIDATES = 20;
export const MAX_VALUE_BYTES = 4096;
export const MAX_VALUE_DEPTH = 6;
export const MAX_VALUE_KEYS = 64;
/** Aggregate budget across the whole value: total nodes and total keys. */
export const MAX_VALUE_NODES = 10_000;
/**
 * Total keys anywhere in the value. Sized below what the byte cap already
 * admits (~450 tiny keys fit 4096 bytes), so this bound is reachable and
 * names key-bloat specifically instead of failing as opaque bytes.
 */
export const MAX_VALUE_TOTAL_KEYS = 256;
export const MAX_KEY_BYTES = 128;
export const MAX_SUBJECT_BYTES = 256;
export const MAX_EVIDENCE_SPANS = 8;
export const MAX_QUOTE_BYTES = 2000;
export const DEFAULT_AWAIT_TIMEOUT_MS = 30_000;

/**
 * Mirror of the knowledge service's booking-business fact vocabulary. If
 * this mirror ever admits a key the service rejects, `intakeCandidate`
 * fails that candidate closed (recorded per-candidate reason, never
 * authority); if it is narrower, affected content reports invalid instead
 * of entering. Divergence fails safe in both directions by construction.
 */
const FACT_KEYS: ReadonlySet<string> = new Set([
  "business",
  "space",
  "policy",
  "scoped_exception",
  "price_line",
  "cost",
  "service",
  "pricing_bounds",
]);

/** Mirror of the service's reserved availability pattern: fresh evidence only. */
const RESERVED_KEY = /^(availability|calendar|freebusy|slots?|windows?|schedule)/i;

export interface ExtractSourceInput {
  /** Trusted host pinning: who owns this, what record, what bytes. */
  source: PinnedSource;
  /** Retrieved source text. Must fit MAX_SOURCE_BYTES exactly as given. */
  text: string;
  /**
   * Caller-persisted idempotency key for this exact (source, bytes) pair.
   * Retries reuse it; per-candidate intake ids derive from it, so replays
   * dedupe instead of duplicating.
   */
  idempotencyKey: string;
  /** sha256 hex of text when the caller pinned it; mismatch fails closed. */
  contentDigest?: string;
  maxCandidates?: number;
  awaitTimeoutMs?: number;
}

export interface AcceptedExtraction {
  /** Validated key/subject/value/confidence fed to intake. */
  key: string;
  subjectId: string;
  value: Record<string, unknown>;
  confidence: CandidateConfidence;
  /** Stored candidate id returned by intake (dedupe may alias repeats). */
  candidateId: string;
  /** Model-supplied evidence quotes, each verified present in source text. */
  evidence: string[];
}

export interface RejectedExtraction {
  /** Zero-based index into the backend's candidates array, or -1 for whole-result failures. */
  index: number;
  reason: string;
}

export type ExtractionStatus =
  | "accepted"
  | "no_relevant_facts"
  | "needs_review"
  | "invalid"
  | "backend_unavailable";

export interface ExtractionOutcome {
  status: ExtractionStatus;
  /** Host identity of the backend run; trusted envelope, never model JSON. */
  backendId: string;
  taskId?: string;
  simulated: boolean;
  accepted: AcceptedExtraction[];
  rejected: RejectedExtraction[];
  /** Machine-readable reason for non-accepted outcomes. */
  reason?: string;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

/**
 * Canonical intake identity for one extracted candidate position. Every
 * component is host-observed (never model-asserted): owning business and
 * account, exact source locator and revision, the computed content digest,
 * the backend run that produced it, and the caller command plus position.
 */
export function deriveIntakeId(parts: {
  businessId: string;
  accountId: string;
  locator: string;
  sourceRevision?: string;
  contentDigest: string;
  backendId: string;
  taskId: string;
  idempotencyKey: string;
  index: number;
}): string {
  const material = [
    parts.businessId,
    parts.accountId,
    parts.locator,
    parts.sourceRevision ?? "",
    parts.contentDigest,
    parts.backendId,
    parts.taskId,
    parts.idempotencyKey,
    String(parts.index),
  ].join("");
  return `ex_${sha256Hex(material).slice(0, 32)}`;
}

/** True only for primary-key collisions on the candidate identity row. */
function isIntakeIdentityConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed: knowledge_candidates/i.test(message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function jsonDepth(value: unknown, depth = 0): number {
  // Only called after checkJsonBudget caps depth: recursion stays bounded.
  if (Array.isArray(value)) {
    let max = depth;
    for (const item of value) max = Math.max(max, jsonDepth(item, depth + 1));
    return max;
  }
  if (isPlainObject(value)) {
    let max = depth;
    for (const entry of Object.values(value)) max = Math.max(max, jsonDepth(entry, depth + 1));
    return max;
  }
  return depth;
}

/**
 * Iterative bounded JSON walk: no recursion, so cyclic or abyssal backend
 * objects cannot overflow the stack. Runs BEFORE any serialization or depth
 * computation — a value that exceeds node, depth, key, or finiteness budgets
 * is rejected without ever calling JSON.stringify on it.
 */
function checkJsonBudget(value: unknown): { ok: true } | { ok: false; reason: string } {
  let nodes = 0;
  let totalKeys = 0;
  const ancestors = new Set<unknown>();
  const stack: { node: unknown; depth: number; closing: boolean }[] = [{ node: value, depth: 0, closing: false }];
  while (stack.length > 0) {
    const frame = stack.pop() as { node: unknown; depth: number; closing: boolean };
    if (frame.closing) {
      ancestors.delete(frame.node);
      continue;
    }
    nodes += 1;
    if (nodes > MAX_VALUE_NODES) return { ok: false, reason: `value exceeds max ${MAX_VALUE_NODES} JSON nodes` };
    if (frame.depth > MAX_VALUE_DEPTH) return { ok: false, reason: `value exceeds max depth ${MAX_VALUE_DEPTH}` };
    const node = frame.node;
    if (node === undefined) return { ok: false, reason: "value must be finite JSON (no undefined)" };
    if (typeof node === "number") {
      if (!Number.isFinite(node)) return { ok: false, reason: "value must be finite JSON (no NaN/Infinity)" };
      continue;
    }
    if (typeof node === "string" || typeof node === "boolean" || node === null) continue;
    if (typeof node !== "object") return { ok: false, reason: "value must be finite JSON (no functions/symbols)" };
    if (ancestors.has(node)) return { ok: false, reason: "value contains a cyclic reference" };
    ancestors.add(node);
    if (Array.isArray(node)) {
      stack.push({ node, depth: frame.depth, closing: true });
      for (let index = node.length - 1; index >= 0; index -= 1) {
        stack.push({ node: node[index], depth: frame.depth + 1, closing: false });
      }
      continue;
    }
    if (!isPlainObject(node)) return { ok: false, reason: "value must be plain JSON objects and arrays" };
    const keys = Object.keys(node);
    totalKeys += keys.length;
    if (totalKeys > MAX_VALUE_TOTAL_KEYS) return { ok: false, reason: `value exceeds max ${MAX_VALUE_TOTAL_KEYS} total keys` };
    stack.push({ node, depth: frame.depth, closing: true });
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      stack.push({ node: (node as Record<string, unknown>)[keys[index] as string], depth: frame.depth + 1, closing: false });
    }
  }
  return { ok: true };
}

interface ValidatedRaw {
  key: string;
  subjectId: string;
  value: Record<string, unknown>;
  confidence: CandidateConfidence;
  evidence: string[];
}

/**
 * Validate one UNKNOWN backend candidate. Returns the validated form or a
 * reason. Anything the model asserts about identity, provenance, authority,
 * or confidence outside probable/uncertain is rejected or ignored here —
 * never coerced upward, never passed through.
 */
function validateRawCandidate(raw: unknown, text: string): { ok: true; value: ValidatedRaw } | { ok: false; reason: string } {
  if (!isPlainObject(raw)) return { ok: false, reason: "candidate must be a JSON object" };
  const key = raw.key;
  if (typeof key !== "string" || key.length === 0 || Buffer.byteLength(key, "utf-8") > MAX_KEY_BYTES) {
    return { ok: false, reason: "candidate key must be a non-empty string within bounds" };
  }
  if (!FACT_KEYS.has(key)) {
    return { ok: false, reason: `key ${JSON.stringify(key)} is outside the booking-business fact vocabulary` };
  }
  if (RESERVED_KEY.test(key)) {
    return { ok: false, reason: `key ${JSON.stringify(key)} is reserved for fresh availability evidence` };
  }
  const confidence = raw.confidence;
  if (confidence !== "probable" && confidence !== "uncertain") {
    return { ok: false, reason: `confidence must be probable or uncertain; ${JSON.stringify(confidence)} can never be minted by extraction` };
  }
  const subjectId = raw.subjectId ?? "";
  if (typeof subjectId !== "string" || Buffer.byteLength(subjectId, "utf-8") > MAX_SUBJECT_BYTES) {
    return { ok: false, reason: "subjectId must be a string within bounds" };
  }
  const value = raw.value;
  if (!isPlainObject(value)) return { ok: false, reason: "value must be a finite JSON object" };
  // Budget first (iterative, cycle-safe): only values inside node/depth/key
  // budgets may be serialized or walked recursively below.
  const budget = checkJsonBudget(value);
  if (!budget.ok) return { ok: false, reason: budget.reason };
  if (Buffer.byteLength(JSON.stringify(value), "utf-8") > MAX_VALUE_BYTES) {
    return { ok: false, reason: `value exceeds ${MAX_VALUE_BYTES} bytes` };
  }
  if (jsonDepth(value) > MAX_VALUE_DEPTH) {
    return { ok: false, reason: `value exceeds max depth ${MAX_VALUE_DEPTH}` };
  }
  if (Object.keys(value).length > MAX_VALUE_KEYS) {
    return { ok: false, reason: `value exceeds max ${MAX_VALUE_KEYS} top-level keys` };
  }
  // Identity/provenance/authority assertions in model output are ignored:
  // the host pins source references and only an owner decision confers
  // authority. They are dropped, never honored, never stored.
  const evidenceRaw = raw.evidence;
  if (!Array.isArray(evidenceRaw) || evidenceRaw.length === 0) {
    return { ok: false, reason: "candidate must carry at least one evidence span" };
  }
  if (evidenceRaw.length > MAX_EVIDENCE_SPANS) {
    return { ok: false, reason: `candidate exceeds max ${MAX_EVIDENCE_SPANS} evidence spans` };
  }
  const evidence: string[] = [];
  for (const span of evidenceRaw) {
    if (typeof span !== "string" || span.length === 0 || Buffer.byteLength(span, "utf-8") > MAX_QUOTE_BYTES) {
      return { ok: false, reason: "evidence spans must be non-empty strings within bounds" };
    }
    // Executable containment boundary: the quote must actually occur in
    // the supplied source text. No semantic matching, no fuzzy search.
    if (!text.includes(span)) {
      return { ok: false, reason: "evidence span does not occur in the supplied source text" };
    }
    evidence.push(span);
  }
  return { ok: true, value: { key, subjectId, value, confidence, evidence } };
}

function hostSourceReferences(source: PinnedSource): SourceReference[] {
  return [{
    kind: source.kind,
    locator: source.locator,
    ...(source.label === undefined ? {} : { label: source.label }),
    ...(source.fictional === undefined ? {} : { fictional: source.fictional }),
  }];
}

function fail(status: ExtractionStatus, backend: ExtractionBackend, reason: string, taskId?: string): ExtractionOutcome {
  return { status, backendId: backend.backendId, simulated: backend.simulated, accepted: [], rejected: [], reason, ...(taskId === undefined ? {} : { taskId }) };
}

/**
 * Marks a lineage-write failure inside the intake transaction. The service
 * rolls the whole transaction back (candidate row, supersede updates, and
 * partial lineage together), and the per-candidate handler below reports
 * it explicitly instead of leaking a raw SQLite error.
 */
class LineageWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LineageWriteError";
  }
}

/**
 * Run bounded extraction for one pinned source and feed validated
 * candidates through intake as pending content. Never confirms, corrects,
 * links, pays, or actuates anything: the only sink is
 * `KnowledgeService.intakeCandidate`.
 */
export async function extractSourceCandidates(
  service: KnowledgeService,
  backend: ExtractionBackend,
  input: ExtractSourceInput,
  ledger?: ExtractionLedger,
): Promise<ExtractionOutcome> {
  if (input.idempotencyKey.trim().length === 0) {
    return fail("invalid", backend, "idempotencyKey is required");
  }
  const sourceBytes = Buffer.byteLength(input.text, "utf-8");
  if (sourceBytes > MAX_SOURCE_BYTES) {
    return fail("invalid", backend, `source text is ${sourceBytes} bytes, exceeding the ${MAX_SOURCE_BYTES}-byte bound; refusing to truncate evidence`);
  }
  const digest = sha256Hex(input.text);
  if (input.contentDigest !== undefined && input.contentDigest !== digest) {
    return fail("invalid", backend, "source text does not match the pinned content digest");
  }
  if (input.source.locator.trim().length === 0 || input.source.businessId.trim().length === 0) {
    return fail("invalid", backend, "pinned source requires businessId and locator");
  }
  const maxCandidates = input.maxCandidates ?? MAX_CANDIDATES;
  if (!Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > MAX_CANDIDATES) {
    return fail("invalid", backend, `maxCandidates must be an integer in 1..${MAX_CANDIDATES}`);
  }
  if (input.awaitTimeoutMs !== undefined && (!Number.isInteger(input.awaitTimeoutMs) || input.awaitTimeoutMs <= 0)) {
    return fail("invalid", backend, "awaitTimeoutMs must be a positive integer when present");
  }
  if (ledger !== undefined && ledger.db !== service.database) {
    return fail("invalid", backend, "lineage ledger must share the service database connection; refusing split-brain lineage");
  }

  let taskId: string;
  try {
    const submitted = await backend.submitExtraction({
      idempotencyKey: input.idempotencyKey,
      sourceDigest: digest,
      text: input.text,
      maxCandidates,
    });
    // The submission echo is validated before anything downstream may name
    // this run: a backend that answers for another command is not ours.
    if (typeof submitted.taskId !== "string" || submitted.taskId.length === 0) {
      return fail("backend_unavailable", backend, "backend submission returned no usable task id");
    }
    if (submitted.idempotencyKey !== input.idempotencyKey) {
      return fail("backend_unavailable", backend, "backend submission echoed a different idempotency key; refusing a foreign run");
    }
    taskId = submitted.taskId;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return fail("backend_unavailable", backend, `extraction submit failed: ${detail.slice(0, 300)}`);
  }


  // Every terminal outcome after a validated submission is recorded in the
  // ledger (attempt audit); pre-submit rejections record nothing because no
  // backend run exists to trace. Ledger writes here never throw past the
  // boundary: a dead handle appends an explicit note instead.
  const finish = (outcome: ExtractionOutcome): ExtractionOutcome => {
    if (ledger !== undefined) {
      try {
        recordExtractionRun(ledger, {
          idempotencyKey: input.idempotencyKey,
          businessId: input.source.businessId,
          accountId: input.source.accountId,
          locator: input.source.locator,
          sourceRevision: input.source.sourceRevision ?? null,
          contentDigest: digest,
          backendId: backend.backendId,
          taskId,
          simulated: backend.simulated,
          status: outcome.status,
          reason: outcome.reason ?? null,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return {
          ...outcome,
          reason: `${outcome.reason ?? outcome.status} (lineage audit write failed: ${detail.slice(0, 200)})`,
        };
      }
    }
    return outcome;
  };

  // Run-first lineage: the run row (with its scope identity) is written
  // before any candidate mutation, so a scope conflict or a dead ledger
  // fails closed here with zero rows fed — never mid-batch, never silent.
  if (ledger !== undefined) {
    try {
      recordExtractionRun(ledger, {
        idempotencyKey: input.idempotencyKey,
        businessId: input.source.businessId,
        accountId: input.source.accountId,
        locator: input.source.locator,
        sourceRevision: input.source.sourceRevision ?? null,
        contentDigest: digest,
        backendId: backend.backendId,
        taskId,
        simulated: backend.simulated,
        status: "started",
        reason: null,
      });
    } catch (error) {
      if (error instanceof ExtractionScopeConflictError) {
        return fail("invalid", backend, `idempotency key reuse across scopes refused: ${error.message.slice(0, 200)}`, taskId);
      }
      const detail = error instanceof Error ? error.message : String(error);
      return fail("invalid", backend, `lineage ledger unavailable before intake; nothing was stored: ${detail.slice(0, 200)}`, taskId);
    }
  }

  let awaited: AwaitedExtraction;
  try {
    awaited = await backend.awaitExtraction(taskId, input.awaitTimeoutMs ?? DEFAULT_AWAIT_TIMEOUT_MS);
  } catch {
    // Every await failure — timeout, transport, or programmer error — is a
    // bounded backend_unavailable outcome with zero rows fed, never a raw
    // throw past the boundary.
    return finish(fail("backend_unavailable", backend, "extraction await failed before a terminal result", taskId));
  }
  if (awaited.status !== "ok") {
    return finish(fail("backend_unavailable", backend, `backend run ended ${awaited.status}${awaited.error ? `: ${awaited.error.slice(0, 300)}` : ""}`, taskId));
  }

  const payload = awaited.payload;
  if (!isPlainObject(payload)) {
    return finish(fail("invalid", backend, "backend payload must be a JSON object", taskId));
  }
  const rawCandidates = payload.candidates;
  if (!Array.isArray(rawCandidates)) {
    return finish(fail("invalid", backend, "backend payload must carry a candidates array", taskId));
  }
  if (rawCandidates.length > maxCandidates) {
    return finish(fail("invalid", backend, `backend returned ${rawCandidates.length} candidates, exceeding the accepted max ${maxCandidates}`, taskId));
  }
  if (rawCandidates.length === 0) {
    return finish({ status: "no_relevant_facts", backendId: backend.backendId, taskId, simulated: backend.simulated, accepted: [], rejected: [], reason: "backend returned no candidates" });
  }

  const accepted: AcceptedExtraction[] = [];
  const rejected: RejectedExtraction[] = [];
  const refs = hostSourceReferences(input.source);
  const runNote = `extracted via ${backend.backendId}/${taskId}${backend.simulated ? " (simulated)" : ""}`;
  rawCandidates.forEach((raw, index) => {
    const validated = validateRawCandidate(raw, input.text);
    if (!validated.ok) {
      rejected.push({ index, reason: validated.reason });
      return;
    }
    const v = validated.value;
    // Canonical intake identity binds business + account + source locator +
    // revision + content digest + backend task + caller command + position:
    // retries reproduce it exactly (stable dedupe), while any altered
    // replay (different bytes, source, or command) names a different row
    // instead of colliding. A primary-key hit therefore always means the
    // same command re-ran against changed model content, and is reported
    // deterministically rather than leaking a raw UNIQUE error.
    const intakeId = deriveIntakeId({
      businessId: input.source.businessId,
      accountId: input.source.accountId,
      locator: input.source.locator,
      sourceRevision: input.source.sourceRevision,
      contentDigest: digest,
      backendId: backend.backendId,
      taskId,
      idempotencyKey: input.idempotencyKey,
      index,
    });
    try {
      const stored: KnowledgeCandidate = service.intakeCandidate({
        businessId: input.source.businessId,
        accountId: input.source.accountId,
        key: v.key,
        ...(v.subjectId.length > 0 ? { subjectId: v.subjectId } : {}),
        value: v.value,
        confidence: v.confidence,
        // Host-pinned attribution only: model-supplied locators, revisions,
        // business ids, or provenance are never read, never stored.
        sourceReferences: refs,
        ...(input.source.sourceRevision === undefined ? {} : { sourceRevision: input.source.sourceRevision }),
        intakeId,
        note: runNote,
        // Same-transaction lineage: the candidate row and its lineage row
        // commit together on the service connection or roll back together.
        ...(ledger === undefined ? {} : {
          atomically: () => {
            try {
              recordExtractionCandidate(ledger, input.idempotencyKey, {
                candidateIndex: index,
                candidateId: intakeId,
                intakeId,
                factKey: v.key,
                subjectId: v.subjectId,
                confidence: v.confidence,
                evidenceJson: JSON.stringify(v.evidence),
              });
            } catch (error) {
              throw new LineageWriteError(error instanceof Error ? error.message : String(error));
            }
          },
        }),
      });
      accepted.push({ key: v.key, subjectId: v.subjectId, value: v.value, confidence: v.confidence, candidateId: stored.id, evidence: v.evidence });
    } catch (error) {
      if (error instanceof LineageWriteError) {
        rejected.push({ index, reason: `lineage write failed; candidate rolled back with it: ${error.message.slice(0, 200)}` });
        return;
      }
      if (isIntakeIdentityConflict(error)) {
        rejected.push({ index, reason: "intake identity already used for different content; altered replays are rejected, never merged" });
        return;
      }
      const detail = error instanceof Error ? `${(error as { code?: unknown }).code ?? error.name}: ${error.message}` : String(error);
      rejected.push({ index, reason: `intake rejected: ${detail.slice(0, 300)}` });
    }
  });

  const terminal: ExtractionOutcome = (() => {
    if (accepted.length === 0) {
      return { status: "invalid", backendId: backend.backendId, taskId, simulated: backend.simulated, accepted, rejected, reason: "no candidate survived validation" };
    }
    if (rejected.length > 0) {
      return { status: "needs_review", backendId: backend.backendId, taskId, simulated: backend.simulated, accepted, rejected, reason: `${rejected.length} of ${rawCandidates.length} candidates failed validation; accepted entries are pending only` };
    }
    return { status: "accepted", backendId: backend.backendId, taskId, simulated: backend.simulated, accepted, rejected };
  })();
  return finish(terminal);
}
