import { test } from "node:test";
import assert from "node:assert/strict";
import type { CalendarAccount, Db } from "@exec-assistant/db";
import { ensureFreshCalendar } from "./calendar-freshness.js";

const UID = "6f1d5a3c-2b7e-4f5a-9c8d-0a1b2c3d4e5f";

function account(overrides: Partial<CalendarAccount> = {}): CalendarAccount {
  return {
    id: "account-1",
    user_id: UID,
    provider: "google",
    access_token: "access-token",
    refresh_token: null,
    expires_at: new Date(Date.now() + 3_600_000),
    calendar_id: "primary",
    synced_at: new Date(Date.now() - 60_000),
    account_email: "ada@example.com",
    scopes: ["calendar.events"],
    connected_at: new Date(),
    last_sync_error: null,
    reauth_required_at: null,
    sync_token: null,
    next_sync_at: null,
    sync_lock_at: null,
    sync_attempts: 0,
    created_at: new Date(),
    ...overrides,
  } as CalendarAccount;
}

function fakeDb(a: CalendarAccount) {
  const upserted: Array<Record<string, unknown>> = [];
  const updates: string[] = [];
  const db = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?").replace(/\s+/g, " ");
    if (sql.includes("from calendar_accounts")) return Promise.resolve([a]);
    if (sql.includes("insert into events")) {
      const row = {
        id: `event-${upserted.length + 1}`,
        user_id: values[0],
        external_id: values[1],
        title: values[2],
        start_at: values[3],
        end_at: values[4],
        all_day: values[5],
        location: values[6],
        description: values[7],
        status: values[8],
        updated_at: new Date(),
      };
      upserted.push(row);
      return Promise.resolve([row]);
    }
    if (sql.includes("as cancelled") && sql.includes("reminders_removed")) {
      return Promise.resolve([{ cancelled: 0, reminders_removed: 0 }]);
    }
    if (sql.includes("insert into reminders")) return Promise.resolve([]);
    if (sql.includes("delete from reminders")) return Promise.resolve([]);
    if (sql.includes("update calendar_accounts")) {
      updates.push(sql);
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  }) as unknown as Db;
  return { db, upserted, updates };
}

const google = {
  clientId: "client",
  clientSecret: "secret",
  tokenKey: Buffer.alloc(32),
};

test("a calendar read refreshes immediately and applies a new Google event", async () => {
  const original = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    requested.push(String(input));
    return new Response(
      JSON.stringify({
        items: [
          {
            id: "new-from-google",
            summary: "Created directly in Google",
            start: { dateTime: "2026-11-24T09:00:00Z" },
            end: { dateTime: "2026-11-24T10:00:00Z" },
          },
        ],
        nextSyncToken: "cursor-2",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const { db, upserted } = fakeDb(account());
    const result = await ensureFreshCalendar({
      db,
      userId: UID,
      google,
      freshnessMs: 0,
      lookaheadDays: 14,
      reminderOffsets: [15, 10, 5, 0],
      maxOffsetMinutes: 15,
    });

    assert.equal(requested.length, 1);
    assert.match(requested[0], /\/events\?/);
    assert.equal(result.refreshed, true);
    assert.equal(result.stale, false);
    assert.equal(upserted[0]?.external_id, "new-from-google");
    assert.equal(upserted[0]?.title, "Created directly in Google");
  } finally {
    globalThis.fetch = original;
  }
});

test("a failed refresh reports staleness and never records a new sync time", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: { message: "purged" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

  try {
    const oldSync = new Date(Date.now() - 3_600_000);
    const { db, updates } = fakeDb(account({ synced_at: oldSync }));
    const result = await ensureFreshCalendar({
      db,
      userId: UID,
      google,
      freshnessMs: 0,
      lookaheadDays: 14,
      reminderOffsets: [15, 10, 5, 0],
      maxOffsetMinutes: 15,
    });

    assert.equal(result.refreshed, false);
    assert.equal(result.stale, true);
    assert.match(result.warning ?? "", /couldn't refresh/);
    assert.equal(
      updates.some((sql) => sql.includes("synced_at = now()")),
      false,
      "failure must not move the last successful sync timestamp",
    );
    assert.equal(result.lastSyncedAt, oldSync.toISOString());
  } finally {
    globalThis.fetch = original;
  }
});

test("a reconnect-required account is stale without calling Google", async () => {
  const { db } = fakeDb(account({ reauth_required_at: new Date() }));
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response("{}");
  }) as typeof fetch;
  try {
    const result = await ensureFreshCalendar({
      db,
      userId: UID,
      google,
      freshnessMs: 0,
      lookaheadDays: 14,
      reminderOffsets: [15, 10, 5, 0],
      maxOffsetMinutes: 15,
    });
    assert.equal(result.stale, true);
    assert.match(result.warning ?? "", /reconnect/);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = original;
  }
});
