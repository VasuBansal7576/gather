/**
 * Stable, collision-bound source keys for booking identity (PRD G04).
 *
 * A source key identifies ONE provider-side record in the scope that owns it:
 * provider + connected account + business + source kind + provider external id
 * + provider thread id. It never contains customer PII matching material
 * (sender email/name/date are hints, not identity) and never trusts
 * message-body claims.
 *
 * Encoding: `v1.` + base64url(JSON array of the six components). JSON
 * framing makes the boundary between components unambiguous, so values
 * containing delimiter strings (`|`, `:`, `::`, `/`, unicode, empty string)
 * can never collide the way a naive `parts.join("|")` key would. The `v1.`
 * prefix versions the encoding for future changes.
 */

/** Scope + provider record address. `threadId` may be "" when there is no thread. */
export interface IdentityComponents {
  provider: string;
  accountId: string;
  businessId: string;
  sourceKind: string;
  externalId: string;
  threadId: string;
}

const KEY_VERSION_PREFIX = "v1.";

function requireComponent(name: keyof IdentityComponents, value: string, opts: { allowEmpty: boolean }): string {
  if (typeof value !== "string") throw new Error(`Identity component "${name}" must be a string`);
  // All segments trim surrounding whitespace (provider/type segments also
  // lowercase) so `GMail` and `gmail` address one record and blank strings
  // can never become a scope identity.
  const trimmed = value.trim();
  const normalized = name === "provider" || name === "sourceKind" ? trimmed.toLowerCase() : trimmed;
  if (!opts.allowEmpty && normalized.length === 0) throw new Error(`Identity component "${name}" must not be empty`);
  return normalized;
}

export function normalizeComponents(input: IdentityComponents): IdentityComponents {
  return {
    provider: requireComponent("provider", input.provider, { allowEmpty: false }),
    accountId: requireComponent("accountId", input.accountId, { allowEmpty: false }),
    businessId: requireComponent("businessId", input.businessId, { allowEmpty: false }),
    sourceKind: requireComponent("sourceKind", input.sourceKind, { allowEmpty: false }),
    externalId: requireComponent("externalId", input.externalId, { allowEmpty: false }),
    threadId: requireComponent("threadId", input.threadId ?? "", { allowEmpty: true }),
  };
}

/** Build the durable source key for one provider-side record in scope. */
export function buildSourceKey(input: IdentityComponents): string {
  const parts = normalizeComponents(input);
  const material = JSON.stringify([
    parts.provider,
    parts.accountId,
    parts.businessId,
    parts.sourceKind,
    parts.externalId,
    parts.threadId,
  ]);
  return KEY_VERSION_PREFIX + Buffer.from(material, "utf8").toString("base64url");
}

/** Decode a source key back to its components. Throws on malformed keys. */
export function decodeSourceKey(sourceKey: string): IdentityComponents {
  if (typeof sourceKey !== "string" || !sourceKey.startsWith(KEY_VERSION_PREFIX)) {
    throw new Error("Malformed booking identity source key: unknown version prefix");
  }
  let material: string;
  try {
    material = Buffer.from(sourceKey.slice(KEY_VERSION_PREFIX.length), "base64url").toString("utf8");
  } catch {
    throw new Error("Malformed booking identity source key: undecodable payload");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(material);
  } catch {
    throw new Error("Malformed booking identity source key: invalid payload JSON");
  }
  if (!Array.isArray(parsed) || parsed.length !== 6 || !parsed.every((part) => typeof part === "string")) {
    throw new Error("Malformed booking identity source key: expected six string components");
  }
  return {
    provider: parsed[0] as string,
    accountId: parsed[1] as string,
    businessId: parsed[2] as string,
    sourceKind: parsed[3] as string,
    externalId: parsed[4] as string,
    threadId: parsed[5] as string,
  };
}
