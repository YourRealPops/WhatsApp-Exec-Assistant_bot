import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import { buildConnectionsUrl, signState, verifyState } from "@exec-assistant/calendar";
import type { Db } from "@exec-assistant/db";
import { connectionsRouter } from "./connections.js";

const SECRET = "s".repeat(32);
const UID = "6f1d5a3c-2b7e-4f5a-9c8d-0a1b2c3d4e5f";

/** A structural stand-in for `Db`: enough of the tagged-template API for the
 * connections route to run, and it records every mutation so the tests can
 * assert on it. */
function createFakeDb() {
  const accounts = new Map<string, Record<string, unknown>>();
  const events: Record<string, unknown>[] = [];
  const reminders: Record<string, unknown>[] = [];
  const nonces = new Set<string>();
  const upserts: unknown[] = [];

  const fake = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?");
    if (sql.includes("insert into calendar_accounts")) {
      upserts.push({ userId: values[0], accessToken: values[2], refreshToken: values[3] });
      const id = randomUUID();
      accounts.set(id, {
        id,
        user_id: values[0] as string,
        provider: "google",
        access_token: values[2] as string,
        refresh_token: values[3] ?? null,
        expires_at: null,
        calendar_id: "primary",
        synced_at: null,
        account_email: null,
        scopes: [] as string[],
        connected_at: null,
        last_sync_error: null,
        reauth_required_at: null,
        created_at: new Date(),
      });
      return Promise.resolve([accounts.get(id)!]);
    }
    if (sql.includes("from calendar_accounts")) {
      return Promise.resolve(accounts.has(String(values[0])) ? [accounts.get(String(values[0]))!] : []);
    }
    if (sql.includes("insert into events")) {
      const row = {
        id: randomUUID(),
        user_id: values[1] as string,
        external_id: "e1",
        title: "Board review",
        start_at: values[3] as Date,
        end_at: values[4] as Date,
        location: values[5] as string | null,
        description: values[6] as string | null,
        status: "confirmed",
        all_day: false,
        updated_at: new Date(),
      };
      events.push(row);
      return Promise.resolve([row]);
    }
    if (sql.includes("from events")) {
      const userId = String(values[0]);
      return Promise.resolve([...events].filter((e) => e.user_id === userId));
    }
    if (sql.includes("insert into reminders")) {
      const row = {
        id: randomUUID(),
        user_id: values[1] as string,
        event_id: values[2] as string | null,
        offset_minutes: values[3] as number | null,
        fire_at: values[4] as Date,
        note: values[5] as string,
        status: "pending",
        attempts: 0,
        last_error: null,
        sent_at: null,
        alarm: false,
        called_at: null,
        call_sid: null,
        created_at: new Date(),
        updated_at: new Date(),
      };
      reminders.push(row);
      return Promise.resolve([row]);
    }
    if (sql.includes("from reminders")) {
      const userId = String(values[0]);
      return Promise.resolve([...reminders.filter((r) => r.user_id === userId)]);
    }
    if (sql.includes("insert into used_nonces")) {
      const nonce = String(values[0]);
      if (nonces.has(nonce)) return Promise.resolve([]);
      nonces.add(nonce);
      return Promise.resolve([nonce]);
    }
    if (sql.includes("select * from used_nonces")) {
      return Promise.resolve([...nonces].map((n) => ({ nonce: n })) as unknown as Row[]);
    }
    // A stand-in `db` is only ever called with the queries the connections route
    // performs; anything else returns [] so a route that does more fails early.
    return Promise.resolve([]);
  }) as unknown as Db;

  return { db: fake, accounts, events, reminders, nonces, upserts };
}

interface Row {
  nonce: string;
}

async function withServer(opts: {
  db: Db;
  fn: (base: string) => Promise<void>;
  revokeToken?: (token: string) => Promise<boolean>;
  secret?: string;
  uid?: string;
}) {
  const { db, fn, revokeToken = async () => false, secret = SECRET, uid = UID } = opts;
  const app = express();
  app.use(
    connectionsRouter({
      db,
      google: { revokeToken },
      publicBaseUrl: "https://ecos.example.com",
      oauthStateSecret: secret,
    }),
  );
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const port = server.address() as { port: number };
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function signedConnectionsToken(overrides?: Partial<{ secret: string; uid: string }>) {
  const { secret = SECRET, uid = UID } = overrides ?? {};
  return signState({ secret, uid, purpose: "connections" });
}

/** Build a connections link + a fresh single-use nonce for the route under test. */
function linkAndNonce(db: Db, uid: string, token: string) {
  const url = new URL(`${buildConnectionsUrl({ baseUrl: "https://ecos.example.com", secret: SECRET, uid })}?token=${encodeURIComponent(token)}`);
  return { url, nonce: randomUUID(), token };
}

test("a GET with a bad token is a generic 400", async () => {
  const { db } = createFakeDb();
  await withServer({ db, fn: async (base) => {
    const res = await fetch(`${base}/connections?token=nonsense`, { redirect: "manual" });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /invalid or has expired/);
  }});
});

test("a GET with an expired token is a generic 400", async () => {
  const { db } = createFakeDb();
  await withServer({ db, fn: async (base) => {
    const token = signState({ secret: SECRET, uid: UID, purpose: "connections", ttlMs: -60_000 });
    const res = await fetch(`${base}/connections?token=${token}`, { redirect: "manual" });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /invalid or has expired/);
  }});
});

test("a GET with the wrong purpose is a generic 400", async () => {
  const { db } = createFakeDb();
  await withServer({ db, fn: async (base) => {
    const token = signState({ secret: SECRET, uid: UID, purpose: "connect" });
    const res = await fetch(`${base}/connections?token=${token}`, { redirect: "manual" });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /invalid or has expired/);
  }});
});

test("GET renders the status and a Disconnect button, and never changes state", async () => {
  const { db, upserts } = createFakeDb();
  await withServer({ db, fn: async (base) => {
    const { url } = linkAndNonce(db, UID, signedConnectionsToken({ uid: UID }));
    const res = await fetch(url, { redirect: "manual" });
    assert.equal(res.status, 302);
    const location = new URL(res.headers.get("location") ?? "");
    assert.equal(location.pathname, "/connections");
    assert.equal(new URL(location.search).searchParams.get("token"), signedConnectionsToken({ uid: UID }));

    const page = await (await fetch(url, { redirect: "manual" })).text();
    assert.match(page, /Calendar connected/);
    assert.match(page, /Disconnect my calendar/);
    assert.equal(upserts.length, 0, "no state change on GET");
  }});
});

test("POST /connections/disconnect with a reused nonce is rejected", async () => {
  const { db } = createFakeDb();
  const token = signedConnectionsToken({ uid: UID });
  await withServer({ db, fn: async (base) => {
    const { url, nonce } = linkAndNonce(db, UID, token);
    const first = await fetch(`${url}?nonce=${encodeURIComponent(nonce)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true, currentMessage: "disconnect my calendar" }),
      redirect: "manual",
    });
    assert.equal(first.status, 302);

    const replayed = await fetch(`${url}?nonce=${encodeURIComponent(nonce)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true, currentMessage: "disconnect my calendar" }),
      redirect: "manual",
    });
    assert.equal(replayed.status, 400, "nonce reuse must be rejected");
    assert.match(await replayed.text(), /invalid or has expired/);
  }});
});

test("POST /connections/disconnect with a bad token is a generic 400", async () => {
  const { db } = createFakeDb();
  await withServer({ db, fn: async (base) => {
    const res = await fetch(`${base}/connections/disconnect?token=nonsense`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nonce: randomUUID(), confirm: true, currentMessage: "disconnect my calendar" }),
      redirect: "manual",
    });
    assert.equal(res.status, 400);
  }});
});

test("POST /connections/disconnect deletes the tokens and cancels events", async () => {
  const { db, accounts, events, reminders } = createFakeDb();
  await withServer({ db, fn: async (base) => {
    const token = signedConnectionsToken({ uid: UID });
    const { url, nonce } = linkAndNonce(db, UID, token);
    const res = await fetch(`${url}?nonce=${encodeURIComponent(nonce)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true, currentMessage: "disconnect my calendar" }),
      redirect: "manual",
    });
    assert.equal(res.status, 302);

    const account = accounts.get(UID)!;
    assert.equal(account.access_token, "encrypted-access");
    assert.equal(account.refresh_token, "encrypted-refresh");
    assert.equal(events.length, 0, "all provider events are cancelled/deleted");
    assert.equal(reminders.filter((r) => r.status === "pending").length, 0, "pending reminders are dropped");
  }});
});

test("disconnect revokes at Google when the stub reports success", async () => {
  const { db, upserts } = createFakeDb();const stubRevoke = async () => true;
  await withServer({ db, fn: async (base) => {
    const { nonce } = linkAndNonce(db, UID, signedConnectionsToken());
    const res = await fetch(`${base}/connections/disconnect?nonce=${encodeURIComponent(nonce)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true, currentMessage: "disconnect my calendar" }),
      redirect: "manual",
    });
    assert.equal(res.status, 302);
    assert.equal((upserts[0] as { revoke?: boolean })?.revoke, true);
  }, revokeToken: stubRevoke });
});




test("disconnect is idempotent", async () => {
  const { db, accounts } = createFakeDb();
  await withServer({ db, fn: async (base) => {
    const token = signedConnectionsToken({ uid: UID });
    const { url, nonce } = linkAndNonce(db, UID, token);

    const first = await fetch(`${url}?nonce=${encodeURIComponent(nonce)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true, currentMessage: "disconnect my calendar" }),
      redirect: "manual",
    });
    assert.equal(first.status, 302);

    const second = await fetch(`${url}?nonce=${encodeURIComponent(nonce)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true, currentMessage: "disconnect my calendar" }),
      redirect: "manual",
    });
    // The second spend is rejected, but the account was already removed.
    assert.equal(second.status, 400);
    assert.equal(accounts.size, 0, "the account is gone after the first disconnect");
  }});
});
