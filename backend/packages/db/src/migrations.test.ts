import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createDb, type Db } from "./client.js";
import { MIGRATION_COUNT, runMigrations } from "./migrations.js";

const url = process.env.DATABASE_URL;
const skip = url ? false : "DATABASE_URL not set — skipping DB integration test";

let db: Db | null = null;
const schemas: string[] = [];

function getDb(): Db {
  if (!db) throw new Error("database not initialised");
  return db;
}

function schemaName(): string {
  const name = `mig_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  schemas.push(name);
  return name;
}

before(async () => {
  if (!url) return;
  db = createDb(url, { max: 2 });
});

after(async () => {
  if (!db) return;
  for (const schema of schemas) {
    await db.unsafe(`drop schema if exists ${schema} cascade`).catch(() => {});
  }
  await db.end();
});

/** A one-connection pool keeps every query on the schema we selected. */
async function scratch(schema: string): Promise<Db> {
  const scratchDb = createDb(url!, { max: 1 });
  await scratchDb.unsafe(`set search_path to ${schema}`);
  return scratchDb;
}

test("a fresh database applies every migration", { skip }, async () => {
  const schema = schemaName();
  const d = getDb();
  await d.unsafe(`create schema ${schema}`);
  const fresh = await scratch(schema);
  try {
    await runMigrations(fresh);

    const applied = await fresh`select version from schema_migrations order by version`;
    assert.equal(applied.length, MIGRATION_COUNT, "every migration is recorded");
    assert.equal(Number(applied.at(-1)?.version), MIGRATION_COUNT);

    const tables = await fresh`
      select tablename from pg_tables
      where schemaname = current_schema()
      order by tablename`;
    const names = tables.map((row) => String(row.tablename));
    for (const required of [
      "users",
      "messages",
      "calendar_accounts",
      "events",
      "reminders",
      "proposals",
      "proposal_events",
      "used_nonces",
      "event_references",
      "document_jobs",
    ]) {
      assert.ok(names.includes(required), `fresh schema has ${required}`);
    }
  } finally {
    await fresh.end();
  }
});

test("the previous schema upgrades without losing data", { skip }, async () => {
  const schema = schemaName();
  const d = getDb();
  await d.unsafe(`create schema ${schema}`);
  const previous = await scratch(schema);
  try {
    // Stop before the incremental-sync and document-job migrations.
    const previousVersion = MIGRATION_COUNT - 2;
    await runMigrations(previous, { upTo: previousVersion });

    const before = await previous`
      select table_name from information_schema.tables
      where table_schema = current_schema()`;
    const beforeNames = before.map((row) => String(row.table_name));
    assert.ok(beforeNames.includes("events"), "old schema exists");
    assert.equal(beforeNames.includes("document_jobs"), false);
    const oldColumns = await previous`
      select column_name from information_schema.columns
      where table_schema = current_schema() and table_name = 'calendar_accounts'`;
    assert.equal(
      oldColumns.some((row) => row.column_name === "sync_token"),
      false,
      "the previous schema has no sync cursor",
    );

    // Data written before the upgrade must survive it.
    const [user] = await previous`
      insert into users (phone, timezone)
      values (${`upgrade-${randomUUID()}`}, 'Africa/Lagos')
      returning id`;
    const [event] = await previous`
      insert into events (user_id, external_id, title, start_at, end_at)
      values (${user.id}, 'google:upgrade', 'Keep me', now(), now() + interval '1 hour')
      returning id`;

    await runMigrations(previous);

    const after = await previous`
      select table_name from information_schema.tables
      where table_schema = current_schema()`;
    const afterNames = after.map((row) => String(row.table_name));
    assert.ok(afterNames.includes("document_jobs"), "new table was added");
    const columns = await previous`
      select column_name from information_schema.columns
      where table_schema = current_schema() and table_name = 'calendar_accounts'`;
    const columnNames = columns.map((row) => String(row.column_name));
    for (const added of ["sync_token", "next_sync_at", "sync_lock_at", "sync_attempts"]) {
      assert.ok(columnNames.includes(added), `calendar_accounts.${added} was added`);
    }

    const [kept] = await previous`select title from events where id = ${event.id}`;
    assert.equal(kept?.title, "Keep me", "pre-upgrade rows survive");
    const versions = await previous`select version from schema_migrations order by version`;
    assert.equal(versions.length, MIGRATION_COUNT, "only the missing migrations ran");
  } finally {
    await previous.end();
  }
});

test("running migrations twice is idempotent", { skip }, async () => {
  const schema = schemaName();
  const d = getDb();
  await d.unsafe(`create schema ${schema}`);
  const idempotent = await scratch(schema);
  try {
    await runMigrations(idempotent);
    await runMigrations(idempotent);
    const applied = await idempotent`select count(*)::int as count from schema_migrations`;
    assert.equal(Number(applied[0]?.count), MIGRATION_COUNT);
  } finally {
    await idempotent.end();
  }
});
