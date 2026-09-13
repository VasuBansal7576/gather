import { randomUUID } from "node:crypto";
import type { GatherStore } from "../sqlite-store.ts";
import type { GatherRuntimeTasks } from "../../runtime/tasks.ts";
import type { ProviderConnectors } from "../provider-runtime/index.ts";
import { createLiveTools } from "./tools.ts";
import type {
  LiveRunInput,
  LiveRunRecord,
  LiveRunStep,
  PreparedProposal,
  ProposalTerms,
} from "./types.ts";
import { LiveModelError } from "./types.ts";

/**
 * Narrowly bound run controller: ONE business, ONE verified account, ONE
 * run id, exactly four tool calls in a fixed order. The model contributes
 * ONLY term interpretation (slot/guests/notes from the inquiry text) via
 * the injected extractor; it never selects sources (all designated),
 * never approves, and never sees credentials. Without an injected
 * extractor, live runs fail with an explicit MODEL_UNCONFIGURED error —
 * the authorized model auth path arrives separately from I, and no model
 * executes before it.
 */

export interface TermsExtractor {
  extractTerms(input: { inquiryBody: string; inquirySubject: string; policyText: string }): Promise<ProposalTerms>;
}

export interface LiveJourneyDeps {
  store: GatherStore;
  providers: ProviderConnectors;
  /** Injected model runtime channel (I's auth path pending; accepted, not yet callable). */
  tasks?: GatherRuntimeTasks;
  /** Injected term interpreter (scripted in verification; model-backed later). */
  termsExtractor?: TermsExtractor;
  now?: () => string;
}

function nowIso(deps: Pick<LiveJourneyDeps, "now">): string {
  return deps.now ? deps.now() : new Date().toISOString();
}

function ensureRunTables(store: GatherStore): void {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS live_model_runs (
      id TEXT PRIMARY KEY,
      business_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      simulated INTEGER NOT NULL,
      status TEXT NOT NULL,
      idempotency_key TEXT,
      record_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_live_model_runs_key ON live_model_runs(business_id, idempotency_key);
  `);
}

function readRun(store: GatherStore, runId: string): LiveRunRecord | undefined {
  const row = store.db.prepare("SELECT record_json FROM live_model_runs WHERE id = $id").get({ $id: runId }) as
    | { record_json: string }
    | undefined;
  if (!row) return undefined;
  return JSON.parse(String(row.record_json)) as LiveRunRecord;
}

function writeRun(store: GatherStore, record: LiveRunRecord, idempotencyKey?: string): void {
  const at = record.finishedAt;
  store.db
    .prepare(
      `INSERT INTO live_model_runs (id, business_id, account_id, mode, simulated, status, idempotency_key, record_json, created_at, updated_at)
       VALUES ($id, $b, $a, $mode, $sim, $status, $key, $record, $at, $at)
       ON CONFLICT (id) DO UPDATE SET status = excluded.status, record_json = excluded.record_json, updated_at = excluded.updated_at`,
    )
    .run({
      $id: record.runId,
      $b: record.businessId,
      $a: record.accountId,
      $mode: record.mode,
      $sim: record.simulated ? 1 : 0,
      $status: record.status,
      $key: idempotencyKey ?? null,
      $record: JSON.stringify(record),
      $at: at,
    });
}

/**
 * Integration hook: run the full designated journey and persist the run
 * record. Scripted mode serves injected ports; live mode enforces the
 * authorization gate before any provider read.
 */
export async function runLiveModelJourney(input: LiveRunInput, deps: LiveJourneyDeps): Promise<LiveRunRecord> {
  if (!input.businessId?.trim() || !input.threadId?.trim() || !input.fileId?.trim() || !input.calendarId?.trim()) {
    throw new LiveModelError("INVALID_REQUEST", "businessId, threadId, fileId, and calendarId are all designated and required");
  }
  ensureRunTables(deps.store);
  if (input.idempotencyKey) {
    const prior = deps.store.db
      .prepare("SELECT record_json FROM live_model_runs WHERE business_id = $b AND idempotency_key = $k ORDER BY created_at DESC LIMIT 1")
      .get({ $b: input.businessId, $k: input.idempotencyKey }) as { record_json: string } | undefined;
    if (prior) {
      const record = JSON.parse(String(prior.record_json)) as LiveRunRecord;
      return { ...record, steps: [...record.steps] };
    }
  }
  const runId = `lmr_${randomUUID()}`;
  const startedAt = nowIso(deps);
  const steps: LiveRunStep[] = [];
  let accountId = "";

  try {
    // Live gate (before ANY provider read): designated connected account,
    // Chief-assigned controlled recipient, and explicit opt-in. Pending
    // Chief, this gate stays closed and nothing sends or reads live data.
    if (input.mode === "live") {
      if (input.allowLive !== true) throw new LiveModelError("LIVE_NOT_AUTHORIZED", "live runs require explicit allowLive opt-in");
      if (!process.env.GATHER_LIVE_RECIPIENT?.trim()) {
        throw new LiveModelError("LIVE_NOT_AUTHORIZED", "live runs require a Chief-assigned controlled recipient (GATHER_LIVE_RECIPIENT); account/recipient selection still pending");
      }
    }
    const gmail = deps.providers.resolveAccountPorts({ businessId: input.businessId, capability: "gmail" });
    if (!gmail.ok || !gmail.ports.inbox || !gmail.ports.threads) {
      throw new LiveModelError("LIVE_NOT_AUTHORIZED", `no verified connected Gmail account with inbox+threads for business ${input.businessId}`);
    }
    const drive = deps.providers.resolveAccountPorts({ businessId: input.businessId, capability: "google_drive" });
    if (!drive.ok || !drive.ports.documents) {
      throw new LiveModelError("LIVE_NOT_AUTHORIZED", `no verified connected Drive account for business ${input.businessId}`);
    }
    if (drive.ports.account.businessId !== input.businessId) {
      throw new LiveModelError("LIVE_NOT_AUTHORIZED", "Drive ports resolved to a different business; refusing cross-business assembly");
    }
    const calendar = deps.providers.resolveCalendarPorts({ businessId: input.businessId, calendarId: input.calendarId });
    if (!calendar.ok) {
      throw new LiveModelError("LIVE_NOT_AUTHORIZED", `calendar ${input.calendarId} is not bound to a verified account of this business`);
    }
    if (calendar.ports.account.businessId !== input.businessId) {
      throw new LiveModelError("LIVE_NOT_AUTHORIZED", "calendar is pinned to a different business; refusing cross-business assembly");
    }
    const account = gmail.ports.account;
    accountId = account.id;
    if (input.mode === "live" && account.status !== "connected") {
      throw new LiveModelError("LIVE_NOT_AUTHORIZED", "resolved Gmail account is not connected");
    }

    const tools = createLiveTools({
      store: deps.store,
      businessId: input.businessId,
      accountId,
      runId,
      threads: gmail.ports.threads,
      documents: drive.ports.documents,
      calendar: calendar.ports.calendar,
      calendarId: input.calendarId,
      ...(deps.now === undefined ? {} : { now: deps.now }),
    });
    const step = async <T extends { provenance: NonNullable<LiveRunStep["provenance"]> }>(tool: LiveRunStep["tool"], call: () => Promise<T>): Promise<T> => {
      const at = nowIso(deps);
      try {
        const result = await call();
        steps.push({ tool, ok: true, at, provenance: result.provenance });
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        steps.push({ tool, ok: false, at: nowIso(deps), error: message });
        throw error;
      }
    };

    const inquiry = await step("readInquiry", () => tools.readInquiry({ threadId: input.threadId }));
    const policy = await step("readVenuePolicy", () => tools.readVenuePolicy({ fileId: input.fileId }));
    if (!deps.termsExtractor) {
      steps.push({ tool: "prepareProposal", ok: false, at: nowIso(deps), error: "MODEL_UNCONFIGURED" });
      throw new LiveModelError(
        "MODEL_UNCONFIGURED",
        "no term interpreter is configured: the authorized model auth path (I, pending) must supply it; scripted verification injects one explicitly",
      );
    }
    const terms = await deps.termsExtractor.extractTerms({ inquiryBody: inquiry.body, inquirySubject: inquiry.subject, policyText: policy.text });
    const availability = await step("checkAvailability", () => tools.checkAvailability({ startAt: terms.startAt, endAt: terms.endAt }));
    const proposal: PreparedProposal = await step("prepareProposal", () =>
      tools.prepareProposal({ inquiry, policy, availability, terms }),
    );
    const record: LiveRunRecord = {
      runId,
      businessId: input.businessId,
      accountId,
      mode: input.mode,
      simulated: input.mode === "scripted",
      status: "ok",
      steps,
      proposal,
      startedAt,
      finishedAt: nowIso(deps),
    };
    writeRun(deps.store, record, input.idempotencyKey);
    return record;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const record: LiveRunRecord = {
      runId,
      businessId: input.businessId,
      accountId,
      mode: input.mode,
      simulated: input.mode === "scripted",
      status: "error",
      steps,
      error: message,
      startedAt,
      finishedAt: nowIso(deps),
    };
    writeRun(deps.store, record, input.idempotencyKey);
    throw error;
  }
}

export function getLiveRun(store: GatherStore, runId: string): LiveRunRecord | undefined {
  ensureRunTables(store);
  return readRun(store, runId);
}
