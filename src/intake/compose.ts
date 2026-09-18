import { ServiceError } from "../server/booking-service.ts";
import type { GatherStore } from "../server/sqlite-store.ts";
import { evaluateDomainGate, type DomainGateDecision } from "./gate.ts";
import { createScriptedDomainClassifier } from "./scripted.ts";
import { IntakeDomainStore, type ComposedMessageRecord } from "./store.ts";

/**
 * ADR-003 prepared-only composer service. Anyone can type an email into the
 * prepared business and watch the domain gate classify it: unrelated mail
 * (invoice, newsletter, vendor pitch, pure instructions) never becomes a
 * business action, while legitimate inquiries stay eligible even with
 * missing fields or embedded instruction text.
 *
 * Prepared-only is enforced here, not just at the route: in live mode this
 * entry throws DENIED no matter who calls it. Everything it records is
 * fictional — the composed row and its decision are labelled simulated,
 * source-tagged "prepared-composer", and deduped by (account, content hash)
 * so a replayed submit returns the same durable row.
 */

export const PREPARED_COMPOSER_TAG = "prepared-composer";
export const PREPARED_COMPOSER_ACCOUNT = "prepared-composer-account";

export interface ComposeServiceDeps {
  store: GatherStore;
  /** Runtime mode; "live" is refused unconditionally. */
  mode: "prepared" | "live";
  businessId: string;
  /** Composer source account scope (fictional; never a connected account). */
  accountId?: string;
  now?: () => string;
}

export interface ComposedMessageInput {
  from: string;
  to: string;
  subject: string;
  body: string;
}

export interface ComposeResult {
  message: ComposedMessageRecord;
  duplicate: boolean;
  classification: DomainGateDecision;
  classifier: string;
  simulated: true;
}

const MAX_SUBJECT = 500;
const MAX_BODY = 20_000;

function requireText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    throw new ServiceError("INVALID_REQUEST", `${field} must be a non-empty string of at most ${max} characters`, false);
  }
  return value;
}

function optionalAddress(value: unknown, field: string, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_SUBJECT) {
    throw new ServiceError("INVALID_REQUEST", `${field} must be a non-empty string when supplied`, false);
  }
  return value;
}

export async function composePreparedMessage(
  deps: ComposeServiceDeps,
  input: unknown,
): Promise<ComposeResult> {
  if (deps.mode === "live") {
    throw new ServiceError(
      "DENIED",
      "The inbox composer is prepared-mode only; live inboxes are read through the connected account, never written by typed mail.",
      false,
    );
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ServiceError("INVALID_REQUEST", "Compose requires a JSON object { subject, body, from?, to? }", false);
  }
  const raw = input as Record<string, unknown>;
  const subject = requireText(raw.subject, "subject", MAX_SUBJECT);
  const body = requireText(raw.body, "body", MAX_BODY);
  const from = optionalAddress(raw.from, "from", "composer@prepared.example.test");
  const to = optionalAddress(raw.to, "to", "events@prepared.example.test");
  const businessId = deps.businessId.trim();
  if (businessId.length === 0) {
    throw new ServiceError("INVALID_REQUEST", "businessId is required", false);
  }
  try {
    deps.store.getBusiness(businessId);
  } catch {
    throw new ServiceError("NOT_FOUND", `Business not found: ${businessId}`, false);
  }
  const accountId = deps.accountId ?? PREPARED_COMPOSER_ACCOUNT;
  const store = new IntakeDomainStore(deps.store.db);
  const receivedAt = deps.now ? deps.now() : new Date().toISOString();
  const { message, duplicate } = store.recordComposed({
    businessId,
    accountId,
    from,
    to,
    subject,
    body,
    receivedAt,
    sourceTag: PREPARED_COMPOSER_TAG,
  });
  const gate = await evaluateDomainGate(createScriptedDomainClassifier(), {
    messageId: message.id,
    subject,
    body,
    from,
    sourceTag: PREPARED_COMPOSER_TAG,
  });
  store.record({
    accountId,
    messageId: message.id,
    sourceTag: PREPARED_COMPOSER_TAG,
    decision: gate.decision,
    classifier: gate.classifierId,
    simulated: true,
  });
  return {
    message,
    duplicate,
    classification: gate.decision,
    classifier: gate.classifierId,
    simulated: true,
  };
}
