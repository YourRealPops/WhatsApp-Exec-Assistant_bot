import type { Db } from "./client.js";

/**
 * Migrations are append-only: never edit an applied entry, add a new one.
 * The runner takes a Postgres advisory lock inside one transaction, so the
 * API and the worker booting at the same time is safe.
 */
const MIGRATIONS: string[] = [
  `
  create table if not exists users (
    id uuid primary key default gen_random_uuid(),
    phone text not null unique,
    name text,
    timezone text not null default 'UTC',
    created_at timestamptz not null default now()
  );

  create table if not exists messages (
    id text primary key,
    user_id uuid not null references users(id) on delete cascade,
    direction text not null check (direction in ('inbound', 'outbound')),
    body text not null,
    channel text not null default 'whatsapp',
    created_at timestamptz not null default now()
  );
  create index if not exists messages_user_created_idx
    on messages (user_id, created_at desc, id desc);

  create table if not exists calendar_accounts (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null unique references users(id) on delete cascade,
    provider text not null default 'google',
    access_token text not null,
    refresh_token text,
    expires_at timestamptz,
    calendar_id text not null default 'primary',
    synced_at timestamptz,
    created_at timestamptz not null default now()
  );

  create table if not exists events (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references users(id) on delete cascade,
    external_id text not null,
    title text not null,
    start_at timestamptz not null,
    end_at timestamptz not null,
    location text,
    description text,
    status text not null default 'confirmed',
    updated_at timestamptz not null default now(),
    unique (user_id, external_id)
  );
  create index if not exists events_user_start_idx on events (user_id, start_at);

  create table if not exists reminders (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references users(id) on delete cascade,
    event_id uuid references events(id) on delete cascade,
    offset_minutes int,
    fire_at timestamptz not null,
    note text not null default '',
    status text not null default 'pending'
      check (status in ('pending', 'sending', 'sent', 'failed')),
    attempts int not null default 0,
    last_error text,
    sent_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (event_id, offset_minutes)
  );
  create index if not exists reminders_pending_idx
    on reminders (fire_at) where status = 'pending';
  create index if not exists reminders_user_idx on reminders (user_id, fire_at);
  create unique index if not exists reminders_adhoc_uniq
    on reminders (user_id, fire_at, note) where event_id is null;
  `,
  `
  -- Reminder alarms: ring the user's phone with a spoken reminder in addition
  -- to the WhatsApp message. The alarm flag marks which rows get a call; the
  -- ladder stays message-only unless a row opts in.
  alter table reminders
    add column if not exists alarm boolean not null default false,
    add column if not exists called_at timestamptz,
    add column if not exists call_sid text,
    add column if not exists call_error text;
  `,
  `
  -- A dead Google grant must become visible: the worker flags the account,
  -- stops syncing it and asks the user to reconnect. Cleared on reconnect.
  alter table calendar_accounts
    add column if not exists reauth_required_at timestamptz;
  `,
  `
  -- All-day events are dates, not instants: keep them off the 15/10/5/0
  -- ladder and let lists print "All day" instead of a clock time.
  alter table events
    add column if not exists all_day boolean not null default false;
  `,
  `
  -- ECOS opens with "can I know your name and designation?": keep both so
  -- every later reply can address the user by name until they change it.
  alter table users add column if not exists designation text;
  `,
  `
  -- A visible connection: which Google account, exactly what it granted, when
  -- it was linked and why the last sync failed (if it did).
  alter table calendar_accounts
    add column if not exists account_email text,
    add column if not exists scopes text[] not null default '{}',
    add column if not exists connected_at timestamptz,
    add column if not exists last_sync_error text;

  -- Reschedule proposals. ECOS never writes to Google on the model's say-so:
  -- it stores the exact intended change, asks, and executes only an approved
  -- proposal. payload_hash is the integrity check for "exactly what was
  -- approved is exactly what runs".
  create table if not exists proposals (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references users(id) on delete cascade,
    kind text not null default 'reschedule'
      check (kind in ('reschedule')),
    payload jsonb not null,
    payload_hash text not null,
    status text not null default 'pending'
      check (status in ('pending', 'approved', 'rejected', 'expired',
                        'executing', 'succeeded', 'failed')),
    expires_at timestamptz not null,
    created_at timestamptz not null default now(),
    decided_at timestamptz,
    executed_at timestamptz,
    provider_result jsonb,
    error text
  );
  create index if not exists proposals_user_pending_idx
    on proposals (user_id, status, expires_at);
  create index if not exists proposals_expiry_idx
    on proposals (expires_at) where status = 'pending';

  -- Every transition, with a timestamp (masked, no message bodies).
  create table if not exists proposal_events (
    id bigserial primary key,
    proposal_id uuid not null references proposals(id) on delete cascade,
    from_status text,
    to_status text not null,
    detail text,
    created_at timestamptz not null default now()
  );
  create index if not exists proposal_events_proposal_idx
    on proposal_events (proposal_id, created_at);

  -- Single-use web actions (disconnect): a signed link can be replayed, a
  -- nonce can only be spent once.
  create table if not exists used_nonces (
    nonce text primary key,
    used_at timestamptz not null default now()
  );
  `,
];

export const MIGRATION_COUNT = MIGRATIONS.length;

export async function runMigrations(db: Db): Promise<void> {
  await db.begin(async (tx) => {
    // Serialises concurrent migrators (API + worker booting together).
    await tx`select pg_advisory_xact_lock(727272)`;
    await tx`
      create table if not exists schema_migrations (
        version int primary key,
        applied_at timestamptz not null default now()
      )`;
    const applied = await tx`select version from schema_migrations`;
    const done = new Set(applied.map((r) => Number(r.version)));
    for (let i = 0; i < MIGRATIONS.length; i++) {
      const version = i + 1;
      if (done.has(version)) continue;
      await tx.unsafe(MIGRATIONS[i]);
      await tx`insert into schema_migrations (version) values (${version})`;
    }
  });
}
