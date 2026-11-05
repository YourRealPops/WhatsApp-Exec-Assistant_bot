import { test } from "node:test";
import assert from "node:assert/strict";
import { parseProfile } from "./profile.js";

test("the answer to the greeting gives name and designation", () => {
  assert.deepEqual(parseProfile("Ada Lovelace, CTO at Analytic Engines"), {
    name: "Ada Lovelace",
    designation: "CTO at Analytic Engines",
    explicit: false,
  });
});

test("'my name is … and I'm the …' splits both parts", () => {
  assert.deepEqual(parseProfile("my name is Ada and I'm the CTO"), {
    name: "Ada",
    designation: "CTO",
    explicit: true,
  });
});

test("a bare name is accepted, with no designation", () => {
  assert.deepEqual(parseProfile("Ada Lovelace"), {
    name: "Ada Lovelace",
    designation: null,
    explicit: false,
  });
});

test("'call me …' is an explicit name change", () => {
  assert.deepEqual(parseProfile("call me Ada"), {
    name: "Ada",
    designation: null,
    explicit: true,
  });
});

test("a lowercase nickname only counts when stated outright", () => {
  assert.equal(parseProfile("ada"), null, "a bare lowercase word is too ambiguous to store");
  assert.equal(parseProfile("call me ada")?.name, "ada");
});

test("questions, greetings and refusals are not profiles", () => {
  assert.equal(parseProfile("what's on my calendar today?"), null);
  assert.equal(parseProfile("Good morning"), null);
  assert.equal(parseProfile("I am available tomorrow"), null);
  assert.equal(parseProfile("Not telling you"), null);
  assert.equal(parseProfile(""), null);
});

test("an over-long designation is dropped instead of stored", () => {
  const parsed = parseProfile(`Ada, ${"x".repeat(120)}`);
  assert.equal(parsed?.name, "Ada");
  assert.equal(parsed?.designation, null);
});
