import { NextResponse } from "next/server";
import { ConnectionError } from "../../../src/server/connections/index.ts";
import { CrossOriginError, ValidationError } from "../../../src/server/validation.ts";

const STATUS_BY_CODE: Record<string, number> = {
  UNAVAILABLE: 503,
  INVALID_REQUEST: 400,
  REPLAY: 409,
  NOT_FOUND: 404,
  STALE: 409,
  CROSS_BUSINESS: 409,
  ACCESS_REVOKED: 409,
  EXCHANGE_FAILED: 502,
  MISSING_SCOPE: 409,
};

/** Connection errors are redacted by contract: provider messages are generic, tokens never appear. */
export function connectionErrorResponse(error: unknown): NextResponse {
  if (error instanceof CrossOriginError) {
    return NextResponse.json({ code: "CROSS_ORIGIN_DENIED", message: error.message, retryable: false }, { status: 403 });
  }
  if (error instanceof ValidationError) {
    return NextResponse.json({ code: "INVALID_REQUEST", message: error.message, retryable: false }, { status: 400 });
  }
  if (error instanceof ConnectionError) {
    return NextResponse.json(
      { code: error.code, message: error.message, retryable: error.retryable },
      { status: STATUS_BY_CODE[error.code] ?? 500 },
    );
  }
  return NextResponse.json(
    { code: "INVALID_REQUEST", message: "Request failed", retryable: false },
    { status: 400 },
  );
}
