import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSignature, verifySignature } from "./signature.js";

const SECRET = "cat_secret_123";
const BODY = JSON.stringify({ object: "whatsapp_business_account", entry: [] });

test("computes sha256= prefixed hex HMAC", () => {
  const sig = computeSignature(SECRET, BODY);
  assert.match(sig, /^sha256=[0-9a-f]{64}$/);
});

test("accepts a correctly signed body", () => {
  assert.equal(verifySignature(BODY, computeSignature(SECRET, BODY), SECRET), true);
});

test("rejects a wrong secret", () => {
  assert.equal(verifySignature(BODY, computeSignature("other", BODY), SECRET), false);
});

test("rejects a tampered body", () => {
  const sig = computeSignature(SECRET, BODY);
  const tampered = BODY.replace("entry", "entrX");
  assert.equal(verifySignature(tampered, sig, SECRET), false);
});

test("rejects missing or malformed headers", () => {
  assert.equal(verifySignature(BODY, undefined, SECRET), false);
  assert.equal(verifySignature(BODY, "", SECRET), false);
  assert.equal(verifySignature(BODY, "sha256=short", SECRET), false);
  assert.equal(verifySignature(BODY, "deadbeef", SECRET), false);
});

test("rejects when no app secret is configured", () => {
  assert.equal(verifySignature(BODY, computeSignature(SECRET, BODY), ""), false);
});
