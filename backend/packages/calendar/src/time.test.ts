import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addDaysToDateStr,
  clockInTz,
  parseSpokenWhen,
  parseWhen,
  startOfDayInTz,
  todayInTz,
  tzOffsetMs,
  zonedToUtc,
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

test("Lagos wall-clock converts to UTC once, in both directions", () => {
  // 21:00 Lagos is 20:00 UTC — never 22:00.
  assert.equal(
    zonedToUtc(2026, 11, 19, 21, 0, LAGOS).toISOString(),
    "2026-11-19T20:00:00.000Z",
  );
  // 22:30 Lagos is 21:30 UTC.
  assert.equal(
    zonedToUtc(2026, 11, 19, 22, 30, LAGOS).toISOString(),
    "2026-11-19T21:30:00.000Z",
  );
  // ...and back: the same instant reads 21:00 again in Lagos.
  assert.equal(clockInTz(new Date("2026-11-19T20:00:00Z"), LAGOS), "21:00");
  assert.equal(clockInTz(new Date("2026-11-19T21:30:00Z"), LAGOS), "22:30");
});

test("'tomorrow' is the user's tomorrow, in their timezone", () => {
  // 00:30 UTC on the 20th is already 01:30 on the 20th in Lagos, and 10am
  // "tomorrow" from there is the 21st — 09:00 UTC.
  const now = new Date("2026-11-20T00:30:00Z");
  assert.equal(
    parseSpokenWhen("10 AM tomorrow", LAGOS, now).toISOString(),
    "2026-11-21T09:00:00.000Z",
  );
  // The same sentence late on the 19th UTC is still 10:00 on the 20th local.
  assert.equal(
    parseSpokenWhen("10a.m tomorrow", LAGOS, new Date("2026-11-19T12:00:00Z"))
      .toISOString(),
    "2026-11-20T09:00:00.000Z",
  );
});

test("spoken times need no offset arithmetic from the caller", () => {
  const now = new Date("2026-11-19T12:00:00Z"); // 13:00 in Lagos
  assert.equal(
    parseSpokenWhen("4 PM", LAGOS, now).toISOString(),
    "2026-11-19T15:00:00.000Z",
  );
  assert.equal(
    parseSpokenWhen("today at 21:00", LAGOS, now).toISOString(),
    "2026-11-19T20:00:00.000Z",
  );
  assert.equal(
    parseSpokenWhen("noon", LAGOS, now).toISOString(),
    "2026-11-19T11:00:00.000Z",
  );
  // Explicit offsets are taken as written, in any zone.
  assert.equal(
    parseSpokenWhen("2026-11-20T10:00:00+01:00", LAGOS, now).toISOString(),
    "2026-11-20T09:00:00.000Z",
  );
});
