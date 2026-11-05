import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReminderDetail } from "@exec-assistant/db";
import { buildTwiML } from "./alarm.js";
import { buildAlarmText } from "./dispatch.js";

function reminder(overrides: Partial<ReminderDetail> = {}): ReminderDetail {
  return {
    id: "00000000-0000-0000-0000-000000000000",
    user_id: "00000000-0000-0000-0000-000000000001",
    event_id: null,
    offset_minutes: null,
    fire_at: new Date("2026-11-04T08:30:00Z"),
    note: "Call the dentist",
    status: "sending",
    attempts: 1,
    last_error: null,
    sent_at: null,
    alarm: true,
    called_at: null,
    call_sid: null,
    call_error: null,
    created_at: new Date("2026-11-01T00:00:00Z"),
    updated_at: new Date("2026-11-01T00:00:00Z"),
    phone: "+2348012345678",
    timezone: "Africa/Lagos",
    event_title: null,
    event_start: null,
    ...overrides,
  };
}

/** ICU inserts narrow no-break spaces before AM/PM on some versions. */
function spoken(text: string): string {
  return text.replace(/[\s\u202f\u00a0]+/g, " ");
}

test("TwiML is escaped XML and speaks the reminder twice", () => {
  const twiml = buildTwiML('Pay <rent> & "fees"', "Polly.Joanna", "en-US");
  const say = `<Say voice="Polly.Joanna" language="en-US">Pay &lt;rent&gt; &amp; &quot;fees&quot;</Say>`;
  assert.equal(twiml, `<Response>${say}${say}</Response>`);
  assert.equal(twiml.match(/<Say /g)?.length, 2, "spoken twice per call");
});

test("ad-hoc reminders are spoken as plain text on a 12-hour clock", () => {
  const text = spoken(buildAlarmText(reminder()));
  assert.equal(text, "Reminder. Call the dentist. Due at 9:30 AM GMT+1.");
  assert.ok(!/[\u{23F0}\u{1F514}]/u.test(text), "no emoji in spoken copy");
});

test("event reminders are spoken with their offset", () => {
  const text = spoken(
    buildAlarmText(
      reminder({
        event_id: "event-1",
        event_title: "Investor call",
        event_start: new Date("2026-11-04T09:00:00Z"),
        offset_minutes: 15,
      }),
    ),
  );
  assert.equal(
    text,
    "Reminder. Investor call starts in 15 minutes, at 10:00 AM GMT+1.",
  );
});

test("a T-0 event reminder says the event starts now", () => {
  const text = spoken(
    buildAlarmText(
      reminder({
        event_id: "event-1",
        event_title: "Standup",
        event_start: new Date("2026-11-04T09:00:00Z"),
        offset_minutes: 0,
      }),
    ),
  );
  assert.equal(text, "Reminder. Standup starts now, at 10:00 AM GMT+1.");
});
