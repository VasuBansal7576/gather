import { NextResponse } from "next/server";
import { ServiceError } from "../../src/server/booking-service.ts";
import type { ErrorDTO } from "../../src/server/dto.ts";
import { CrossOriginError, ValidationError } from "../../src/server/validation.ts";

const STATUS_BY_CODE: Record<string, number> = {
  INVALID_REQUEST: 400,
  NOT_FOUND: 404,
  STALE_PROPOSAL: 409,
  CROSS_BOOKING: 409,
  SLOT_UNAVAILABLE: 409,
  CONFLICT: 409,
  RECONCILE_REQUIRED: 409,
  ACCESS_REVOKED: 502,
  EXECUTION_FAILED: 502,
  UNCERTAIN: 503,
  CROSS_ORIGIN_DENIED: 403,
};

export function errorBody(code: ErrorDTO["code"], message: string, retryable: boolean): ErrorDTO {
  return { code, message, retryable, demo: true };
}

export function errorResponse(code: ErrorDTO["code"], message: string, retryable = false): NextResponse {
  return NextResponse.json(errorBody(code, message, retryable), { status: STATUS_BY_CODE[code] ?? 500 });
}

export function unknownErrorResponse(error: unknown): NextResponse {
  if (error instanceof CrossOriginError) return errorResponse("CROSS_ORIGIN_DENIED", error.message, false);
  if (error instanceof ValidationError) return errorResponse("INVALID_REQUEST", error.message, false);
  if (error instanceof ServiceError) {
    return errorResponse(error.code as ErrorDTO["code"], error.message, error.retryable);
  }
  if (error instanceof Error && /not found/i.test(error.message)) {
    return errorResponse("NOT_FOUND", error.message, false);
  }
  return errorResponse("INVALID_REQUEST", error instanceof Error ? error.message : "Unknown request failure", false);
}
