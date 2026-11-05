import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CalendarAuthError,
  GOOGLE_SCOPES,
  buildAuthUrl,
  createGoogleClient,
  mapGoogleEvent,
  refreshAccessToken,
} from "./google.js";
import { createDevClient, defaultDevEvents } from "./dev.js";
import type { OAuthTokens } from "./types.js";

const FROM = new Date("2026-11-05T00:00:00Z");
const TO = new Date("2026-11-06T00:00:00Z");

interface FakeResponse {
  status?: number;
  body: unknown;
}

/** Replace global fetch for one test; returns the URLs that were requested. */
function stubFetch(
  t: { after: (fn: () => void) => void },
  handler: (url: URL) => FakeResponse,
): string[] {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const raw =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : String((input as { url: string }).url);
    const url = new URL(raw);
    calls.push(url.toString());
    const { status = 200, body } = handler(url);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

function timedEvent(id: string) {
  return {
    id,
    summary: id,
    status: "confirmed",
    start: { dateTime: "2026-11-05T09:00:00Z" },
    end: { dateTime: "2026-11-05T10:00:00Z" },
  };
}

function client(opts: {
  refreshToken?: string | null;
  expiresAt?: Date | null;
  onTokenRefresh?: (tokens: OAuthTokens) => void;
}) {
  return createGoogleClient({
    clientId: "cid",
    clientSecret: "csecret",
    tokens: {
      accessToken: "access-1",
      refreshToken: opts.refreshToken ?? null,
      expiresAt: opts.expiresAt ?? null,
    },
    onTokenRefresh: opts.onTokenRefresh,
  });
}

test("maps a timed Google event", () => {
  const mapped = mapGoogleEvent({
    id: "abc123",
    summary: "Board review",
    status: "confirmed",
    start: { dateTime: "2026-10-25T09:00:00+01:00" },
    end: { dateTime: "2026-10-25T10:00:00+01:00" },
    location: "Boardroom",
  });
  assert.ok(mapped);
  assert.equal(mapped.externalId, "abc123");
  assert.equal(mapped.title, "Board review");
  assert.equal(mapped.status, "confirmed");
  assert.equal(mapped.location, "Boardroom");
  assert.equal(mapped.allDay, false);
  assert.equal(mapped.start.toISOString(), "2026-10-25T08:00:00.000Z");
});

test("maps an all-day event (date instead of dateTime) in UTC", () => {
  const mapped = mapGoogleEvent({
    id: "all-day",
    start: { date: "2026-10-26" },
    end: { date: "2026-10-27" },
  });
  assert.ok(mapped);
  assert.equal(mapped.title, "(untitled)", "missing summary gets a placeholder");
  assert.equal(mapped.allDay, true);
  assert.equal(mapped.start.toISOString(), "2026-10-26T00:00:00.000Z");
});

test("all-day events are local midnight in Africa/Lagos, not UTC midnight", () => {
  const mapped = mapGoogleEvent(
    {
      id: "lagos-holiday",
      summary: "Public holiday",
      start: { date: "2026-11-05" },
      end: { date: "2026-11-06" },
    },
    "Africa/Lagos",
  );
  assert.ok(mapped);
  assert.equal(mapped.allDay, true);
  assert.equal(mapped.start.toISOString(), "2026-11-04T23:00:00.000Z");
  assert.equal(mapped.end.toISOString(), "2026-11-05T23:00:00.000Z");
});

test("all-day events are local midnight in America/Los_Angeles", () => {
  const mapped = mapGoogleEvent(
    {
      id: "la-offsite",
      summary: "Offsite",
      start: { date: "2026-11-05" },
      end: { date: "2026-11-06" },
    },
    "America/Los_Angeles",
  );
  assert.ok(mapped);
  // DST ended on 2026-11-01, so November is PST (UTC-8).
  assert.equal(mapped.start.toISOString(), "2026-11-05T08:00:00.000Z");
  assert.equal(mapped.end.toISOString(), "2026-11-06T08:00:00.000Z");
});

test("all-day events survive the 2026-03-08 DST boundary in America/Los_Angeles", () => {
  // Clocks spring forward at 02:00 on 2026-03-08, so that local day is 23h long.
  const mapped = mapGoogleEvent(
    {
      id: "dst-day",
      summary: "Spring forward",
      start: { date: "2026-03-08" },
      end: { date: "2026-03-09" },
    },
    "America/Los_Angeles",
  );
  assert.ok(mapped);
  assert.equal(mapped.start.toISOString(), "2026-03-08T08:00:00.000Z", "PST midnight");
  assert.equal(mapped.end.toISOString(), "2026-03-09T07:00:00.000Z", "PDT midnight");
  assert.equal(mapped.end.getTime() - mapped.start.getTime(), 23 * 3_600_000);

  // The day before the change is still 24h and reads as the same local date.
  const before = mapGoogleEvent(
    { id: "dst-eve", start: { date: "2026-03-07" }, end: { date: "2026-03-08" } },
    "America/Los_Angeles",
  );
  assert.ok(before);
  assert.equal(before.start.toISOString(), "2026-03-07T08:00:00.000Z");
  assert.equal(before.end.toISOString(), "2026-03-08T08:00:00.000Z");
});

test("timed events keep their instant and are never marked all-day", () => {
  const mapped = mapGoogleEvent(
    {
      id: "timed-la",
      start: { dateTime: "2026-11-05T15:00:00-07:00" },
      end: { dateTime: "2026-11-05T16:00:00-07:00" },
    },
    "America/Los_Angeles",
  );
  assert.ok(mapped);
  assert.equal(mapped.allDay, false);
  assert.equal(mapped.start.toISOString(), "2026-11-05T22:00:00.000Z");
});

test("marks cancelled events", () => {
  const mapped = mapGoogleEvent({
    id: "gone",
    summary: "Cancelled sync",
    status: "cancelled",
    start: { dateTime: "2026-10-25T11:00:00Z" },
    end: { dateTime: "2026-10-25T11:30:00Z" },
  });
  assert.equal(mapped?.status, "cancelled");
});

test("rejects malformed resources instead of throwing", () => {
  assert.equal(mapGoogleEvent({}), null);
  assert.equal(mapGoogleEvent({ id: "x" }), null);
  assert.equal(
    mapGoogleEvent({ id: "y", start: { dateTime: "nonsense" }, end: { dateTime: "nonsense" } }),
    null,
  );
  assert.equal(mapGoogleEvent(null as any), null);
});

test("auth URL carries the OAuth handshake parameters", () => {
  const url = new URL(
    buildAuthUrl({
      clientId: "cid",
      redirectUri: "http://localhost:3000/auth/google/callback",
      state: "signed-state",
    }),
  );
  assert.equal(url.hostname, "accounts.google.com");
  assert.equal(url.searchParams.get("client_id"), "cid");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("state"), "signed-state");
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.match(url.searchParams.get("scope") ?? "", /auth\/calendar\.events/);
});

test("the requested scope allows writing events and grants nothing broader", () => {
  assert.deepEqual(GOOGLE_SCOPES, ["https://www.googleapis.com/auth/calendar.events"]);
});

test("listEvents follows nextPageToken so the list is complete", async (t) => {
  const pages = [
    { items: [timedEvent("first")], nextPageToken: "page-2" },
    { items: [timedEvent("second")], nextPageToken: "page-3" },
    { items: [timedEvent("third")] },
  ];
  let page = 0;
  const calls = stubFetch(t, () => ({ status: 200, body: pages[page++] }));

  const events = await client({}).listEvents(FROM, TO);
  assert.deepEqual(
    events.map((e) => e.externalId),
    ["first", "second", "third"],
    "every page is mapped, in order",
  );
  assert.equal(calls.length, 3);
  assert.equal(new URL(calls[0]).searchParams.get("pageToken"), null);
  assert.equal(new URL(calls[1]).searchParams.get("pageToken"), "page-2");
  assert.equal(new URL(calls[2]).searchParams.get("pageToken"), "page-3");
  assert.equal(new URL(calls[0]).searchParams.get("showDeleted"), null);
});

test("invalid_grant from the token endpoint is a CalendarAuthError", async (t) => {
  stubFetch(t, () => ({
    status: 400,
    body: { error: "invalid_grant", error_description: "Token has been expired or revoked." },
  }));
  await assert.rejects(
    refreshAccessToken({ clientId: "cid", clientSecret: "csecret", refreshToken: "rt" }),
    (err: unknown) =>
      err instanceof CalendarAuthError && err.code === "invalid_grant",
  );
});

test("a 503 from the token endpoint stays an ordinary error", async (t) => {
  stubFetch(t, () => ({ status: 503, body: { error: "backend_error" } }));
  await assert.rejects(
    refreshAccessToken({ clientId: "cid", clientSecret: "csecret", refreshToken: "rt" }),
    (err: unknown) => err instanceof Error && !(err instanceof CalendarAuthError),
  );
});

test("a 429 from the token endpoint stays an ordinary error", async (t) => {
  stubFetch(t, () => ({ status: 429, body: { error: "rate_limit_exceeded" } }));
  await assert.rejects(
    refreshAccessToken({ clientId: "cid", clientSecret: "csecret", refreshToken: "rt" }),
    (err: unknown) => err instanceof Error && !(err instanceof CalendarAuthError),
  );
});

test("a network failure stays an ordinary error", async (t) => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  await assert.rejects(
    refreshAccessToken({ clientId: "cid", clientSecret: "csecret", refreshToken: "rt" }),
    (err: unknown) => err instanceof Error && !(err instanceof CalendarAuthError),
  );
});

test("a 401 with no usable refresh token is a CalendarAuthError", async (t) => {
  stubFetch(t, () => ({ status: 401, body: { error: { message: "Invalid Credentials" } } }));
  await assert.rejects(
    client({}).listEvents(FROM, TO),
    (err: unknown) => err instanceof CalendarAuthError && err.code === "invalid_token",
  );
});

test("a 401 with a refresh token refreshes once and retries the list", async (t) => {
  let eventCalls = 0;
  stubFetch(t, (url) => {
    if (url.hostname === "oauth2.googleapis.com") {
      return { status: 200, body: { access_token: "access-2", expires_in: 3600 } };
    }
    eventCalls += 1;
    return eventCalls === 1
      ? { status: 401, body: { error: { message: "Invalid Credentials" } } }
      : { status: 200, body: { items: [timedEvent("after-refresh")] } };
  });

  const persisted: OAuthTokens[] = [];
  const c = client({ refreshToken: "rt", onTokenRefresh: (tokens) => persisted.push(tokens) });
  const events = await c.listEvents(FROM, TO);

  assert.deepEqual(
    events.map((e) => e.externalId),
    ["after-refresh"],
  );
  assert.equal(eventCalls, 2, "retried exactly once");
  assert.equal(persisted.length, 1, "the refreshed token is handed back to be persisted");
  assert.equal(c.getTokens().accessToken, "access-2");
  assert.equal(c.getTokens().refreshToken, "rt", "the refresh token is kept");
});

test("a 401 that survives the refresh is a CalendarAuthError", async (t) => {
  stubFetch(t, (url) =>
    url.hostname === "oauth2.googleapis.com"
      ? { status: 200, body: { access_token: "access-2", expires_in: 3600 } }
      : { status: 401, body: { error: { message: "Invalid Credentials" } } },
  );
  await assert.rejects(
    client({ refreshToken: "rt" }).listEvents(FROM, TO),
    (err: unknown) => err instanceof CalendarAuthError,
  );
});

test("a 429 on the calendar list is an ordinary error, not an auth failure", async (t) => {
  stubFetch(t, () => ({ status: 429, body: { error: { message: "Rate Limit Exceeded" } } }));
  await assert.rejects(
    client({}).listEvents(FROM, TO),
    (err: unknown) => err instanceof Error && !(err instanceof CalendarAuthError),
  );
});

test("dev client filters fixture events to the window", async () => {
  const now = new Date("2026-10-25T08:00:00");
  const fixtures = defaultDevEvents(now);
  const client = createDevClient(fixtures);

  const morning = await client.listEvents(
    new Date("2026-10-25T08:30:00"),
    new Date("2026-10-25T10:00:00"),
  );
  assert.deepEqual(
    morning.map((e) => e.title),
    ["Daily standup"],
  );

  const empty = await client.listEvents(
    new Date("2026-10-25T20:00:00"),
    new Date("2026-10-25T21:00:00"),
  );
  assert.deepEqual(empty, []);

  const ids = fixtures.map((e) => e.externalId);
  assert.equal(new Set(ids).size, ids.length, "dev external ids must be unique");
});
