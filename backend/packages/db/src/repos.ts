import { redactQueryValues } from "@exec-assistant/ai";
import type { Db } from "./client.js";

/**
 * Redact query values of `token=` and `state=` in every message body. This is
 * the single place a stored message becomes safe for the LLM context or for
 * a later outbound row.
 */
export function redactMessageBodies(messages: Message[]): Message[] {
  return messages.map((m) => ({ ...m, body: redactQueryValues(m.body) }));
}
// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export interface User {
  id: string;
  phone: string;
  name: string | null;
  /** Job title/role the user gave ECOS, e.g. "CTO". */
  designation: string | null;
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
  /** Ciphertext (AES-256-GCM, "v1:" prefixed) — never log this. */
  access_token: string;
  /** Ciphertext, or null when Google issued no refresh token. */
  refresh_token: string | null;
  expires_at: Date | null;
  calendar_id: string;
  synced_at: Date | null;
  /** The Google account that granted access, shown in status and the web page. */
  account_email: string | null;
  /** Exactly what Google granted, e.g. calendar.events. */
  scopes: string[];
  connected_at: Date | null;
  /** Why the last sync failed; null means the last sync was clean. */
  last_sync_error: string | null;
  /** Google rejected the grant; the account is paused until the user reconnects. */
  reauth_required_at: Date | null;
  created_at: Date;
  /** Joined from users by listAccountsDueSync, for reconnect messages. */
  phone?: string | null;
  timezone?: string | null;
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
  /** Date-only event: start_at/end_at are local midnight, no reminder ladder. */
  all_day: boolean;
  updated_at: Date;
}

export interface EventInput {
  externalId: string;
  title: string;
  start: Date;
  end: Date;
  allDay?: boolean;
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
  /** Ring the user's phone for this reminder, not just message them. */
  alarm: boolean;
  called_at: Date | null;
  call_sid: string | null;
  call_error: string | null;
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
  input: { phone: string; timezone?: string; name?: string | null }
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
  phone: string
): Promise<User | null> {
  const rows = await db`select * from users where phone = ${phone}`;
  return (rows[0] as unknown as User) ?? null;
}

/**
 * Sets or edits the profile. An omitted field is left untouched, so a user can
 * change only their designation (or only their name) without wiping the other
 * — and a stored name survives until they explicitly replace it.
 */
export async function setUserProfile(
  db: Db,
  userId: string,
  input: { name?: string | null; designation?: string | null }
): Promise<User | null> {
  const rows = await db`
    update users set
      name = coalesce(${input.name ?? null}, name),
      designation = coalesce(${input.designation ?? null}, designation)
    where id = ${userId}
    returning *`;
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
  }
): Promise<boolean> {
  const rows = await db`
    insert into messages (id, user_id, direction, body, channel)
    values (${msg.id}, ${msg.userId}, ${msg.direction}, ${msg.body}, ${
    msg.channel ?? "whatsapp"
  })
    on conflict (id) do nothing
    returning id`;
  return rows.length > 0;
}/**
 * Most recent messages, oldest first (ready to feed an LLM prompt). The
 * bodies are redacted so any calendar link already in the history can never
 * be re-quoted by the model or recorded to a new outbound row.
 */
export async function listHistory(
  db: Db,
  userId: string,
  limit = 20
): Promise<Message[]> {
  const rows = await db`select * from messages
    where user_id = ${userId}
    order by created_at desc, id desc
    limit ${limit}`;
  const messages = (rows as unknown as Message[]).reverse();
  return redactMessageBodies(messages);
}

// ---------------------------------------------------------------------------
// Calendar accounts
// ---------------------------------------------------------------------------

export async function upsertCalendarAccount(
  db: Db,
  input: {
    userId: string;
    provider: string;
    /** Ciphertext: encrypt before calling (see packages/calendar crypto). */
    accessToken: string;
    refreshToken?: string | null;
    expiresAt?: Date | null;
    calendarId?: string;
    accountEmail?: string | null;
    scopes?: string[];
  }
): Promise<CalendarAccount> {
  const rows = await db`
    insert into calendar_accounts
      (user_id, provider, access_token, refresh_token, expires_at, calendar_id,
       synced_at, account_email, scopes, connected_at)
    values
      (${input.userId}, ${input.provider}, ${input.accessToken},
       ${input.refreshToken ?? null}, ${input.expiresAt ?? null},
       ${input.calendarId ?? "primary"}, null, ${input.accountEmail ?? null},
       ${input.scopes ?? []}::text[], now())
    on conflict (user_id) do update set
      provider = excluded.provider,
      access_token = excluded.access_token,
      refresh_token = coalesce(excluded.refresh_token, calendar_accounts.refresh_token),
      expires_at = excluded.expires_at,
      calendar_id = excluded.calendar_id,
      account_email = coalesce(excluded.account_email, calendar_accounts.account_email),
      scopes = case when cardinality(excluded.scopes) > 0
                    then excluded.scopes else calendar_accounts.scopes end,
      connected_at = now(),
      synced_at = null,
      last_sync_error = null,
      reauth_required_at = null
    returning *`;
  return rows[0] as unknown as CalendarAccount;
}

export async function getCalendarAccount(
  db: Db,
  userId: string
): Promise<CalendarAccount | null> {
  const rows =
    await db`select * from calendar_accounts where user_id = ${userId}`;
  return (rows[0] as unknown as CalendarAccount) ?? null;
}

/**
 * Accounts whose grant still works and whose last sync is old enough.
 * Accounts flagged for reauth are paused until the user reconnects, so a dead
 * token can't hot-loop every tick.
 */
export async function listAccountsDueSync(
  db: Db,
  intervalMs: number
): Promise<CalendarAccount[]> {
  const cutoff = new Date(Date.now() - intervalMs);
  const rows = await db`
    select a.*, u.phone, u.timezone
    from calendar_accounts a
    join users u on u.id = a.user_id
    where a.reauth_required_at is null
      and (a.synced_at is null or a.synced_at < ${cutoff})
    order by a.synced_at nulls first`;
  return rows as unknown as CalendarAccount[];
}

/**
 * Pause an account whose grant Google rejected. Returns true only on the
 * pending → flagged transition, so the user is messaged exactly once.
 */
export async function markReauthRequired(
  db: Db,
  accountId: string
): Promise<boolean> {
  const rows = await db`
    update calendar_accounts
    set reauth_required_at = now()
    where id = ${accountId} and reauth_required_at is null
    returning id`;
  return rows.length > 0;
}

export async function markSynced(
  db: Db,
  accountId: string,
  error: string | null = null
): Promise<void> {
  await db`
    update calendar_accounts
    set synced_at = now(), last_sync_error = ${error}
    where id = ${accountId}`;
}

/**
 * Encrypt tokens that were stored before encryption existed. Idempotent: rows
 * that already carry a ciphertext are skipped, so it is safe on every boot.
 */
export async function encryptLegacyTokens(
  db: Db,
  codec: { isEncrypted(value: string): boolean; encrypt(value: string): string }
): Promise<number> {
  const rows = await db`
    select id, access_token, refresh_token from calendar_accounts`;
  let changed = 0;
  for (const row of rows) {
    const access = String(row.access_token);
    const refresh = row.refresh_token === null ? null : String(row.refresh_token);
    const accessEnc = codec.isEncrypted(access) ? access : codec.encrypt(access);
    const refreshEnc =
      refresh === null || codec.isEncrypted(refresh) ? refresh : codec.encrypt(refresh);
    if (accessEnc === access && refreshEnc === refresh) continue;
    await db`
      update calendar_accounts
      set access_token = ${accessEnc}, refresh_token = ${refreshEnc}
      where id = ${row.id}`;
    changed += 1;
  }
  return changed;
}

/**
 * Remove a connection and everything derived from it, in one transaction:
 * the stored tokens, the provider's synced events and their pending reminders.
 * Idempotent — running it twice is not an error.
 */
export async function disconnectCalendarAccount(
  db: Db,
  userId: string
): Promise<{ removed: boolean; cancelledEvents: number; removedReminders: number }> {
  return db.begin(async (tx) => {
    const account = await tx`
      select id from calendar_accounts where user_id = ${userId}`;
    if (account.length === 0) {
      return { removed: false, cancelledEvents: 0, removedReminders: 0 };
    }
    const cancelled = await tx`
      update events
      set status = 'cancelled', updated_at = now()
      where user_id = ${userId}
        and status <> 'cancelled'
        and external_id not like 'dev:%'
        and external_id not like 'local:%'
      returning id`;
    const dropped = await tx`
      delete from reminders
      where user_id = ${userId}
        and event_id is not null
        and status = 'pending'
      returning id`;
    await tx`delete from calendar_accounts where user_id = ${userId}`;
    return {
      removed: true,
      cancelledEvents: cancelled.length,
      removedReminders: dropped.length,
    };
  }) as unknown as {
    removed: boolean;
    cancelledEvents: number;
    removedReminders: number;
  };
}

export async function updateAccountTokens(
  db: Db,
  accountId: string,
  tokens: { accessToken: string; expiresAt: Date | null }
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
  events: EventInput[]
): Promise<CalEvent[]> {
  const out: CalEvent[] = [];
  for (const e of events) {
    const rows = await db`
      insert into events
        (user_id, external_id, title, start_at, end_at, all_day, location, description, status, updated_at)
      values
        (${userId}, ${e.externalId}, ${e.title}, ${e.start}, ${e.end}, ${e.allDay ?? false},
         ${e.location ?? null}, ${e.description ?? null}, ${e.status ?? "confirmed"}, now())
      on conflict (user_id, external_id) do update set
        title = excluded.title,
        start_at = excluded.start_at,
        end_at = excluded.end_at,
        all_day = excluded.all_day,
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
  limit = 200
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

/**
 * After a complete fetch of the sync window: events Google did not return are
 * gone, so cancel them and drop their unsent reminders. Only ever call this
 * with the full list — a partial page would look like mass deletion.
 *
 * `dev:*` fixtures and assistant-created `local:*` events are not Google's to
 * reconcile, so they are left alone.
 */
export async function reconcileMissingEvents(
  db: Db,
  userId: string,
  opts: { from: Date; to: Date; seenExternalIds: string[] }
): Promise<{ cancelled: number; remindersRemoved: number }> {
  const rows = await db`
    with gone as (
      update events
      set status = 'cancelled', updated_at = now()
      where user_id = ${userId}
        and start_at >= ${opts.from}
        and start_at < ${opts.to}
        and status <> 'cancelled'
        and not (external_id = any(${opts.seenExternalIds}::text[]))
        and external_id not like 'dev:%'
        and external_id not like 'local:%'
      returning id
    ), dropped as (
      delete from reminders
      where event_id in (select id from gone)
        and status = 'pending'
      returning id
    )
    select
      (select count(*)::int from gone) as cancelled,
      (select count(*)::int from dropped) as reminders_removed`;
  const row = rows[0] as unknown as {
    cancelled: number;
    reminders_removed: number;
  };
  return { cancelled: row.cancelled, remindersRemoved: row.reminders_removed };
}

// ---------------------------------------------------------------------------
// Proposals (propose → approve → execute → verify)
// ---------------------------------------------------------------------------

export type ProposalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "expired"
  | "executing"
  | "succeeded"
  | "failed";

/** The exact change a user is approving — stored, hashed and executed verbatim. */
export interface ProposalPayload {
  eventId: string;
  calendarId: string;
  title: string;
  before: { start: string; end: string };
  after: { start: string; end: string };
  /** ETag of the event when the proposal was made; the write is conditional on it. */
  etag: string | null;
  timezone: string;
  /** Guests on the event: drives Google's sendUpdates on execution. */
  attendees: number;
  sendUpdates: "all" | "none";
}

export interface Proposal {
  id: string;
  user_id: string;
  kind: string;
  payload: ProposalPayload;
  payload_hash: string;
  status: ProposalStatus;
  expires_at: Date;
  created_at: Date;
  decided_at: Date | null;
  executed_at: Date | null;
  provider_result: Record<string, unknown> | null;
  error: string | null;
}

export async function createProposal(
  db: Db,
  input: {
    userId: string;
    kind?: "reschedule";
    payload: ProposalPayload;
    payloadHash: string;
    expiresAt: Date;
  }
): Promise<Proposal> {
  const rows = await db`
    insert into proposals (user_id, kind, payload, payload_hash, expires_at)
    values (${input.userId}, ${input.kind ?? "reschedule"},
            ${JSON.stringify(input.payload)}::jsonb, ${input.payloadHash},
            ${input.expiresAt})
    returning *`;
  return rows[0] as unknown as Proposal;
}

export async function getProposal(
  db: Db,
  id: string
): Promise<Proposal | null> {
  const rows = await db`select * from proposals where id = ${id}`;
  return (rows[0] as unknown as Proposal) ?? null;
}

export async function listPendingProposals(
  db: Db,
  userId: string,
  now: Date = new Date()
): Promise<Proposal[]> {
  const rows = await db`
    select * from proposals
    where user_id = ${userId}
      and status = 'pending'
      and expires_at > ${now}
    order by created_at desc`;
  return rows as unknown as Proposal[];
}

/**
 * One-time use: pending → executing in a single UPDATE. Whoever gets a row
 * back owns the execution; a second tap (or a second worker) gets null.
 * Also enforces ownership and expiry inside the statement.
 */
export async function claimProposal(
  db: Db,
  opts: { id: string; userId: string; now?: Date }
): Promise<Proposal | null> {
  const now = opts.now ?? new Date();
  const rows = await db`
    update proposals
    set status = 'executing', decided_at = now()
    where id = ${opts.id}
      and user_id = ${opts.userId}
      and status = 'pending'
      and expires_at > ${now}
    returning *`;
  return (rows[0] as unknown as Proposal) ?? null;
}

export async function rejectProposal(
  db: Db,
  opts: { id: string; userId: string; now?: Date }
): Promise<Proposal | null> {
  const now = opts.now ?? new Date();
  const rows = await db`
    update proposals
    set status = 'rejected', decided_at = now()
    where id = ${opts.id}
      and user_id = ${opts.userId}
      and status = 'pending'
      and expires_at > ${now}
    returning *`;
  return (rows[0] as unknown as Proposal) ?? null;
}

/** Terminal state for an execution attempt that already claimed the proposal. */
export async function finishProposal(
  db: Db,
  id: string,
  result: {
    status: "succeeded" | "failed";
    providerResult?: Record<string, unknown> | null;
    error?: string | null;
  }
): Promise<void> {
  await db`
    update proposals
    set status = ${result.status},
        executed_at = now(),
        provider_result = ${
          result.providerResult ? JSON.stringify(result.providerResult) : null
        }::jsonb,
        error = ${result.error ?? null}
    where id = ${id} and status = 'executing'`;
}

/** Terminal failure for a proposal that never reached a provider write. */
export async function failProposal(
  db: Db,
  id: string,
  error: string
): Promise<void> {
  await db`
    update proposals
    set status = 'failed', error = ${error}, executed_at = coalesce(executed_at, now())
    where id = ${id} and status in ('pending', 'executing')`;
}

/** Flip one pending proposal to expired (e.g. a tap that arrived too late). */
export async function expireProposal(db: Db, id: string): Promise<boolean> {
  const rows = await db`
    update proposals
    set status = 'expired', decided_at = now()
    where id = ${id} and status = 'pending'
    returning id`;
  return rows.length > 0;
}

/** Worker sweep: pending proposals past their TTL become expired. */
export async function expireStaleProposals(
  db: Db,
  now: Date = new Date()
): Promise<number> {
  const rows = await db`
    update proposals
    set status = 'expired', decided_at = now()
    where status = 'pending' and expires_at <= ${now}
    returning id`;
  return rows.length;
}

/** Append-only audit trail of proposal transitions (no message bodies). */
export async function logProposalEvent(
  db: Db,
  input: {
    proposalId: string;
    from: ProposalStatus | null;
    to: ProposalStatus;
    detail?: string | null;
  }
): Promise<void> {
  await db`
    insert into proposal_events (proposal_id, from_status, to_status, detail)
    values (${input.proposalId}, ${input.from}, ${input.to}, ${input.detail ?? null})`;
}

/**
 * Spend a one-shot web nonce. Returns false when it was already used, which is
 * what makes a replayed disconnect link harmless.
 */
export async function useNonce(db: Db, nonce: string): Promise<boolean> {
  const rows = await db`
    insert into used_nonces (nonce) values (${nonce})
    on conflict (nonce) do nothing
    returning nonce`;
  return rows.length > 0;
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
  event: { id: string; userId: string; startAt: Date; allDay?: boolean },
  offsets: number[]
): Promise<number> {
  if (offsets.length === 0 || event.allDay) return 0;
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
  opts: { offsets: number[]; lookaheadDays: number; maxOffsetMinutes: number }
): Promise<number> {
  if (opts.offsets.length === 0) return 0;
  const rows = await db`
    insert into reminders (user_id, event_id, offset_minutes, fire_at)
    select e.user_id, e.id, o.off, e.start_at - make_interval(mins => o.off)
    from events e, unnest(${opts.offsets}::int[]) as o(off)
    where e.status = 'confirmed'
      and e.all_day = false
      and e.start_at >= now() - make_interval(mins => ${opts.maxOffsetMinutes})
      and e.start_at < now() + make_interval(days => ${opts.lookaheadDays})
    on conflict (event_id, offset_minutes)
    do update set fire_at = excluded.fire_at, updated_at = now()
    where reminders.status = 'pending'
      and reminders.fire_at is distinct from excluded.fire_at
    returning id`;
  return rows.length;
}

/**
 * One-off reminder not tied to a calendar event. Deduped on (user, time, note).
 * Rings the phone by default — a reminder the user set by hand should alert.
 */
export async function createAdHocReminder(
  db: Db,
  input: { userId: string; fireAt: Date; note: string; alarm?: boolean }
): Promise<Reminder | null> {
  const rows = await db`
    insert into reminders (user_id, event_id, offset_minutes, fire_at, note, alarm)
    select ${input.userId}, null, null, ${input.fireAt}, ${input.note}, ${
    input.alarm ?? true
  }
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
  limit: number
): Promise<ReminderDetail[]> {
  const rows = await db`
    with claimed as (
      update reminders
      set status = 'sending', attempts = attempts + 1, updated_at = now()
      where id in (
        select r2.id from reminders r2
where r2.status = 'pending'
  and r2.fire_at <= ${now}
  and (r2.event_id is null
       or exists (select 1 from events e
                  where e.id = r2.event_id and e.status <> 'cancelled'))
order by r2.fire_at
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

/** A reminder's alarm call connected/started; the provider call id is kept for tracing. */
export async function markReminderCalled(
  db: Db,
  id: string,
  sid: string
): Promise<void> {
  await db`
    update reminders
    set called_at = now(), call_sid = ${sid}, call_error = null, updated_at = now()
    where id = ${id}`;
}

/** The alarm call never went out. Best-effort: the message may still have landed. */
export async function markReminderCallFailed(
  db: Db,
  id: string,
  error: string
): Promise<void> {
  await db`
    update reminders
    set call_error = ${error}, updated_at = now()
    where id = ${id}`;
}

export async function markReminderFailed(
  db: Db,
  id: string,
  error: string,
  retry: boolean
): Promise<void> {
  await db`
    update reminders
    set status = ${
      retry ? "pending" : "failed"
    }, last_error = ${error}, updated_at = now()
    where id = ${id}`;
}

/** Return rows stuck in 'sending' (worker died mid-send) to the queue, or fail them if out of attempts. */
export async function requeueStuckReminders(
  db: Db,
  olderThanMinutes: number,
  maxAttempts: number
): Promise<number> {
  const rows = await db`
    update reminders
    set status = case when attempts >= ${maxAttempts} then 'failed' else 'pending' end,
        last_error = case when attempts >= ${maxAttempts}
                          then 'worker died mid-send' else last_error end,
        updated_at = now()
    where status = 'sending'
      and updated_at < now() - make_interval(mins => ${olderThanMinutes})
    returning id`;
  return rows.length;
}

/** Event reminders that missed their window are dropped; ad-hoc reminders are never expired. */
export async function expireStaleReminders(
  db: Db,
  now: Date,
  graceMinutes: number
): Promise<number> {
  const rows = await db`
    update reminders
    set status = 'failed', last_error = 'expired: missed delivery window', updated_at = now()
    where status = 'pending'
      and event_id is not null
      and fire_at < ${now}::timestamptz - make_interval(mins => ${graceMinutes})
    returning id`;
  return rows.length;
}

export async function listReminders(
  db: Db,
  userId: string,
  opts: { limit?: number; status?: string } = {}
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
  limit = 20
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
  eventIds: string[]
): Promise<number> {
  let removed = 0;
  for (const eventId of eventIds) {
    const rows = await db`
      delete from reminders where event_id = ${eventId} and status = 'pending'`;
    removed += rows.count;
  }
  return removed;
}
