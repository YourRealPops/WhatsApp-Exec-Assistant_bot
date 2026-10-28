import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createDb, type Db } from "./client.js";
import { runMigrations } from "./migrations.js";
import {
  ensureUser,
  upsertEvents,
  materializeReminders,
  claimDueReminders,
  markReminderSent,
  markReminderFailed,
  listReminders,
  createAdHocReminder,
  DEFAULT_OFFSETS,
} from "./repos.js";

const url = process.env.DATABASE_URL;
const skip = url ? false : "DATABASE_URL not set — skipping DB integration test";

let db: Db | null = null;
let userId = "";

function getDb(): Db {
  if (!db) throw new Error("database not initialised");
  return db;
}

before(async () => {
  if (!url) return;
  db = createDb(url, { max: 2 });
  await runMigrations(db);
  const user = await ensureUser(db, {
    phone: `test-${randomUUID().slice(0, 12)}`,
    timezone: "Africa/Lagos",
  });
  userId = user.id;
});

after(async () => {
  if (!db) return;
  if (userId) await db`delete from users where id = ${userId}`;
  await db.end();
});

async function makeEvent(offsetMinutesFromNow: number) {
  const d = getDb();
  const start = new Date(Date.now() + offsetMinutesFromNow * 60_000);
  const [ev] = await upsertEvents(d, userId, [
    {
      externalId: `test-${randomUUID()}`,
      title: "Board review",
      start,
      end: new Date(start.getTime() + 30 * 60_000),
      location: "Boardroom",
    },
  ]);
  return ev;
}

test("materializes the 15/10/5/0 ladder for an event", { skip }, async () => {
  const d = getDb();
  const ev = await makeEvent(10); // starts in 10 minutes → T-15 and T-10 already due
  const changed = await materializeReminders(
    d,
    { id: ev.id, userId, startAt: ev.start_at },
    DEFAULT_OFFSETS,
  );
  assert.equal(changed, 4, "four fresh reminder rows expected");

  const forEvent = (await listReminders(d, userId, { limit: 100 })).filter(
    (r) => r.event_id === ev.id,
  );
  assert.equal(forEvent.length, 4);
  const byOffset = new Map(forEvent.map((r) => [r.offset_minutes, r]));
  for (const off of DEFAULT_OFFSETS) {
    const reminder = byOffset.get(off);
    assert.ok(reminder, `missing reminder for offset ${off}`);
    const expected = ev.start_at.getTime() - off * 60_000;
    assert.equal(
      Math.floor(new Date(reminder.fire_at).getTime() / 1000),
      Math.floor(expected / 1000),
      `fire_at for T-${off}`,
    );
  }
});

test("claims only due reminders, never twice, and tracks retries", { skip }, async () => {
  const d = getDb();
  const ev = await makeEvent(10);
  await materializeReminders(
    d,
    { id: ev.id, userId, startAt: ev.start_at },
    DEFAULT_OFFSETS,
  );

  const claimed = await claimDueReminders(d, new Date(), 50);
  const mine = claimed.filter((r) => r.event_id === ev.id);
  assert.equal(mine.length, 2, "only T-15 and T-10 are due");
  assert.deepEqual(
    new Set(mine.map((r) => r.offset_minutes)),
    new Set([15, 10]),
  );
  assert.ok(mine.every((r) => r.status === "sending"));

  const again = await claimDueReminders(d, new Date(), 50);
  assert.equal(
    again.filter((r) => r.event_id === ev.id).length,
    0,
    "in-flight reminders must not be claimed again",
  );

  const [sent, failed] = mine;
  await markReminderSent(d, sent.id);
  await markReminderFailed(d, failed.id, "boom", true);

  const rows = await listReminders(d, userId, { limit: 100 });
  const sentRow = rows.find((r) => r.id === sent.id)!;
  const failedRow = rows.find((r) => r.id === failed.id)!;
  assert.equal(sentRow.status, "sent");
  assert.ok(sentRow.sent_at);
  assert.equal(failedRow.status, "pending", "retryable failure goes back to pending");
  assert.equal(failedRow.last_error, "boom");
});

test("rescheduling an event moves its still-pending reminders", { skip }, async () => {
  const d = getDb();
  const ev = await makeEvent(60);
  const first = await materializeReminders(
    d,
    { id: ev.id, userId, startAt: ev.start_at },
    DEFAULT_OFFSETS,
  );
  assert.equal(first, 4);

  const newStart = new Date(ev.start_at.getTime() + 30 * 60_000);
  const [moved] = await upsertEvents(d, userId, [
    {
      externalId: ev.external_id,
      title: ev.title,
      start: newStart,
      end: new Date(newStart.getTime() + 30 * 60_000),
    },
  ]);
  const changed = await materializeReminders(
    d,
    { id: ev.id, userId, startAt: moved.start_at },
    DEFAULT_OFFSETS,
  );
  assert.equal(changed, 4, "all four pending reminders should move");

  const rows = (await listReminders(d, userId, { limit: 100 })).filter(
    (r) => r.event_id === ev.id,
  );
  for (const r of rows) {
    const expected = newStart.getTime() - (r.offset_minutes ?? 0) * 60_000;
    assert.equal(Math.floor(new Date(r.fire_at).getTime() / 1000), Math.floor(expected / 1000));
  }
});

test("ad-hoc reminders dedupe on (user, time, note)", { skip }, async () => {
  const d = getDb();
  const fireAt = new Date(Date.now() + 3_600_000);
  const first = await createAdHocReminder(d, { userId, fireAt, note: "Call the dentist" });
  const second = await createAdHocReminder(d, { userId, fireAt, note: "Call the dentist" });
  assert.ok(first, "first ad-hoc reminder created");
  assert.equal(second, null, "duplicate must be rejected");
});
