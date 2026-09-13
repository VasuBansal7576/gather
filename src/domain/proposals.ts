import { createHash } from "node:crypto";
import type { ActionKind, SourceReference } from "./contracts.ts";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

export function proposalFingerprint(input: {
  bookingId: string;
  kind: ActionKind;
  payload: Record<string, unknown>;
  sourceReferences: SourceReference[];
}): string {
  const canonical = JSON.stringify(canonicalize(input));
  return createHash("sha256").update(canonical).digest("hex");
}
