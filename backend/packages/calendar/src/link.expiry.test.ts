import { test } from "node:test";
import assert from "node:assert/strict";
import { buildConnectUrl, verifyState } from "./state.js";

const SECRET = "s".repeat(32);
const UID = "6f1d5a3c-2b7e-4f5a-9c8d-0a1b2c3d4e5f";

test("two connect requests produce two links with different expiries", () => {
  // Each build mints a fresh 30-minute window. Two requests made a moment
  // apart must therefore give the model two different links/expiries, never
  // the same bearer token twice.
  const first = buildConnectUrl({
    baseUrl: "https://ecos.example.com/",
    secret: SECRET,
    uid: UID,
    now: new Date(),
  });
  const second = buildConnectUrl({
    baseUrl: "https://ecos.example.com/",
    secret: SECRET,
    uid: UID,
    now: new Date(Date.now() + 10_000),
  });

  assert.notEqual(first, second, "the two links must differ (fresh token each call)");

  const firstUrl = new URL(first);
  const secondUrl = new URL(second);
  const firstToken = firstUrl.searchParams.get("token");
  const secondToken = secondUrl.searchParams.get("token");
  assert.ok(firstToken && secondToken, "both links carry a token");

  const firstPayload = verifyState({ secret: SECRET, token: firstToken!, purpose: "connect" });
  const secondPayload = verifyState({ secret: SECRET, token: secondToken!, purpose: "connect" });
  assert.ok(firstPayload, "the first link verifies");
  assert.ok(secondPayload, "the second link verifies");

  // Same user, but a genuinely different expiry: the second window starts
  // later and is independent of the first.
  assert.equal(firstPayload.uid, secondPayload.uid);
  assert.notEqual(firstPayload.exp, secondPayload.exp, "expiry must differ between the two links");
});

test("an expired link does not verify and cannot be re-used", () => {
  const now = new Date("2026-11-05T12:00:00Z");
  const expired = buildConnectUrl({
    baseUrl: "https://ecos.example.com/",
    secret: SECRET,
    uid: UID,
    ttlMs: 60_000,
    now,
  });
  const url = new URL(expired);
  const token = url.searchParams.get("token")!;

  assert.equal(
    verifyState({ secret: SECRET, token: token!, purpose: "connect", now: new Date("2026-11-05T12:01:00Z") }),
    null,
    "the link is expired and must not verify",
  );
});
