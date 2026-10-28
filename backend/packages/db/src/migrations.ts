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
];

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
