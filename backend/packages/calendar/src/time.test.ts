import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addDaysToDateStr,
  parseWhen,
  startOfDayInTz,
  todayInTz,
  tzOffsetMs,
} from "./time.js";

const LAGOS = "Africa/Lagos"; // UTC+01:00, no DST

test("tz offset for Lagos is +1h", () => {
  assert.equal(tzOffsetMs(new Date("2026-10-25T12:00:00Z"), LAGOS), 3_600_000);
  assert.equal(tzOffsetMs(new Date("2026-10-25T12:00:00Z"), "UTC"), 0);
});

test("start of day is computed in the user's timezone, not the server's", () => {
  // Lagos is UTC+1, so local midnight = 23:00Z the previous day
  assert.equal(
    startOfDayInTz("2026-10-25", LAGOS).toISOString(),
    "2026-10-24T23:00:00.000Z",
  );
  assert.equal(
    startOfDayInTz("2026-10-25", "UTC").toISOString(),
    "2026-10-25T00:00:00.000Z",
  );
  // Eastern hemisphere behind UTC
  assert.equal(
    startOfDayInTz("2026-10-25", "America/New_York").toISOString(),
    "2026-10-25T04:00:00.000Z",
  );
});

test("naive datetimes are interpreted in the user's timezone", () => {
  assert.equal(
    parseWhen("2026-10-25T09:00", LAGOS).toISOString(),
    "2026-10-25T08:00:00.000Z",
  );
  assert.equal(
    parseWhen("2026-10-25T09:00:00", "UTC").toISOString(),
    "2026-10-25T09:00:00.000Z",
  );
});

test("explicit offsets win over the user timezone", () => {
  assert.equal(
    parseWhen("2026-10-25T09:00:00+02:00", LAGOS).toISOString(),
    "2026-10-25T07:00:00.000Z",
  );
  assert.equal(
    parseWhen("2026-10-25T09:00:00Z", LAGOS).toISOString(),
    "2026-10-25T09:00:00.000Z",
  );
});

test("rejects nonsense instead of producing Invalid Date", () => {
  assert.throws(() => parseWhen("next tuesday", LAGOS), /Unrecognised time/);
  assert.throws(() => parseWhen("2026-13-45T99:99", LAGOS));
});

test("date arithmetic is pure calendar math", () => {
  assert.equal(addDaysToDateStr("2026-10-31", 1), "2026-11-01");
  assert.equal(addDaysToDateStr("2026-12-31", 1), "2027-01-01");
  assert.equal(addDaysToDateStr("2026-03-01", -1), "2026-02-28");
});

test("todayInTz follows the user's clock", () => {
  const justBeforeUtcMidnight = new Date("2026-10-25T23:30:00Z");
  assert.equal(todayInTz("UTC", justBeforeUtcMidnight), "2026-10-25");
  assert.equal(todayInTz(LAGOS, justBeforeUtcMidnight), "2026-10-26");
});
