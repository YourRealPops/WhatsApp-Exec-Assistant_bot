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
  /** Google incremental sync token; null means the next fetch is a full sync. */
  sync_token: string | null;
  /** When the account is next due a sync (success interval or failure backoff). */
  next_sync_at: Date | null;
  /** Held while a worker is syncing this account (concurrency guard). */
  sync_lock_at: Date | null;
  /** Consecutive failed syncs, used for exponential backoff. */
  sync_attempts: number;
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
      reauth_required_at = null,
      sync_token = null,
      next_sync_at = null,
      sync_lock_at = null,
      sync_attempts = 0
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
 * Accounts that are due a sync. `next_sync_at` is authoritative: a successful
 * sync schedules the next interval, a failure schedules a backed-off retry.
 * Accounts flagged for reauth are paused until the user reconnects, so a dead
 * token can't hot-loop every tick. A lock older than 10 minutes is treated as
 * abandoned (the worker died mid-sync) and may be reclaimed.
 *
 * `intervalMs` is kept for callers that only ever pass it through; a never
 * synced account (next_sync_at is null) is always due.
 */
export async function listAccountsDueSync(
  db: Db,
  intervalMs: number
): Promise<CalendarAccount[]> {
  const fallbackCutoff = new Date(Date.now() - intervalMs);
  const rows = await db`
    select a.*, u.phone, u.timezone
    from calendar_accounts a
    join users u on u.id = a.user_id
    where a.reauth_required_at is null
      and (a.sync_lock_at is null or a.sync_lock_at < now() - interval '10 minutes')
      and (
        (a.next_sync_at is not null and a.next_sync_at <= now())
        or (
          a.next_sync_at is null
          and (a.synced_at is null or a.synced_at < ${fallbackCutoff})
        )
      )
    order by a.next_sync_at nulls first, a.synced_at nulls first`;
  return rows as unknown as CalendarAccount[];
}

/**
 * Atomically take the per-account sync lock. Returns false when another worker
 * already owns this account, so two workers never fetch the same calendar.
 */
export async function claimAccountForSync(
  db: Db,
  accountId: string
): Promise<boolean> {
  const rows = await db`
    update calendar_accounts
    set sync_lock_at = now()
    where id = ${accountId}
      and (sync_lock_at is null or sync_lock_at < now() - interval '10 minutes')
    returning id`;
  return rows.length > 0;
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

export interface MarkSyncedOptions {
  /** null means the sync was clean. */
  error?: string | null;
  /** When this account is next due; null clears the schedule. */
  nextSyncAt?: Date | null;
  /**
   * Google's incremental cursor after a successful fetch. Omit to keep the
   * stored value, pass null to clear it (an expired cursor on a full sync).
   */
  syncToken?: string | null;
  /** Reset to 0 after success; a failure path uses recordSyncFailure. */
  attempts?: number;
}

/** A successful sync: data is now current, so synced_at moves. */
export async function markSynced(
  db: Db,
  accountId: string,
  opts: MarkSyncedOptions | string | null = {}
): Promise<void> {
  const options: MarkSyncedOptions =
    typeof opts === "string" || opts === null ? { error: opts } : opts;
  await db`
    update calendar_accounts
    set synced_at = now(),
        last_sync_error = ${options.error ?? null},
        next_sync_at = ${options.nextSyncAt ?? null},
        sync_lock_at = null,
        sync_attempts = ${options.attempts ?? 0},
        sync_token = case
          when ${options.syncToken === undefined}::boolean then sync_token
          else ${options.syncToken ?? null}
        end
    where id = ${accountId}`;
}

/**
 * A failed refresh. synced_at is deliberately left untouched: the stored
 * events are still the old ones, and reporting a new sync time would present
 * stale data as current. The account is retried after a backoff.
 */
export async function recordSyncFailure(
  db: Db,
  accountId: string,
  error: string,
  attempts: number,
  nextSyncAt: Date
): Promise<void> {
  await db`
    update calendar_accounts
    set last_sync_error = ${error},
        sync_attempts = ${attempts},
        next_sync_at = ${nextSyncAt},
        sync_lock_at = null
    where id = ${accountId}`;
}

/** Drop the incremental token so the next sync fetches the full window. */
export async function clearSyncToken(db: Db, accountId: string): Promise<void> {
  await db`
    update calendar_accounts set sync_token = null where id = ${accountId}`;
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

/**
 * One event from the last calendar listing the user was shown. `position` is
 * the 1-based order of that listing, which is what "the second one" means.
 */
export interface EventReference {
  id: string;
  user_id: string;
  position: number;
  external_id: string;
  title: string;
  start_at: Date;
  end_at: Date;
  listed_at: Date;
  /** When a proposal last pointed at this event; null until then. */
  focused_at: Date | null;
}

/**
 * Replace the user's listing context in one transaction. Each successful
 * listing is the whole truth: keeping older rows around would let "the first
 * one" refer to an event the user is no longer looking at.
 */
export async function replaceEventReferences(
  db: Db,
  userId: string,
  events: Array<{
    externalId: string;
    title: string;
    start: Date;
    end: Date;
  }>,
): Promise<void> {
  await db.begin(async (tx) => {
    await tx`delete from event_references where user_id = ${userId}`;
    let position = 0;
    for (const event of events) {
      position += 1;
      await tx`
        insert into event_references
          (user_id, position, external_id, title, start_at, end_at)
        values
          (${userId}, ${position}, ${event.externalId}, ${event.title},
           ${event.start}, ${event.end})`;
    }
  });
}

/**
 * The events from the last listing, unless that listing is stale. A stale
 * context is never used to select an event silently.
 */
export async function listEventReferences(
  db: Db,
  userId: string,
  maxAgeMinutes = 720,
): Promise<EventReference[]> {
  const rows = await db`
    select * from event_references
    where user_id = ${userId}
      and listed_at >= now() - make_interval(mins => ${maxAgeMinutes})
    order by position`;
  return rows as unknown as EventReference[];
}

/** Record which referenced event a proposal resolved, for a later "it". */
export async function focusEventReference(
  db: Db,
  userId: string,
  externalId: string,
): Promise<void> {
  await db`
    update event_references
    set focused_at = now()
    where user_id = ${userId} and external_id = ${externalId}`;
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
  /**
   * What this proposal does. Absent means "reschedule": rows written before
   * cancellation existed are reschedules, and they keep the same hash.
   */
  action?: "reschedule" | "cancellation";
  eventId: string;
  calendarId: string;
  title: string;
  before: { start: string; end: string };
  /** Present for a reschedule only — a cancellation has no new times. */
  after?: { start: string; end: string };
  /** ETag of the event when the proposal was made; the write is conditional on it. */
  etag: string | null;
  timezone: string;
  /** Guests on the event: drives Google's sendUpdates on execution. */
  attendees: number;
  sendUpdates: "all" | "none";
}

export type ProposalKind = "reschedule" | "cancellation";

/**
 * A jsonb parameter. Passing an already stringified value here would be
 * double-encoded by the driver (a JSON string, not an object), which is what
 * made stored payloads fail their own hash check.
 */
function jsonb(db: Db, value: unknown): ReturnType<Db["json"]> {
  return db.json(value as Parameters<Db["json"]>[0]);
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

/**
 * Rows written before the jsonb encoding fix hold the payload as a JSON
 * string. Parsing it here keeps those proposals hash-verifiable instead of
 * turning them into unreadable objects.
 */
function normalizeProposal(row: Proposal | undefined): Proposal | null {
  if (!row) return null;
  if (typeof row.payload === "string") {
    try {
      row.payload = JSON.parse(row.payload as unknown as string) as Proposal["payload"];
    } catch {
      // Left as-is: the hash check will refuse it, which is the safe outcome.
    }
  }
  return row;
}

export async function createProposal(
  db: Db,
  input: {
    userId: string;
    kind?: ProposalKind;
    payload: ProposalPayload;
    payloadHash: string;
    expiresAt: Date;
  }
): Promise<Proposal> {
  const rows = await db`
    insert into proposals (user_id, kind, payload, payload_hash, expires_at)
    values (${input.userId}, ${input.kind ?? "reschedule"},
            ${jsonb(db, input.payload)}, ${input.payloadHash},
            ${input.expiresAt})
    returning *`;
  return rows[0] as unknown as Proposal;
}

export async function getProposal(
  db: Db,
  id: string
): Promise<Proposal | null> {
  const rows = await db`select * from proposals where id = ${id}`;
  return normalizeProposal(rows[0] as unknown as Proposal);
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
  return (rows as unknown as Proposal[])
    .map((row) => normalizeProposal(row))
    .filter((row): row is Proposal => row !== null);
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
  return normalizeProposal(rows[0] as unknown as Proposal);
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
  return normalizeProposal(rows[0] as unknown as Proposal);
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
          result.providerResult ? jsonb(db, result.providerResult) : null
        },
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

/**
 * Incremental sync reports deleted events by external id (status cancelled).
 * Cancel our copies and drop their still-pending reminders in one statement.
 */
export async function cancelEventsByExternalIds(
  db: Db,
  userId: string,
  externalIds: string[]
): Promise<{ cancelled: number; remindersRemoved: number }> {
  if (externalIds.length === 0) return { cancelled: 0, remindersRemoved: 0 };
  const rows = await db`
    with gone as (
      update events
      set status = 'cancelled', updated_at = now()
      where user_id = ${userId}
        and external_id = any(${externalIds}::text[])
        and status <> 'cancelled'
      returning id
    ), dropped as (
      delete from reminders
      where event_id in (select id from gone) and status = 'pending'
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
// Document jobs (queued by the API, rendered and delivered by the worker)
// ---------------------------------------------------------------------------

export type DocumentKind = "pdf" | "docx" | "pptx";
export type DocumentJobStatus =
  | "queued"
  | "generating"
  | "uploading"
  | "sent"
  | "failed";

export type DocumentJobSource = "calendar" | "general";

/**
 * A calendar snapshot or a general-purpose writing brief. `source` is absent
 * on rows created before general documents existed; those are calendar jobs.
 */
export interface DocumentJobPayload {
  source?: DocumentJobSource;
  /** Calendar fields (also the pre-general-document shape). */
  timezone?: string;
  rangeLabel?: string;
  events?: Array<{
    title: string;
    start: string;
    end: string;
    allDay?: boolean;
    location?: string | null;
    description?: string | null;
  }>;
  /** General-document brief. */
  subject?: string;
  prompt?: string;
  audience?: string;
  tone?: string;
  /** Requested outline or section headings, one per line. */
  structure?: string;
  slideCount?: number;
  generatedFor?: string | null;
}

export interface DocumentJob {
  id: string;
  user_id: string;
  request_message_id: string;
  kind: DocumentKind;
  title: string;
  payload: DocumentJobPayload;
  status: DocumentJobStatus;
  attempts: number;
  max_attempts: number;
  next_attempt_at: Date | null;
  error: string | null;
  wa_media_id: string | null;
  wa_message_id: string | null;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  updated_at: Date;
}

/** A claimed job with everything delivery needs, joined from users. */
export interface DocumentJobDetail extends DocumentJob {
  phone: string;
  user_name: string | null;
  user_timezone: string;
}

/**
 * Create the job for one user request. `request_message_id` is unique, so a
 * redelivered webhook returns the existing job instead of generating twice.
 */
export async function createDocumentJob(
  db: Db,
  input: {
    userId: string;
    requestMessageId: string;
    kind: DocumentKind;
    title: string;
    payload: DocumentJobPayload;
  }
): Promise<DocumentJob> {
  const rows = await db`
    insert into document_jobs
      (user_id, request_message_id, kind, title, payload)
    values
      (${input.userId}, ${input.requestMessageId}, ${input.kind},
       ${input.title}, ${jsonb(db, input.payload)})
    on conflict (request_message_id) do update
      set request_message_id = document_jobs.request_message_id
      where document_jobs.user_id = excluded.user_id
    returning *`;
  if (rows[0]) return rows[0] as unknown as DocumentJob;
  // The id exists but belongs to another user. Never return it: the caller
  // would otherwise create an acknowledgement for someone else's job.
  const existing = await db`
    select user_id from document_jobs where request_message_id = ${input.requestMessageId}`;
  if (existing[0]) {
    throw new Error("that request message id belongs to another user");
  }
  // The row disappeared between the upsert and the lookup.
  throw new Error("could not create the document job");
}

export async function getDocumentJob(
  db: Db,
  id: string
): Promise<DocumentJob | null> {
  const rows = await db`select * from document_jobs where id = ${id}`;
  return (rows[0] as unknown as DocumentJob) ?? null;
}

/**
 * Claim up to `limit` queued jobs atomically. Two workers can run in parallel
 * without ever picking up the same job.
 */
export async function claimDocumentJobs(
  db: Db,
  limit: number
): Promise<DocumentJobDetail[]> {
  const rows = await db`
    with claimed as (
      update document_jobs
      set status = 'generating',
          attempts = attempts + 1,
          started_at = now(),
          updated_at = now()
      where id in (
        select j.id from document_jobs j
        where j.status = 'queued'
          and (j.next_attempt_at is null or j.next_attempt_at <= now())
          and j.attempts < j.max_attempts
        order by j.created_at
        limit ${limit}
        for update skip locked
      )
      returning *
    )
    select c.*, u.phone, u.name as user_name, u.timezone as user_timezone
    from claimed c
    join users u on u.id = c.user_id
    order by c.created_at`;
  return rows as unknown as DocumentJobDetail[];
}

export async function markDocumentJobUploading(
  db: Db,
  id: string
): Promise<void> {
  await db`
    update document_jobs
    set status = 'uploading', updated_at = now()
    where id = ${id} and status = 'generating'`;
}

/** Only call this after WhatsApp has accepted the document message. */
export async function markDocumentJobSent(
  db: Db,
  id: string,
  delivery: { mediaId: string | null; messageId: string | null }
): Promise<void> {
  await db`
    update document_jobs
    set status = 'sent',
        wa_media_id = ${delivery.mediaId},
        wa_message_id = ${delivery.messageId},
        error = null,
        completed_at = now(),
        updated_at = now()
    where id = ${id} and status in ('generating', 'uploading')`;
}

/**
 * Record a failed attempt. Transient failures go back to the queue with a
 * backoff; exhausted or permanent failures become terminal.
 */
export async function markDocumentJobFailed(
  db: Db,
  id: string,
  error: string,
  retry: boolean,
  nextAttemptAt: Date | null = null
): Promise<void> {
  await db`
    update document_jobs
    set status = ${retry ? "queued" : "failed"},
        error = ${error},
        next_attempt_at = ${nextAttemptAt},
        updated_at = now(),
        completed_at = ${retry ? null : new Date()}
    where id = ${id} and status in ('generating', 'uploading')`;
}

/**
 * Return jobs stuck in generating/uploading (the worker died mid-job) to the
 * queue, or fail them once they have used all their attempts. Mirrors the
 * reminder recovery path so no job is silently lost across a restart.
 */
export async function requeueStuckDocumentJobs(
  db: Db,
  olderThanMinutes: number
): Promise<number> {
  const rows = await db`
    update document_jobs
    set status = case when attempts >= max_attempts then 'failed' else 'queued' end,
        error = case when attempts >= max_attempts
                     then 'worker died mid-job' else error end,
        next_attempt_at = now(),
        completed_at = case when attempts >= max_attempts then now() else completed_at end,
        updated_at = now()
    where status in ('generating', 'uploading')
      and updated_at < now() - make_interval(mins => ${olderThanMinutes})
    returning id`;
  return rows.length;
}

/** Retention sweep: finished jobs (and their stored metadata) are deleted. */
export async function cleanupDocumentJobs(
  db: Db,
  retentionDays: number
): Promise<number> {
  const rows = await db`
    delete from document_jobs
    where status in ('sent', 'failed')
      and updated_at < now() - make_interval(days => ${retentionDays})
    returning id`;
  return rows.length;
}

/** Queue health, useful for logs and the implementation report. */
export async function documentJobCounts(
  db: Db
): Promise<Record<string, number>> {
  const rows = await db`select status, count(*)::int as count from document_jobs group by status`;
  const out: Record<string, number> = {};
  for (const row of rows) out[String(row.status)] = Number(row.count);
  return out;
}
