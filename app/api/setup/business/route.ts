import { NextResponse } from "next/server";
import { getRuntime } from "../../../../src/server/runtime.ts";
import { assertSameOrigin, readHeaders, ValidationError } from "../../../../src/server/validation.ts";
import { connectionErrorResponse } from "../../connections/_helpers.ts";

export const dynamic = "force-dynamic";

function requireField(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 200) {
    throw new ValidationError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function requireTimeZone(value: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
  } catch {
    throw new ValidationError(`timezone must be a valid IANA time zone (got "${value}")`);
  }
  return value;
}

/**
 * Create (or idempotently return) a business for the local owner. The
 * ownerId is server-derived and never read from the request; a double
 * submit — or a same-name+timezone retry — returns the existing business
 * instead of duplicating it. Real setup seeds no fictional data: only the
 * business row is created.
 */
export async function POST(req: Request): Promise<NextResponse> {
  try {
    assertSameOrigin(readHeaders(req));
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const name = requireField(body.name, "name");
    const timezone = requireTimeZone(requireField(body.timezone, "timezone"));
    const { store, deps } = getRuntime();
    store.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = store
        .listBusinesses()
        .find((business) => business.name === name && business.timezone === timezone);
      if (existing) {
        store.db.exec("COMMIT");
        return NextResponse.json({ business: { id: existing.id, name, timezone }, created: false, ownerId: deps.ownerId });
      }
      const business = store.createBusiness({ name, timezone });
      store.db.exec("COMMIT");
      return NextResponse.json({ business: { id: business.id, name, timezone }, created: true, ownerId: deps.ownerId });
    } catch (error) {
      try {
        store.db.exec("ROLLBACK");
      } catch {
        // Already rolled back.
      }
      throw error;
    }
  } catch (error) {
    return connectionErrorResponse(error);
  }
}
