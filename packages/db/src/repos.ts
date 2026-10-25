import type { Db } from "./client.js";

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export interface User {
  id: string;
  phone: string;
  name: string | null;
  timezone: string;
  created_at: Date;
}

export interface Message {
  id: string;
  user_id: string;
  direction: "inbound" | "outbound";
  body: string;
  channel: string;
  created_at: Date;
}

export interface CalendarAccount {
  id: string;
  user_id: string;
  provider: string;
  access_token: string;
  refresh_token: string | null;
  expires_at: Date | null;
  calendar_id: string;
  synced_at: Date | null;
  created_at: Date;
}

export interface CalEvent {
  id: string;
  user_id: string;
  external_id: string;
  title: string;
  start_at: Date;
  end_at: Date;
  location: string | null;
  description: string | null;
  status: string;
  updated_at: Date;
}

export interface EventInput {
  externalId: string;
  title: string;
  start: Date;
  end: Date;
  location?: string | null;
  description?: string | null;
  status?: string;
}

export interface Reminder {
  id: string;
  user_id: string;
  event_id: string | null;
  offset_minutes: number | null;
  fire_at: Date;
  note: string;
  status: "pending" | "sending" | "sent" | "failed";
  attempts: number;
  last_error: string | null;
  sent_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** Reminder ladder offsets in minutes before an event starts. */
export const DEFAULT_OFFSETS = [15, 10, 5, 0];

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export async function ensureUser(
  db: Db,
  input: { phone: string; timezone?: string; name?: string | null },
): Promise<User> {
  const rows = await db`
    insert into users (phone, timezone, name)
    values (${input.phone}, ${input.timezone ?? "UTC"}, ${input.name ?? null})
    on conflict (phone) do update set phone = users.phone
    returning *`;
  return rows[0] as unknown as User;
}

export async function getUserById(db: Db, id: string): Promise<User | null> {
  const rows = await db`select * from users where id = ${id}`;
  return (rows[0] as unknown as User) ?? null;
}

export async function getUserByPhone(
  db: Db,
  phone: string,
): Promise<User | null> {
  const rows = await db`select * from users where phone = ${phone}`;
  return (rows[0] as unknown as User) ?? null;
}

// ---------------------------------------------------------------------------
// Messages (the primary key doubles as Meta's message id → webhook dedupe)
// ---------------------------------------------------------------------------

export async function saveMessage(
  db: Db,
  msg: {
    id: string;
    userId: string;
    direction: "inbound" | "outbound";
    body: string;
    channel?: string;
  },
): Promise<boolean> {
  const rows = await db`
    insert into messages (id, user_id, direction, body, channel)
    values (${msg.id}, ${msg.userId}, ${msg.direction}, ${msg.body}, ${msg.channel ?? "whatsapp"})
    on conflict (id) do nothing
    returning id`;
  return rows.length > 0;
}

/** Most recent messages, oldest first (ready to feed an LLM prompt). */
export async function listHistory(
  db: Db,
  userId: string,
  limit = 20,
): Promise<Message[]> {
  const rows = await db`
    select * from messages
    where user_id = ${userId}
    order by created_at desc, id desc
    limit ${limit}`;
  return (rows as unknown as Message[]).reverse();
}

// ---------------------------------------------------------------------------
// Calendar accounts
// ---------------------------------------------------------------------------

export async function upsertCalendarAccount(
  db: Db,
  input: {
    userId: string;
    provider: string;
    accessToken: string;
    refreshToken?: string | null;
    expiresAt?: Date | null;
    calendarId?: string;
  },
): Promise<CalendarAccount> {
  const rows = await db`
    insert into calendar_accounts
      (user_id, provider, access_token, refresh_token, expires_at, calendar_id, synced_at)
    values
      (${input.userId}, ${input.provider}, ${input.accessToken},
       ${input.refreshToken ?? null}, ${input.expiresAt ?? null},
       ${input.calendarId ?? "primary"}, null)
    on conflict (user_id) do update set
      provider = excluded.provider,
      access_token = excluded.access_token,
      refresh_token = coalesce(excluded.refresh_token, calendar_accounts.refresh_token),
      expires_at = excluded.expires_at,
      calendar_id = excluded.calendar_id,
      synced_at = null
    returning *`;
  return rows[0] as unknown as CalendarAccount;
}

export async function getCalendarAccount(
  db: Db,
  userId: string,
): Promise<CalendarAccount | null> {
  const rows = await db`select * from calendar_accounts where user_id = ${userId}`;
  return (rows[0] as unknown as CalendarAccount) ?? null;
}

export async function listAccountsDueSync(
  db: Db,
  intervalMs: number,
): Promise<CalendarAccount[]> {
  const cutoff = new Date(Date.now() - intervalMs);
  const rows = await db`
    select * from calendar_accounts
    where synced_at is null or synced_at < ${cutoff}
    order by synced_at nulls first`;
  return rows as unknown as CalendarAccount[];
}

export async function markSynced(db: Db, accountId: string): Promise<void> {
  await db`update calendar_accounts set synced_at = now() where id = ${accountId}`;
}

export async function updateAccountTokens(
  db: Db,
  accountId: string,
  tokens: { accessToken: string; expiresAt: Date | null },
): Promise<void> {
  await db`
    update calendar_accounts
    set access_token = ${tokens.accessToken}, expires_at = ${tokens.expiresAt}
    where id = ${accountId}`;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export async function upsertEvents(
  db: Db,
  userId: string,
  events: EventInput[],
): Promise<CalEvent[]> {
  const out: CalEvent[] = [];
  for (const e of events) {
    const rows = await db`
      insert into events
        (user_id, external_id, title, start_at, end_at, location, description, status, updated_at)
      values
        (${userId}, ${e.externalId}, ${e.title}, ${e.start}, ${e.end},
         ${e.location ?? null}, ${e.description ?? null}, ${e.status ?? "confirmed"}, now())
      on conflict (user_id, external_id) do update set
        title = excluded.title,
        start_at = excluded.start_at,
        end_at = excluded.end_at,
        location = excluded.location,
        description = excluded.description,
        status = excluded.status,
        updated_at = now()
      returning *`;
    out.push(rows[0] as unknown as CalEvent);
  }
  return out;
}

export async function listUpcomingEvents(
  db: Db,
  userId: string,
  from: Date,
  to: Date,
  limit = 200,
): Promise<CalEvent[]> {
  const rows = await db`
    select * from events
    where user_id = ${userId}
      and start_at >= ${from}
      and start_at < ${to}
      and status <> 'cancelled'
    order by start_at
    limit ${limit}`;
  return rows as unknown as CalEvent[];
}

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

/**
 * Ensure every event has one reminder row per offset. Rescheduled events
 * move their still-pending reminders; already-sent ones are left alone.
 * Returns how many rows were created or adjusted.
 */
export async function materializeReminders(
  db: Db,
  event: { id: string; userId: string; startAt: Date },
  offsets: number[],
): Promise<number> {
  if (offsets.length === 0) return 0;
  const rows = await db`
    insert into reminders (user_id, event_id, offset_minutes, fire_at)
    select ${event.userId}, ${event.id}, o.off, ${event.startAt}::timestamptz - make_interval(mins => o.off)
    from unnest(${offsets}::int[]) as o(off)
    on conflict (event_id, offset_minutes)
    do update set fire_at = excluded.fire_at, updated_at = now()
    where reminders.status = 'pending'
      and reminders.fire_at is distinct from excluded.fire_at
    returning id`;
  return rows.length;
}

/**
 * Bulk version for the worker: ensure every confirmed event in the window
 * has one reminder per offset, in a single statement.
 * Returns how many rows were created or adjusted.
 */
export async function materializeAllReminders(
  db: Db,
  opts: { offsets: number[]; lookaheadDays: number; maxOffsetMinutes: number },
): Promise<number> {
  if (opts.offsets.length === 0) return 0;
  const rows = await db`
    insert into reminders (user_id, event_id, offset_minutes, fire_at)
    select e.user_id, e.id, o.off, e.start_at - make_interval(mins => o.off)
    from events e, unnest(${opts.offsets}::int[]) as o(off)
    where e.status = 'confirmed'
      and e.start_at >= now() - make_interval(mins => ${opts.maxOffsetMinutes})
      and e.start_at < now() + make_interval(days => ${opts.lookaheadDays})
    on conflict (event_id, offset_minutes)
    do update set fire_at = excluded.fire_at, updated_at = now()
    where reminders.status = 'pending'
      and reminders.fire_at is distinct from excluded.fire_at
    returning id`;
  return rows.length;
}

/** One-off reminder not tied to a calendar event. Deduped on (user, time, note). */
export async function createAdHocReminder(
  db: Db,
  input: { userId: string; fireAt: Date; note: string },
): Promise<Reminder | null> {
  const rows = await db`
    insert into reminders (user_id, event_id, offset_minutes, fire_at, note)
    select ${input.userId}, null, null, ${input.fireAt}, ${input.note}
    where not exists (
      select 1 from reminders r
      where r.user_id = ${input.userId}
        and r.event_id is null
        and r.fire_at = ${input.fireAt}
        and r.note = ${input.note}
    )
    returning *`;
  return (rows[0] as unknown as Reminder) ?? null;
}

/** A claimed reminder joined with everything needed to build the message. */
export interface ReminderDetail extends Reminder {
  phone: string | null;
  timezone: string | null;
  event_title: string | null;
  event_start: Date | null;
}

/** Atomically claim due reminders (status pending → sending), skipping rows other workers hold. */
export async function claimDueReminders(
  db: Db,
  now: Date,
  limit: number,
): Promise<ReminderDetail[]> {
  const rows = await db`
    with claimed as (
      update reminders
      set status = 'sending', attempts = attempts + 1, updated_at = now()
      where id in (
        select id from reminders
        where status = 'pending' and fire_at <= ${now}
        order by fire_at
        limit ${limit}
        for update skip locked
      )
      returning *
    )
    select c.*, u.phone, u.timezone, e.title as event_title, e.start_at as event_start
    from claimed c
    left join users u on u.id = c.user_id
    left join events e on e.id = c.event_id
    order by c.fire_at`;
  return rows as unknown as ReminderDetail[];
}

export async function markReminderSent(db: Db, id: string): Promise<void> {
  await db`
    update reminders
    set status = 'sent', sent_at = now(), last_error = null, updated_at = now()
    where id = ${id}`;
}

export async function markReminderFailed(
  db: Db,
  id: string,
  error: string,
  retry: boolean,
): Promise<void> {
  await db`
    update reminders
    set status = ${retry ? "pending" : "failed"}, last_error = ${error}, updated_at = now()
    where id = ${id}`;
}

export async function listReminders(
  db: Db,
  userId: string,
  opts: { limit?: number; status?: string } = {},
): Promise<Reminder[]> {
  const limit = opts.limit ?? 50;
  if (opts.status) {
    const rows = await db`
      select * from reminders
      where user_id = ${userId} and status = ${opts.status}
      order by fire_at limit ${limit}`;
    return rows as unknown as Reminder[];
  }
  const rows = await db`
    select * from reminders
    where user_id = ${userId}
    order by fire_at limit ${limit}`;
  return rows as unknown as Reminder[];
}

/** Pending reminders with their event titles — for the assistant's list_reminders tool. */
export interface UpcomingReminder extends Reminder {
  event_title: string | null;
}

export async function listUpcomingReminders(
  db: Db,
  userId: string,
  limit = 20,
): Promise<UpcomingReminder[]> {
  const rows = await db`
    select r.*, e.title as event_title
    from reminders r
    left join events e on e.id = r.event_id
    where r.user_id = ${userId}
      and r.status in ('pending', 'sending')
    order by r.fire_at
    limit ${limit}`;
  return rows as unknown as UpcomingReminder[];
}

/** Users who have not connected a calendar yet (candidates for dev fixtures). */
export async function listUsersWithoutCalendar(db: Db): Promise<User[]> {
  const rows = await db`
    select u.* from users u
    left join calendar_accounts a on a.user_id = u.id
    where a.id is null
    order by u.created_at`;
  return rows as unknown as User[];
}

/** Drop still-pending reminders for events that disappeared or were cancelled. */
export async function cancelEventReminders(
  db: Db,
  eventIds: string[],
): Promise<number> {
  let removed = 0;
  for (const eventId of eventIds) {
    const rows = await db`
      delete from reminders where event_id = ${eventId} and status = 'pending'`;
    removed += rows.count;
  }
  return removed;
}
