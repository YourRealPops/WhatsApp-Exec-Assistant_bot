import { test } from "node:test";
import assert from "node:assert/strict";
import {
  lookupEvent,
  normalizeTitle,
  parseClockHint,
  type LookupCandidate,
} from "./event-lookup.js";

const LAGOS = "Africa/Lagos"; // UTC+01:00, no DST

/** 21:00 and 22:30 Lagos, the two events from the production listing. */
const FUTURE_AFRICA: LookupCandidate = {
  id: "evt-future-africa",
  title: "Future Africa meeting",
  start: new Date("2026-11-19T20:00:00Z"),
};
const L2E: LookupCandidate = {
  id: "evt-l2e",
  title: "L2E meeting",
  start: new Date("2026-11-19T21:30:00Z"),
};
const CANDIDATES = [FUTURE_AFRICA, L2E];

test("presentation details are stripped before matching", () => {
  assert.equal(
    normalizeTitle("21:00 Future Africa meeting (22:00 UTC)"),
    "future africa meeting",
  );
  assert.equal(normalizeTitle("  Board   Review!! "), "board review");
  assert.equal(parseClockHint("9 PM"), "21:00");
  assert.equal(parseClockHint("21:00"), "21:00");
});

test("an exact title matches", () => {
  const result = lookupEvent(
    CANDIDATES,
    { text: "Future Africa meeting" },
    LAGOS,
  );
  assert.equal(result.kind, "matched");
  assert.equal(result.kind === "matched" && result.candidate.id, FUTURE_AFRICA.id);
});

test("a normalized title matches case, punctuation and annotations", () => {
  const result = lookupEvent(
    CANDIDATES,
    { text: "future africa MEETING (22:00 UTC)" },
    LAGOS,
  );
  assert.equal(result.kind, "matched");
  assert.equal(result.kind === "matched" && result.candidate.id, FUTURE_AFRICA.id);
});

test("a unique partial title matches", () => {
  const result = lookupEvent(CANDIDATES, { text: "L2e" }, LAGOS);
  assert.equal(result.kind, "matched");
  assert.equal(result.kind === "matched" && result.candidate.id, L2E.id);
});

test("a clock alone matches the event at that local time", () => {
  const result = lookupEvent(CANDIDATES, { time: "9 PM" }, LAGOS);
  assert.equal(result.kind, "matched");
  assert.equal(result.kind === "matched" && result.candidate.id, FUTURE_AFRICA.id);
});

test("title plus clock narrows a broad title to one event", () => {
  const candidates = [
    ...CANDIDATES,
    {
      id: "evt-future-africa-2",
      title: "Future Africa meeting",
      start: new Date("2026-11-20T08:00:00Z"),
    },
  ];
  const result = lookupEvent(
    candidates,
    { text: "Future Africa meeting", time: "9 PM" },
    LAGOS,
  );
  assert.equal(result.kind, "matched");
  assert.equal(result.kind === "matched" && result.candidate.id, FUTURE_AFRICA.id);
});

test("two matches are ambiguous and nothing is selected", () => {
  const candidates = [FUTURE_AFRICA, { ...FUTURE_AFRICA, id: "evt-other" }];
  const result = lookupEvent(candidates, { text: "Future Africa" }, LAGOS);
  assert.equal(result.kind, "ambiguous");
  assert.equal(result.kind === "ambiguous" && result.candidates.length, 2);
});

test("an ordinal picks from the listing order, never the first result", () => {
  const second = lookupEvent(CANDIDATES, { ordinal: 2 }, LAGOS);
  assert.equal(second.kind, "matched");
  assert.equal(second.kind === "matched" && second.candidate.id, L2E.id);

  const last = lookupEvent(CANDIDATES, { ordinal: -1 }, LAGOS);
  assert.equal(last.kind === "matched" && last.candidate.id, L2E.id);

  const missing = lookupEvent(CANDIDATES, { ordinal: 3 }, LAGOS);
  assert.equal(missing.kind, "none");
});

test("an event that is not there is none, not a guess", () => {
  assert.equal(lookupEvent(CANDIDATES, { text: "budget" }, LAGOS).kind, "none");
  assert.equal(lookupEvent(CANDIDATES, { time: "3 AM" }, LAGOS).kind, "none");
  assert.equal(lookupEvent([], { text: "anything" }, LAGOS).kind, "none");
});
