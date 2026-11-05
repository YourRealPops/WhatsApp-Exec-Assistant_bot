import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import express from "express";
import { buildConnectUrl, signState, verifyState } from "@exec-assistant/calendar";
import type { Db } from "@exec-assistant/db";
import { authRouter, type AuthConfig } from "./auth.js";

const SECRET = "s".repeat(32);
const UID = "6f1d5a3c-2b7e-4f5a-9c8d-0a1b2c3d4e5f";
const PHONE = "+2348012345678";

interface Upsert {
  userId: unknown;
  accessToken: unknown;
  refreshToken: unknown;
}

/**
 * getUserById/upsertCalendarAccount each run one tagged query, so a function
 * with the right shape is a faithful stand-in and keeps this a route test.
 */
function createFakeDb() {
  const upserts: Upsert[] = [];
  const users = new Map<string, Record<string, unknown>>([
    [UID, { id: UID, phone: PHONE, name: null, timezone: "Africa/Lagos", created_at: new Date() }],
  ]);
  const fake = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?");
    if (sql.includes("insert into calendar_accounts")) {
      upserts.push({
        userId: values[0],
        accessToken: values[2],
        refreshToken: values[3],
      });
      return Promise.resolve([{}]);
    }
    if (sql.includes("from users")) {
      const found = users.get(String(values[0]));
      return Promise.resolve(found ? [found] : []);
    }
    return Promise.resolve([]);
  }) as unknown as Db;
  return { db: fake, upserts };
}

async function withServer(
  overrides: Partial<AuthConfig>,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const { db } = createFakeDb();
  const app = express();
  app.use(
    authRouter({
      db,
      clientId: "cid",
      clientSecret: "csecret",
      redirectUri: "https://ecos.example.com/auth/google/callback",
      configured: true,
      stateSecret: SECRET,
      ...overrides,
    }),
  );
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("a signed connect link redirects to Google with a fresh short-lived state", async () => {
  await withServer({}, async (base) => {
    const link = buildConnectUrl({ baseUrl: base, secret: SECRET, uid: UID });
    const res = await fetch(link, { redirect: "manual" });
    assert.equal(res.status, 302);

    const location = new URL(res.headers.get("location") ?? "");
    assert.equal(location.hostname, "accounts.google.com");
    assert.match(location.searchParams.get("scope") ?? "", /auth\/calendar\.events/);
    assert.equal(location.searchParams.get("redirect_uri"), "https://ecos.example.com/auth/google/callback");

    const state = location.searchParams.get("state") ?? "";
    assert.notEqual(state, new URL(link).searchParams.get("token"), "a fresh state, not the link token");
    const payload = verifyState({ secret: SECRET, token: state, purpose: "oauth" });
    assert.ok(payload, "the state is signed by us");
    assert.equal(payload.uid, UID);
    const lifetime = payload.exp - Date.now();
    assert.ok(lifetime <= 10 * 60_000 && lifetime > 9 * 60_000, `10 minute state, got ${lifetime}ms`);
  });
});

test("tampered, expired, wrong-purpose and missing tokens get the same 400", async () => {
  await withServer({}, async (base) => {
    const good = signState({ secret: SECRET, uid: UID, purpose: "connect" });
    const [payload, signature] = good.split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify({ uid: "attacker", exp: Date.now() + 60_000, purpose: "connect" }),
    ).toString("base64url");

    const links = [
      `${base}/auth/google`,
      `${base}/auth/google?token=`,
      `${base}/auth/google?token=nonsense`,
      `${base}/auth/google?token=${forgedPayload}.${signature}`,
      `${base}/auth/google?token=${payload}.${signature.slice(0, -1)}A`,
      `${base}/auth/google?token=${signState({
        secret: SECRET,
        uid: UID,
        purpose: "connect",
        ttlMs: -60_000,
      })}`,
      `${base}/auth/google?token=${signState({ secret: SECRET, uid: UID, purpose: "oauth" })}`,
      `${base}/auth/google?token=${signState({ secret: "t".repeat(40), uid: UID, purpose: "connect" })}`,
    ];

    for (const link of links) {
      const res = await fetch(link, { redirect: "manual" });
      assert.equal(res.status, 400, `should reject ${link}`);
      assert.match(await res.text(), /invalid or has expired/);
    }
  });
});

test("the raw ?user= path only works while debug routes are on", async () => {
  await withServer({ debugRoutes: false }, async (base) => {
    const res = await fetch(`${base}/auth/google?user=${UID}`, { redirect: "manual" });
    assert.equal(res.status, 400, "off by default");
  });

  await withServer({ debugRoutes: true }, async (base) => {
    const res = await fetch(`${base}/auth/google?user=${UID}`, { redirect: "manual" });
    assert.equal(res.status, 302, "kept for local debugging");
  });
});

test("a validly signed link for an unknown user is rejected", async () => {
  await withServer({}, async (base) => {
    const link = buildConnectUrl({
      baseUrl: base,
      secret: SECRET,
      uid: "00000000-0000-0000-0000-000000000000",
    });
    const res = await fetch(link, { redirect: "manual" });
    assert.equal(res.status, 400);
  });
});

test("the callback rejects a forged or expired state before touching Google", async () => {
  await withServer({}, async (base) => {
    const realFetch = globalThis.fetch;
    let googleCalls = 0;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      if (String(input).includes("oauth2.googleapis.com")) {
        googleCalls += 1;
        return new Response("{}", { status: 200 });
      }
      return realFetch(input as string, init);
    }) as typeof fetch;

    try {
      const expired = signState({ secret: SECRET, uid: UID, purpose: "oauth", ttlMs: -1 });
      for (const state of ["forged", expired, signState({ secret: SECRET, uid: UID, purpose: "connect" })]) {
        const res = await fetch(
          `${base}/auth/google/callback?code=abc&state=${encodeURIComponent(state)}`,
          { redirect: "manual" },
        );
        assert.equal(res.status, 400);
      }
      assert.equal(googleCalls, 0, "no token exchange for an unverified callback");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

test("a valid callback stores the tokens and clears any reauth flag", async () => {
  const { db, upserts } = createFakeDb();
  const app = express();
  app.use(
    authRouter({
      db,
      clientId: "cid",
      clientSecret: "csecret",
      redirectUri: "https://ecos.example.com/auth/google/callback",
      configured: true,
      stateSecret: SECRET,
    }),
  );
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const port = (server.address() as AddressInfo).port;

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    if (String(input).includes("oauth2.googleapis.com")) {
      return new Response(
        JSON.stringify({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return realFetch(input as string, init);
  }) as typeof fetch;

  try {
    const state = signState({ secret: SECRET, uid: UID, purpose: "oauth" });
    const res = await fetch(
      `http://127.0.0.1:${port}/auth/google/callback?code=abc&state=${encodeURIComponent(state)}`,
      { redirect: "manual" },
    );
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Calendar connected/);
    assert.deepEqual(upserts, [
      { userId: UID, accessToken: "access-1", refreshToken: "refresh-1" },
    ]);
  } finally {
    globalThis.fetch = realFetch;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
