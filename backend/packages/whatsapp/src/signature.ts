import { createHmac, timingSafeEqual } from "node:crypto";

/** Compute Meta's expected `sha256=<hex>` signature for a raw request body. */
export function computeSignature(appSecret: string, rawBody: string): string {
  return `sha256=${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;
}

/**
 * Verify the `x-hub-signature-256` header against the raw (unparsed) body.
 * Comparison is length-checked first so timingSafeEqual never throws.
 */
export function verifySignature(
  rawBody: string | Buffer,
  header: string | undefined | null,
  appSecret: string,
): boolean {
  if (!header || !appSecret) return false;
  const expected = Buffer.from(computeSignature(appSecret, rawBody.toString("utf8")));
  const actual = Buffer.from(header);
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
