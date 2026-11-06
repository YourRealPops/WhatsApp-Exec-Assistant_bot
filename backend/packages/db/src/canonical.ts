import { createHash } from "node:crypto";

/**
 * Canonical JSON: keys sorted, no whitespace. Two objects that mean the same
 * thing must hash the same, otherwise the approval integrity check would fail
 * on formatting alone.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] === undefined) continue;
      out[key] = sortDeep(source[key]);
    }
    return out;
  }
  return value;
}

/** sha256 hex of the canonical JSON — the proposal's payload hash. */
export function hashPayload(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
