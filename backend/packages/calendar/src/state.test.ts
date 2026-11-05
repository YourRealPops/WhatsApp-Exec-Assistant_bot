import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONNECT_TOKEN_TTL_MS,
  MIN_OAUTH_STATE_SECRET_LENGTH,
  buildConnectUrl,
  reconnectNotice,
  signState,
  verifyState,
} from "./state.js";

const SECRET = "s".repeat(MIN_OAUTH_STATE_SECRET_LENGTH);
const UID = "6f1d5a3c-2b7e-4f5a-9c8d-0a1b2c3d4e5f";

test("a signed state round-trips for the requesting user", () => {
  const token = signState({ secret: SECRET, uid: UID, purpose: "connect" });
  const payload = verifyState({ secret: SECRET, token, purpose: "connect" });
  assert.ok(payload);
  assert.equal(payload.uid, UID);
  assert.equal(payload.purpose, "connect");
  assert.ok(payload.exp > Date.now(), "expiry must be in the future");
  assert.equal(token.split(".").length, 2, "payload.signature");
  assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
});

test("a tampered payload is rejected", () => {
  const token = signState({ secret: SECRET, uid: UID, purpose: "connect" });
  const [, signature] = token.split(".");
  const forged = Buffer.from(
    JSON.stringify({ uid: "attacker", exp: Date.now() + 60_000, purpose: "connect" }),
  ).toString("base64url");
  assert.equal(
    verifyState({ secret: SECRET, token: `${forged}.${signature}`, purpose: "connect" }),
    null,
  );
});

test("a tampered signature, a different secret and a missing token are rejected", () => {
  const token = signState({ secret: SECRET, uid: UID, purpose: "connect" });
  const [payload, signature] = token.split(".");
  const flipped = `${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`;
  assert.equal(
    verifyState({ secret: SECRET, token: `${payload}.${flipped}`, purpose: "connect" }),
    null,
  );
  assert.equal(
    verifyState({ secret: "t".repeat(40), token, purpose: "connect" }),
    null,
    "a token signed with another secret must not verify",
  );
  assert.equal(verifyState({ secret: SECRET, token: "", purpose: "connect" }), null);
  assert.equal(verifyState({ secret: SECRET, token: "nonsense", purpose: "connect" }), null);
  assert.equal(verifyState({ secret: SECRET, token: "a.b.c", purpose: "connect" }), null);
});

test("an expired token is rejected", () => {
  const now = new Date("2026-11-05T12:00:00Z");
  const token = signState({
    secret: SECRET,
    uid: UID,
    purpose: "connect",
    ttlMs: 60_000,
    now,
  });
  assert.ok(
    verifyState({ secret: SECRET, token, purpose: "connect", now: new Date("2026-11-05T12:00:30Z") }),
    "still inside its lifetime",
  );
  assert.equal(
    verifyState({ secret: SECRET, token, purpose: "connect", now: new Date("2026-11-05T12:01:01Z") }),
    null,
  );
});

test("a token minted for another purpose is rejected", () => {
  const connect = signState({ secret: SECRET, uid: UID, purpose: "connect" });
  const oauth = signState({ secret: SECRET, uid: UID, purpose: "oauth" });
  assert.equal(verifyState({ secret: SECRET, token: connect, purpose: "oauth" }), null);
  assert.equal(verifyState({ secret: SECRET, token: oauth, purpose: "connect" }), null);
});

test("short secrets are refused when signing", () => {
  assert.throws(
    () => signState({ secret: "too-short", uid: UID, purpose: "connect" }),
    new RegExp(`at least ${MIN_OAUTH_STATE_SECRET_LENGTH}`),
  );
});

test("the connect link is a 30-minute signed token on /auth/google", () => {
  const link = buildConnectUrl({ baseUrl: "https://ecos.example.com/", secret: SECRET, uid: UID });
  const url = new URL(link);
  assert.equal(url.origin + url.pathname, "https://ecos.example.com/auth/google");
  const token = url.searchParams.get("token");
  assert.ok(token, "token query param");
  const payload = verifyState({ secret: SECRET, token: token!, purpose: "connect" });
  assert.ok(payload);
  assert.equal(payload.uid, UID);
  const lifetime = payload.exp - Date.now();
  assert.ok(
    Math.abs(lifetime - CONNECT_TOKEN_TTL_MS) < 5_000,
    `expected a ~30 minute lifetime, got ${lifetime}ms`,
  );
  assert.equal(url.searchParams.get("user"), null, "no raw user id in the link");
});

test("the reconnect notice is one line carrying the link", () => {
  const notice = reconnectNotice("https://ecos.example.com/auth/google?token=abc.def");
  assert.ok(notice.includes("https://ecos.example.com/auth/google?token=abc.def"));
  assert.equal(notice.split("\n").length, 1, "one line only");
  assert.match(notice, /calendar/i);
});
