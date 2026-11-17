import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CalendarAuthError,
  EventConflictError,
  TransientCalendarError,
  createGoogleClient,
} from "./google.js";
import type { OAuthTokens } from "./types.js";

const FROM = new Date("2026-11-05T00:00:00Z");
const TO = new Date("2026-11-06T00:00:00Z");

function tokens(input: Partial<OAuthTokens> = {}): OAuthTokens {
  return {
    accessToken: "access-1",
    refreshToken: "rt",
    expiresAt: new Date(Date.now() + 60_000),
    ...input,
  };
}

/** Replace global fetch for one test; returns the URLs that were requested. */ function stubFetch(
  t: { after: (fn: () => void) => void },
  handler: (url: URL) => { status?: number; body?: unknown },
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
    const { status = 200, body = {} } = handler(url);
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

test("insertEvent posts to the events.insert URL and returns the id", async (t) => {
  const client = createGoogleClient({
    clientId: "cid",
    clientSecret: "csecret",
    tokens: tokens(),
    calendarId: "primary",
  });

  const calls = stubFetch(t, () => ({
    status: 200,
    body: {
      id: "google-event-123",
      summary: "Board review",
      location: "Boardroom",
      start: { dateTime: "2026-11-05T09:00:00+01:00" },
      end: { dateTime: "2026-11-05T10:00:00+01:00" },
      htmlLink: "https://google.com/event/123",
    },
  }));

  const result = await client.insertEvent({
    calendarId: "primary",
    sendUpdates: "all",
    requestBody: {
      summary: "Board review",
      start: { dateTime: "2026-11-05T09:00:00+01:00", timeZone: "Africa/Lagos" },
      end: { dateTime: "2026-11-05T10:00:00+01:00", timeZone: "Africa/Lagos" },
      location: "Boardroom",
    },
  });

  assert.equal(result.event.externalId, "google-event-123");
  assert.equal(result.event.title, "Board review");
  assert.equal(result.event.location, "Boardroom");

  console.error('URL check:', calls[0]);
  // First call is the token refresh to oauth2.googleapis.com; the insertEvent
  // POST is the second call.
  const url = new URL(calls[1]);
  assert.equal(url.hostname, "www.googleapis.com");
  assert.equal(url.pathname, "/calendar/v3/calendars/primary/events");
  assert.equal(url.searchParams.get("sendUpdates"), "all");
});

test("insertEvent enriches the response timeZone and keeps the instant", async (t) => {
  const client = createGoogleClient({
    clientId: "cid",
    clientSecret: "csecret",
    tokens: tokens(),
    timezone: "Africa/Lagos",
  });

  stubFetch(t, () => ({
    status: 200,
    body: {
      id: "google-event-456",
      summary: "Nigeria call",
      start: { dateTime: "2026-11-05T09:00:00+01:00" },
      end: { dateTime: "2026-11-05T10:00:00+01:00" },
      htmlLink: "https://google.com/event/456",
    },
  }));

  const result = await client.insertEvent({
    calendarId: "primary",
    requestBody: {
      summary: "Nigeria call",
      start: { dateTime: "2026-11-05T09:00:00+01:00", timeZone: "Africa/Lagos" },
      end: { dateTime: "2026-11-05T10:00:00+01:00", timeZone: "Africa/Lagos" },
    },
  });

  assert.ok(result.event.start.getTime() > 0);
  assert.equal(result.event.externalId, "google-event-456");
});

test("insertEvent refreshes once and retries when Google answers 401", async (t) => {
  const persisted: OAuthTokens[] = [];
  const client = createGoogleClient({
    clientId: "cid",
    clientSecret: "csecret",
    tokens: tokens(),
    onTokenRefresh: (tokens) => { persisted.push(tokens); },
  });

  const calls = stubFetch(t, (url) => {
    if (url.hostname === "oauth2.googleapis.com") {
      return { status: 200, body: { access_token: "access-2", expires_in: 3600 } };
    }
    return { status: 401, body: { error: { message: "Invalid Credentials" } } };
  });

  await assert.rejects(
    client.insertEvent({
      calendarId: "primary",
      requestBody: {
        summary: "Retry event",
        start: { dateTime: "2026-11-05T09:00:00+01:00", timeZone: "UTC" },
        end: { dateTime: "2026-11-05T10:00:00+01:00", timeZone: "UTC" },
      },
    }),
    (err: unknown) =>
      err instanceof CalendarAuthError &&
      err.code === "invalid_token",
  );
  assert.ok(calls.some((c) => c.includes("oauth2.googleapis.com/token")), "token refresh was called");
  assert.ok(calls.some((c) => c.includes("www.googleapis.com/calendar/v3/calendars/primary/events")), "first API call was made");
  assert.ok(calls.filter((c) => c.includes("www.googleapis.com/calendar/v3/calendars/primary/events")).length === 2, "API called twice (401 then retry) after refresh");
  assert.ok(calls.some((c) => c.includes("oauth2.googleapis.com/token")), "token refresh was called again after 401");
  console.error('DEBUG persisted:', persisted.length, persisted.map(p => p.accessToken));
  assert.equal(persisted.length, 1, "the refreshed token is handed back to be persisted");
  assert.equal((client as any).getTokens().accessToken, "access-2");
});

test("insertEvent fails with CalendarAuthError when the 401 survives the refresh", async (t) => {
  const client = createGoogleClient({
    clientId: "cid",
    clientSecret: "csecret",
    tokens: tokens(),
  });

  stubFetch(t, (url) =>
    url.hostname === "oauth2.googleapis.com"
      ? { status: 200, body: { access_token: "access-2", expires_in: 3600 } }
      : { status: 401, body: { error: { message: "Invalid Credentials" } } },
  );

  await assert.rejects(
    client.insertEvent({
      calendarId: "primary",
      requestBody: {
        summary: "No retry",
        start: { dateTime: "2026-11-05T09:00:00+01:00", timeZone: "UTC" },
        end: { dateTime: "2026-11-05T10:00:00+01:00", timeZone: "UTC" },
      },
    }),
    (err: unknown) => err instanceof CalendarAuthError && err.code === "invalid_token",
  );
});

test("insertEvent fails with EventConflictError on a 409", async (t) => {
  const client = createGoogleClient({
    clientId: "cid",
    clientSecret: "csecret",
    tokens: tokens(),
    calendarId: "primary",
  });

  stubFetch(t, () => ({ status: 409, body: { error: { message: "Conflict" } } }));

  await assert.rejects(
    client.insertEvent({
      calendarId: "primary",
      requestBody: {
        summary: "Already exists",
        start: { dateTime: "2026-11-05T09:00:00+01:00", timeZone: "UTC" },
        end: { dateTime: "2026-11-05T10:00:00+01:00", timeZone: "UTC" },
      },
    }),
    (err: unknown) => err instanceof EventConflictError,
  );
});

test("insertEvent fails with TransientCalendarError on 429/5xx", async (t) => {
  const client = createGoogleClient({
    clientId: "cid",
    clientSecret: "csecret",
    tokens: tokens(),
  });

  stubFetch(t, (url) => {
    if (url.hostname === "www.googleapis.com") {
      return { status: 429, body: { error: { message: "Rate limit" } } };
    }
    return { status: 200, body: { access_token: "access-1" } };
  });

  await assert.rejects(
    client.insertEvent({
      calendarId: "primary",
      requestBody: {
        summary: "Too fast",
        start: { dateTime: "2026-11-05T09:00:00+01:00", timeZone: "UTC" },
        end: { dateTime: "2026-11-05T10:00:00+01:00", timeZone: "UTC" },
      },
    }),
    (err: unknown) =>
      err instanceof TransientCalendarError &&
      err.message.includes("429") &&
      err.message.includes("the write state is unknown"),
  );
});

test("insertEvent fails with a readable error on an unexpected response", async (t) => {
  const client = createGoogleClient({
    clientId: "cid",
    clientSecret: "csecret",
    tokens: tokens(),
  });

  stubFetch(t, (url) => {
    if (url.hostname === "www.googleapis.com") {
      return { status: 500, body: { error: "backend_error", error_description: "Backend down" } };
    }
    return { status: 200, body: { access_token: "access-1" } };
  });

  await assert.rejects(
    client.insertEvent({
      calendarId: "primary",
      requestBody: {
        summary: "Backend",
        start: { dateTime: "2026-11-05T09:00:00+01:00", timeZone: "UTC" },
        end: { dateTime: "2026-11-05T10:00:00+01:00", timeZone: "UTC" },
      },
    }),
    (err: unknown) =>
      err instanceof TransientCalendarError &&
      err.message.includes("Google Calendar create failed (500)"),
  );
});
