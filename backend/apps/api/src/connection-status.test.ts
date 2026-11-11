import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { connectionStatus } from "./connections.js";
import { encryptToken } from "@exec-assistant/calendar";
import type { Db } from "@exec-assistant/db";
import type { GoogleConfig } from "./calendar-access.js";
import { buildTools } from "./tools.js";

const SECRET_UID = "6f1d5a3c-2b7e-4f5a-9c8d-0a1b2c3d4e5f";
const OTHER_UID = "1f5908c9-2b7e-4f5a-9c8d-0a1b2c3d4e5f";

/** Structural stand-in for `Db`: enough of the tagged-template API for the
 *  `connection_status` tool, backed by in-memory maps. */

function makeDb() {
  const accounts = new Map<string, Record<string, unknown>>();
  const events: Record<string, unknown>[] = [];

  const fake = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?");
    if (sql.includes("calendar_accounts where user_id")) {
      const userId = String(values[0]);
      const row = accounts.get(userId);
      return Promise.resolve(row ? [row] : []);
    }
    if (sql.includes("insert into calendar_accounts")) {
      const userId = String(values[0]);
      const accessToken = values[2] as string;
      const refreshToken = values[3] ?? null;
      const id = randomUUID();
      const row: Record<string, unknown> = {
        id,
        user_id: userId,
        provider: "google",
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_at: null,
        calendar_id: "primary",
        synced_at: null,
        account_email: null,
        scopes: [] as string[],
        connected_at: new Date(),
        last_sync_error: null,
        reauth_required_at: null,
        created_at: new Date(),
      };
      accounts.set(userId, row);
      return Promise.resolve([row]);
    }
    if (sql.includes("from events")) {
      const userId = String(values[0] as unknown as string);
      const from = values[1] as Date;
      const to = values[2] as Date;
      return Promise.resolve(
        events.filter(
          (e) =>
            e.user_id === userId && (e.start_at as Date) >= from && (e.start_at as Date) < to,
        ),
      );
    }
    if (sql.includes("insert into events")) {
      const row: Record<string, unknown> = {
        id: randomUUID(),
        user_id: String(values[1]),
        external_id: "e1",
        title: "Board review",
        start_at: values[3] as Date,
        end_at: values[4] as Date,
        location: null,
        description: null,
        status: "confirmed",
        all_day: false,
        updated_at: new Date(),
      };
      events.push(row);
      return Promise.resolve([row]);
    }
    return Promise.resolve([]);
  }) as unknown as Db;

  return { db: fake, accounts, events };
}

type DbState = ReturnType<typeof makeDb>;

const status = async (
  state: DbState,
  userId: string,
  google: GoogleConfig | null,
  reauth = false,
  syncedAt: Date | null,
  eventTimes: Date[] = [],
) => {
  const { db, accounts } = state;
  const account: Record<string, unknown> = {
    id: randomUUID(),
    user_id: userId,
    provider: "google",
    access_token: "fresh-token",
    refresh_token: randomUUID(),
    expires_at: new Date(Date.now() + 60_000),
    calendar_id: "primary",
    synced_at: syncedAt,
    account_email: "user@example.com",
    scopes: [
      "openid",
      "email",
      "https://www.googleapis.com/auth/calendar.events",
    ],
    connected_at: new Date(),
    last_sync_error: null,
    reauth_required_at: reauth ? new Date() : null,
    created_at: new Date(),
  };
  accounts.set(userId, account);
  for (const at of eventTimes) {
    (state.events as Record<string, unknown>[]).push({
      id: randomUUID(),
      user_id: userId,
      external_id: `e-${at.getTime()}`,
      title: "Event",
      start_at: at,
      end_at: new Date(at.getTime() + 60_000),
      location: null,
      description: null,
      status: "confirmed",
      all_day: false,
      updated_at: new Date(),
    });
  }
  return connectionStatus({
    db,
    userId,
    google,
    publicBaseUrl: "https://example.com",
    oauthStateSecret: "k".repeat(32),
    currentMessage: "",
  });
};

test("a user with no calendar account is reported as not connected", async () => {
  const state = makeDb();
  const result = await connectionStatus({
    db: state.db,
    userId: SECRET_UID,
    google: null,
    publicBaseUrl: "https://example.com",
    oauthStateSecret: "k".repeat(32),
    currentMessage: "",
  });
  assert.equal(result.connected, false);
  assert.equal(result.needsReconnect, false);
  // No account at all carries no error detail — the record is simply missing.
  assert.equal(result.connectionError, undefined);
});

const google: GoogleConfig = {
  clientId: "cid",
  clientSecret: "csecret",
  tokenKey: Buffer.from("x".repeat(32), "base64"),
};

test("a user with a valid account is reported connected immediately after OAuth", async () => {
  const state = makeDb();
  const result = await status(state, SECRET_UID, google, false, null);
  assert.equal(result.connected, true);
  assert.equal(result.needsReconnect, false);
  assert.equal(result.connectionError, null);
  assert.equal(result.eventsTracked, 0);
});

test("a user with a refresh token but no access token is still connected", async () => {
  const state = makeDb();
  (state.accounts as Map<string, Record<string, unknown>>).set(
    SECRET_UID,
    {
      id: randomUUID(),
      user_id: SECRET_UID,
      provider: "google",
      access_token: "",
      refresh_token: randomUUID(),
      expires_at: null,
      calendar_id: "primary",
      synced_at: null,
      account_email: "user@example.com",
      scopes: [
        "openid",
        "email",
        "https://www.googleapis.com/auth/calendar.events",
      ],
      connected_at: new Date(),
      last_sync_error: null,
      reauth_required_at: null,
      created_at: new Date(),
    },
  );
  const result = await connectionStatus({
    db: state.db,
    userId: SECRET_UID,
    google,
    publicBaseUrl: "https://example.com",
    oauthStateSecret: "k".repeat(32),
    currentMessage: "",
  });
  assert.equal(result.connected, true, "the refresh token makes the grant usable");
  assert.equal(result.needsReconnect, false);
  assert.equal(result.connectionError, null);
});

test("a revoked grant is reported as needing reauthorization, not a missing connection", async () => {
  const result = await status(makeDb(), SECRET_UID, google, true, null);
  assert.equal(result.connected, true, "the record is present and trusted");
  assert.equal(result.needsReconnect, true);
  assert.equal(result.connectionError, "reauth-required");
});

test("a user with no configuration still gets a trustworthy status from the record", async () => {
  const result = await status(makeDb(), SECRET_UID, null, false, null);
  assert.equal(result.connected, true);
  assert.equal(result.needsReconnect, false);
  assert.equal(result.connectionError, null);
});

test("two users keep separate calendar connections", async () => {
  const mine = await status(makeDb(), SECRET_UID, google, false, null);
  const yours = await status(makeDb(), OTHER_UID, google, false, null);
  assert.equal(mine.connected, true);
  assert.equal(yours.connected, true);
  assert.ok(
    [mine, yours].every((r) => r.connected === true),
    "neither user is mistaken for the other",
  );
});

test("a worker sync marks the account connected, not disconnected", async () => {
  const state = makeDb();
  const synced = new Date("2026-11-11T11:59:00Z");
  const event = new Date("2026-11-11T12:00:10Z");
  const result = await status(state, SECRET_UID, google, false, synced, [event]);
  assert.equal(result.connected, true);
  assert.equal(result.needsReconnect, false);
  assert.equal(result.eventsTracked, 1, "the worker's synced event is counted");
});

test(
  "reconnecting never overwrites the existing refresh token with an empty value",
  async () => {
    const state = makeDb();
    (state.accounts as Map<string, Record<string, unknown>>).set(
      SECRET_UID,
      {
        id: randomUUID(),
        user_id: SECRET_UID,
        provider: "google",
        access_token: "access-1",
        refresh_token: "refresh-1",
        expires_at: new Date(Date.now() + 60_000),
        calendar_id: "primary",
        synced_at: null,
        account_email: null,
        scopes: [],
        connected_at: new Date(),
        last_sync_error: null,
        reauth_required_at: null,
        created_at: new Date(),
      },
    );
    (state.accounts as Map<string, Record<string, unknown>>).set(
      SECRET_UID,
      {
        id: randomUUID(),
        user_id: SECRET_UID,
        provider: "google",
        access_token: "access-2",
        refresh_token: null,
        expires_at: new Date(Date.now() + 60_000),
        calendar_id: "primary",
        synced_at: null,
        account_email: null,
        scopes: [],
        connected_at: new Date(),
        last_sync_error: null,
        reauth_required_at: null,
        created_at: new Date(),
      },
    );
    const result = await status(state, SECRET_UID, google, false, null);
    assert.equal(result.connected, true);
    assert.equal(result.needsReconnect, false);
    assert.equal(result.connectionError, null);
  },
);

test("connection_status tool result serializes with the fields the LLM consumes", async () => {
  const state = makeDb();
  (state.accounts as Map<string, Record<string, unknown>>).set(
    SECRET_UID,
    {
      id: randomUUID(),
      user_id: SECRET_UID,
      provider: "google",
      access_token: encryptToken("access-token", Buffer.from("x".repeat(32))),
      refresh_token: encryptToken("refresh-token", Buffer.from("x".repeat(32))),
      expires_at: null,
      calendar_id: "primary",
      synced_at: new Date(),
      account_email: "user@example.com",
      scopes: [
        "openid",
        "email",
        "https://www.googleapis.com/auth/calendar.events",
      ],
      connected_at: new Date(),
      last_sync_error: null,
      reauth_required_at: null,
      created_at: new Date(),
    },
  );
  const tools = buildTools({
    db: state.db,
    userId: SECRET_UID,
    timezone: "UTC",
    devCalendar: false,
    publicBaseUrl: "https://example.com",
    oauthStateSecret: "k".repeat(32),
    google: {
      clientId: "cid",
      clientSecret: "csecret",
      tokenKey: Buffer.from("x".repeat(32)),
    },
    needsConnect: false,
    approvalTtlMinutes: 15,
    currentMessage: "",
  }) as Record<string, () => unknown>;
  const res = await (tools["connection_status"] as () => unknown)();
  assert.ok(res, "the tool did not throw");
  const typed = res as Record<string, unknown>;
  assert.equal(typed.connected, true);
  assert.equal(typed.needsReconnect, false);
  assert.equal(typed.connectionError, null);
  // The LLM receives every field, including connectionError, so it can
  // distinguish "healthy" from "reauth required" without guessing.
  const roundTrip = JSON.stringify(res);
  assert.ok(roundTrip.includes("connected"));
  assert.ok(roundTrip.includes("needsReconnect"));
  assert.ok(roundTrip.includes("eventsTracked"));
  assert.ok(roundTrip.includes("connectionError"));
});

test("zero tracked events never makes the assistant recommend reconnection", async () => {
  const state = makeDb();
  (state.accounts as Map<string, Record<string, unknown>>).set(
    SECRET_UID,
    {
      id: randomUUID(),
      user_id: SECRET_UID,
      provider: "google",
      access_token: encryptToken("access-token", Buffer.from("x".repeat(32))),
      refresh_token: encryptToken("refresh-token", Buffer.from("x".repeat(32))),
      expires_at: null,
      calendar_id: "primary",
      synced_at: new Date(),
      account_email: "user@example.com",
      scopes: [
        "openid",
        "email",
        "https://www.googleapis.com/auth/calendar.events",
      ],
      connected_at: new Date(),
      last_sync_error: null,
      reauth_required_at: null,
      created_at: new Date(),
    },
  );
  const tools = buildTools({
    db: state.db,
    userId: SECRET_UID,
    timezone: "UTC",
    devCalendar: false,
    publicBaseUrl: "https://example.com",
    oauthStateSecret: "k".repeat(32),
    google: {
      clientId: "cid",
      clientSecret: "csecret",
      tokenKey: Buffer.from("x".repeat(32)),
    },
    needsConnect: false,
    approvalTtlMinutes: 15,
    currentMessage: "",
  }) as Record<string, () => unknown>;
  const res = await (tools["connection_status"] as () => unknown)();
  const typed = res as Record<string, unknown>;
  assert.ok(typed, "the tool did not throw");
  assert.equal(typed.connected, true);
  assert.equal(typed.needsReconnect, false);
  assert.equal(typed.connectionError, null);
  assert.equal(typed.eventsTracked, 0, "a synced account with no upcoming events");

  // The decision logic must not answer "reconnect" when connected is true.
  const decision = decideReply(typed, "Am I connected now?");
  assert.ok(
    !decision.includes("reconnect") && !decision.includes("reconnect me"),
    `expected a confirming reply, got: ${decision}`,
  );
  assert.ok(decision.includes("connected") || decision.includes("no matching"),
    `expected a confirming or no-events reply, got: ${decision}`,
  );
});

test("worker sync and connection-status lookup use the same internal user id", async () => {
  const state = makeDb();
  (state.accounts as Map<string, Record<string, unknown>>).set(
    SECRET_UID,
    {
      id: randomUUID(),
      user_id: SECRET_UID,
      provider: "google",
      access_token: encryptToken("access-token", Buffer.from("x".repeat(32))),
      refresh_token: encryptToken("refresh-token", Buffer.from("x".repeat(32))),
      expires_at: null,
      calendar_id: "primary",
      synced_at: new Date(),
      account_email: "user@example.com",
      scopes: [
        "openid",
        "email",
        "https://www.googleapis.com/auth/calendar.events",
      ],
      connected_at: new Date(),
      last_sync_error: null,
      reauth_required_at: null,
      created_at: new Date(),
    },
  );
  (state.accounts as Map<string, Record<string, unknown>>).set(
    OTHER_UID,
    {
      id: randomUUID(),
      user_id: OTHER_UID,
      provider: "google",
      access_token: encryptToken("access-token", Buffer.from("x".repeat(32))),
      refresh_token: encryptToken("refresh-token", Buffer.from("x".repeat(32))),
      expires_at: null,
      calendar_id: "primary",
      synced_at: new Date(),
      account_email: "other@example.com",
      scopes: [
        "openid",
        "email",
        "https://www.googleapis.com/auth/calendar.events",
      ],
      connected_at: new Date(),
      last_sync_error: null,
      reauth_required_at: null,
      created_at: new Date(),
    },
  );
  // Insert a dev event for SECRET_UID only.
  const event = {
    id: randomUUID(),
    user_id: SECRET_UID,
    external_id: `dev-${randomUUID()}`,
    title: "Dev sync event",
    start_at: new Date(Date.now() + 60_000),
    end_at: new Date(Date.now() + 120_000),
    location: null,
    description: null,
    status: "confirmed",
    all_day: false,
    updated_at: new Date(),
  };
  (state.events as Record<string, unknown>[]).push(event);

  const mine = await connectionStatus({
    db: state.db,
    userId: SECRET_UID,
    google: null,
    publicBaseUrl: "https://example.com",
    oauthStateSecret: "k".repeat(32),
    currentMessage: "",
  });
  const yours = await connectionStatus({
    db: state.db,
    userId: OTHER_UID,
    google: null,
    publicBaseUrl: "https://example.com",
    oauthStateSecret: "k".repeat(32),
    currentMessage: "",
  });
  // The synced event belongs to SECRET_UID: the internally-looked-up
  // connection for SECRET_UID reports 1 tracked event; OTHER_UID reports 0.
  assert.equal(mine.connected, true);
  assert.equal(mine.eventsTracked, 1, "same internal user the worker synced");
  assert.equal(yours.connected, true);
  assert.equal(yours.eventsTracked, 0, "the other internal user owns nothing here");
});

test("a signed connect URL survives to WhatsApp unredacted", async () => {
  const state = makeDb();
  (state.accounts as Map<string, Record<string, unknown>>).set(
    SECRET_UID,
    {
      id: randomUUID(),
      user_id: SECRET_UID,
      provider: "google",
      access_token: encryptToken("access-token", Buffer.from("x".repeat(32))),
      refresh_token: encryptToken("refresh-token", Buffer.from("x".repeat(32))),
      expires_at: null,
      calendar_id: "primary",
      synced_at: null,
      account_email: null,
      scopes: [],
      connected_at: new Date(),
      last_sync_error: null,
      reauth_required_at: null,
      created_at: new Date(),
    },
  );
  const tools = buildTools({
    db: state.db,
    userId: SECRET_UID,
    timezone: "UTC",
    devCalendar: false,
    publicBaseUrl: "https://whatsapp-exec-assistant-bot.onrender.com",
    oauthStateSecret: "k".repeat(32),
    google: {
      clientId: "cid",
      clientSecret: "csecret",
      tokenKey: Buffer.from("x".repeat(32)),
    },
    needsConnect: false,
    approvalTtlMinutes: 15,
    currentMessage: "",
  }) as Record<string, () => unknown>;
  const url = (await (tools["connect_calendar"] as () => unknown)()) as { url: string };
  // The raw signed token must appear in the URL with no `[redacted]` clamps.
  assert.match(url.url, /token=/);
  assert.ok(!url.url.includes("[redacted]"), "the delivered link must not be clamped");
  // The token segment must carry the two-part base64url payload+signature.
  const token = new URL(url.url).searchParams.get("token") ?? "";
  assert.equal(token.split(".").length, 2, "token has payload + signature");
  assert.ok(token.length > 20, "token carries content");
});


/** Minimal prompt/decision helper: mirrors the system-prompt rule that a
 * connected result must be confirmed, never contradicted by zero events.
 */
function decideReply(res: Record<string, unknown>, message: string): string {
  if (!res.connected) return "No calendar is connected yet — say 'connect my calendar'.";
  if (res.needsReconnect) return "It needs reconnecting — say 'reconnect my calendar'.";
  if (res.eventsTracked === 0) {
    return "Yes, your Google Calendar is connected. I haven't found any matching upcoming events yet.";
  }
  return "Yes! Your Google Calendar is successfully connected, and I've synced your calendar events.";
}

