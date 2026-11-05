import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createDb, type Db } from "./client.js";
import { runMigrations } from "./migrations.js";
import {
  DEFAULT_OFFSETS,
  cancelEventReminders,
  claimDueReminders,
  createAdHocReminder,
  ensureUser,
  getCalendarAccount,
  listAccountsDueSync,
  listReminders,
  listUpcomingEvents,
  markReauthRequired,
  materializeAllReminders,
  materializeReminders,
  reconcileMissingEvents,
  upsertCalendarAccount,
  upsertEvents,
  type User,
} from "./repos.js";

const url = process.env.DATABASE_URL;
const skip = url ? false : "DATABASE_URL not set — skipping DB integration test";

let db: Db | null = null;
const userIds: string[] = [];

function getDb(): Db {
  if (!db) throw new Error("database not initialised");
  return db;
}

/** A fresh user per test, so counts and windows never overlap. */
async function makeUser(timezone = "Africa/Lagos"): Promise<User> {
  const user = await ensureUser(getDb(), {
    phone: `test-${randomUUID().slice(0, 12)}`,
    timezone,
  });
  userIds.push(user.id);
  return user;
}

function future(minutesFromNow: number): Date {
  return new Date(Date.now() + minutesFromNow * 60_000);
}

before(async () => {
  if (!url) return;
  db = createDb(url, { max: 2 });
  await runMigrations(db);
});

after(async () => {
  if (!db) return;
  for (const id of userIds) await db`delete from users where id = ${id}`;
  await db.end();
});

test("reconnecting keeps the stored refresh token and clears the reauth flag", { skip }, async () => {
  const d = getDb();
  const user = await makeUser();

  const first = await upsertCalendarAccount(d, {
    userId: user.id,
    provider: "google",
    accessToken: "access-1",
    refreshToken: "refresh-1",
    expiresAt: future(60),
  });
  assert.equal(first.refresh_token, "refresh-1");

  assert.equal(await markReauthRequired(d, first.id), true, "the first failure flags it");
  assert.equal(await markReauthRequired(d, first.id), false, "later failures do not re-notify");
  const flagged = await getCalendarAccount(d, user.id);
  assert.ok(flagged?.reauth_required_at, "flagged in the database");

  // Google re-consents sometimes omit the refresh token; the old one must stay.
  const again = await upsertCalendarAccount(d, {
    userId: user.id,
    provider: "google",
    accessToken: "access-2",
    refreshToken: null,
    expiresAt: future(60),
  });
  assert.equal(again.access_token, "access-2");
  assert.equal(again.refresh_token, "refresh-1", "the refresh token survives reconnect");
  assert.equal(again.reauth_required_at, null, "a successful reconnect clears the flag");

  // …and a reconnect that does carry a new token replaces it.
  const third = await upsertCalendarAccount(d, {
    userId: user.id,
    provider: "google",
    accessToken: "access-3",
    refreshToken: "refresh-2",
  });
  assert.equal(third.refresh_token, "refresh-2");
});

test("flagged accounts are skipped by the sync scheduler until they reconnect", { skip }, async () => {
  const d = getDb();
  const user = await makeUser();
  const account = await upsertCalendarAccount(d, {
    userId: user.id,
    provider: "google",
    accessToken: "access-1",
    refreshToken: "refresh-1",
  });

  const due = await listAccountsDueSync(d, 0);
  const mine = due.find((a) => a.id === account.id);
  assert.ok(mine, "a fresh account is due");
  assert.equal(mine.phone, user.phone, "the user's phone is joined in for messages");
  assert.equal(mine.timezone, "Africa/Lagos", "the user's timezone is joined in");

  await markReauthRequired(d, account.id);
  const paused = await listAccountsDueSync(d, 0);
  assert.equal(
    paused.some((a) => a.id === account.id),
    false,
    "a dead grant must not be retried every tick",
  );

  await upsertCalendarAccount(d, {
    userId: user.id,
    provider: "google",
    accessToken: "access-2",
    refreshToken: null,
  });
  const resumed = await listAccountsDueSync(d, 0);
  assert.ok(resumed.some((a) => a.id === account.id), "reconnecting resumes syncing");
});

test("all-day events get no reminder ladder", { skip }, async () => {
  const d = getDb();
  const user = await makeUser();
  const start = future(180);

  const [allDay] = await upsertEvents(d, user.id, [
    {
      externalId: `allday-${randomUUID()}`,
      title: "Public holiday",
      start,
      end: new Date(start.getTime() + 24 * 3_600_000),
      allDay: true,
    },
  ]);
  assert.equal(allDay.all_day, true);

  const [timed] = await upsertEvents(d, user.id, [
    {
      externalId: `timed-${randomUUID()}`,
      title: "Board review",
      start,
      end: new Date(start.getTime() + 30 * 60_000),
    },
  ]);
  assert.equal(timed.all_day, false);

  await materializeAllReminders(d, {
    offsets: DEFAULT_OFFSETS,
    lookaheadDays: 14,
    maxOffsetMinutes: 15,
  });
  const rows = await listReminders(d, user.id, { limit: 200 });
  assert.equal(
    rows.filter((r) => r.event_id === allDay.id).length,
    0,
    "no 15/10/5/0 rows for an all-day event",
  );
  assert.equal(
    rows.filter((r) => r.event_id === timed.id).length,
    4,
    "timed events still get the full ladder",
  );

  assert.equal(
    await materializeReminders(
      d,
      { id: allDay.id, userId: user.id, startAt: allDay.start_at, allDay: true },
      DEFAULT_OFFSETS,
    ),
    0,
    "the per-event path skips all-day events too",
  );
});

test("a complete fetch reconciles events Google no longer returns", { skip }, async () => {
  const d = getDb();
  const user = await makeUser();
  const suffix = randomUUID().slice(0, 8);
  const from = future(-60);
  const to = future(14 * 24 * 60);

  const make = async (externalId: string, startMinutes: number) => {
    const start = future(startMinutes);
    const [event] = await upsertEvents(d, user.id, [
      {
        externalId,
        title: externalId,
        start,
        end: new Date(start.getTime() + 30 * 60_000),
      },
    ]);
    return event;
  };

  const kept = await make(`google-kept-${suffix}`, 120);
  const deleted = await make(`google-deleted-${suffix}`, 180);
  const outside = await make(`google-outside-${suffix}`, 20 * 24 * 60);
  const dev = await make(`dev:gym:${suffix}`, 240);
  const local = await make(`local:${suffix}`, 300);

  await materializeReminders(
    d,
    { id: deleted.id, userId: user.id, startAt: deleted.start_at },
    DEFAULT_OFFSETS,
  );
  const before = await listReminders(d, user.id, { limit: 200 });
  assert.equal(before.filter((r) => r.event_id === deleted.id).length, 4);

  const result = await reconcileMissingEvents(d, user.id, {
    from,
    to,
    seenExternalIds: [kept.external_id],
  });
  assert.equal(result.cancelled, 1, "only the vanished event is cancelled");
  assert.equal(result.remindersRemoved, 4, "its pending reminders are dropped");

  const after = await listUpcomingEvents(d, user.id, from, future(30 * 24 * 60), 500);
  const ids = after.map((e) => e.external_id);
  assert.ok(ids.includes(kept.external_id), "events Google still returns are kept");
  assert.equal(ids.includes(deleted.external_id), false, "the deleted event disappears");
  assert.ok(ids.includes(outside.external_id), "events outside the window are untouched");
  assert.ok(ids.includes(dev.external_id), "dev fixtures are never reconciled");
  assert.ok(ids.includes(local.external_id), "locally created events are never reconciled");

  const left = await listReminders(d, user.id, { limit: 200 });
  assert.equal(
    left.filter((r) => r.event_id === deleted.id && r.status === "pending").length,
    0,
    "no reminders keep firing for a deleted event",
  );
});

test("claiming skips reminders for cancelled events but keeps ad-hoc ones", { skip }, async () => {
  const d = getDb();
  const user = await makeUser();
  const start = future(10);

  const [event] = await upsertEvents(d, user.id, [
    {
      externalId: `claim-${randomUUID()}`,
      title: "Board review",
      start,
      end: new Date(start.getTime() + 30 * 60_000),
    },
  ]);
  await materializeReminders(
    d,
    { id: event.id, userId: user.id, startAt: event.start_at },
    DEFAULT_OFFSETS,
  );
  const pending = (await listReminders(d, user.id, { limit: 200 })).filter(
    (r) => r.event_id === event.id && r.status === "pending",
  );
  assert.ok(pending.length > 0, "the ladder is materialised");

  // Google dropped the event without saying so: the reminder rows are pending,
  // but the event is no longer confirmed.
  await upsertEvents(d, user.id, [
    {
      externalId: event.external_id,
      title: event.title,
      start: new Date(event.start_at),
      end: new Date(event.end_at),
      status: "cancelled",
    },
  ]);

  const adHoc = await createAdHocReminder(d, {
    userId: user.id,
    fireAt: future(-1),
    note: "Call the dentist",
  });
  assert.ok(adHoc);

  const claimed = await claimDueReminders(d, future(1), 200);
  assert.equal(
    claimed.filter((r) => r.event_id === event.id).length,
    0,
    "a cancelled event's reminders must not be claimed",
  );
  assert.ok(
    claimed.some((r) => r.id === adHoc.id),
    "reminders with no event stay eligible",
  );

  // Clean up so this user's rows can't leak into other assertions.
  await cancelEventReminders(d, [event.id]);
});
