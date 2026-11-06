import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Token encryption at rest (AES-256-GCM).
 *
 * OAuth refresh tokens are long-lived credentials: a database dump must not be
 * a Google account take-over. Values are stored as `v1:<base64(iv|tag|ct)>` so
 * an encrypted row is recognisable, and the prefix is also what makes the
 * legacy backfill idempotent.
 *
 * The key comes from TOKEN_ENCRYPTION_KEY (base64, exactly 32 bytes):
 *   openssl rand -base64 32
 */

export const TOKEN_KEY_BYTES = 32;
const PREFIX = "v1:";
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Decode TOKEN_ENCRYPTION_KEY, rejecting anything that isn't a 32-byte key. */
export function parseTokenKey(raw: string | undefined | null): Buffer {
  const value = (raw ?? "").trim();
  if (!value) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY is not set — generate one with: openssl rand -base64 32",
    );
  }
  const key = Buffer.from(value, "base64");
  if (key.length !== TOKEN_KEY_BYTES) {
    throw new Error(
      `TOKEN_ENCRYPTION_KEY must decode to exactly ${TOKEN_KEY_BYTES} bytes (base64). Got ${key.length}.`,
    );
  }
  return key;
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}

/** AES-256-GCM encrypt one token; the IV is random per call. */
export function encryptToken(plaintext: string, key: Buffer): string {
  if (key.length !== TOKEN_KEY_BYTES) {
    throw new Error("encryption key must be 32 bytes");
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

/**
 * Decrypt a stored token. Unprefixed values are returned unchanged so a row
 * written before encryption existed still works until the backfill runs —
 * the migration, not a crash, is what fixes old rows.
 */
export function decryptToken(value: string, key: Buffer): string {
  if (!isEncrypted(value)) return value;
  const raw = Buffer.from(value.slice(PREFIX.length), "base64");
  if (raw.length <= IV_BYTES + TAG_BYTES) {
    throw new Error("stored token is malformed");
  }
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = raw.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  // A wrong key or a tampered value throws here — never silently returns junk.
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
    "utf8",
  );
}
