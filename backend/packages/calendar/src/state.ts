import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signed, expiring tokens for the OAuth `state` parameter and for the
 * connect link we hand the user. A raw user id in the URL lets anyone
 * attach their own Google account to somebody else's calendar, so the id
 * always travels inside `base64url(payload).base64url(hmac)`.
 */

export const MIN_OAUTH_STATE_SECRET_LENGTH = 32;
/** Connect links are clicked from chat, sometimes hours later. */
export const CONNECT_TOKEN_TTL_MS = 30 * 60_000;
/** The redirect Google sees dies with the consent screen it belongs to. */
export const OAUTH_STATE_TTL_MS = 10 * 60_000;

/**
 * A connect link must never be redeemable as a callback state, or vice versa —
 * and the connections page gets its own purpose so a connect link can't be
 * replayed there either.
 */
export type StatePurpose = "connect" | "oauth" | "connections";

/** The connections page is a reading + disconnect action, not an auth flow. */
export const CONNECTIONS_TOKEN_TTL_MS = 30 * 60_000;

export interface StatePayload {
  uid: string;
  /** Expiry, epoch milliseconds. */
  exp: number;
  purpose: StatePurpose;
}

function assertSecret(secret: string): void {
  if (!secret || secret.length < MIN_OAUTH_STATE_SECRET_LENGTH) {
    throw new Error(
      `OAUTH_STATE_SECRET must be at least ${MIN_OAUTH_STATE_SECRET_LENGTH} characters`,
    );
  }
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function parsePayload(raw: string): StatePayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { uid, exp, purpose } = parsed as Record<string, unknown>;
  if (typeof uid !== "string" || uid.length === 0) return null;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return null;
  if (purpose !== "connect" && purpose !== "oauth" && purpose !== "connections") {
    return null;
  }
  return { uid, exp, purpose };
}

/** `base64url(payload).base64url(hmac)` for one user and purpose. */
export function signState(opts: {
  secret: string;
  uid: string;
  purpose: StatePurpose;
  ttlMs?: number;
  now?: Date;
}): string {
  assertSecret(opts.secret);
  const ttlMs =
    opts.ttlMs ??
    (opts.purpose === "connect"
      ? CONNECT_TOKEN_TTL_MS
      : opts.purpose === "connections"
        ? CONNECTIONS_TOKEN_TTL_MS
        : OAUTH_STATE_TTL_MS);
  const now = (opts.now ?? new Date()).getTime();
  const payload: StatePayload = {
    uid: opts.uid,
    exp: now + ttlMs,
    purpose: opts.purpose,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  return `${encoded}.${sign(encoded, opts.secret)}`;
}

/**
 * The payload behind a token, or null for anything that is not a currently
 * valid token of exactly this purpose (tampered, expired, malformed, wrong
 * purpose, signed with another secret).
 */
export function verifyState(opts: {
  secret: string;
  token: string;
  purpose: StatePurpose;
  now?: Date;
}): StatePayload | null {
  assertSecret(opts.secret);
  const parts = opts.token.split(".");
  if (parts.length !== 2) return null;
  const [encoded, provided] = parts;
  if (!encoded || !provided) return null;

  const expected = Buffer.from(sign(encoded, opts.secret), "base64url");
  const actual = Buffer.from(provided, "base64url");
  if (expected.length !== actual.length) return null;
  if (!timingSafeEqual(expected, actual)) return null;

  const payload = parsePayload(Buffer.from(encoded, "base64url").toString("utf8"));
  if (!payload) return null;
  if (payload.purpose !== opts.purpose) return null;
  if (payload.exp <= (opts.now ?? new Date()).getTime()) return null;
  return payload;
}

/** `/auth/google?token=<signed, 30 min>` — the link we chat to the user. */
export function buildConnectUrl(opts: {
  baseUrl: string;
  secret: string;
  uid: string;
  ttlMs?: number;
  now?: Date;
}): string {
  const token = signState({
    secret: opts.secret,
    uid: opts.uid,
    purpose: "connect",
    ttlMs: opts.ttlMs,
    now: opts.now,
  });
  return `${opts.baseUrl.replace(/\/+$/, "")}/auth/google?token=${encodeURIComponent(token)}`;
}

/** `/connections?token=<signed, 30 min>` — status + disconnect, in a browser. */
export function buildConnectionsUrl(opts: {
  baseUrl: string;
  secret: string;
  uid: string;
  ttlMs?: number;
  now?: Date;
}): string {
  const token = signState({
    secret: opts.secret,
    uid: opts.uid,
    purpose: "connections",
    ttlMs: opts.ttlMs,
    now: opts.now,
  });
  return `${opts.baseUrl.replace(/\/+$/, "")}/connections?token=${encodeURIComponent(token)}`;
}

/**
 * One-line nudge for both the proactive WhatsApp message and the pipeline
 * notice. Deliberately not logged anywhere: the link is a bearer credential.
 */
export function reconnectNotice(link: string): string {
  return `⚠️ Google Calendar needs reconnecting — open this link within 30 minutes: ${link}`;
}
